import * as THREE from 'three'

/*
 * Spring-bone secondary motion for the hair (VRM-style verlet joints).
 *
 * Each joint keeps a simulated tail point. Every step the tail carries its
 * own inertia, is pulled back toward where the animated pose wants it
 * (stiffness), sags with gravity, is kept at bone length and pushed out of
 * the body colliders; the bone is then re-aimed at the tail. Joints step a
 * level at a time — every chain's first joint, then every chain's second… —
 * so chains hung side by side as a ring (a skirt) can keep the cloth
 * between them out of the colliders too. Runs after the animation mixer, on
 * a fixed 60 Hz sub-step so it behaves the same at any frame rate.
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
  /** chains hung round her side by side (a skirt): the cloth between this
   *  chain and its neighbours in the ring — the chains added with the same
   *  `name`, in order, closed — is kept out of the colliders as well, from
   *  joint `from` down (0 = the root's). Between two chains the cloth runs
   *  straight, and a thigh swinging forward between them (past one chain,
   *  pushing the other) would come up through it. */
  ring?: { name: string; from: number }
}

/** cloth lying over a limb that swings up under it (a skirt over a thigh as
 *  she crouches): the chain's root turns with the limb's swing out of its
 *  rest pose — `weight` of it, faded in as the swing grows from `from` to
 *  `to` degrees, and only while the limb swings forward. Colliders alone
 *  hold the cloth off a limb, not on top of it: with nothing under it but
 *  the round of a raised thigh, a chain slides off round its side and the
 *  thigh comes up through the cloth. */
export interface SpringFollow {
  /** the limb's root bone (an upper leg); its child gives the limb's line */
  bone: THREE.Object3D
  weight: number
  from: number
  to: number
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
  /** the root only: the limbs it turns with (see SpringFollow) */
  follow?: Follow[]
}

interface Follow {
  bone: THREE.Object3D
  /** the limb's line runs from its bone to this child */
  child: THREE.Object3D
  /** the limb's line and her forward at rest, in the frame of its parent */
  restLine: THREE.Vector3
  forward: THREE.Vector3
  weight: number
  /** radians */
  from: number
  to: number
}

export interface Collider {
  bone: THREE.Object3D
  offset: THREE.Vector3
  radius: number
  /** a capsule: its other end (bone space) and the radius there */
  end?: THREE.Vector3
  endRadius?: number
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
const _target = new THREE.Vector3()
const _ab = new THREE.Vector3()
const _core = new THREE.Vector3()
const _f1 = new THREE.Vector3()
const _f2 = new THREE.Vector3()
const _f3 = new THREE.Vector3()
const _qf = new THREE.Quaternion()
const _qs = new THREE.Quaternion()
const _qId = new THREE.Quaternion()
const _e1 = new THREE.Vector3()
const _e2 = new THREE.Vector3()
const _e3 = new THREE.Vector3()
const _c1 = new THREE.Vector3()
const _c2 = new THREE.Vector3()
const _c3 = new THREE.Vector3()
const _st: [number, number] = [0, 0]

const STEP = 1 / 60

/** the closest points of segments p0→p1 and q0→q1 (q0 = q1: a point), as
 *  parameters along each (Ericson, Real-Time Collision Detection 5.1.9) */
function closestOnSegments(p0: THREE.Vector3, p1: THREE.Vector3, q0: THREE.Vector3, q1: THREE.Vector3): [number, number] {
  const d1 = _c1.copy(p1).sub(p0)
  const d2 = _c2.copy(q1).sub(q0)
  const r = _c3.copy(p0).sub(q0)
  const a = d1.lengthSq()
  const e = d2.lengthSq()
  const f = d2.dot(r)
  const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
  let s = 0
  let t = 0
  if (a <= 1e-12 && e <= 1e-12) {
    // both points
  } else if (a <= 1e-12) {
    t = clamp01(f / e)
  } else {
    const c = d1.dot(r)
    if (e <= 1e-12) {
      s = clamp01(-c / a)
    } else {
      const b = d1.dot(d2)
      const denom = a * e - b * b
      s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = clamp01(-c / a)
      } else if (t > 1) {
        t = 1
        s = clamp01((b - c) / a)
      }
    }
  }
  _st[0] = s
  _st[1] = t
  return _st
}

