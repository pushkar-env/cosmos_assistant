import * as THREE from 'three'
import { animate } from 'framer-motion'
import type { AvatarRig } from '../avatarAsset'
import type { Reading } from '../emotion'
import { shared } from '../toonMaterials'
import { SIDES, bodyInput, sideSign, type ArmGoal, type BodyInput, type BodyRig, type Contact, type Side } from './body'
import { angleDiff, bezier, clamp, slerpFrame, smooth, smoother } from './ik'
import { useStageStore } from './bridge'
import { CROUCH_DEPTH, Locomotion } from './locomotion'
import {
  GLASS_Z,
  cardState,
  layoutCenter,
  pxPerMetre,
  screenToGlass,
  setHeld,
  springTo,
  stopCard,
  touchRipple,
  view,
  widgets,
  worldToScreen,
  type CardHome,
  type StageWidget
} from './widgets'

/*
 * The actor: her body as something a script can direct — "walk over there",
 * "crouch", "put your right palm on that card", "carry it here", "let go".
 * Each command is a promise that settles when it's done (or rejects when the
 * script is interrupted), so routines read like stage directions.
 *
 * Every frame it advances its tweens and her walk, then writes the body
 * input (feet, hips, spine, hands) that BodyRig layers onto the clip pose.
 * While she isn't acting it does nothing at all — the clips own her.
 */

export class Aborted extends Error {
  constructor() {
    super('interrupted')
    this.name = 'AbortError'
  }
}

export const isAborted = (e: unknown): boolean => e instanceof Aborted || (e as Error)?.name === 'AbortError'

/** what the controller needs from the actor */
export interface ControllerLink {
  feel(r: Reading): void
  resetSprings(): void
  /** where she's looking: a world point, and how much (0..1) */
  look: { target: THREE.Vector3; weight: number } | null
  /** true while she's acting (the clips' ambient gestures stand down) */
  acting: boolean
  /** 0..1: how freely her cloth may swing past its resting limits */
  clothFree: number
}

export interface HandShape {
  /** thumb, index, middle, ring, little (degrees) */
  curl: number[]
  spread?: number
  thumbOut?: number
  /** the thumb's flexion joint by joint (base, middle, tip — degrees), in
   *  place of curl[0] spread over them */
  thumb?: number[]
}

/** a shape's thumb flexion, joint by joint */
const thumbOf = (s: HandShape): number[] => s.thumb ?? [s.curl[0] * 0.5, s.curl[0], s.curl[0]]

/** hand shapes for the things she does */
export const SHAPES = {
  relaxed: { curl: [12, 14, 16, 18, 20], spread: 2, thumbOut: 0 },
  point: { curl: [40, 0, 82, 88, 92], spread: 0, thumbOut: -6 },
  /** a finger snap: thumb pressed to the middle fingertip… then the middle
   *  finger cracks down into the palm and the thumb flies out */
  snapReady: { curl: [40, 44, 56, 86, 90], spread: 0, thumbOut: -16 },
  snapped: { curl: [2, 48, 98, 90, 94], spread: 0, thumbOut: 18 },
  thumbsUp: { curl: [-10, 90, 94, 94, 94], spread: 0, thumbOut: 22 },
  /** a card pinched by its edge from behind: fingers straight up its back,
   *  the thumb's base swung round in front of the palm so the thumb lies
   *  along its face (PINCH_DEPTH: the card runs between them) */
  pinch: { curl: [0, 5, 6, 7, 8], spread: 2, thumbOut: -18, thumb: [45, -42, -20] },
  /** about to pinch: fingers up, the thumb out and down, below the edge */
  pinchOpen: { curl: [0, 7, 8, 9, 10], spread: 2.5, thumbOut: 24, thumb: [18, -8, -6] },
  /** a free hand as she walks: loosely curled, thumb in */
  walk: { curl: [16, 28, 34, 40, 46], spread: 1, thumbOut: -6 }
} satisfies Record<string, HandShape>

export interface HandTarget {
  /** the contact point's target (world) — re-read every frame */
  at: THREE.Vector3 | (() => THREE.Vector3)
  /** the hand's frame (world): fingers point along dir, the palm faces palm */
  dir: THREE.Vector3
  palm: THREE.Vector3
  contact?: Contact
  /** the elbow points this way (world); default down and out */
  pole?: THREE.Vector3
  shape?: HandShape
}

interface ArmSeg {
  fromPos: THREE.Vector3
  fromDir: THREE.Vector3
  fromPalm: THREE.Vector3
  fromPole: THREE.Vector3
  fromW: number
  fromFw: number
  to: HandTarget
  toW: number
  /** finger pose weight at the end (0 = the clip's own fingers) */
  toFw: number
  /** Bézier control-point offset from the straight line (world) */
  arc: THREE.Vector3
  u: number
  /** the target is the hand's resting place (clip or hip) */
  rest: boolean
  /** the resting hand off its hip, hanging free while she's up and about */
  free?: boolean
}

interface ArmState {
  side: Side
  seg: ArmSeg | null
  /** finger shape tween */
  shapeFrom: HandShape
  shapeTo: HandShape
  su: number
  fw: number
  /** the resting hand's place on her hip, in hips space */
  anchor: { hand: THREE.Matrix4; elbow: THREE.Vector3 } | null
  /** the resting hand is on (or about to leave) her hip */
  onHip: boolean
  /** bumped by every move of this arm: a move in several steps checks it
   *  between them, and gives way to whatever started since */
  claim: number
}

interface Hold {
  w: StageWidget
  sides: Side[]
  /** card centre relative to the hand(s) on screen at grab (px, at grab scale) */
  grip: { x: number; y: number }
  layout: { x: number; y: number }
  scale0: number
  dist0: number
  /** two hands squeeze/stretch it */
  scaling: boolean
  rot0: number
  ang0: number
  /** the card's plane (world z): where her hands hold it */
  plane: number
}

interface Flight {
  w: StageWidget
  from: { x: number; y: number }
  to: () => { x: number; y: number }
  layout: { x: number; y: number }
  t: number
  dur: number
  height: number
  spin: number
  rot0: number
  /** its plane in flight (world z) */
  plane: number
  done: () => void
}

interface Tween {
  t: number
  dur: number
  step?: (u: number) => void
  resolve: () => void
  reject: (e: unknown) => void
  signal?: AbortSignal
  off?: () => void
}

