import * as THREE from 'three'
import type { AvatarRig } from '../avatarAsset'
import { clamp, frameQuat, solveTwoBone, twistAngle, twoBoneResult } from './ik'

/*
 * The avatar's procedural body: everything the clips can't know in advance —
 * where her feet are planted, how low she crouches, where each hand must
 * land. It never owns a bone: every change is layered onto the clip pose
 * through the controller (``PoseLayers``), which takes it back off before the
 * mixer runs again, and each limb blends in and out by its own weight.
 *
 * Three.js space: Y up, her front is +Z at rest, her left is +X.
 */

export type Side = 'left' | 'right'
export const SIDES: readonly Side[] = ['left', 'right']
/** +1 for her left (+X), −1 for her right */
export const sideSign = (s: Side): number => (s === 'left' ? 1 : -1)

export interface PoseLayers {
  /** right-multiply a local rotation onto a bone (undone before the next mixer update) */
  layer(bone: THREE.Bone, q: THREE.Quaternion): void
  /** add a local offset to a bone's position (likewise undone) */
  layerPos(bone: THREE.Bone, offset: THREE.Vector3): void
}

export type Contact = 'palm' | 'index' | 'wrist'

export interface ArmGoal {
  weight: number
  /** where the contact point goes (world) */
  target: THREE.Vector3
  /** the hand's frame (world): the way the fingers point, and the palm faces */
  fingerDir: THREE.Vector3
  palm: THREE.Vector3
  contact: Contact
  /** the elbow bends toward this (a world direction) */
  pole: THREE.Vector3
}

export interface FingerPose {
  weight: number
  /** curl per finger (degrees): thumb, index, middle, ring, little */
  curl: number[]
  /** fan between neighbouring fingers (degrees) */
  spread: number
  /** thumb swung away from the index (degrees) */
  thumbOut: number
}

export interface LegGoal {
  weight: number
  /** ankle (foot bone origin) target, world */
  ankle: THREE.Vector3
  /** the foot's world rotation */
  foot: THREE.Quaternion
  /** the knee bends toward this (world direction) */
  pole: THREE.Vector3
  /** the toes' bend from the foot (radians, + = curled under) — a heel
   *  peeling up keeps them flat on the floor */
  toe: number
}

export interface BodyInput {
  /** world-space translation of the hips */
  hipsOffset: THREE.Vector3
  /** hips rotation about her own axes (radians): yaw (+ = turn left), pitch (+ = tip forward), roll (+ = tilt to her left: the left hip drops) */
  hipsYaw: number
  hipsPitch: number
  hipsRoll: number
  /** spread over spine → upper chest (radians): bend forward, twist left, lean left */
  spineBend: number
  spineTwist: number
  spineSide: number
  legs: Record<Side, LegGoal>
  arms: Record<Side, ArmGoal>
  /** walking arm swing for arms off IK (radians, + = forward) */
  swing: Record<Side, number>
  /** shoulder (clavicle) lift (radians) */
  shoulderLift: Record<Side, number>
  fingers: Record<Side, FingerPose>
  /** called once the hips, spine, legs and fingers are posed and before the
   *  arms reach — targets riding on her body (a hand on her hip) are final
   *  only now */
  beforeArms: (() => void) | null
}

/** where a hand is before IK touches it this frame (the clip on her moved body) */
export interface AnimatedHand {
  hand: THREE.Vector3
  q: THREE.Quaternion
  elbow: THREE.Vector3
  shoulder: THREE.Vector3
}

interface Limb {
  upper: THREE.Bone
  lower: THREE.Bone
  end: THREE.Bone
  l1: number
  l2: number
  /** each bone's own axes: along the bone, and the hinge it bends about */
  dirU: THREE.Vector3
  hingeU: THREE.Vector3
  dirL: THREE.Vector3
  hingeL: THREE.Vector3
}

interface FingerJoint {
  bone: THREE.Bone
  rest: THREE.Quaternion
  /** local axis: positive turns flex the joint toward the palm */
  curl: THREE.Vector3
  /** local axis fanning the finger away from the middle one (proximal only) */
  spread: THREE.Vector3 | null
  spreadW: number
  /** share of the finger's curl this joint takes */
  w: number
  finger: number
}

