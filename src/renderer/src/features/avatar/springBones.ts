import * as THREE from 'three'

/*
 * Spring-bone secondary motion for the hair (VRM-style verlet joints).
 *
 * Each joint keeps a simulated tail point. Every step the tail carries its
 * own inertia, is pulled back toward where the animated pose wants it
 * (stiffness), sags with gravity, is kept at bone length and pushed out of
 * the body colliders; the bone is then re-aimed at the tail. Runs after the
 * animation mixer, on a fixed 60 Hz sub-step so it behaves the same at any
 * frame rate.
 */

export interface SpringSettings {
  stiffness: number
  drag: number
  gravity: number
  /** collision radius of the strand around the chain */
  radius: number
  /** response to the ambient breeze (`external`), 0 = none */
  wind?: number
  /** collider group this chain belongs to (see Collider.groups) */
  group?: string
  /** cloth hanging round the body: a joint may swing out and around freely,
   *  but never more than this (m) closer to the body's axis — the line of the
   *  bone the chain hangs from — than it hangs at rest. Colliders only hold
   *  the joints off the body; the cloth between them still cut through
   *  whatever lay just under it when it swung in. */
  inward?: number
  /** per joint, root first: never more than this (m) further out from the
   *  body's axis than it hangs at rest — so cloth swinging out can't sweep
   *  through an arm hanging just beyond it. Joints past the end of the list
   *  swing out freely (a hem below the hands can flare). */
  outward?: number[]
}

interface Joint {
  bone: THREE.Bone
  /** tail direction in the bone's local space (unit) */
  axis: THREE.Vector3
  length: number
  restLocal: THREE.Quaternion
  tail: THREE.Vector3
  prevTail: THREE.Vector3
  settings: SpringSettings
  /** the bone the chain hangs from, and the body's up axis in its frame (from
   *  the rest pose, where she stands upright) — the axis for `inward` */
  hangsFrom: THREE.Object3D
  upLocal: THREE.Vector3
  /** 0..1: how firmly the tail is held at its animated rest (see hold) */
  held: number
  /** position in its chain (0 = root) */
  index: number
}

export interface Collider {
  bone: THREE.Object3D
  offset: THREE.Vector3
  radius: number
  /** chain groups this collider affects; undefined = every chain */
  groups?: string[]
}

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _q1 = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _v4 = new THREE.Vector3()
const _v5 = new THREE.Vector3()
const _v6 = new THREE.Vector3()
const _q3 = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _delta = new THREE.Quaternion()
const _gravity = new THREE.Vector3(0, -1, 0)

const STEP = 1 / 60

export class SpringBones {
  private joints: Joint[] = []
  private colliders: Collider[] = []
  private acc = 0
  private colliderScratch: { center: THREE.Vector3; radius: number; groups?: string[] }[] = []
  /** world-space wind / body motion impulse added on top of gravity */
  readonly external = new THREE.Vector3()
  /** nothing hangs through the floor (her coat's hem when she crouches) */
  floor = 0.012
  /** 0..1: loosens every chain's ``outward`` limit (by up to 10 cm) — while
   *  she strides or crouches her legs must be able to push the cloth aside */
  outwardFree = 0