/** visual effects the scene provides */
export interface StageFx {
  footstep(at: THREE.Vector3, hard: number): void
  /** dissolve her out (true) or in (false); resolves when done */
  dissolve(out: boolean, dur: number): Promise<void>
}

/** how far in front of the pinch point (the web of the thumb) the plane of a
 *  card she pinches runs: her fingers ~1 cm behind it, the thumb in front */
export const PINCH_DEPTH = 0.014

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _Y = new THREE.Vector3(0, 1, 0)
const _hF = new THREE.Vector3()
const _hL = new THREE.Vector3()
const _kA = new THREE.Vector3()
const _kB = new THREE.Vector3()
const _kC = new THREE.Vector3()
const _kD = new THREE.Vector3()
const _kE = new THREE.Vector3()
const _kF = new THREE.Vector3()
const _kG = new THREE.Vector3()

export class Actor {
  readonly loco: Locomotion
  readonly inp: BodyInput = bodyInput()
  /** acting: the body layer is live (she's walking, reaching…) */
  active = false
  /** where she lives: the floor pad at the centre */
  readonly home = new THREE.Vector3(0, 0, 0)
  fx: StageFx | null = null

  private readonly arms: Record<Side, ArmState>
  private readonly tweens = new Set<Tween>()
  private readonly holds: Hold[] = []
  private readonly flights: Flight[] = []
  private readonly homes = new Map<StageWidget, CardHome>()
  /** cards on their way home after a tidy (still in front of her until they land) */
  private readonly returning = new Map<StageWidget, CardHome>()
  /** each touched card's layout centre (its slot with no offset), CSS px */
  private readonly layouts = new Map<StageWidget, { x: number; y: number }>()
  /** the plane (world z) of each card in the air between her hands — tossed
   *  and not yet caught, or let go of for a moment */
  private readonly planes = new Map<StageWidget, number>()
  private lookTarget: THREE.Vector3 | (() => THREE.Vector3) | null = null
  private readonly look = { target: new THREE.Vector3(), weight: 0 }
  private lookW = 0
  private lookWGoal = 0
  private shoulderLift: Record<Side, number> = { left: 0, right: 0 }
  private lean = 0
  private leanGoal = 0
  /** her chest's turn toward what her hands are reaching for (rad) */
  private reachTwist = 0
  private time = 0
  private readonly rootQ = new THREE.Quaternion()
  private readonly restingSide: Side | null
  /** her deepest crouch (0..1) */
  private readonly crouchMax: number

  constructor(
    private readonly rig: AvatarRig,
    readonly body: BodyRig,
    private readonly ctrl: ControllerLink
  ) {
    this.loco = new Locomotion(body)
    this.loco.onStep = (_s, at, hard) => this.fx?.footstep(at, hard)
    this.loco.kneeOut = rig.config.stage?.kneeOut ?? 0.35
    this.crouchMax = rig.config.stage?.crouchMax ?? 1
    this.restingSide = rig.config.restingHand ?? null
    const arm = (side: Side): ArmState => ({
      side,
      seg: null,
      shapeFrom: SHAPES.relaxed,
      shapeTo: SHAPES.relaxed,
      su: 1,
      fw: 0,
      anchor: null,
      onHip: false,
      claim: 0
    })
    this.arms = { left: arm('left'), right: arm('right') }
    this.inp.beforeArms = () => this.evalArms()
  }

  // ── time & cancellation ────────────────────────────────────────────────

  /** run `step(u)` over `dur` seconds of her time (u: 0 → 1). Rejects with
   *  Aborted if the signal fires or she's reset — whoever awaits it hears
   *  that; nobody needs to (finger shaping alongside a reach isn't awaited) */
  tween(dur: number, step: ((u: number) => void) | undefined, signal?: AbortSignal): Promise<void> {
    return quiet(this.startTween(dur, step, signal))
  }

  private startTween(dur: number, step: ((u: number) => void) | undefined, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Aborted())
    return new Promise<void>((resolve, reject) => {
      const tw: Tween = { t: 0, dur: Math.max(0, dur), step, resolve, reject, signal }
      if (signal) {
        const onAbort = (): void => {
          this.tweens.delete(tw)
          reject(new Aborted())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        tw.off = () => signal.removeEventListener('abort', onAbort)
      }
      this.tweens.add(tw)
    })
  }

  wait(sec: number, signal?: AbortSignal): Promise<void> {
    return this.tween(sec, undefined, signal)
  }