export interface HandRest {
  bone: THREE.Bone
  /** hand-local: along the fingers, and out of the palm */
  fingerDir: THREE.Vector3
  palm: THREE.Vector3
  /** hand-local: the middle of the palm's skin */
  palmPoint: THREE.Vector3
  joints: FingerJoint[]
  /** the index fingertip's pad, in the distal bone's frame */
  indexTip: { bone: THREE.Bone; offset: THREE.Vector3 }
  thumbOut: { bone: THREE.Bone; axis: THREE.Vector3 } | null
}

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _q3 = new THREE.Quaternion()
const _qU = new THREE.Quaternion()
const _qL = new THREE.Quaternion()
const _qH = new THREE.Quaternion()
const _qT = new THREE.Quaternion()
const _ident = new THREE.Quaternion()
const _ik = twoBoneResult()
const _X = new THREE.Vector3(1, 0, 0)
const _Y = new THREE.Vector3(0, 1, 0)
const _Z = new THREE.Vector3(0, 0, 1)

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const
const SEGS = ['Proximal', 'Intermediate', 'Distal'] as const

export class BodyRig {
  readonly hips: THREE.Bone
  readonly spineBones: THREE.Bone[]
  readonly arms: Record<Side, Limb>
  readonly legs: Record<Side, Limb>
  readonly shoulders: Record<Side, THREE.Bone>
  readonly hands: Record<Side, HandRest>
  /** the toes (they bend at the ball of the foot), if the rig has them */
  readonly toes: Record<Side, THREE.Bone | null>
  private readonly footLat: Record<Side, THREE.Vector3> = { left: new THREE.Vector3(), right: new THREE.Vector3() }
  readonly head: THREE.Bone
  /** rest heights (m) — the ankle above the floor, the shoulders */
  readonly ankleHeight: number
  readonly shoulderHeight: number
  readonly shoulderX: number
  readonly armLength: number
  readonly legLength: number

  /** set by the last apply: where each hand's contact point actually landed */
  readonly reached: Record<Side, THREE.Vector3> = { left: new THREE.Vector3(), right: new THREE.Vector3() }
  /** set by the last apply: each arm as the clip had it, before IK */
  readonly animated: Record<Side, AnimatedHand> = {
    left: { hand: new THREE.Vector3(), q: new THREE.Quaternion(), elbow: new THREE.Vector3(), shoulder: new THREE.Vector3() },
    right: { hand: new THREE.Vector3(), q: new THREE.Quaternion(), elbow: new THREE.Vector3(), shoulder: new THREE.Vector3() }
  }

  constructor(
    private readonly rig: AvatarRig,
    private readonly layers: PoseLayers
  ) {
    const bone = (n: string): THREE.Bone => {
      const b = rig.bones.get(n)
      if (!b) throw new Error(`avatar has no "${n}" bone`)
      return b
    }
    // the rig is in its bind pose here (the controller builds us before the
    // first mixer update)
    rig.root.updateWorldMatrix(true, true)
    this.hips = bone('hips')
    this.head = bone('head')
    this.spineBones = ['spine', 'chest', 'upperChest'].map(bone)
    const limb = (u: string, l: string, e: string, bend: THREE.Vector3): Limb => {
      const upper = bone(u)
      const lower = bone(l)
      const end = bone(e)
      const pu = upper.getWorldPosition(new THREE.Vector3())
      const pl = lower.getWorldPosition(new THREE.Vector3())
      const pe = end.getWorldPosition(new THREE.Vector3())
      const axis = pe.clone().sub(pu).normalize()
      // the hinge as solveTwoBone defines it: (bend ⟂ axis) × axis
      const n = bend.clone().addScaledVector(axis, -bend.dot(axis)).normalize()
      const hinge = n.clone().cross(axis).normalize()
      const qu = upper.getWorldQuaternion(new THREE.Quaternion()).invert()
      const ql = lower.getWorldQuaternion(new THREE.Quaternion()).invert()
      return {
        upper,
        lower,
        end,
        l1: pl.distanceTo(pu),
        l2: pe.distanceTo(pl),
        dirU: pl.clone().sub(pu).normalize().applyQuaternion(qu),
        hingeU: hinge.clone().applyQuaternion(qu),
        dirL: pe.clone().sub(pl).normalize().applyQuaternion(ql),
        hingeL: hinge.clone().applyQuaternion(ql)
      }
    }
    // elbows bend with the forearm coming forward (the elbow points back);
    // knees with the shin going back (the knee points forward)
    this.arms = {
      left: limb('leftUpperArm', 'leftLowerArm', 'leftHand', new THREE.Vector3(0, 0, -1)),
      right: limb('rightUpperArm', 'rightLowerArm', 'rightHand', new THREE.Vector3(0, 0, -1))
    }
    this.legs = {
      left: limb('leftUpperLeg', 'leftLowerLeg', 'leftFoot', new THREE.Vector3(0, 0, 1)),
      right: limb('rightUpperLeg', 'rightLowerLeg', 'rightFoot', new THREE.Vector3(0, 0, 1))
    }
    this.shoulders = { left: bone('leftShoulder'), right: bone('rightShoulder') }
    this.hands = { left: this.handRest('left', bone), right: this.handRest('right', bone) }
    this.toes = { left: rig.bones.get('leftToes') ?? null, right: rig.bones.get('rightToes') ?? null }
    // her side-to-side axis in each foot's own frame (she faces +Z here)
    for (const s of SIDES) {
      this.footLat[s].set(1, 0, 0).applyQuaternion(this.legs[s].end.getWorldQuaternion(new THREE.Quaternion()).invert())
    }

    const foot = this.legs.left.end.getWorldPosition(new THREE.Vector3())
    this.ankleHeight = foot.y
    const sh = this.arms.left.upper.getWorldPosition(new THREE.Vector3())
    this.shoulderHeight = sh.y
    this.shoulderX = Math.abs(sh.x)
    this.armLength = this.arms.left.l1 + this.arms.left.l2
    this.legLength = this.legs.left.l1 + this.legs.left.l2
  }

