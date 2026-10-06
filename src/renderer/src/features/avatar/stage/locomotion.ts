import * as THREE from 'three'
import { SIDES, sideSign, type BodyInput, type BodyRig, type Side } from './body'
import { angleDiff, clamp, smooth } from './ik'

/*
 * Procedural walking, turning and crouching: a real gait cycle.
 *
 * Her root (x, z and heading) glides toward a goal with eased acceleration,
 * and a stride clock moves her feet. Each foot spends ~60% of a stride on
 * the ground — heel strike, rolling flat, the heel peeling up over the ball
 * of the foot — and ~40% in the air, where the knee folds up behind her (the
 * ankle rises to whatever height gives the knee its natural swing bend) and
 * then straightens to reach out for the next heel strike. Landing spots are
 * planned from where her body will be when the foot comes down, half a
 * stance ahead of it, so a planted foot never slides. The pelvis bobs (low as
 * both feet share her weight, high over the standing leg), sways over the
 * standing foot, turns with the stride and dips on the swinging side; the
 * chest turns against it and a free arm swings opposite its leg. The hips
 * never sit so high that a standing knee locks straight.
 *
 * Setting off she shifts her weight and steps; stopping, her last steps
 * bring her feet together under her. Turning on the spot the clock runs with
 * nowhere to go, so she steps round. To crouch she sets one foot back and
 * sinks onto the ball of it, knees together (a skirt-friendly squat).
 */

const ACCEL = 0.95 // m/s²
const DECEL = 1.3
const TURN_RATE = 2.2 // rad/s at most (standing)
/** how deep a full crouch takes her hips (m) */
export const CROUCH_DEPTH = 0.36
/** each foot's line either side of her path while walking (m) — in heels she walks a narrow line */
const GAIT_HALF_WIDTH = 0.05
/** share of a stride each foot is on the ground */
const STANCE = 0.62
/** heel strike → foot flat (share of a stride) */
const LOAD = 0.1
/** the heel peels up over the ball this long before toe-off */
const HEEL_OFF = 0.22
/** a full step: the roll and knee bend below are reached at this step length (m) */
const STEP_REF = 0.36
const D2R = THREE.MathUtils.DEG2RAD
/** toes up at heel strike, heel up at toe-off (a full step, radians) */
const ROLL_ON = -9 * D2R
const ROLL_OFF = 26 * D2R
/** the swing knee's bend at the top of a full step */
const SWING_KNEE = 56 * D2R
/** how far the back foot steps back to crouch, and how high its heel rises */
const CROUCH_STAGGER = 0.15
const CROUCH_HEEL = 34 * D2R

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _qRoot = new THREE.Quaternion()
const _qG = new THREE.Quaternion()
const _Y = new THREE.Vector3(0, 1, 0)
const _X = new THREE.Vector3(1, 0, 0)
const _Z = new THREE.Vector3(0, 0, 1)

/** the swing knee's bend over a swing (share of its peak) */
function swingKnee(s: number): number {
  // folded up as the foot leaves the floor, most bent a third of the way
  // through, straightening to reach out for the heel strike
  const pts = [
    [0, 0.62],
    [0.15, 0.88],
    [0.32, 1.0],
    [0.5, 0.86],
    [0.7, 0.46],
    [0.88, 0.16],
    [1.0, 0.07]
  ]
  for (let i = 1; i < pts.length; i++) {
    if (s <= pts[i][0]) {
      const [s0, k0] = pts[i - 1]
      const [s1, k1] = pts[i]
      return k0 + (k1 - k0) * smooth((s - s0) / (s1 - s0))
    }
  }
  return pts[pts.length - 1][1]
}

interface Swing {
  /** the flat-foot ankle position it left from / will land on (world) */
  from: THREE.Vector3
  to: THREE.Vector3
  fromYaw: number
  toYaw: number
  /** heel-up roll it left with, toes-up roll it lands with (rad) */
  rollOff: number
  rollOn: number
  /** peak knee bend of this swing (rad), and the bend it left the floor with */
  knee: number
  knee0: number
}

export interface Foot {
  side: Side
  /** the planted foot: where its ankle is when the foot lies flat (world) */
  plant: THREE.Vector3
  /** the heading it was planted with (world yaw, like the root's) */
  yaw: number
  swing: Swing | null
  /** its own place in the stride: 0 heel strike … STANCE toe-off … 1 */
  phase: number
  /** this frame: ankle, heading, roll (+ heel up over the ball, − toes up
   *  on the heel) and the toes' bend (keeping them flat on the floor) */
  pos: THREE.Vector3
  curYaw: number
  pitch: number
  toe: number
  /** the roll the foot landed with, and the roll it will leave with */
  rollOn: number
  rollOff: number
  /** where it stands relative to her root (root frame), and its rotation relative to her heading */
  offset: THREE.Vector3
  rel: THREE.Quaternion
}