  /** resolve once `cond()` holds (checked every frame), or after `timeout` s */
  until(cond: () => boolean, signal?: AbortSignal, timeout = 8): Promise<void> {
    if (signal?.aborted) return quiet(Promise.reject(new Aborted()))
    return quiet(new Promise<void>((resolve, reject) => {
      const tw: Tween = {
        t: 0,
        dur: timeout,
        step: () => {
          if (cond()) {
            this.tweens.delete(tw)
            tw.off?.()
            resolve()
          }
        },
        resolve,
        reject,
        signal
      }
      if (signal) {
        const onAbort = (): void => {
          this.tweens.delete(tw)
          reject(new Aborted())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        tw.off = () => signal.removeEventListener('abort', onAbort)
      }
      this.tweens.add(tw)
    }))
  }

  // ── acting on / off ────────────────────────────────────────────────────

  /** the body layer takes over from the clips (seamlessly: it starts from
   *  exactly where the clip has her) */
  begin(): void {
    if (this.active) return
    this.active = true
    this.ctrl.acting = true
    const root = this.rig.root
    root.updateWorldMatrix(true, true)
    this.loco.begin(root.position, root.rotation.y)
    this.loco.legWeight = 0
    void this.tween(0.25, (u) => (this.loco.legWeight = Math.max(this.loco.legWeight, smooth(u))))
    // the resting hand: remember its place on her hip, and hold it there
    if (this.restingSide) {
      const a = this.arms[this.restingSide]
      const hips = this.body.hips
      const arm = this.body.arms[this.restingSide]
      _m.copy(hips.matrixWorld).invert()
      a.anchor = {
        hand: _m.clone().multiply(arm.end.matrixWorld),
        elbow: arm.lower.getWorldPosition(new THREE.Vector3()).applyMatrix4(_m)
      }
      // (the anchor IS where the clip has the hand: only the weight ramps)
      a.onHip = true
      const seg = (a.seg = this.restSeg(a, 0, 0, 0))
      void this.tween(0.25, (u) => {
        seg.fromW = seg.toW = smooth(u)
      })
      // ...then it comes off her hip and hangs free while she's up and about
      // (a hand left on her hip through a walk or a game looks pinned there);
      // it goes back once she's home (handsHome)
      const claim = ++a.claim
      void this.wait(0.25)
        .then(() => (a.claim === claim ? this.hangFree(a, claim) : undefined))
        .catch(() => {})
    }
    this.inp.shoulderLift.left = this.inp.shoulderLift.right = 0
  }

  /** hand her back to the clips (call at home, standing still) */
  async end(signal?: AbortSignal): Promise<void> {
    if (!this.active) return
    // her hand goes back on her hip before the clips take her back
    await this.handsHome(signal)
    const legs0 = this.loco.legWeight
    const fade = this.restingSide ? this.arms[this.restingSide] : null
    const yaw0 = this.loco.yaw
    await this.tween(
      0.35,
      (u) => {
        const k = 1 - smooth(u)
        this.loco.legWeight = legs0 * k
        if (fade?.seg?.rest) fade.seg.fromW = fade.seg.toW = k
        // (settle the last fraction of a degree of heading too)
        this.loco.yaw = yaw0 * k
      },
      signal
    )
    this.reset()
    this.rig.root.rotation.set(0, 0, 0)
    this.rig.root.position.copy(this.home)
  }

  /** drop everything — back to the clips at once */
  reset(): void {
    for (const tw of this.tweens) {
      tw.off?.()
      tw.reject(new Aborted())
    }
    this.tweens.clear()
    this.active = false
    this.ctrl.acting = false
    this.ctrl.look = null
    this.lookTarget = null
    this.lookW = this.lookWGoal = 0
    this.loco.legWeight = 0
    this.loco.crouch = 0
    this.loco.crouchStance = 0
    this.loco.widen = 0
    this.loco.goal = null
    this.lean = this.leanGoal = 0
    this.reachTwist = 0
    for (const s of SIDES) {
      const a = this.arms[s]
      a.seg = null
      a.fw = 0
      a.anchor = null
      a.onHip = false
      a.claim++
      this.shoulderLift[s] = 0
      this.inp.arms[s].weight = 0
      this.inp.fingers[s].weight = 0
    }
  }

  // ── per frame ──────────────────────────────────────────────────────────

  /** advance tweens and her walk; place her root (before the mixer runs) */
  preUpdate(dt: number): void {
    this.time += dt
    for (const tw of [...this.tweens]) {
      if (!this.tweens.has(tw)) continue
      tw.t += dt
      const u = tw.dur > 0 ? Math.min(1, tw.t / tw.dur) : 1
      tw.step?.(u)
      if (u >= 1 && this.tweens.has(tw)) {
        this.tweens.delete(tw)
        tw.off?.()
        tw.resolve()
      }
    }
    if (!this.active) {
      this.ctrl.clothFree = 0
      return
    }
    this.loco.update(dt)
    // her legs push the cloth aside as she strides or crouches
    const free = Math.min(1, this.loco.walking * 1.5 + this.loco.crouch + (this.loco.stepping ? 0.4 : 0))
    this.ctrl.clothFree += (free - this.ctrl.clothFree) * Math.min(1, dt * (free > this.ctrl.clothFree ? 8 : 1.5))
    const root = this.rig.root
    root.position.set(this.loco.pos.x, 0, this.loco.pos.z)
    root.rotation.set(0, this.loco.yaw, 0)
    root.updateMatrix()
  }

  /** write the body input and pose her (after the mixer and finger life) */
  pose(dt: number): void {
    if (!this.active) return
    const inp = this.inp
    this.loco.pose(inp, dt)
    this.lean += (this.leanGoal - this.lean) * Math.min(1, dt * 4)
    inp.spineBend += this.lean
    // her chest turns a little toward what her hands reach for — across her
    // most of all (last frame's goals: they're set once her body is posed)
    let twist = 0
    for (const s of SIDES) {
      const a = this.arms[s]
      const g = inp.arms[s]
      if (!a.seg || a.seg.rest || g.weight < 0.01) continue
      _v.copy(g.target).sub(_v2.set(this.loco.pos.x, g.target.y, this.loco.pos.z)).applyAxisAngle(_Y, -this.loco.yaw)
      twist += g.weight * Math.atan2(_v.x, Math.max(0.12, _v.z))
    }
    twist = clamp(twist * 0.3, -0.26, 0.26)
    // ...and a touch toward what she's watching (here, not after her hands
    // are placed — see AvatarController.chestFollow)
    if (this.lookTarget && this.lookW > 0.01) {
      const t = typeof this.lookTarget === 'function' ? this.lookTarget() : this.lookTarget
      _v.copy(t).sub(_v2.set(this.loco.pos.x, t.y, this.loco.pos.z)).applyAxisAngle(_Y, -this.loco.yaw)
      twist += clamp(Math.atan2(_v.x, Math.max(0.12, _v.z)) * 0.1, -0.1, 0.1) * this.lookW
    }
    this.reachTwist += (twist - this.reachTwist) * Math.min(1, dt * 3)
    inp.spineTwist += this.reachTwist
    for (const s of SIDES) {
      const goal = this.shoulderLift[s]
      inp.shoulderLift[s] += (goal - inp.shoulderLift[s]) * Math.min(1, dt * 6)
      // fingers
      const a = this.arms[s]
      const f = inp.fingers[s]
      const k = smooth(a.su)
      for (let i = 0; i < 5; i++) f.curl[i] = a.shapeFrom.curl[i] + (a.shapeTo.curl[i] - a.shapeFrom.curl[i]) * k
      f.spread = (a.shapeFrom.spread ?? 0) + ((a.shapeTo.spread ?? 0) - (a.shapeFrom.spread ?? 0)) * k
      f.thumbOut = (a.shapeFrom.thumbOut ?? 0) + ((a.shapeTo.thumbOut ?? 0) - (a.shapeFrom.thumbOut ?? 0)) * k
      const t0 = thumbOf(a.shapeFrom)
      const t1 = thumbOf(a.shapeTo)
      for (let i = 0; i < 3; i++) f.thumb[i] = t0[i] + (t1[i] - t0[i]) * k
      f.weight = a.fw
      // a free hand relaxes into a loose curl while she walks
      const free = a.seg ? !!a.seg.free : !a.anchor
      const ww = free ? smooth(this.loco.walking) : 0
      if (ww > 0.01) {
        const wk = SHAPES.walk
        for (let i = 0; i < 5; i++) f.curl[i] += (wk.curl[i] - f.curl[i]) * ww
        f.spread += (wk.spread - f.spread) * ww
        f.thumbOut += (wk.thumbOut - f.thumbOut) * ww
        const wt = thumbOf(wk)
        for (let i = 0; i < 3; i++) f.thumb[i] += (wt[i] - f.thumb[i]) * ww
        f.weight = Math.max(a.fw, ww)
      }
    }
    // the look
    this.lookW += (this.lookWGoal - this.lookW) * Math.min(1, dt * 5)
    if (this.lookTarget && this.lookW > 0.01) {
      const t = typeof this.lookTarget === 'function' ? this.lookTarget() : this.lookTarget
      this.look.target.copy(t)
      this.look.weight = this.lookW
      this.ctrl.look = this.look
    } else this.ctrl.look = null
    this.rootQ.setFromAxisAngle(_Y, this.loco.yaw)
    this.body.apply(inp, this.rootQ, dt)
  }

  /** after the frame is posed: cards follow the hands holding them (and the
   *  cut-outs follow the cards, this same frame) */
  postUpdate(dt: number): void {
    for (const h of this.holds) this.syncHold(h)
    for (const f of [...this.flights]) {
      f.t += dt
      const u = clamp(f.t / f.dur, 0, 1)
      const to = f.to()
      const x = f.from.x + (to.x - f.from.x) * u
      const y = f.from.y + (to.y - f.from.y) * u - f.height * 4 * u * (1 - u)
      const m = f.w.motion!
      m.x.set(x - f.layout.x)
      m.y.set(y - f.layout.y)
      m.rotate.set(f.rot0 + f.spin * smoother(u))
      if (u >= 1) {
        this.flights.splice(this.flights.indexOf(f), 1)
        this.planes.set(f.w, f.plane)
        f.done()
      }
    }
    this.updateCuts()
  }

  // ── arms ───────────────────────────────────────────────────────────────

  private restSeg(a: ArmState, fromW: number, toW: number, fw: number): ArmSeg {
    const s = a.side
    return {
      fromPos: new THREE.Vector3(),
      fromDir: new THREE.Vector3(),
      fromPalm: new THREE.Vector3(),
      fromPole: new THREE.Vector3(0, -1, -0.3),
      fromW,
      fromFw: fw,
      to: a.anchor ? this.anchorTarget(a) : this.clipTarget(s),
      toW,
      toFw: 0,
      arc: new THREE.Vector3(),
      u: 1,
      rest: true
    }
  }

  /** the resting hand's place on her hip, as her hips are this frame */
  private anchorTarget(a: ArmState): HandTarget {
    const hand = this.body.hands[a.side]
    const at = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const palm = new THREE.Vector3()
    const pole = new THREE.Vector3()
    const t: HandTarget = {
      at: () => {
        const anc = a.anchor!
        _m.multiplyMatrices(this.body.hips.matrixWorld, anc.hand)
        _m.decompose(at, _q, _v3)
        dir.copy(hand.fingerDir).applyQuaternion(_q)
        palm.copy(hand.palm).applyQuaternion(_q)
        const elbow = _v.copy(anc.elbow).applyMatrix4(this.body.hips.matrixWorld)
        const sh = this.body.animated[a.side].shoulder
        pole.copy(elbow).sub(_v2.copy(sh).add(at).multiplyScalar(0.5)).normalize()
        // crouching, the thigh rises under a hand on the hip: it moves down
        // onto the knee instead
        const k = smooth((this.loco.crouch - 0.12) / 0.45)
        if (k > 0) this.kneeRest(a.side, at, dir, palm, pole, k)
        return at
      },
      dir,
      palm,
      contact: 'wrist',
      pole
    }
    return t
  }

  /** blend a wrist target (`at`, frame `dir`/`palm`, elbow `pole`) toward
   *  the hand laid on top of `side`'s thigh just short of the knee, palm
   *  down, fingers over the kneecap — by k */
  private kneeRest(side: Side, at: THREE.Vector3, dir: THREE.Vector3, palm: THREE.Vector3, pole: THREE.Vector3, k: number): void {
    const leg = this.body.legs[side]
    const hip = leg.upper.getWorldPosition(_kA)
    const knee = leg.lower.getWorldPosition(_kB)
    const along = _kC.subVectors(knee, hip).normalize()
    const sg = sideSign(side)
    const left = _kD.set(Math.cos(this.loco.yaw), 0, -Math.sin(this.loco.yaw))
    // the top of the thigh (the leg is ~6 cm thick there), a hand's length
    // back from the knee, a touch to the outside
    const pad = _kE.copy(knee).addScaledVector(along, -0.085).addScaledVector(_Y, 0.065).addScaledVector(left, sg * 0.012)
    // fingers run along the thigh and over the knee, palm down on it
    const fdir = _kF.copy(along).addScaledVector(_Y, -0.35).normalize()
    const pdown = _kG.set(0, -1, 0).addScaledVector(left, sg * 0.25).normalize()
    // (the wrist sits a palm's length back from the pad, a palm's thickness up)
    const wrist = pad.addScaledVector(fdir, -0.075).addScaledVector(pdown, -0.014)
    at.lerp(wrist, k)
    slerpFrame(dir, palm, fdir, pdown, k)
    pole.lerp(_kA.copy(left).multiplyScalar(sg).addScaledVector(_Y, -0.3).normalize(), k).normalize()
  }

  /** the free hand where the clip has it */
  private clipTarget(s: Side): HandTarget {
    const at = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const palm = new THREE.Vector3()
    const pole = new THREE.Vector3()
    return {
      at: () => {
        const a = this.body.animated[s]
        at.copy(a.hand)
        this.body.animatedFrame(s, dir, palm)
        pole.copy(a.elbow).sub(_v.copy(a.shoulder).add(a.hand).multiplyScalar(0.5)).normalize()
        return at
      },
      dir,
      palm,
      contact: 'wrist',
      pole
    }
  }

  /** inside body.apply: the arm goals, now that her hips are where they are */
  private evalArms(): void {
    for (const s of SIDES) {
      const a = this.arms[s]
      const g = this.inp.arms[s]
      const seg = a.seg
      if (!seg) {
        this.walkArm(s, g)
        a.fw = Math.max(0, a.fw - 0.1)
        continue
      }
      const to = typeof seg.to.at === 'function' ? seg.to.at() : seg.to.at
      const u = seg.u
      const e = smoother(u)
      // a gentle arc: the control point is the midpoint pushed by `arc`
      _v.copy(seg.fromPos).lerp(to, 0.5).add(seg.arc)
      bezier(seg.fromPos, _v, to, e, g.target)
      g.fingerDir.copy(seg.fromDir)
      g.palm.copy(seg.fromPalm)
      slerpFrame(g.fingerDir, g.palm, seg.to.dir, seg.to.palm, e)
      g.pole.copy(seg.fromPole).lerp(seg.to.pole ?? defaultPole(s, this.loco.yaw), e).normalize()
      g.contact = seg.to.contact ?? 'palm'
      // weight: into IK early in the move, out of it late (the target is
      // then the clip's own hand, so the hand-over is seamless)
      const wk = seg.toW >= seg.fromW ? smooth(u / 0.4) : smooth((u - 0.55) / 0.45)
      g.weight = seg.fromW + (seg.toW - seg.fromW) * wk
      const fk = seg.toFw >= seg.fromFw ? smooth(u / 0.35) : smooth((u - 0.5) / 0.5)
      a.fw = seg.fromFw + (seg.toFw - seg.fromFw) * fk
      if (seg.rest && seg.toW <= 0 && u >= 1) a.seg = null
    }
  }

  /** a free arm's hang (world): out at her side as wide as her clip's
   *  hanging hand (~14 cm: the haori hangs wide, and a hand any closer swung
   *  through it), a touch forward, swinging opposite its leg as she walks and
   *  swaying faintly as she stands; fingers down, the palm in toward her
   *  thigh, the elbow back and a little out */
  private hangPose(s: Side, target: THREE.Vector3, dir: THREE.Vector3, palm: THREE.Vector3, pole: THREE.Vector3): void {
    const sg = sideSign(s)
    const yaw = this.loco.yaw
    const fwd = _hF.set(Math.sin(yaw), 0, Math.cos(yaw))
    const left = _hL.set(Math.cos(yaw), 0, -Math.sin(yaw))
    const sh = this.body.animated[s].shoulder
    const w = this.loco.walking
    const ang = this.loco.armSwing(s) * 1.15 + (1 - w) * 0.022 * Math.sin(this.time * 1.4 + sg)
    const len = this.body.armLength * 0.93
    target
      .copy(sh)
      .addScaledVector(_Y, -len * Math.cos(ang))
      .addScaledVector(fwd, len * Math.sin(ang) + 0.05)
      .addScaledVector(left, sg * 0.14)
    // walking along the HUD side on, the near hand swings toward you: it
    // stays behind the glass (in front of it, it would be painted over a card)
    target.z = Math.min(target.z, GLASS_Z - 0.07)
    dir.set(0, -1, 0).addScaledVector(fwd, Math.sin(ang * 1.4) + 0.06).normalize()
    palm.copy(left).multiplyScalar(-sg).addScaledVector(fwd, -0.25).normalize()
    pole.copy(fwd).multiplyScalar(-1).addScaledVector(left, sg * 0.45).addScaledVector(_Y, -0.2).normalize()
  }

  /** the free hang as a target (the resting hand off its hip) - crouching,
   *  the hand rests on her knee instead (hanging, it would sink into her
   *  thigh) */
  private hangTarget(a: ArmState): HandTarget {
    const at = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const palm = new THREE.Vector3()
    const pole = new THREE.Vector3()
    return {
      at: () => {
        this.hangPose(a.side, at, dir, palm, pole)
        const k = smooth((this.loco.crouch - 0.12) / 0.45)
        if (k > 0) this.kneeRest(a.side, at, dir, palm, pole, k)
        return at
      },
      dir,
      palm,
      contact: 'wrist',
      pole
    }
  }

  /** a segment to the free hang, held there (it swings with her stride) */
  private freeSeg(a: ArmState): ArmSeg {
    const seg = this.blankSeg(this.hangTarget(a))
    seg.rest = true
    seg.free = true
    return seg
  }

  /** a free arm with nothing to do while she walks (the clip's arm, which
   *  hangs by her side, while she stands). By IK: swinging the clip's arm by
   *  FK carried its open hand out in front of her like an offering. */
  private walkArm(s: Side, g: ArmGoal): void {
    const w = this.loco.walking
    if (w < 0.01) {
      g.weight = 0
      return
    }
    this.hangPose(s, g.target, g.fingerDir, g.palm, g.pole)
    g.contact = 'wrist'
    g.weight = smooth(w) * 0.9
  }

  /** the resting hand comes off her hip (straight off it first) and hangs free */
  private async hangFree(a: ArmState, claim: number, signal?: AbortSignal): Promise<void> {
    if (a.onHip) {
      await this.liftOff(a, signal)
      if (a.claim !== claim) return
    }
    const seg = this.freeSeg(a)
    this.startFrom(a, seg, 'wrist')
    a.seg = seg
    void this.setShape(a.side, SHAPES.relaxed, 0.35)
    await this.tween(0.55, (u) => (seg.u = u), signal)
  }

  /** the resting hand back on her hip, now she's home: to just off it, then
   *  onto it (it rests ON the coat pressed under it - gliding straight there
   *  would sweep through the cloth) */
  async handsHome(signal?: AbortSignal, dur = 0.6): Promise<void> {
    const s = this.restingSide
    if (!s) return
    const a = this.arms[s]
    if (!a.anchor) return
    if (a.onHip) {
      // still on her hip (a scene that ended at once): it stays — and a lift
      // off still pending from begin() is called off
      a.claim++
      return
    }
    const claim = ++a.claim
    const t = this.anchorTarget(a)
    const lift = new THREE.Vector3()
    const near: HandTarget = {
      at: () => {
        const at = t.at instanceof Function ? t.at() : t.at
        return lift.copy(at).addScaledVector(t.palm, -0.085)
      },
      dir: t.dir,
      palm: t.palm,
      contact: 'wrist',
      pole: t.pole
    }
    const seg1: ArmSeg = { ...this.blankSeg(near), toFw: 0 }
    this.startFrom(a, seg1, 'wrist')
    a.seg = seg1
    void this.setShape(s, SHAPES.relaxed, dur * 0.7)
    await this.tween(dur * 0.78, (u) => (seg1.u = u), signal)
    if (a.claim !== claim) return
    const seg2 = this.restSeg(a, 1, 1, 0)
    seg2.u = 0
    this.startFrom(a, seg2, 'wrist')
    a.seg = seg2
    a.onHip = true
    await this.tween(dur * 0.22 + 0.06, (u) => (seg2.u = u), signal)
  }

  /** where a hand is right now, as a segment start */
  private startFrom(a: ArmState, seg: ArmSeg, contact: Contact): void {
    const s = a.side
    const g = this.inp.arms[s]
    if (g.weight > 0.001) {
      // where the IK actually put it (contact point for the new contact type)
      this.body.contactPoint(s, contact, seg.fromPos)
      this.body.handFrame(s, seg.fromDir, seg.fromPalm)
      seg.fromPole.copy(g.pole)
    } else {
      this.body.animatedContact(s, contact, seg.fromPos)
      this.body.animatedFrame(s, seg.fromDir, seg.fromPalm)
      const an = this.body.animated[s]
      seg.fromPole.copy(an.elbow).sub(_v.copy(an.shoulder).add(an.hand).multiplyScalar(0.5)).normalize()
    }
    seg.fromW = g.weight
    seg.fromFw = a.fw
  }

  /** move a hand to a target over `dur` s (rejects if interrupted) */
  async reach(side: Side, to: HandTarget, dur: number, signal?: AbortSignal, arc?: THREE.Vector3): Promise<void> {
    const a = this.arms[side]
    const claim = ++a.claim
    // a hand resting on her hip first lifts straight off it (sliding away
    // would drag it through the coat pressed under it)
    if (a.onHip) {
      await this.liftOff(a, signal)
      if (a.claim !== claim) return
    }
    const seg: ArmSeg = {
      fromPos: new THREE.Vector3(),
      fromDir: new THREE.Vector3(),
      fromPalm: new THREE.Vector3(),
      fromPole: new THREE.Vector3(),
      fromW: 0,
      fromFw: 0,
      to,
      toW: 1,
      toFw: 1,
      arc: arc ?? new THREE.Vector3(),
      u: 0,
      rest: false
    }
    this.startFrom(a, seg, to.contact ?? 'palm')
    a.seg = seg
    if (to.shape) this.setShape(side, to.shape, dur * 0.8)
    await this.tween(dur, (u) => (seg.u = u), signal)
  }

  private async liftOff(a: ArmState, signal?: AbortSignal): Promise<void> {
    a.onHip = false
    const t = this.anchorTarget(a)
    const at = typeof t.at === 'function' ? t.at() : t.at
    // straight out from the palm (it faces into her hip)
    const lift = at.clone().addScaledVector(t.palm, -0.085)
    const seg: ArmSeg = {
      fromPos: new THREE.Vector3(),
      fromDir: new THREE.Vector3(),
      fromPalm: new THREE.Vector3(),
      fromPole: new THREE.Vector3(),
      fromW: 0,
      fromFw: 0,
      to: { at: () => lift.copy(t.at instanceof Function ? t.at() : t.at).addScaledVector(t.palm, -0.085), dir: t.dir, palm: t.palm, contact: 'wrist', pole: t.pole },
      toW: 1,
      toFw: 0,
      arc: new THREE.Vector3(),
      u: 0,
      rest: false
    }
    this.startFrom(a, seg, 'wrist')
    a.seg = seg
    await this.tween(0.22, (u) => (seg.u = u), signal)
  }

  /** bring a hand to rest: the resting hand hangs free while she's up and
   *  about (back on her hip only once she's home - handsHome); the other
   *  goes back to wherever the clip has it */
  async rest(side: Side, dur: number, signal?: AbortSignal): Promise<void> {
    const a = this.arms[side]
    if (a.anchor) {
      if (a.seg?.free) return
      const claim = ++a.claim
      if (a.onHip) {
        await this.liftOff(a, signal)
        if (a.claim !== claim) return
      }
      const seg = this.freeSeg(a)
      this.startFrom(a, seg, 'wrist')
      a.seg = seg
      void this.setShape(side, SHAPES.relaxed, dur * 0.6)
      await this.tween(dur, (u) => (seg.u = u), signal)
      return
    }
    if (!a.seg || a.seg.rest) return
    a.claim++
    const seg = this.restSeg(a, 1, 0, 0)
    seg.u = 0
    // (down and home — bulging forward, it would swing through the card it
    // just let go of)
    seg.arc.set(0, -0.05, 0)
    this.startFrom(a, seg, 'wrist')
    a.seg = seg
    void this.setShape(side, SHAPES.relaxed, dur * 0.6)
    await this.tween(dur, (u) => (seg.u = u), signal)
  }

  private blankSeg(to: HandTarget): ArmSeg {
    return {
      fromPos: new THREE.Vector3(),
      fromDir: new THREE.Vector3(),
      fromPalm: new THREE.Vector3(),
      fromPole: new THREE.Vector3(),
      fromW: 0,
      fromFw: 0,
      to,
      toW: 1,
      toFw: 1,
      arc: new THREE.Vector3(),
      u: 0,
      rest: false
    }
  }

  /** shape a hand (fingers) over `dur` s, wherever it is */
  setShape(side: Side, shape: HandShape, dur: number, signal?: AbortSignal): Promise<void> {
    const a = this.arms[side]
    const f = this.inp.fingers[side]
    a.shapeFrom = { curl: [...f.curl], spread: f.spread, thumbOut: f.thumbOut, thumb: [...f.thumb] }
    a.shapeTo = shape
    a.su = 0
    return this.tween(dur, (u) => (a.su = u), signal)
  }

  shrug(side: Side, rad: number): void {
    this.shoulderLift[side] = rad
  }

  bend(rad: number): void {
    this.leanGoal = rad
  }

  /** her clock (s): it runs at the stage's rate */
  get now(): number {
    return this.time
  }

  /** where a hand's contact point is now */
  handPoint(side: Side, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.body.reached[side])
  }

