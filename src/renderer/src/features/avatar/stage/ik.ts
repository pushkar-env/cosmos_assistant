import * as THREE from 'three'

/*
 * Small, allocation-free maths for posing the avatar at runtime: building a
 * bone's world rotation from two of its own axes, an analytic two-bone IK
 * (arm or leg, with a real hinge at the elbow / knee), and swing–twist.
 */

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _d = new THREE.Vector3()
const _e = new THREE.Vector3()
const _f = new THREE.Vector3()
const _m1 = new THREE.Matrix4()
const _m2 = new THREE.Matrix4()

export const clamp = THREE.MathUtils.clamp

/** 0..1 → 0..1, zero velocity and acceleration at both ends */
export function smoother(u: number): number {
  u = clamp(u, 0, 1)
  return u * u * u * (u * (u * 6 - 15) + 10)
}

/** 0..1 → 0..1, zero velocity at both ends */
export function smooth(u: number): number {
  u = clamp(u, 0, 1)
  return u * u * (3 - 2 * u)
}

/** shortest signed difference b − a between two angles (radians) */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

/** a vector perpendicular to `v` (unit), written into `out` */
function anyPerp(v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.set(0, 0, 1).addScaledVector(v, -v.z)
  if (out.lengthSq() < 1e-6) out.set(1, 0, 0).addScaledVector(v, -v.x)
  return out.normalize()
}

/**
 * The rotation that carries a frame given in some local space onto a frame
 * in world space: `dirL` lands exactly on `dirW`, and `refL` as close to
 * `refW` as that allows (both refs are projected off their dirs).
 */
export function frameQuat(
  dirL: THREE.Vector3,
  refL: THREE.Vector3,
  dirW: THREE.Vector3,
  refW: THREE.Vector3,
  out: THREE.Quaternion
): THREE.Quaternion {
  const a1 = _a.copy(dirL).normalize()
  const a2 = _b.copy(refL).addScaledVector(a1, -refL.dot(a1))
  if (a2.lengthSq() < 1e-10) anyPerp(a1, a2)
  a2.normalize()
  const a3 = _c.crossVectors(a1, a2)
  _m1.makeBasis(a1, a2, a3)
  const b1 = _d.copy(dirW).normalize()
  const b2 = _e.copy(refW).addScaledVector(b1, -refW.dot(b1))
  if (b2.lengthSq() < 1e-10) anyPerp(b1, b2)
  b2.normalize()
  const b3 = _f.crossVectors(b1, b2)
  _m2.makeBasis(b1, b2, b3)
  // R = B · Aᵀ (A is orthonormal, so its transpose is its inverse)
  _m2.multiply(_m1.transpose())
  return out.setFromRotationMatrix(_m2)
}

export interface TwoBoneResult {
  /** where the middle joint (elbow / knee) goes */
  mid: THREE.Vector3
  /** where the end joint lands — the target, pulled into reach */
  end: THREE.Vector3
  /** the hinge axis (world): the joint bends about it */
  hinge: THREE.Vector3
  /** true when the target was out of reach (the chain is straight) */
  stretched: boolean
}

/**
 * Two-bone IK: from `root`, bones of length `l1` and `l2`, reaching
 * `target`, the middle joint bending toward `bend` (any direction; only its
 * part across the root→target line counts). The hinge comes out as
 * `bend × (target − root)` normalised, so a chain whose bones map their own
 * hinge axes onto it bends the right way.
 */
export function solveTwoBone(
  root: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
  bend: THREE.Vector3,
  out: TwoBoneResult
): TwoBoneResult {
  const e = _a.subVectors(target, root)
  let dist = e.length()
  if (dist < 1e-6) {
    e.set(0, -1, 0)
    dist = 1e-6
  } else e.divideScalar(dist)
  const max = (l1 + l2) * 0.9995
  const min = Math.abs(l1 - l2) + 1e-4
  out.stretched = dist > max
  dist = clamp(dist, min, max)
  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1)
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA))
  const n = _b.copy(bend).addScaledVector(e, -bend.dot(e))
  if (n.lengthSq() < 1e-10) anyPerp(e, n)
  n.normalize()
  out.end.copy(root).addScaledVector(e, dist)
  out.mid.copy(root).addScaledVector(e, l1 * cosA).addScaledVector(n, l1 * sinA)
  out.hinge.crossVectors(n, e).normalize()
  return out
}

export function twoBoneResult(): TwoBoneResult {
  return { mid: new THREE.Vector3(), end: new THREE.Vector3(), hinge: new THREE.Vector3(), stretched: false }
}

/** the twist (radians, −π..π) of rotation `q` about the unit `axis` */
export function twistAngle(q: THREE.Quaternion, axis: THREE.Vector3): number {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z
  let a = 2 * Math.atan2(d, q.w)
  if (a > Math.PI) a -= Math.PI * 2
  if (a < -Math.PI) a += Math.PI * 2
  return a
}

const _q = new THREE.Quaternion()
const _qa = new THREE.Quaternion()
const _ux = new THREE.Vector3(0, 1, 0)
const _uy = new THREE.Vector3(0, 0, 1)

/** spherical blend between two (direction, reference) frames, in place on a */
export function slerpFrame(
  dirA: THREE.Vector3,
  refA: THREE.Vector3,
  dirB: THREE.Vector3,
  refB: THREE.Vector3,
  u: number
): void {
  if (u <= 0) return
  if (u >= 1) {
    dirA.copy(dirB)
    refA.copy(refB)
    return
  }
  frameQuat(_ux, _uy, dirA, refA, _qa)
  frameQuat(_ux, _uy, dirB, refB, _q)
  _qa.slerp(_q, u)
  dirA.copy(_ux).applyQuaternion(_qa)
  refA.copy(_uy).applyQuaternion(_qa)
}

/** quadratic Bézier, written into out */
export function bezier(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, u: number, out: THREE.Vector3): THREE.Vector3 {
  const v = 1 - u
  return out.set(
    v * v * a.x + 2 * v * u * c.x + u * u * b.x,
    v * v * a.y + 2 * v * u * c.y + u * u * b.y,
    v * v * a.z + 2 * v * u * c.z + u * u * b.z
  )
}