  private handRest(side: Side, bone: (n: string) => THREE.Bone): HandRest {
    const s = side
    const pos = (n: string): THREE.Vector3 => bone(n).getWorldPosition(new THREE.Vector3())
    const hand = bone(`${s}Hand`)
    const hp = hand.getWorldPosition(new THREE.Vector3())
    const handInv = hand.getWorldQuaternion(new THREE.Quaternion()).invert()
    const idx = pos(`${s}IndexProximal`)
    const lit = pos(`${s}LittleProximal`)
    const mp = pos(`${s}MiddleProximal`)
    const mi = pos(`${s}MiddleIntermediate`)
    const ring = pos(`${s}RingProximal`)
    const along = mi.clone().sub(mp).normalize()
    const across = idx.clone().sub(lit).normalize()
    // the palm side: (along × toward-the-thumb) on the left hand, mirrored on
    // the right — the way the kit's palm_frame defines it (palms face down in
    // the A-pose, thumbs forward)
    const palm = along.clone().cross(across).multiplyScalar(sideSign(side)).normalize()

    const joints: FingerJoint[] = []
    let thumbOut: HandRest['thumbOut'] = null
    for (const [i, f] of FINGERS.entries()) {
      for (const [k, seg] of SEGS.entries()) {
        const b = bone(`${s}${f}${seg}`)
        const a = b.getWorldPosition(new THREE.Vector3())
        const next = k < 2 ? pos(`${s}${f}${SEGS[k + 1]}`) : null
        const prev = k > 0 ? pos(`${s}${f}${SEGS[k - 1]}`) : null
        const dir = next ? next.sub(a).normalize() : prev ? a.clone().sub(prev).normalize() : along.clone()
        const inv = b.getWorldQuaternion(new THREE.Quaternion()).invert()
        let spread: THREE.Vector3 | null = null
        let spreadW = 0
        if (k === 0 && f !== 'Thumb' && f !== 'Middle') {
          const sideDir = a.clone().sub(mp)
          sideDir.addScaledVector(dir, -sideDir.dot(dir)).normalize()
          spread = dir.clone().cross(sideDir).normalize().applyQuaternion(inv)
          spreadW = f === 'Little' ? 1.5 : 1
        }
        if (k === 0 && f === 'Thumb') {
          const away = a.clone().sub(idx)
          away.addScaledVector(dir, -away.dot(dir)).normalize()
          thumbOut = { bone: b, axis: dir.clone().cross(away).normalize().applyQuaternion(inv) }
        }
        joints.push({
          bone: b,
          rest: b.quaternion.clone(),
          curl: dir.clone().cross(palm).normalize().applyQuaternion(inv),
          spread,
          spreadW,
          w: f === 'Thumb' ? [0.5, 1, 1][k] : [0.8, 1.1, 0.9][k],
          finger: i
        })
      }
    }
    // the index pad: past the distal joint by most of the last segment
    const ii = pos(`${s}IndexIntermediate`)
    const id = pos(`${s}IndexDistal`)
    const distal = bone(`${s}IndexDistal`)
    const tipW = id.clone().addScaledVector(id.clone().sub(ii), 0.9).addScaledVector(palm, 0.004)
    const tip = tipW.sub(id).applyQuaternion(distal.getWorldQuaternion(new THREE.Quaternion()).invert())
    // the palm's skin, between the wrist and the knuckles
    const knuckles = idx.clone().add(mp).add(ring).add(lit).multiplyScalar(0.25)
    const palmPoint = hp.clone().lerp(knuckles, 0.55).addScaledVector(palm, 0.013).sub(hp).applyQuaternion(handInv)
    return {
      bone: hand,
      fingerDir: mp.clone().sub(hp).normalize().applyQuaternion(handInv),
      palm: palm.clone().applyQuaternion(handInv),
      palmPoint,
      joints,
      indexTip: { bone: distal, offset: tip },
      thumbOut
    }
  }