  // ── looking ────────────────────────────────────────────────────────────

  lookAt(target: THREE.Vector3 | (() => THREE.Vector3) | null, weight = 1): void {
    if (target) this.lookTarget = target
    this.lookWGoal = target ? weight : 0
  }

  /** a point just in front of the camera — she looks at you */
  lookAtViewer(): void {
    this.lookAt(() => _v3.set(this.loco.pos.x * 0.3, this.body.shoulderHeight + 0.12, 3), 1)
  }

  /** a height relative to her shoulders (the routines are tuned on a 1.33 m
   *  shoulder line; this keeps them on any avatar) */
  atShoulder(dy: number): number {
    return this.body.shoulderHeight + dy
  }

  // ── walking ────────────────────────────────────────────────────────────

  async walkTo(x: number, z: number, yaw: number, signal?: AbortSignal, speed = 0.72, faceTravel = 1): Promise<void> {
    this.loco.goal = { pos: new THREE.Vector3(x, 0, z), yaw, speed, faceTravel }
    const far = Math.hypot(x - this.loco.pos.x, z - this.loco.pos.z)
    await this.until(() => this.loco.settled, signal, 3 + far * 3)
  }

  async turnTo(yaw: number, signal?: AbortSignal): Promise<void> {
    await this.walkTo(this.loco.pos.x, this.loco.pos.z, yaw, signal)
  }