/** a tail back at its bone's length from the bone's head */
function keepLength(j: Joint): void {
  j.bone.getWorldPosition(_pos)
  j.tail.sub(_pos).normalize().multiplyScalar(j.length).add(_pos)
}

interface ColliderNow {
  center: THREE.Vector3
  radius: number
  end: THREE.Vector3 | null
  endRadius: number
  groups?: string[]
}

export class SpringBones {
  private joints: Joint[] = []
  /** each chain's joints, root first; the longest chain's length */
  private chains: Joint[][] = []
  private depth = 0
  /** the chains of each ring, in order round it */
  private rings = new Map<string, Joint[][]>()
  private colliders: Collider[] = []
  private acc = 0
  private colliderScratch: ColliderNow[] = []
  /** world-space wind / body motion impulse added on top of gravity */
  readonly external = new THREE.Vector3()
  /** nothing hangs through the floor (her coat's hem when she crouches) */
  floor = 0.012
  /** 0..1: loosens every chain's ``outward`` limit (by up to 10 cm) — while
   *  she strides or crouches her legs must be able to push the cloth aside */
  outwardFree = 0

  /** ``follow``: limbs the chain's root turns with (from the rest pose, where
   *  she stands facing +z) */
  addChain(bones: THREE.Bone[], settings: SpringSettings, follow?: SpringFollow[]): void {
    const hangsFrom = (bones[0]?.parent ?? bones[0]) as THREE.Object3D
    hangsFrom.updateWorldMatrix(true, false)
    const upLocal = new THREE.Vector3(0, 1, 0).applyQuaternion(hangsFrom.getWorldQuaternion(new THREE.Quaternion()).invert())
    const follows = (follow ?? []).flatMap((f): Follow[] => {
      const child = f.bone.children.find((c) => (c as THREE.Bone).isBone)
      const parent = f.bone.parent
      if (!child || !parent) return []
      f.bone.updateWorldMatrix(true, true)
      const inv = parent.getWorldQuaternion(new THREE.Quaternion()).invert()
      const line = child.getWorldPosition(new THREE.Vector3()).sub(f.bone.getWorldPosition(new THREE.Vector3()))
      return [
        {
          bone: f.bone,
          child,
          restLine: line.normalize().applyQuaternion(inv),
          forward: new THREE.Vector3(0, 0, 1).applyQuaternion(inv),
          weight: THREE.MathUtils.clamp(f.weight, 0, 1),
          from: THREE.MathUtils.degToRad(f.from),
          to: THREE.MathUtils.degToRad(f.to)
        }
      ]
    })
    const chain: Joint[] = []
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
      chain.push({
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
        index: i,
        follow: i === 0 && follows.length ? follows : undefined
      })
    }
    if (!chain.length) return
    this.joints.push(...chain)
    this.chains.push(chain)
    this.depth = Math.max(this.depth, chain.length)
    if (settings.ring) {
      const ring = this.rings.get(settings.ring.name) ?? []
      ring.push(chain)
      this.rings.set(settings.ring.name, ring)
    }
  }

  /** hold a joint's tail at its animated rest (0 = free, 1 = fixed) — e.g.
   *  cloth pressed under a resting hand, which mustn't swing out through it */
  hold(boneName: string, amount: number): void {
    for (const j of this.joints) if (j.bone.name === boneName) j.held = amount
  }

  /** collider sphere given by its REST world position, carried by ``bone`` —
   *  or with ``end``, a capsule (tapering from ``radius`` to the end's) */
  addCollider(
    bone: THREE.Object3D,
    worldCenter: THREE.Vector3,
    radius: number,
    groups?: string[],
    end?: { at: THREE.Vector3; radius: number }
  ): void {
    bone.updateWorldMatrix(true, false)
    const offset = bone.worldToLocal(worldCenter.clone())
    const c: Collider = { bone, offset, radius, groups }
    if (end) {
      c.end = bone.worldToLocal(end.at.clone())
      c.endRadius = end.radius
    }
    this.colliders.push(c)
  }

  /** colliders in world space (debug view; a capsule has an end) */
  debugColliders(): { center: THREE.Vector3; radius: number; end?: THREE.Vector3; endRadius?: number }[] {
    return this.colliders.map((c) => ({
      center: c.offset.clone().applyMatrix4(c.bone.matrixWorld),
      radius: c.radius,
      end: c.end?.clone().applyMatrix4(c.bone.matrixWorld),
      endRadius: c.endRadius
    }))
  }

  /** snap every tail back to the posed rest (after teleports / long pauses) */
  reset(): void {
    for (const j of this.joints) {
      j.bone.quaternion.copy(j.restLocal)
      if (j.follow) {
        // a root turned with the limbs it lies over (it could start inside one)
        const parent = j.bone.parent as THREE.Object3D
        parent.updateWorldMatrix(true, false)
        parent.getWorldQuaternion(_q1)
        _q2.copy(_q1).multiply(j.restLocal)
        const restDir = _v1.copy(j.axis).applyQuaternion(_q2)
        this.followed(j, _target.copy(restDir))
        _delta.setFromUnitVectors(restDir, _target).multiply(_q2)
        j.bone.quaternion.copy(_q1.invert().multiply(_delta))
      }
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
      if (!cols[i]) cols[i] = { center: new THREE.Vector3(), radius: 0, end: null, endRadius: 0 }
      const now = cols[i]
      now.center.copy(c.offset).applyMatrix4(c.bone.matrixWorld)
      now.radius = c.radius
      if (c.end) {
        now.end = (now.end ?? new THREE.Vector3()).copy(c.end).applyMatrix4(c.bone.matrixWorld)
        now.endRadius = c.endRadius ?? c.radius
      } else now.end = null
      now.groups = c.groups
    }

    // a level at a time: a joint's head is where its parent's step left it
    for (let k = 0; k < this.depth; k++) {
      for (const chain of this.chains) if (chain[k]) this.move(chain[k], dt)
      for (const ring of this.rings.values()) this.clearRing(ring, k)
      for (const chain of this.chains) if (chain[k]) this.aim(chain[k])
    }
  }

  /** one step of a joint's tail */
  private move(j: Joint, dt: number): void {
    const cols = this.colliderScratch
    const parent = j.bone.parent as THREE.Object3D
    parent.updateWorldMatrix(true, false)
    // where the animated pose wants the tail
    parent.getWorldQuaternion(_q1)
    _q2.copy(_q1).multiply(j.restLocal) // bone world rotation at rest-in-pose
    const restDir = _v1.copy(j.axis).applyQuaternion(_q2)
    // ...turned with a limb raised under it
    const target = j.follow ? this.followed(j, _target.copy(restDir)) : restDir
    j.bone.getWorldPosition(_pos)

    const s = j.settings
    // verlet: inertia + stiffness + gravity
    const next = _v2
      .copy(j.tail)
      .addScaledVector(_v3.copy(j.tail).sub(j.prevTail), 1 - s.drag)
      .addScaledVector(target, s.stiffness * dt)
      .addScaledVector(_gravity, s.gravity * dt)
      .addScaledVector(this.external, dt * (s.wind ?? 0))
    // keep bone length
    next.sub(_pos).normalize().multiplyScalar(j.length).add(_pos)
    // push out of colliders (a sphere, or the nearest point of a capsule's line)
    for (const c of cols) {
      if (c.groups && !c.groups.includes(s.group ?? '')) continue
      let core = c.center
      let r = c.radius
      if (c.end) {
        _ab.copy(c.end).sub(c.center)
        const t = THREE.MathUtils.clamp(_core.copy(next).sub(c.center).dot(_ab) / Math.max(_ab.lengthSq(), 1e-9), 0, 1)
        core = _core.copy(c.center).addScaledVector(_ab, t)
        r += (c.endRadius - c.radius) * t
      }
      r += s.radius
      _v3.copy(next).sub(core)
      const d = _v3.length()
      if (d < r && d > 1e-6) {
        next.copy(core).addScaledVector(_v3, r / d)
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
      const restTail = _v4.copy(target).multiplyScalar(j.length).add(_pos)
      if (s.inward !== undefined || out !== undefined) this.keepWithin(j, next, restTail, s.inward, out)
      if (j.held > 0) next.lerp(restTail, Math.min(1, j.held))
      next.sub(_pos).normalize().multiplyScalar(j.length).add(_pos)
    }
    j.prevTail.copy(j.tail)
    j.tail.copy(next)
  }

  /** aim a joint's bone at its simulated tail */
  private aim(j: Joint): void {
    const parent = j.bone.parent as THREE.Object3D
    parent.getWorldQuaternion(_q1)
    _q2.copy(_q1).multiply(j.restLocal)
    const restDir = _v1.copy(j.axis).applyQuaternion(_q2).normalize()
    const to = _v3.copy(j.tail).sub(j.bone.getWorldPosition(_pos)).normalize()
    const worldRot = _delta.setFromUnitVectors(restDir, to).multiply(_q2)
    j.bone.quaternion.copy(_q1.invert().multiply(worldRot))
    j.bone.updateWorldMatrix(false, false)
  }

  /** the cloth between each pair of neighbouring chains in a ring, at level
   *  ``k``: where it runs through a collider, both tails move out together */
  private clearRing(ring: Joint[][], k: number): void {
    const n = ring.length
    if (n < 2) return
    for (let i = 0; i < n; i++) {
      const a = ring[i][k]
      const b = ring[(i + 1) % n][k]
      if (!a || !b || k < (a.settings.ring?.from ?? 0)) continue
      this.clearEdge(a, b)
    }
  }

  private clearEdge(a: Joint, b: Joint): void {
    const s = a.settings
    let moved = false
    for (const c of this.colliderScratch) {
      if (c.groups && !c.groups.includes(s.group ?? '')) continue
      const [u, t] = closestOnSegments(a.tail, b.tail, c.center, c.end ?? c.center)
      const core = _e2.copy(c.center)
      // (the bare collider, not grown by the chain's radius: the straight
      // line between two tails runs inside the cloth, which bows out round
      // her between its chains)
      let r = c.radius
      if (c.end) {
        core.lerp(c.end, t)
        r += (c.endRadius - c.radius) * t
      }
      const d = _e3.copy(_e1.copy(a.tail).lerp(b.tail, u)).sub(core)
      const dist = d.length()
      if (dist >= r || dist < 1e-6) continue
      // move the two ends so the closest point comes out by r − dist: each
      // by its share of it (a point u along moves (1−u)²+u² of a shared move)
      d.multiplyScalar((r - dist) / ((1 - u) * (1 - u) + u * u) / dist)
      a.tail.addScaledVector(d, 1 - u)
      b.tail.addScaledVector(d, u)
      moved = true
    }
    if (!moved) return
    keepLength(a)
    keepLength(b)
  }

  /** a root's rest direction ``dir`` (world, unit) turned with the limbs it
   *  lies over, as far as each has swung forward out of its rest pose */
  private followed(j: Joint, dir: THREE.Vector3): THREE.Vector3 {
    for (const f of j.follow ?? []) {
      ;(f.bone.parent as THREE.Object3D).getWorldQuaternion(_qf)
      const rest = _f1.copy(f.restLine).applyQuaternion(_qf)
      const now = f.child.getWorldPosition(_f2).sub(f.bone.getWorldPosition(_f3)).normalize()
      // swung back (a stride's trailing leg) it moves out from under the
      // cloth, which just hangs
      if (now.dot(_f3.copy(f.forward).applyQuaternion(_qf)) <= rest.dot(_f3)) continue
      const u = THREE.MathUtils.clamp((rest.angleTo(now) - f.from) / Math.max(f.to - f.from, 1e-6), 0, 1)
      const w = f.weight * u * u * (3 - 2 * u)
      if (w <= 0) continue
      dir.applyQuaternion(_qs.copy(_qId).slerp(_q3.setFromUnitVectors(rest, now), w))
    }
    return dir
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