  // ── helpers ──

  /** set a bone's local rotation to `local`, blended by w, as a layer */
  private setLocal(bone: THREE.Bone, local: THREE.Quaternion, w: number): void {
    if (w <= 0) return
    // (normalised: the clip's quaternions are only unit to float32, and
    // invert() is a conjugate — an un-normalised delta would compound
    // through the layer/undo cycle until the bone explodes)
    _q3.copy(bone.quaternion).invert().multiply(local).normalize()
    if (w < 1) _q3.copy(_ident).slerp(_q3, w)
    this.layers.layer(bone, _q3)
  }

  /** set a bone's WORLD rotation, blended by w */
  private setWorld(bone: THREE.Bone, world: THREE.Quaternion, w: number): void {
    const parent = bone.parent as THREE.Object3D
    parent.getWorldQuaternion(_q2).invert().multiply(world)
    this.setLocal(bone, _q2, w)
  }

  /** rotate a bone in world space by `g` (about the world origin of its own joint) */
  private rotateWorld(bone: THREE.Bone, g: THREE.Quaternion): void {
    // local' = local · (W⁻¹ G W)
    bone.getWorldQuaternion(_q).normalize()
    _q2.copy(_q).invert().multiply(g).multiply(_q).normalize()
    this.layers.layer(bone, _q2)
  }

  /** the current world position of a hand's contact point */
  contactPoint(side: Side, contact: Contact, out: THREE.Vector3): THREE.Vector3 {
    const h = this.hands[side]
    if (contact === 'index') return h.indexTip.bone.localToWorld(out.copy(h.indexTip.offset))
    if (contact === 'palm') return h.bone.localToWorld(out.copy(h.palmPoint))
    return h.bone.getWorldPosition(out)
  }

  /** the current world frame of a hand (finger direction, palm normal) */
  handFrame(side: Side, dir: THREE.Vector3, palm: THREE.Vector3): void {
    const h = this.hands[side]
    h.bone.getWorldQuaternion(_q)
    dir.copy(h.fingerDir).applyQuaternion(_q)
    palm.copy(h.palm).applyQuaternion(_q)
  }

  // ── the frame ──