  addChain(bones: THREE.Bone[], settings: SpringSettings): void {
    const hangsFrom = (bones[0]?.parent ?? bones[0]) as THREE.Object3D
    hangsFrom.updateWorldMatrix(true, false)
    const upLocal = new THREE.Vector3(0, 1, 0).applyQuaternion(hangsFrom.getWorldQuaternion(new THREE.Quaternion()).invert())
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i]
      const child = bones[i + 1]
      bone.updateWorldMatrix(true, false)
      let localTail: THREE.Vector3
      if (child) {
        localTail = child.position.clone()
      } else {
        // leaf: extrapolate the incoming segment (parent → bone) one more
        // step, expressed in the bone's own space
        const parent = bone.parent as THREE.Object3D
        const from = parent.getWorldPosition(new THREE.Vector3())
        const at = bone.getWorldPosition(new THREE.Vector3())
        const worldTail = at.clone().add(at.clone().sub(from).multiplyScalar(0.9))
        localTail = bone.worldToLocal(worldTail)
        if (localTail.lengthSq() < 1e-8) localTail.set(0, 0.05, 0)
      }
      const tail = localTail.clone().applyMatrix4(bone.matrixWorld)
      this.joints.push({
        bone,
        axis: localTail.clone().normalize(),
        length: localTail.length() * bone.getWorldScale(_v1).x,
        restLocal: bone.quaternion.clone(),
        tail: tail.clone(),
        prevTail: tail.clone(),
        settings,
        hangsFrom,
        upLocal,
        held: 0,
        index: i
      })
    }
  }

  /** hold a joint's tail at its animated rest (0 = free, 1 = fixed) — e.g.
   *  cloth pressed under a resting hand, which mustn't swing out through it */
  hold(boneName: string, amount: number): void {
    for (const j of this.joints) if (j.bone.name === boneName) j.held = amount
  }

  /** collider sphere given by its REST world position, carried by ``bone`` */
  addCollider(bone: THREE.Object3D, worldCenter: THREE.Vector3, radius: number, groups?: string[]): void {
    bone.updateWorldMatrix(true, false)
    const offset = bone.worldToLocal(worldCenter.clone())
    this.colliders.push({ bone, offset, radius, groups })
  }

  /** collider centres in world space (debug view) */
  debugColliders(): { center: THREE.Vector3; radius: number }[] {
    return this.colliders.map((c) => ({
      center: c.offset.clone().applyMatrix4(c.bone.matrixWorld),
      radius: c.radius
    }))
  }

  /** snap every tail back to the posed rest (after teleports / long pauses) */
  reset(): void {
    for (const j of this.joints) {
      j.bone.quaternion.copy(j.restLocal)
      j.bone.updateWorldMatrix(true, false)
      j.tail.copy(j.axis).multiplyScalar(j.length).applyMatrix4(j.bone.matrixWorld)
      j.prevTail.copy(j.tail)
    }
  }

  /** advance the simulation; returns how many fixed steps ran (0 = bones untouched) */
  update(dt: number): number {
    if (dt > 0.25) {
      // returning from a pause — don't integrate a quarter-second of physics
      this.reset()
      return 1
    }
    this.acc += dt
    let steps = 0
    while (this.acc >= STEP && steps < 4) {
      this.step(STEP)
      this.acc -= STEP
      steps++
    }
    if (steps === 4) this.acc = 0
    return steps
  }

  private step(dt: number): void {
    const cols = this.colliderScratch
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i]
      c.bone.updateWorldMatrix(true, false)
      if (!cols[i]) cols[i] = { center: new THREE.Vector3(), radius: 0 }
      cols[i].center.copy(c.offset).applyMatrix4(c.bone.matrixWorld)
      cols[i].radius = c.radius
      cols[i].groups = c.groups
    }

    for (const j of this.joints) {
      const parent = j.bone.parent as THREE.Object3D
      parent.updateWorldMatrix(true, false)
      // where the animated pose wants the tail
      parent.getWorldQuaternion(_q1)
      _q2.copy(_q1).multiply(j.restLocal) // bone world rotation at rest-in-pose
      const restDir = _v1.copy(j.axis).applyQuaternion(_q2)
      j.bone.getWorldPosition(_pos)

      const s = j.settings
      // verlet: inertia + stiffness + gravity
      const next = _v2
        .copy(j.tail)
        .addScaledVector(_v3.copy(j.tail).sub(j.prevTail), 1 - s.drag)
        .addScaledVector(restDir, s.stiffness * dt)
        .addScaledVector(_gravity, s.gravity * dt)
        .addScaledVector(this.external, dt * (s.wind ?? 0))
      // keep bone length
      next.sub(_pos).normalize().multiplyScalar(j.length).add(_pos)
      // push out of colliders
      for (const c of cols) {
        if (c.groups && !c.groups.includes(s.group ?? '')) continue
        const r = c.radius + s.radius
        _v3.copy(next).sub(c.center)
        const d = _v3.length()
        if (d < r && d > 1e-6) {
          next.copy(c.center).addScaledVector(_v3, r / d)
          next.sub(_pos).normalize().multiplyScalar(j.length).add(_pos)
        }
      }
      const fl = this.floor + s.radius
      if (next.y < fl) {
        next.y = fl
        next.sub(_pos).normalize().multiplyScalar(j.length).add(_pos)
      }
      const lim = s.outward?.[j.index]
      const out = lim === undefined ? undefined : lim + this.outwardFree * 0.1
      if (s.inward !== undefined || out !== undefined || j.held > 0) {
        const restTail = _v4.copy(restDir).multiplyScalar(j.length).add(_pos)
        if (s.inward !== undefined || out !== undefined) this.keepWithin(j, next, restTail, s.inward, out)
        if (j.held > 0) next.lerp(restTail, Math.min(1, j.held))
        next.sub(_pos).normalize().multiplyScalar(j.length).add(_pos)
      }
      j.prevTail.copy(j.tail)
      j.tail.copy(next)

      // aim the bone at the simulated tail
      const to = _v3.copy(next).sub(_pos).normalize()
      const worldRot = _delta.setFromUnitVectors(restDir.normalize(), to).multiply(_q2)
      j.bone.quaternion.copy(_q1.invert().multiply(worldRot))
      j.bone.updateWorldMatrix(false, false)
    }
  }

  /** keep ``tail`` between ``inward`` nearer and ``outward`` further from the
   *  body's axis (the line of the bone the chain hangs from) than
   *  ``restTail`` is (either may be undefined: no limit that way) */
  private keepWithin(
    j: Joint,
    tail: THREE.Vector3,
    restTail: THREE.Vector3,
    inward: number | undefined,
    outward: number | undefined
  ): void {
    const origin = j.hangsFrom.getWorldPosition(_v5)
    const up = _v6.copy(j.upLocal).applyQuaternion(j.hangsFrom.getWorldQuaternion(_q3))
    // radial offsets from the axis (the along-axis part removed)
    const restR = _v3.copy(restTail).sub(origin)
    restR.addScaledVector(up, -restR.dot(up))
    const rest = restR.length()
    const rel = _v3.copy(tail).sub(origin)
    const along = rel.dot(up)
    rel.addScaledVector(up, -along)
    const r = rel.length()
    if (r < 1e-6) return
    let want = r
    if (inward !== undefined) want = Math.max(want, rest - inward)
    if (outward !== undefined) want = Math.min(want, rest + outward)
    if (want !== r) tail.copy(origin).addScaledVector(up, along).addScaledVector(rel, want / r)
  }
}