export interface WalkGoal {
  pos: THREE.Vector3
  yaw: number
  speed: number
  /** 0..1: how much she faces where she's going on the way (vs. her final heading) */
  faceTravel: number
}

export class Locomotion {
  /** her root: position on the floor and heading (radians, 0 = facing +Z) */
  readonly pos = new THREE.Vector3()
  yaw = 0
  readonly vel = new THREE.Vector3()
  private yawRate = 0
  goal: WalkGoal | null = null
  /** 0..1, set by the actor: how low she is */
  crouch = 0
  /** 0..1, set by the actor: how far her feet are set for a crouch (the
   *  back foot stepped back) — she steps into it before sinking */
  crouchStance = 0
  /** the foot that steps back to crouch */
  backSide: Side = 'right'
  /** extra stance width per foot (m) */
  widen = 0
  readonly feet: Record<Side, Foot>
  /** 0..1: how much the legs follow the planted feet (vs. the clip) */
  legWeight = 0
  /** called when a foot lands (world ankle position) */
  onStep: ((side: Side, at: THREE.Vector3, hard: number) => void) | null = null
  /** how far her knees open at a full crouch (see AvatarConfig.stage) */
  kneeOut = 0.35

  private time = 0
  /** under way to the goal (vs. arrived and turning to her final heading) */
  private going = false
  /** the stride clock: running, its phase (the left foot's), its rate */
  private gaitOn = false
  private phase = 0
  private cadence = 1.6
  /** 0 standing … 1 striding, eased (how much the stride moves her body) */
  private walkAmt = 0
  private stride = 0
  /** the hip joints as last posed (world) — where the swinging knee folds from */
  private readonly hipRoot: Record<Side, THREE.Vector3> = { left: new THREE.Vector3(), right: new THREE.Vector3() }
  /** the foot's contact points relative to its ankle (her frame, standing
   *  flat): the ball it peels up over, the heel it lands on */
  private readonly ball: Record<Side, THREE.Vector3> = { left: new THREE.Vector3(), right: new THREE.Vector3() }
  private readonly heel: Record<Side, THREE.Vector3> = { left: new THREE.Vector3(), right: new THREE.Vector3() }
  private drop = 0
  private lean = 0
  private accelLean = 0
  private lastSpeed = 0