  apply(inp: BodyInput, rootQ: THREE.Quaternion): void {
    const hips = this.hips
    ;(hips.parent as THREE.Object3D).updateWorldMatrix(true, false)

    // 1. hips: translate (world offset → parent space), then turn about her axes
    if (inp.hipsOffset.lengthSq() > 1e-12) {
      // the world offset in the parent's frame (its own origin maps to zero)
      const parent = hips.parent as THREE.Object3D
      _v.copy(parent.getWorldPosition(_v2)).add(inp.hipsOffset)
      this.layers.layerPos(hips, parent.worldToLocal(_v))
    }
    if (inp.hipsYaw || inp.hipsPitch || inp.hipsRoll) {
      _q.setFromAxisAngle(_Y, inp.hipsYaw)
      _q.multiply(_q2.setFromAxisAngle(_X, inp.hipsPitch))
      _q.multiply(_q2.setFromAxisAngle(_Z, -inp.hipsRoll))
      // into world: rootQ · q · rootQ⁻¹
      const g = _qH.copy(rootQ).multiply(_q).multiply(_q2.copy(rootQ).invert())
      this.rotateWorld(hips, g)
    }
    // 2. the spine, spread over its three bones (her own axes)
    if (inp.spineBend || inp.spineTwist || inp.spineSide) {
      const share = [0.3, 0.35, 0.35]
      for (const [i, b] of this.spineBones.entries()) {
        const w = share[i]
        _q.setFromAxisAngle(_Y, inp.spineTwist * w)
        _q.multiply(_q2.setFromAxisAngle(_X, inp.spineBend * w))
        _q.multiply(_q2.setFromAxisAngle(_Z, -inp.spineSide * w))
        const g = _qH.copy(rootQ).multiply(_q).multiply(_q2.copy(rootQ).invert())
        this.rotateWorld(b, g)
      }
    }
    hips.updateWorldMatrix(false, true)

    // 3. legs onto their planted feet
    for (const s of SIDES) {
      const goal = inp.legs[s]
      if (goal.weight <= 0) continue
      const leg = this.legs[s]
      const root = leg.upper.getWorldPosition(_v)
      solveTwoBone(root, goal.ankle, leg.l1, leg.l2, goal.pole, _ik)
      frameQuat(leg.dirU, leg.hingeU, _v2.subVectors(_ik.mid, root), _ik.hinge, _qU)
      this.setWorld(leg.upper, _qU, goal.weight)
      leg.upper.updateWorldMatrix(false, false)
      frameQuat(leg.dirL, leg.hingeL, _v2.subVectors(_ik.end, _ik.mid), _ik.hinge, _qL)
      this.setWorld(leg.lower, _qL, goal.weight)
      leg.lower.updateWorldMatrix(false, false)
      this.setWorld(leg.end, goal.foot, goal.weight)
      leg.end.updateWorldMatrix(false, true)
      // the toes bend at the ball (about the foot's own side-to-side axis).
      // (its own quaternion: rotateWorld writes _q, which once flipped the
      // toes by their whole world rotation for a fifth of every stride)
      const toes = this.toes[s]
      if (toes && Math.abs(goal.toe) > 1e-4) {
        _v2.copy(this.footLat[s]).applyQuaternion(goal.foot)
        this.rotateWorld(toes, _qT.setFromAxisAngle(_v2, goal.toe * goal.weight))
        toes.updateWorldMatrix(false, false)
      }
    }

    // 4. shoulders, arm swing, fingers, then arms onto their targets
    for (const s of SIDES) {
      const lift = inp.shoulderLift[s]
      if (lift) {
        _q.setFromAxisAngle(_Z, lift * sideSign(s))
        const g = _qH.copy(rootQ).multiply(_q).multiply(_q2.copy(rootQ).invert())
        this.rotateWorld(this.shoulders[s], g)
      }
      const arm = this.arms[s]
      const goal = inp.arms[s]
      const swing = inp.swing[s] * (1 - goal.weight)
      if (Math.abs(swing) > 1e-4) {
        // forward is a turn about her left→right axis; the elbow softens as
        // the arm comes forward
        _q.setFromAxisAngle(_X, -swing)
        this.rotateWorld(arm.upper, _qH.copy(rootQ).multiply(_q).multiply(_q2.copy(rootQ).invert()))
        _q.setFromAxisAngle(_X, -Math.max(0, swing) * 0.6 - 0.05)
        this.rotateWorld(arm.lower, _qH.copy(rootQ).multiply(_q).multiply(_q2.copy(rootQ).invert()))
      }
      this.applyFingers(s, inp.fingers[s])
    }
    this.hips.updateWorldMatrix(false, true)
    for (const s of SIDES) {
      const a = this.animated[s]
      const arm = this.arms[s]
      arm.end.getWorldPosition(a.hand)
      arm.end.getWorldQuaternion(a.q)
      arm.lower.getWorldPosition(a.elbow)
      arm.upper.getWorldPosition(a.shoulder)
    }
    inp.beforeArms?.()
    for (const s of SIDES) {
      const goal = inp.arms[s]
      if (goal.weight > 0) this.reachArm(s, goal)
      else this.contactPoint(s, goal.contact, this.reached[s])
    }
  }

  /** a hand's contact point as the clip has it this frame (before IK) */
  animatedContact(side: Side, contact: Contact, out: THREE.Vector3): THREE.Vector3 {
    const a = this.animated[side]
    const h = this.hands[side]
    if (contact === 'wrist') return out.copy(a.hand)
    if (contact === 'palm') return out.copy(h.palmPoint).applyQuaternion(a.q).add(a.hand)
    h.indexTip.bone.updateWorldMatrix(true, false)
    const tip = h.indexTip.bone.localToWorld(_v3.copy(h.indexTip.offset))
    h.bone.worldToLocal(tip)
    return out.copy(tip).applyQuaternion(a.q).add(a.hand)
  }