  /** crouch to 0..1 — as deep as she goes; past that she leans in from the
   *  hips. For anything deeper than a dip she first steps one foot back
   *  (`back`: the reaching hand's side, so its knee drops out of the arm's
   *  way) and sinks onto the ball of it, knees together; standing up, the
   *  foot steps back beside the other. */
  async crouchTo(c: number, signal?: AbortSignal, dur = 0.55, back?: Side): Promise<void> {
    this.bend(Math.max(0, c - this.crouchMax) * 0.55)
    c = clamp(c, 0, this.crouchMax)
    const c0 = this.loco.crouch
    if (Math.abs(c - c0) < 0.02) return
    if (c > c0) {
      const stance = smooth(c / 0.45)
      if (stance > this.loco.crouchStance + 0.05) {
        if (back && this.loco.crouchStance < 0.05) this.loco.backSide = back
        this.loco.crouchStance = stance
        await this.until(() => this.loco.settled, signal, 2.5)
      }
    }
    await this.tween(dur * (0.6 + Math.abs(c - c0) * 0.7), (u) => (this.loco.crouch = c0 + (c - c0) * smooth(u)), signal)
    if (c < 0.01 && this.loco.crouchStance > 0) {
      this.loco.crouchStance = 0
      await this.until(() => this.loco.settled, signal, 2.5)
    }
  }