  constructor(private readonly body: BodyRig) {
    const foot = (side: Side): Foot => ({
      side,
      plant: new THREE.Vector3(),
      yaw: 0,
      swing: null,
      phase: 0,
      pos: new THREE.Vector3(),
      curYaw: 0,
      pitch: 0,
      toe: 0,
      rollOn: 0,
      rollOff: 0,
      offset: new THREE.Vector3(),
      rel: new THREE.Quaternion()
    })
    this.feet = { left: foot('left'), right: foot('right') }
    // the feet's contact points, from the bind pose (she stands facing +Z)
    for (const s of SIDES) {
      const leg = body.legs[s]
      const ankle = leg.end.getWorldPosition(new THREE.Vector3())
      const toes = body.toes[s]?.getWorldPosition(new THREE.Vector3()) ?? ankle.clone().add(new THREE.Vector3(0, -ankle.y * 0.85, 0.1))
      const len = Math.hypot(toes.x - ankle.x, toes.z - ankle.z)
      this.ball[s].set(toes.x - ankle.x, 0.005 - ankle.y, toes.z - ankle.z)
      this.heel[s].set(0, -ankle.y, -0.2 * len)
      leg.upper.getWorldPosition(this.hipRoot[s])
    }
  }

  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z)
  }

  get stepping(): boolean {
    return !!(this.feet.left.swing || this.feet.right.swing)
  }

  /** 0 standing … 1 striding (eased) — how much a free arm walks too */
  get walking(): number {
    return this.walkAmt
  }

  /** a free arm's swing this frame (radians, + = forward) */
  armSwing(side: Side): number {
    const amp = clamp(this.stride / STEP_REF, 0, 1.15)
    const swingR = (0.2 + 0.14 * amp) * this.walkAmt * Math.cos(this.phase * Math.PI * 2 - 0.3)
    return side === 'right' ? swingR : -swingR
  }

  /** take over from the clip: plant the feet where the current pose has them */
  begin(rootPos: THREE.Vector3, rootYaw: number): void {
    this.pos.copy(rootPos).setY(0)
    this.yaw = rootYaw
    this.vel.set(0, 0, 0)
    this.yawRate = 0
    this.goal = null
    this.going = false
    this.gaitOn = false
    this.walkAmt = 0
    this.drop = 0
    this.lean = this.accelLean = 0
    _q2.setFromAxisAngle(_Y, -rootYaw)
    for (const s of SIDES) {
      const f = this.feet[s]
      const leg = this.body.legs[s]
      leg.end.getWorldPosition(f.plant)
      f.pos.copy(f.plant)
      f.yaw = f.curYaw = rootYaw
      f.pitch = f.toe = 0
      f.rollOn = f.rollOff = 0
      f.swing = null
      // its place under her, in her own frame
      f.offset.copy(f.plant).sub(this.pos).applyQuaternion(_q2)
      f.offset.y = f.plant.y
      f.rel.copy(_q2).multiply(leg.end.getWorldQuaternion(_q))
      leg.upper.getWorldPosition(this.hipRoot[s])
    }
  }

  // ── where things go ────────────────────────────────────────────────────

  /** a foot's place under her for a given root position / heading and how
   *  much she's striding (0 her own stance … 1 the narrow walking line),
   *  as a flat-foot ankle position (world) */
  private place(f: Foot, x: number, z: number, yaw: number, walk: number, out: THREE.Vector3): THREE.Vector3 {
    const sg = sideSign(f.side)
    const stand = f.offset.x + sg * this.widen
    let lat = stand + (sg * GAIT_HALF_WIDTH - stand) * walk
    let fwd = f.offset.z * (1 - walk)
    // a crouch: the back foot steps back (and a little in), the front one
    // stays — knees together over a staggered stance
    const c = this.crouchStance
    if (c > 0) {
      const back = f.side === this.backSide
      fwd += (back ? -CROUCH_STAGGER : 0.035) * c
      lat -= sg * (back ? 0.025 : 0.012) * c
    }
    out.set(lat, 0, fwd).applyAxisAngle(_Y, yaw)
    out.x += x
    out.z += z
    out.y = f.offset.y
    return out
  }

  private footError(f: Foot): number {
    const p = this.place(f, this.pos.x, this.pos.z, this.yaw, 0, _v)
    const d = Math.hypot(p.x - f.plant.x, p.z - f.plant.z)
    return d + Math.abs(angleDiff(f.yaw, this.yaw)) * 0.14
  }

  /** at her goal, standing still, feet under her */
  get settled(): boolean {
    if (this.gaitOn || this.stepping || this.speed > 0.01 || Math.abs(this.yawRate) > 0.05) return false
    if (this.goal) {
      const d = Math.hypot(this.goal.pos.x - this.pos.x, this.goal.pos.z - this.pos.z)
      if (d > 0.006 || Math.abs(angleDiff(this.yaw, this.goal.yaw)) > 0.03) return false
    }
    return this.footError(this.feet.left) < 0.035 && this.footError(this.feet.right) < 0.035
  }

  // ── per frame ──────────────────────────────────────────────────────────

  update(dt: number): void {
    this.time += dt
    this.moveRoot(dt)
    this.stepFeet(dt)
  }

  private moveRoot(dt: number): void {
    const g = this.goal
    const prevYaw = this.yaw
    // (not until the legs have fully taken over from the clip: a root that
    // turned while they blended in carried the feet round with it, and they
    // snapped back to their planted spots once the blend finished)
    if (g && this.legWeight < 0.999) {
      this.vel.set(0, 0, 0)
      this.yawRate = 0
      return
    }
    if (g) {
      const dx = g.pos.x - this.pos.x
      const dz = g.pos.z - this.pos.z
      const dist = Math.hypot(dx, dz)
      // heading: toward where she's going while there's a way to go (as
      // much as `faceTravel` says — 0 sidesteps), then her final heading.
      // She turns (stepping round) before she sets off: a body that spins
      // as it travels drags its planted feet across itself
      if (dist > 0.12) this.going = true
      else if (dist < 0.03 || (dist < 0.08 && this.speed < 0.06)) this.going = false
      // (the way she's moving once under way — the line to a goal she's
      // almost on swings about)
      const travel = this.speed > 0.12 ? Math.atan2(this.vel.x, this.vel.z) : dist > 1e-4 ? Math.atan2(dx, dz) : this.yaw
      const want = this.going ? g.yaw + angleDiff(g.yaw, travel) * g.faceTravel : g.yaw
      const off = Math.abs(angleDiff(this.yaw, want))
      // (she sets off once she faces roughly the right way — the first
      // steps finish the turn)
      const go = this.going ? smooth(1 - (off - 0.35) / 0.6) : 1
      // ease toward a stop exactly on the goal
      const vdes = Math.min(g.speed * go, Math.sqrt(2 * DECEL * Math.max(0, dist - 0.002)))
      const wantX = dist > 1e-4 ? (dx / dist) * vdes : 0
      const wantZ = dist > 1e-4 ? (dz / dist) * vdes : 0
      let ax = wantX - this.vel.x
      let az = wantZ - this.vel.z
      const a = Math.hypot(ax, az)
      // (the first step takes off gently: full acceleration once striding)
      const pick = vdes < this.speed ? DECEL : ACCEL * (0.55 + 0.45 * smooth(this.speed / 0.25))
      const cap = pick * dt
      if (a > cap) {
        ax *= cap / a
        az *= cap / a
      }
      this.vel.x += ax
      this.vel.z += az
      // her body can't get far ahead of a foot still on the floor behind it
      // (setting off, the first step goes before she really moves)
      const sp = this.speed
      if (sp > 0.02) {
        const ux = this.vel.x / sp
        const uz = this.vel.z / sp
        let ahead = this.gaitOn ? 0 : 0.5
        for (const s of SIDES) {
          const f = this.feet[s]
          if (!f.swing) ahead = Math.max(ahead, (this.pos.x - f.plant.x) * ux + (this.pos.z - f.plant.z) * uz)
        }
        const over = ahead - 0.27
        if (over > 0) this.vel.multiplyScalar(Math.max(0.3, 1 - over * 10 * dt * 8))
      }
      this.pos.x += this.vel.x * dt
      this.pos.z += this.vel.z * dt
      if (dist < 0.003 && this.speed < 0.03) {
        this.pos.x = g.pos.x
        this.pos.z = g.pos.z
        this.vel.set(0, 0, 0)
      }
      // turning: slower while striding (a walker curves gently), and never
      // faster than her feet can step round after her
      let lag = 0
      for (const s of SIDES) {
        const f = this.feet[s]
        if (!f.swing) lag = Math.max(lag, Math.abs(angleDiff(f.yaw, this.yaw)))
      }
      const d = angleDiff(this.yaw, want)
      const maxTurn = TURN_RATE * dt * (1 - 0.5 * smooth(this.speed / 0.5)) * clamp(1.9 - lag / 0.6, 0.3, 1)
      this.yaw += clamp(d * Math.min(1, dt * 5), -maxTurn, maxTurn)
    } else {
      this.vel.multiplyScalar(Math.max(0, 1 - dt * 8))
      this.going = false
    }
    this.yawRate = angleDiff(prevYaw, this.yaw) / Math.max(dt, 1e-3)
    // a little forward lean while she speeds up, back while she brakes
    const sp = this.speed
    const acc = (sp - this.lastSpeed) / Math.max(dt, 1e-3)
    this.lastSpeed = sp
    this.accelLean += (clamp(acc * 0.06, -0.05, 0.08) - this.accelLean) * Math.min(1, dt * 6)
  }

  /** the root's heading `t` seconds on (eased toward the goal's, never past it) */
  private yawIn(t: number): number {
    let yawAt = this.yaw + this.yawRate * t
    const g = this.goal
    if (g) {
      const toGoal = angleDiff(this.yaw, g.yaw)
      const turn = angleDiff(this.yaw, yawAt)
      if (this.going) {
        // under way: she keeps facing about the way she's heading
        yawAt = this.yaw + clamp(turn, -0.5, 0.5)
      } else if (Math.sign(turn) === Math.sign(toGoal) && Math.abs(turn) > Math.abs(toGoal)) yawAt = g.yaw
    }
    return yawAt
  }

  /** where a foot taking off now should come down (flat-foot ankle, world)
   *  and its heading then */
  private plan(f: Foot, tLand: number, out: THREE.Vector3): number {
    const g = this.goal
    // her body when the foot lands — braking for the goal, never past it
    let vx = this.vel.x
    let vz = this.vel.z
    let px = this.pos.x + vx * tLand
    let pz = this.pos.z + vz * tLand
    let vLand = this.speed
    if (g) {
      const dx = g.pos.x - this.pos.x
      const dz = g.pos.z - this.pos.z
      const dist = Math.hypot(dx, dz)
      const sp = this.speed
      if (dist > 1e-4) {
        // distance covered by then (decelerating into the goal if need be)
        let travel = sp * tLand
        const stop = (sp * sp) / (2 * DECEL)
        if (!this.going || stop >= dist - 0.01) {
          travel = Math.min(travel, dist)
          vLand = Math.sqrt(Math.max(0, sp * sp - 2 * DECEL * travel))
        } else if (this.going) {
          // still speeding up toward her pace
          const v1 = Math.min(g.speed, sp + ACCEL * tLand)
          travel = Math.min(dist, ((sp + v1) / 2) * tLand)
          vLand = v1
        }
        px = this.pos.x + (dx / dist) * travel
        pz = this.pos.z + (dz / dist) * travel
        const vn = Math.max(sp, 1e-4)
        vx = sp > 1e-4 ? (this.vel.x / vn) * vLand : (dx / dist) * vLand
        vz = sp > 1e-4 ? (this.vel.z / vn) * vLand : (dz / dist) * vLand
      }
    }
    const yawAt = this.yawIn(tLand)
    const walk = smooth(vLand / 0.3) * (1 - this.crouchStance)
    this.place(f, px, pz, yawAt, walk, out)
    // land ahead of where it'll stand mid-stance by half the stance's travel
    // (walking forward) — sideways, the leading foot steps out and the other
    // closes in behind it, so they never cross
    const T = 2 / this.cadence
    const fx = Math.sin(yawAt)
    const fz = Math.cos(yawAt)
    const lx = Math.cos(yawAt) // her left
    const lz = -Math.sin(yawAt)
    const vs = vx * fx + vz * fz
    const vl = vx * lx + vz * lz
    const leadS = vs * STANCE * T * 0.5
    const leading = Math.sign(vl) === sideSign(f.side)
    const leadL = vl * T * (leading ? 0.3 : -0.08)
    out.x += fx * leadS + lx * leadL
    out.z += fz * leadS + lz * leadL
    // never cross the other foot, never over-stride
    const other = this.feet[f.side === 'left' ? 'right' : 'left']
    const ref = other.swing ? other.swing.to : other.plant
    const lat = (out.x - ref.x) * lx + (out.z - ref.z) * lz
    const minSep = 0.095 * sideSign(f.side) * (1 - 0.35 * this.crouchStance)
    if (sideSign(f.side) * (lat - minSep) < 0) {
      out.x += lx * (minSep - lat)
      out.z += lz * (minSep - lat)
    }
    // (a foot's swing covers a whole stride — two steps — when striding)
    const len = Math.hypot(out.x - f.plant.x, out.z - f.plant.z)
    if (len > 0.92) {
      const k = 0.92 / len
      out.x = f.plant.x + (out.x - f.plant.x) * k
      out.z = f.plant.z + (out.z - f.plant.z) * k
    }
    return yawAt
  }

  private stepFeet(dt: number): void {
    const speed = this.speed
    const travelling = this.going || speed > 0.04
    const turning = Math.abs(this.yawRate) > 0.3
    let worst = 0
    for (const s of SIDES) worst = Math.max(worst, this.footError(this.feet[s]))
    // the stride clock: brisk short steps in heels; quicker to step round
    this.cadence = clamp(1.55 + 0.6 * speed, 1.55, 2.15) + (turning && speed < 0.15 ? 0.35 : 0)
    if (!this.gaitOn && this.legWeight >= 0.5 && (travelling || turning || worst > 0.028)) this.startGait()
    if (this.gaitOn) {
      // a foot left far behind her body hurries its stance along
      let hurry = 1
      if (speed > 0.1) {
        const ux = this.vel.x / speed
        const uz = this.vel.z / speed
        for (const s of SIDES) {
          const f = this.feet[s]
          if (f.swing || f.phase < LOAD) continue
          const behind = (this.pos.x - f.plant.x) * ux + (this.pos.z - f.plant.z) * uz
          hurry = Math.max(hurry, 1 + clamp((behind - 0.26) * 4, 0, 0.6))
        }
      }
      const rate = this.cadence * 0.5 * hurry
      const before = this.phase
      this.phase = (this.phase + dt * rate) % 1
      for (const s of SIDES) {
        const f = this.feet[s]
        const p0 = (before + (s === 'left' ? 0 : 0.5)) % 1
        const p1 = (this.phase + (s === 'left' ? 0 : 0.5)) % 1
        f.phase = p1
        const wrapped = p1 < p0
        // heel strike: plant where the swing was headed
        if (wrapped && f.swing) this.land(f)
        // the heel starts to peel up: how far the coming step will go
        if (!f.swing && ((p0 < STANCE - HEEL_OFF && p1 >= STANCE - HEEL_OFF) || (wrapped && p1 >= STANCE - HEEL_OFF))) {
          this.plan(f, (1 - STANCE) * (2 / this.cadence), _v3)
          const len = Math.hypot(_v3.x - f.plant.x, _v3.z - f.plant.z)
          f.rollOff = ROLL_OFF * clamp(len / (2 * STEP_REF), 0, 1)
        }
        // toe-off: take the step (or stay put, if it would go nowhere)
        if (!f.swing && ((p0 < STANCE && p1 >= STANCE) || (wrapped && p1 >= STANCE))) this.takeOff(f, travelling, turning)
      }
      // all done: both feet under her and nothing left to do
      if (!travelling && !turning && !this.stepping && this.footError(this.feet.left) < 0.022 && this.footError(this.feet.right) < 0.022) {
        this.gaitOn = false
      }
    }
    // ease how much the stride drives her body
    const goal = this.gaitOn ? smooth(speed / 0.45) : 0
    this.walkAmt += (goal - this.walkAmt) * Math.min(1, dt * 4)
    this.stride = speed / this.cadence
    this.footPoses(dt)
  }

  /** start the stride clock: the foot that most needs to move goes first */
  private startGait(): void {
    this.gaitOn = true
    // which foot? the one furthest from where it'll need to be shortly
    const tAhead = 0.45
    let first: Side = 'left'
    let best = -1
    for (const s of SIDES) {
      const f = this.feet[s]
      this.plan(f, tAhead, _v)
      let e = Math.hypot(_v.x - f.plant.x, _v.z - f.plant.z) + Math.abs(angleDiff(f.yaw, this.yawIn(tAhead))) * 0.1
      // setting off toward one side, that foot leads (it opens the turn)
      const lx = Math.cos(this.yaw)
      const lz = -Math.sin(this.yaw)
      const g = this.goal
      if (g) {
        const dx = g.pos.x - this.pos.x
        const dz = g.pos.z - this.pos.z
        const d = Math.hypot(dx, dz)
        const side = d > 0.05 ? (dx * lx + dz * lz) / d : 0
        if (Math.abs(side) > 0.4 && Math.sign(side) === sideSign(s)) e += 0.5
      }
      if (e > best) {
        best = e
        first = s
      }
    }
    // just before that foot's toe-off (its heel lifting)
    const pf = STANCE - 0.07
    this.phase = first === 'left' ? pf : (pf + 0.5) % 1
    for (const s of SIDES) {
      const f = this.feet[s]
      f.phase = (this.phase + (s === 'left' ? 0 : 0.5)) % 1
      f.rollOn = 0
      f.rollOff = 0
    }
    const f = this.feet[first]
    this.plan(f, (1 - STANCE) * (2 / this.cadence), _v3)
    f.rollOff = ROLL_OFF * 0.6 * clamp(Math.hypot(_v3.x - f.plant.x, _v3.z - f.plant.z) / (2 * STEP_REF), 0, 1)
  }

  private takeOff(f: Foot, travelling: boolean, turning: boolean): void {
    const T = 2 / this.cadence
    const to = new THREE.Vector3()
    const toYaw = this.plan(f, (1 - STANCE) * T, to)
    const len = Math.hypot(to.x - f.plant.x, to.z - f.plant.z)
    const turn = Math.abs(angleDiff(f.yaw, toYaw))
    // winding down: a foot already where it belongs stays planted
    if (!travelling && !turning && len < 0.02 && turn < 0.06) {
      f.rollOff = 0
      return
    }
    const k = clamp(len / (2 * STEP_REF), 0, 1.1)
    // the knee as it is now, on the ball of the foot — the swing's bend
    // grows out of it (starting at the swing's own profile popped the foot up)
    const H = this.hipRoot[f.side]
    const l1 = this.body.legs.left.l1
    const l2 = this.body.legs.left.l2
    const d = f.pos.distanceTo(H)
    const knee0 = Math.acos(clamp((d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1))
    f.swing = {
      from: f.plant.clone(),
      to,
      fromYaw: f.yaw,
      toYaw,
      rollOff: f.rollOff,
      rollOn: ROLL_ON * Math.min(1, k),
      knee: Math.max(14 * D2R, SWING_KNEE * Math.min(1, 0.25 + k * 0.85)),
      knee0
    }
  }

  private land(f: Foot): void {
    const sw = f.swing!
    f.plant.copy(sw.to)
    f.yaw = sw.toYaw
    f.rollOn = sw.rollOn
    f.rollOff = 0
    f.swing = null
    const hard = clamp(Math.hypot(sw.to.x - sw.from.x, sw.to.z - sw.from.z) / 0.5, 0.25, 1)
    this.onStep?.(f.side, f.plant, hard)
  }

  /** this frame's ankle, heading, roll and toes for each foot */
  private footPoses(dt: number): void {
    const l1 = this.body.legs.left.l1
    const l2 = this.body.legs.left.l2
    for (const s of SIDES) {
      const f = this.feet[s]
      const sw = f.swing
      let pitch = 0
      let pivot = this.ball[s]
      if (sw) {
        const sp = clamp((f.phase - STANCE) / (1 - STANCE), 0, 1)
        // keep re-planning the landing until late in the swing (her body
        // may turn or slow), then commit
        if (sp < 0.8) {
          const T = 2 / this.cadence
          const left = (1 - sp) * (1 - STANCE) * T
          // (eased, like the landing spot: her heading's forecast jumps as she
          // arrives and turns to face you, and so did the foot)
          const toYaw = this.plan(f, left, _v)
          sw.toYaw += angleDiff(sw.toYaw, toYaw) * Math.min(1, dt * 14)
          sw.to.lerp(_v, Math.min(1, dt * 14))
        }
        const h = 0.85 * smooth(sp) + 0.15 * sp
        const G = _v2.lerpVectors(sw.from, sw.to, h)
        f.curYaw = sw.fromYaw + angleDiff(sw.fromYaw, sw.toYaw) * smooth(sp)
        // the roll: heel up over the ball as it leaves, toes up on the heel
        // as it lands (pivoting about each in turn)
        pitch = sw.rollOff * (1 - smooth(sp / 0.55)) + sw.rollOn * smooth((sp - 0.5) / 0.5)
        _v3.lerpVectors(this.ball[s], this.heel[s], smooth(sp))
        this.rolled(G, f.curYaw, pitch, _v3, f.pos)
        // the knee folds: lift the ankle until the leg has its swing bend
        const H = this.hipRoot[s]
        const knee = sw.knee0 + (swingKnee(sp) * sw.knee - sw.knee0) * smooth(sp / 0.3)
        const d2 = l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(knee)
        const r2 = (f.pos.x - H.x) ** 2 + (f.pos.z - H.z) ** 2
        const need = H.y - Math.sqrt(Math.max(d2 - r2, 0))
        const clear = 0.016 * Math.sin(Math.PI * sp) * Math.min(1, sw.knee / (30 * D2R))
        const fade = 1 - smooth((sp - 0.74) / 0.26)
        f.pos.y += Math.max(clear, (need - f.pos.y) * fade)
        // the toes stay on the floor a moment as it leaves
        f.toe = -Math.max(0, pitch) * (1 - smooth(sp / 0.35))
        f.pitch = pitch
        continue
      }
      if (this.gaitOn) {
        if (f.phase < LOAD) {
          pitch = f.rollOn * (1 - smooth(f.phase / LOAD))
        } else if (f.phase > STANCE - HEEL_OFF && f.phase < STANCE) {
          pitch = f.rollOff * Math.pow(smooth((f.phase - (STANCE - HEEL_OFF)) / HEEL_OFF), 1.3)
        }
        // (followed closely, not jumped to — the first step's heel starts
        // part way through its peel)
        f.pitch += (pitch - f.pitch) * Math.min(1, dt * 30)
        pitch = f.pitch
        if (pitch < 0) pivot = this.heel[s]
      } else {
        // standing: any roll left over settles flat
        f.pitch += (0 - f.pitch) * Math.min(1, dt * 10)
        pitch = f.pitch
        if (pitch < 0) pivot = this.heel[s]
      }
      // the crouch: the back foot sinks onto its ball, heel up
      if (this.crouch > 0 && s === this.backSide && pitch >= 0) {
        pitch = Math.max(pitch, CROUCH_HEEL * this.crouch)
        f.pitch = pitch
      }
      f.curYaw = f.yaw
      this.rolled(f.plant, f.yaw, pitch, pivot, f.pos)
      f.toe = -Math.max(0, pitch)
    }
  }

  /** the ankle of a foot lying flat at `flat` (heading `yaw`), rolled by
   *  `pitch` about `pivot` (foot-local, relative to the ankle) */
  private rolled(flat: THREE.Vector3, yaw: number, pitch: number, pivot: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    // ankle' = pivot + R(ankle − pivot) → offset = pivot − R·pivot
    _q.setFromAxisAngle(_X, pitch)
    out.copy(pivot).applyQuaternion(_q).negate().add(pivot).applyAxisAngle(_Y, yaw)
    return out.add(flat)
  }

  /** write her hips, spine, legs and arm swing into the body input */
  pose(inp: BodyInput, dt: number): void {
    const w = this.walkAmt
    const amp = clamp(this.stride / STEP_REF, 0, 1.15)
    const ph = this.phase * Math.PI * 2
    const c = this.crouch
    // the stride's rhythm in her pelvis and chest (her frame: + yaw turns
    // left, + roll tilts her to the left — the left hip drops —, + sway goes
    // to her left). Standing on her left foot (phase ¼) the swinging right
    // hip dips and her weight sways over the left foot.
    const g = w * (0.35 + 0.65 * amp)
    const pelvisYaw = -0.085 * g * Math.cos(ph - 0.12)
    const pelvisRoll = -0.07 * g * Math.sin(ph)
    const sway = 0.018 * w * Math.sin(ph - 0.35)
    const bob = 0.009 * g * Math.cos(2 * ph - 0.31 * 4 * Math.PI) - 0.012 * w
    this.lean += (0.045 * w + this.accelLean - this.lean) * Math.min(1, dt * 5)

    inp.hipsYaw = pelvisYaw
    inp.hipsRoll = pelvisRoll
    inp.hipsPitch = c * 0.12
    inp.spineBend = this.lean + c * 0.2
    inp.spineTwist = -pelvisYaw * 1.25
    inp.spineSide = -pelvisRoll * 0.6
    // (a free arm walks by IK — see Actor.walkArm; nothing swings by FK)
    inp.swing.left = 0
    inp.swing.right = 0

    // the hips: sway, bob and crouch, then low enough that no standing knee
    // locks straight
    const back = c * (this.crouchStance > 0 ? 0.045 : 0.085)
    const want = inp.hipsOffset.set(sway, bob - c * CROUCH_DEPTH, -back).applyAxisAngle(_Y, this.yaw)
    const need = this.straightLegDrop(want, inp, c)
    // (followed fast but smoothly — the need already rises ahead of each
    // heel strike — and never lagging more than 2 mm, or a foot would hover)
    if (need > this.drop) this.drop = Math.max(need - 0.002, this.drop + (need - this.drop) * Math.min(1, dt * 22))
    else this.drop += (need - this.drop) * Math.min(1, dt * 6)
    inp.hipsOffset.y -= this.drop

    for (const s of SIDES) {
      const f = this.feet[s]
      const leg = inp.legs[s]
      leg.weight = this.legWeight
      leg.ankle.copy(f.pos)
      // the foot: its stance rotation turned to its heading, rolled by its pitch
      _q.setFromAxisAngle(_Y, f.curYaw).multiply(_q2.setFromAxisAngle(_X, f.pitch)).multiply(f.rel)
      leg.foot.copy(_q)
      leg.toe = f.toe
      // knees over the toes while she walks; together as she crouches
      const sg = sideSign(s)
      const out = sg * (0.07 * (1 - c) - 0.16 * c * (1 - this.kneeOut * 0.5))
      leg.pole.set(out, 0, 1).applyAxisAngle(_Y, this.yaw + angleDiff(this.yaw, f.curYaw) * 0.5)
    }
  }

  /** how far the hips must come down (m) so that no foot on the floor
   *  straightens its knee past a few degrees — worked out from where the
   *  hip joints will be once `offset` and the pelvis turn are applied */
  private straightLegDrop(offset: THREE.Vector3, inp: BodyInput, c: number): number {
    const hips = this.body.hips
    hips.updateWorldMatrix(true, false)
    const H = hips.getWorldPosition(_v)
    // the pelvis turn, in world space (as BodyRig applies it)
    _q.setFromAxisAngle(_Y, inp.hipsYaw).multiply(_q2.setFromAxisAngle(_X, inp.hipsPitch))
    _q.multiply(_q2.setFromAxisAngle(_Z, -inp.hipsRoll))
    _qRoot.setFromAxisAngle(_Y, this.yaw)
    const G = _qG.copy(_qRoot).multiply(_q).multiply(_q2.copy(_qRoot).invert())
    const l1 = this.body.legs.left.l1
    const l2 = this.body.legs.left.l2
    // the straightest a standing knee may be
    const minKnee = (5 + 6 * Math.min(1, this.walkAmt + c)) * D2R
    const maxD = Math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(minKnee))
    let drop = 0
    for (const s of SIDES) {
      const leg = this.body.legs[s]
      leg.upper.updateWorldMatrix(false, false)
      const root = leg.upper.getWorldPosition(_v2).sub(H).applyQuaternion(G).add(H).add(offset)
      this.hipRoot[s].copy(root)
      const f = this.feet[s]
      const reach = (a: THREE.Vector3, rx: number, rz: number, ry: number): number => {
        const r2 = (a.x - rx) ** 2 + (a.z - rz) ** 2
        return r2 >= maxD * maxD ? ry - a.y : ry - a.y - Math.sqrt(maxD * maxD - r2)
      }
      if (f.swing) {
        // a swinging foot counts as it reaches out for its heel strike — and
        // ahead of that, where it will land and where her hips will be by
        // then — so they are already down when it lands instead of dropping
        // onto it
        const sp = clamp((f.phase - STANCE) / (1 - STANCE), 0, 1)
        const wNow = smooth((sp - 0.55) / 0.45)
        if (wNow > 0) drop = Math.max(drop, reach(f.pos, root.x, root.z, root.y) * wNow)
        const wAhead = smooth((sp - 0.2) / 0.8)
        if (wAhead > 0) {
          const tLeft = (1 - sp) * (1 - STANCE) * (2 / this.cadence)
          drop = Math.max(drop, reach(f.swing.to, root.x + this.vel.x * tLeft, root.z + this.vel.z * tLeft, root.y) * wAhead)
        }
        continue
      }
      drop = Math.max(drop, reach(f.pos, root.x, root.z, root.y))
    }
    // (the swinging leg folds from where the hips will actually be)
    for (const s of SIDES) this.hipRoot[s].y -= drop
    return Math.max(0, drop)
  }
}