  /** a hand's frame as the clip has it this frame (before IK) */
  animatedFrame(side: Side, dir: THREE.Vector3, palm: THREE.Vector3): void {
    const a = this.animated[side]
    const h = this.hands[side]
    dir.copy(h.fingerDir).applyQuaternion(a.q)
    palm.copy(h.palm).applyQuaternion(a.q)
  }

  private applyFingers(side: Side, pose: FingerPose): void {
    if (pose.weight <= 0) return
    const h = this.hands[side]
    const D = THREE.MathUtils.DEG2RAD
    for (const j of h.joints) {
      _q.copy(j.rest).multiply(_q2.setFromAxisAngle(j.curl, pose.curl[j.finger] * j.w * D))
      if (j.spread && pose.spread) _q.multiply(_q2.setFromAxisAngle(j.spread, pose.spread * j.spreadW * D))
      if (h.thumbOut && j.bone === h.thumbOut.bone && pose.thumbOut) {
        _q.multiply(_q2.setFromAxisAngle(h.thumbOut.axis, pose.thumbOut * D))
      }
      this.setLocal(j.bone, _q, pose.weight)
    }
  }

  private reachArm(side: Side, goal: ArmGoal): void {
    const arm = this.arms[side]
    const hand = this.hands[side]
    // the hand's world rotation from the requested frame
    frameQuat(hand.fingerDir, hand.palm, goal.fingerDir, goal.palm, _qH)
    // where the wrist must go so the contact point lands on the target
    let offset: THREE.Vector3
    if (goal.contact === 'palm') offset = _v3.copy(hand.palmPoint)
    else if (goal.contact === 'index') {
      // (fingers are posed already; the tip relative to the hand is fixed now)
      hand.indexTip.bone.updateWorldMatrix(true, false)
      const tipW = hand.indexTip.bone.localToWorld(_v3.copy(hand.indexTip.offset))
      offset = hand.bone.worldToLocal(tipW)
    } else offset = _v3.set(0, 0, 0)
    const wrist = _v2.copy(offset).applyQuaternion(_qH)
    wrist.subVectors(goal.target, wrist)

    const root = arm.upper.getWorldPosition(_v)
    solveTwoBone(root, wrist, arm.l1, arm.l2, goal.pole, _ik)
    frameQuat(arm.dirU, arm.hingeU, _v2.subVectors(_ik.mid, root), _ik.hinge, _qU)
    this.setWorld(arm.upper, _qU, goal.weight)
    arm.upper.updateWorldMatrix(false, false)
    frameQuat(arm.dirL, arm.hingeL, _v2.subVectors(_ik.end, _ik.mid), _ik.hinge, _qL)
    // roll the forearm (pronation) to take most of the hand's twist, so the
    // wrist itself only flexes — the way the clips turn a palm over
    _q.copy(_qL).invert().multiply(_qH)
    const roll = clamp(twistAngle(_q, arm.dirL) * 0.8, -2.0, 2.0)
    _qL.multiply(_q.setFromAxisAngle(arm.dirL, roll))
    this.setWorld(arm.lower, _qL, goal.weight)
    arm.lower.updateWorldMatrix(false, false)
    this.setWorld(hand.bone, _qH, goal.weight)
    hand.bone.updateWorldMatrix(false, true)
    this.contactPoint(side, goal.contact, this.reached[side])
  }
}

/** a fresh, neutral BodyInput */
export function bodyInput(): BodyInput {
  const arm = (): ArmGoal => ({
    weight: 0,
    target: new THREE.Vector3(),
    fingerDir: new THREE.Vector3(0, 1, 0),
    palm: new THREE.Vector3(0, 0, 1),
    contact: 'palm',
    pole: new THREE.Vector3(0, -1, -0.3)
  })
  const leg = (): LegGoal => ({ weight: 0, ankle: new THREE.Vector3(), foot: new THREE.Quaternion(), pole: new THREE.Vector3(0, 0, 1), toe: 0 })
  const fingers = (): FingerPose => ({ weight: 0, curl: [10, 12, 14, 16, 18], spread: 0, thumbOut: 0 })
  return {
    hipsOffset: new THREE.Vector3(),
    hipsYaw: 0,
    hipsPitch: 0,
    hipsRoll: 0,
    spineBend: 0,
    spineTwist: 0,
    spineSide: 0,
    legs: { left: leg(), right: leg() },
    arms: { left: arm(), right: arm() },
    swing: { left: 0, right: 0 },
    shoulderLift: { left: 0, right: 0 },
    fingers: { left: fingers(), right: fingers() },
    beforeArms: null
  }
}