  /** a standing spot for reaching `p` (on the glass) with `side`'s hand,
   *  its wrist `below` m under the point that lands on `p` (pinching a card's
   *  edge, the hand points up from it; a fingertip leads it — negative) */
  standFor(p: THREE.Vector3, side: Side, below = -0.12): { x: number; z: number; yaw: number; crouch: number } {
    const sg = sideSign(side)
    const reach = 0.18
    const x = p.x - sg * (this.body.shoulderX + reach)
    const z = Math.min(0.06, p.z - 0.3)
    // a quarter turn toward the reaching side
    const yaw = sg * 0.22
    // low enough that the wrist is in easy reach of the shoulder: forward to
    // the glass, out to the side, and down
    const fwd = p.z - z
    const r = this.body.armLength * 0.86
    const drop = Math.sqrt(Math.max(0.0025, r * r - reach * reach - fwd * fwd))
    const crouch = clamp((this.body.shoulderHeight - (p.y - below + drop)) / (CROUCH_DEPTH * 1.15), 0, 1)
    return { x, z, yaw, crouch }
  }

  // ── cards ──────────────────────────────────────────────────────────────

  /** remember where a card was before she touched it */
  remember(w: StageWidget): void {
    if (!this.homes.has(w)) this.homes.set(w, this.returning.get(w) ?? cardState(w))
    this.returning.delete(w)
    this.layouts.set(w, layoutCenter(w))
  }

