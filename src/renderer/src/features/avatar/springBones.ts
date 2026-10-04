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
}

export interface Collider {
  bone: THREE.Object3D
  offset: THREE.Vector3
  radius: number
}

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _q1 = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _delta = new THREE.Quaternion()
const _gravity = new THREE.Vector3(0, -1, 0)

const STEP = 1 / 60

export class SpringBones {
  private joints: Joint[] = []
  private colliders: Collider[] = []
  private acc = 0
  private colliderScratch: { center: THREE.Vector3; radius: number }[] = []
  /** world-space wind / body motion impulse added on top of gravity */
  readonly external = new THREE.Vector3()

  addChain(bones: THREE.Bone[], settings: SpringSettings): void {
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
        settings
      })
    }
  }

  /** collider sphere given by its REST world position, carried by ``bone`` */
  addCollider(bone: THREE.Object3D, worldCenter: THREE.Vector3, radius: number): void {
    bone.updateWorldMatrix(true, false)
    const offset = bone.worldToLocal(worldCenter.clone())
    this.colliders.push({ bone, offset, radius })
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

  update(dt: number): void {
    if (dt > 0.25) {
      // returning from a pause — don't integrate a quarter-second of physics
      this.reset()
      return
    }
    this.acc += dt
    let steps = 0
    while (this.acc >= STEP && steps < 4) {
      this.step(STEP)
      this.acc -= STEP
      steps++
    }
    if (steps === 4) this.acc = 0
  }

  private step(dt: number): void {
    const cols = this.colliderScratch
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i]
      c.bone.updateWorldMatrix(true, false)
      if (!cols[i]) cols[i] = { center: new THREE.Vector3(), radius: 0 }
      cols[i].center.copy(c.offset).applyMatrix4(c.bone.matrixWorld)
      cols[i].radius = c.radius
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
        .addScaledVector(this.external, dt)
      // keep bone length
      next.sub(_pos).normalize().multiplyScalar(j.length).add(_pos)
      // push out of colliders
      for (const c of cols) {
        const r = c.radius + s.radius
        _v3.copy(next).sub(c.center)
        const d = _v3.length()
        if (d < r && d > 1e-6) {
          next.copy(c.center).addScaledVector(_v3, r / d)
          next.sub(_pos).normalize().multiplyScalar(j.length).add(_pos)
        }
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
}