  /** the HUD's cards are on the glass in front of her: while she's out there
   *  (her canvas over the HUD) the shaders cut away whatever of hers is
   *  behind a card, inside its rectangle (shared.uCut) — her body, and the
   *  hand holding or poking it from behind; a thumb wrapped round its edge
   *  onto its face stays in front */
  private updateCuts(): void {
    const cut = shared.uCut.value
    const shape = shared.uCutShape.value
    for (const [w, home] of this.returning) if (!displaced(w, home)) this.returning.delete(w)
    const canvas = view.ready ? view.canvas : null
    const r = canvas?.getBoundingClientRect()
    const list = useStageStore.getState().acting && canvas && r && r.width >= 1 ? widgets.cards() : []
    // the ones she's handling first (should there ever be more cards than slots)
    const busy = new Set<StageWidget>([...this.holds.map((h) => h.w), ...this.flights.map((f) => f.w), ...this.planes.keys()])
    list.sort((a, b) => (busy.has(b) ? 1 : 0) - (busy.has(a) ? 1 : 0))
    for (let i = 0; i < cut.length; i++) {
      const w = list[i]
      if (!w || !canvas || !r) {
        shape[i].z = 0
        continue
      }
      const k = canvas.width / r.width
      const m = w.motion!
      const lc = this.layouts.get(w) ?? layoutCenter(w)
      const cx = lc.x + m.x.get()
      const cy = lc.y + m.y.get()
      const s = m.scale.get()
      const sx = Math.abs(Math.cos(THREE.MathUtils.degToRad(m.rotateY.get())))
      cut[i].set((cx - r.left) * k, canvas.height - (cy - r.top) * k, (w.el.offsetWidth / 2) * s * sx * k, (w.el.offsetHeight / 2) * s * k)
      shape[i].set(-THREE.MathUtils.degToRad(m.rotate.get()), 16 * s * k, 1, this.cardPlane(w))
    }
  }

  /** a card's plane (world z): where her hands hold it, where it flies, or
   *  the glass */
  cardPlane(w: StageWidget): number {
    return this.holds.find((h) => h.w === w)?.plane ?? this.flights.find((f) => f.w === w)?.plane ?? this.planes.get(w) ?? GLASS_Z
  }

  get touchedCards(): StageWidget[] {
    return [...this.homes.keys()]
  }

  /** stop minding a card (you took it): she won't tidy it away from you */
  forget(w: StageWidget): void {
    this.release(w, false)
    this.planes.delete(w)
    this.homes.delete(w)
    this.returning.delete(w)
    setHeld(w, false)
  }

  /** a point on a card (fx, fy in 0..1 across it) on the glass */
  cardPoint(w: StageWidget, fx: number, fy: number, out = new THREE.Vector3()): THREE.Vector3 {
    const r = w.el.getBoundingClientRect()
    return screenToGlass(r.left + r.width * fx, r.top + r.height * fy, out)
  }

  /** take hold of a card with one or both hands (they must be on it) */
  grab(w: StageWidget, sides: Side[], scaling = false): void {
    this.release(w, false)
    this.remember(w)
    stopCard(w)
    const pts = sides.map((s) => worldToScreen(this.body.reached[s]))
    const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length
    const my = pts.reduce((a, p) => a + p.y, 0) / pts.length
    const r = w.el.getBoundingClientRect()
    const st = cardState(w)
    const ang = sides.length === 1 ? this.handAngle(sides[0]) : 0
    this.holds.push({
      w,
      sides,
      grip: { x: r.left + r.width / 2 - mx, y: r.top + r.height / 2 - my },
      layout: layoutCenter(w),
      scale0: st.scale,
      dist0: pts.length > 1 ? Math.max(20, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)) : 1,
      scaling,
      rot0: st.rotate,
      ang0: ang,
      plane: this.holdPlane(sides)
    })
    setHeld(w, true)
    // picked up: it lifts off the glass a little
    if (!scaling) void animate(w.motion!.scale, st.scale * 1.04, { duration: 0.16, ease: 'easeOut' })
    for (const p of pts) touchRipple(p.x, p.y, 'grab')
  }

  /** let go of a card: it stays where it is on screen, and goes back onto the
   *  glass — or, `keep`, hangs in the air where she held it (she's about to
   *  take it again) */
  release(w: StageWidget, ripple = true, keep = false): void {
    const i = this.holds.findIndex((h) => h.w === w)
    if (i < 0) return
    const h = this.holds[i]
    this.holds.splice(i, 1)
    // (let go of, it's back on the glass: nothing of her may be in front of
    // it as she moves on)
    if (keep) this.planes.set(w, h.plane)
    else this.planes.delete(w)
    setHeld(w, false)
    if (!h.scaling) void animate(w.motion!.scale, h.scale0, { duration: 0.22, ease: 'easeOut' })
    if (ripple) {
      for (const s of h.sides) {
        const p = worldToScreen(this.body.reached[s])
        touchRipple(p.x, p.y, 'release')
      }
    }
  }

  releaseAll(): void {
    for (const h of [...this.holds]) this.release(h.w, false)
    for (const f of this.flights) setHeld(f.w, false)
    this.flights.length = 0
  }

  /** toss a card: it flies along an arc to where `to()` says (px), over `dur` */
  fly(w: StageWidget, to: () => { x: number; y: number }, dur: number, height: number, spin: number): Promise<void> {
    const plane = this.holds.find((h) => h.w === w)?.plane ?? GLASS_Z
    this.release(w, false)
    const r = w.el.getBoundingClientRect()
    return new Promise<void>((done) => {
      this.flights.push({
        w,
        from: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        to,
        layout: layoutCenter(w),
        t: 0,
        dur,
        height,
        spin,
        rot0: w.motion!.rotate.get(),
        plane,
        done
      })
    })
  }

  /** every card she moved goes back where it was */
  tidy(stagger = 0.06): void {
    let i = 0
    for (const [w, home] of this.homes) {
      setHeld(w, false)
      if (w.el.isConnected) {
        springTo(w, home, i++ * stagger)
        this.returning.set(w, home)
      }
    }
    this.homes.clear()
    // (back on the glass)
    this.planes.clear()
  }

  private handAngle(s: Side): number {
    const a = worldToScreen(this.body.hands[s].bone.getWorldPosition(_v))
    const b = worldToScreen(this.body.reached[s])
    return Math.atan2(b.y - a.y, b.x - a.x)
  }

  /** the plane of a card held by these hands: just in front of the webs of
   *  their thumbs (see PINCH_DEPTH) */
  private holdPlane(sides: Side[]): number {
    let z = 0
    for (const s of sides) z += this.body.reached[s].z / sides.length
    return z + PINCH_DEPTH
  }

  private syncHold(h: Hold): void {
    h.plane = this.holdPlane(h.sides)
    const m = h.w.motion!
    const pts = h.sides.map((s) => worldToScreen(this.body.reached[s]))
    let cx = 0
    let cy = 0
    for (const p of pts) {
      cx += p.x / pts.length
      cy += p.y / pts.length
    }
    let scale = h.scale0
    if (h.scaling && pts.length > 1) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      scale = clamp((h.scale0 * d) / h.dist0, 0.4, 1.7)
    }
    const k = scale / h.scale0
    const x = cx + h.grip.x * k
    const y = cy + h.grip.y * k
    m.x.set(clamp(x, 20, innerWidth - 20) - h.layout.x)
    m.y.set(clamp(y, 40, innerHeight - 20) - h.layout.y)
    if (h.scaling) m.scale.set(scale)
    // a card held in one hand tilts with it (a little)
    if (h.sides.length === 1) {
      const da = angleDiff(h.ang0, this.handAngle(h.sides[0]))
      m.rotate.set(h.rot0 + clamp(THREE.MathUtils.radToDeg(da) * 0.55, -22, 22))
    }
  }

  // ── teleport ───────────────────────────────────────────────────────────

  /** vanish and re-form at home in her resting pose */
  async teleportHome(): Promise<void> {
    this.releaseAll()
    this.tidy(0.03)
    const fx = this.fx
    if (fx) await fx.dissolve(true, 0.42)
    this.reset()
    const root = this.rig.root
    root.position.copy(this.home)
    root.rotation.set(0, 0, 0)
    root.updateMatrix()
    root.updateWorldMatrix(false, true)
    this.ctrl.resetSprings()
    if (fx) await fx.dissolve(false, 0.55)
  }

  pxPerMetre(): number {
    return pxPerMetre(_v.set(this.loco.pos.x, 1.2, GLASS_Z))
  }
}

/** mark a promise's rejection as handled (awaiting it still throws) */
function quiet<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {})
  return p
}

function displaced(w: StageWidget, home: CardHome): boolean {
  const m = w.motion!
  return (
    Math.abs(m.x.get() - home.x) + Math.abs(m.y.get() - home.y) > 3 ||
    Math.abs(m.scale.get() - home.scale) > 0.02 ||
    Math.abs(m.rotate.get() - home.rotate) > 1 ||
    Math.abs(m.rotateY.get() - home.rotateY) > 2
  )
}

/** the default elbow direction: down, out to her side and a little back */
export function defaultPole(side: Side, yaw: number): THREE.Vector3 {
  return new THREE.Vector3(sideSign(side) * 0.55, -1, -0.35).applyAxisAngle(_Y, yaw).normalize()
}
