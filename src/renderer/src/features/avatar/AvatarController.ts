import * as THREE from 'three'
import type { AssistantState } from '@shared/types'
import type { AvatarRig } from './avatarAsset'
import type { Emotion, Gesture, Reading } from './emotion'
import { LipSync, VISEMES } from './lipsync'
import { SpringBones } from './springBones'
import { shared } from './toonMaterials'

/*
 * The avatar's "nervous system": everything that makes the model feel alive,
 * evaluated once per frame in a fixed order —
 *
 *   1. body clips   — a looping base per assistant state (Idle/Listen/Think/
 *                     Talk) crossfaded by hand, plus one-shot gestures on top
 *   2. head & gaze  — eyes track the cursor (or you), with saccades; the neck
 *                     and head follow part of the way, layered on the clip
 *   3. face         — emotion preset + natural blinking + lip-sync, blended
 *                     into the blendshapes with per-channel smoothing
 *   4. hair & cloth — spring bones react to whatever the body just did, plus
 *                     a faint ambient breeze
 *
 * Inputs arrive as plain fields/methods (state, pointer, emotion readings)
 * so React never re-renders on the hot path.
 */

type Preset = {
  m: Record<string, number>
  blush?: number
  lines?: number
  sparkle?: number
  pupil?: number
  gaze?: [number, number]
}

const PRESETS: Record<Emotion, Preset> = {
  neutral: { m: { M_Smile: 0.25 }, blush: 0.14 },
  relaxed: { m: { E_Relax: 0.42, M_Smile: 0.55 }, blush: 0.18 },
  happy: { m: { M_Smile: 0.9, E_Relax: 0.12, B_Up: 0.3 }, blush: 0.32 },
  joy: { m: { E_Happy: 1, M_Joy: 0.9, B_Up: 0.45 }, blush: 0.55 },
  excited: { m: { E_Wide: 0.45, M_Joy: 0.65, B_Up: 0.7 }, blush: 0.38, sparkle: 1, pupil: 1.12 },
  sad: { m: { E_Sad: 0.65, B_Sad: 0.95, M_Frown: 0.6 }, blush: 0.06, gaze: [0, -0.5], pupil: 1.06 },
  surprised: { m: { E_Wide: 1, B_Up: 1, M_Small: 0.9 }, pupil: 0.78, blush: 0.12 },
  angry: { m: { E_Angry: 0.6, B_Angry: 0.85, M_Pout: 0.8 }, blush: 0.35 },
  thinking: { m: { E_Relax: 0.2, B_Angry: 0.12, B_Up_L: 0.4, M_Pout: 0.3 }, gaze: [-0.55, 0.6], blush: 0.12 },
  shy: { m: { E_Relax: 0.3, M_Smile: 0.5, B_Sad: 0.4 }, blush: 1, lines: 1, gaze: [0.45, -0.5] }
}

/** what her face rests on in each assistant state (before any reading) */
const STATE_MOOD: Record<AssistantState, [Emotion, number]> = {
  idle: ['neutral', 1],
  listening: ['happy', 0.35],
  thinking: ['thinking', 1],
  speaking: ['happy', 0.4]
}

const BASE_CLIP: Record<AssistantState, string> = {
  idle: 'Idle',
  listening: 'Listen',
  thinking: 'Think',
  speaking: 'Talk'
}

const SIDED = ['E_Blink', 'E_Happy', 'E_Wide', 'E_Relax', 'E_Sad', 'E_Angry', 'B_Up', 'B_Angry', 'B_Sad']

const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _q3 = new THREE.Quaternion()
const _vPress = new THREE.Vector3()

type HandMoment = 'tap' | 'ripple' | 'flex' | 'open' | 'thumb' | 'wrist'
/** how a finger's lift (a negative curl) splits over its three joints */
const LIFT_SHARE = [1.25, 0.3, 0.1]
const _e = new THREE.Euler()
const _axis = new THREE.Vector3()

interface Track {
  action: THREE.AnimationAction
  w: number
  target: number
}

export class AvatarController {
  // ── inputs ──
  state: AssistantState = 'idle'
  speaking = false
  /** pointer in NDC, or null when the cursor is off the avatar canvas */
  pointer: THREE.Vector2 | null = null

  private rig: AvatarRig
  private headPivot: THREE.Vector3
  /** resting blush relative to the presets (tuned for a 0.14 base) */
  private blushScale: number
  private mixer: THREE.AnimationMixer
  private tracks = new Map<string, Track>()
  private baseName = 'Idle'
  private gesture: { name: string; track: Track; fadingOut: boolean } | null = null
  private gestureCooldown = 0
  private idleTimer = 14
  private talkGestureTimer = 6

  private morphIndex = new Map<string, { mesh: THREE.Mesh; index: number }[]>()
  private weights = new Map<string, number>()
  private lipsync = new LipSync()
  private springs = new SpringBones()

  // emotion
  private emotion: Emotion = 'neutral'
  private emotionIntensity = 0
  private emotionHold = 0
  private blush = 0
  private lines = 0
  private sparkle = 0
  private pupil = 1

  // blinking
  private blinkTimer = 2
  private blinkPhase = -1
  private doubleBlink = false

  // gaze (yaw, pitch) in "eye units" −1..1
  private gaze = new THREE.Vector2()
  private gazeTarget = new THREE.Vector2()
  private saccade = new THREE.Vector2()
  private saccadeTimer = 1
  private headYaw = 0
  private headPitch = 0
  private headTilt = 0
  private time = 0

  private restWorld = new Map<string, THREE.Quaternion>()
  private breathApplied = new Map<string, THREE.Quaternion>()
  /** living hands: every finger joint (axis: its curl axis in its own frame,
   *  w: share of the motion, phase: its own rhythm, side 0 = left, finger
   *  0 = thumb … 4 = little) and each wrist (flex / sideways axes) */
  private joints: {
    bone: THREE.Bone
    axis: THREE.Vector3
    w: number
    phase: number
    side: number
    finger: number
    seg: number
    q: THREE.Quaternion
  }[] = []
  private wrists: { bone: THREE.Bone; flex: THREE.Vector3; sway: THREE.Vector3; side: number; q: THREE.Quaternion }[] = []
  /** every rotation layered on top of the clips this frame (head turns,
   *  living hands), taken back off before the mixer runs: three's mixer only
   *  rewrites a bone when the clip's value CHANGES, so during a held pose
   *  (a bow, the end of a gesture) anything layered on top would otherwise
   *  compound frame after frame */
  private layered = new Map<THREE.Bone, THREE.Quaternion>()
  /** an occasional small hand "moment" (a tap, a flex…) */
  private moment: { kind: HandMoment; side: number; start: number; dur: number } | null = null
  private nextMoment = 6
  /** where the resting hand sits on her (hips space, in the base pose) and
   *  how pressed her clothes are under it right now (0..1) */
  private pressRest: THREE.Vector3 | null = null
  private pressGoal = 0

  constructor(rig: AvatarRig) {
    this.rig = rig
    this.headPivot = new THREE.Vector3(...rig.config.headPivot)
    this.blushScale = rig.config.blush / 0.14
    this.mixer = new THREE.AnimationMixer(rig.root)
    for (const clip of rig.clips) {
      const action = this.mixer.clipAction(clip)
      const once = !['Idle', 'Listen', 'Think', 'Talk'].includes(clip.name)
      if (once) {
        action.setLoop(THREE.LoopOnce, 1)
        action.clampWhenFinished = true
      }
      action.enabled = true
      action.setEffectiveWeight(0)
      this.tracks.set(clip.name, { action, w: 0, target: 0 })
    }
    const idle = this.tracks.get('Idle')
    if (idle) {
      idle.w = idle.target = 1
      idle.action.setEffectiveWeight(1).play()
    }

    for (const mesh of rig.morphMeshes) {
      const dict = mesh.morphTargetDictionary!
      for (const [name, index] of Object.entries(dict)) {
        if (!this.morphIndex.has(name)) this.morphIndex.set(name, [])
        this.morphIndex.get(name)!.push({ mesh, index })
      }
    }

    // rest orientations (relative to the avatar root) for additive head turns
    rig.root.updateWorldMatrix(true, true)
    const rootInv = rig.root.getWorldQuaternion(new THREE.Quaternion()).invert()
    for (const name of ['spine', 'chest', 'upperChest', 'neck', 'head']) {
      const b = rig.bones.get(name)
      if (b) this.restWorld.set(name, rootInv.clone().multiply(b.getWorldQuaternion(new THREE.Quaternion())))
    }

    this.setupFingers()
    this.setupSprings()
    // settle the first pose so the springs start from the idle stance
    this.mixer.update(0)
    rig.root.updateWorldMatrix(true, true)
    this.springs.reset()
    this.pressRest = this.handOnHips()
  }

  private setupSprings(): void {
    const b = (n: string): THREE.Bone | undefined => this.rig.bones.get(n)
    const chain = (prefix: string): THREE.Bone[] => {
      const out: THREE.Bone[] = []
      for (let i = 1; i < 10; i++) {
        const bone = b(`${prefix}_${i}`)
        if (!bone) break
        out.push(bone)
      }
      return out
    }
    this.rig.root.updateWorldMatrix(true, true)
    const { springs, colliders } = this.rig.config
    for (const s of springs) {
      const bones = chain(s.prefix)
      if (bones.length) this.springs.addChain(bones, s)
    }
    for (const c of colliders) {
      const bone = b(c.bone)
      if (bone) this.springs.addCollider(bone, new THREE.Vector3(...c.at), c.radius, c.groups)
    }
  }

  /** find each finger joint's curl axis from the rest pose: the palm normal
   *  comes from the knuckles' spread and the middle finger's direction, and
   *  points the way the (slightly curled) rest fingers bend */
  private setupFingers(): void {
    if (!this.rig.config.fingerLife) return
    const pos = (n: string): THREE.Vector3 | null => {
      const b = this.rig.bones.get(n)
      return b ? b.getWorldPosition(new THREE.Vector3()) : null
    }
    const q = new THREE.Quaternion()
    for (const [h, s] of (['left', 'right'] as const).entries()) {
      const idx = pos(`${s}IndexProximal`)
      const lit = pos(`${s}LittleProximal`)
      const mp = pos(`${s}MiddleProximal`)
      const mi = pos(`${s}MiddleIntermediate`)
      const md = pos(`${s}MiddleDistal`)
      if (!idx || !lit || !mp || !mi || !md) continue
      const dir = mi.clone().sub(mp).normalize()
      const palm = idx.clone().sub(lit).cross(dir).normalize()
      const bend = md.clone().sub(mi)
      bend.addScaledVector(dir, -bend.dot(dir))
      if (bend.dot(palm) < 0) palm.negate()
      const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Little']
      for (const [i, f] of fingers.entries()) {
        const segs = ['Proximal', 'Intermediate', 'Distal']
        for (const [k, seg] of segs.entries()) {
          const bone = this.rig.bones.get(`${s}${f}${seg}`)
          if (!bone) continue
          const a = bone.getWorldPosition(new THREE.Vector3())
          // a joint points at the next one; the last carries on its parent's line
          const next = k < 2 ? pos(`${s}${f}${segs[k + 1]}`) : null
          const prev = k === 2 ? pos(`${s}${f}${segs[1]}`) : null
          const fdir = next ? next.sub(a).normalize() : prev ? a.clone().sub(prev).normalize() : dir
          // positive turns curl the finger toward the palm
          const world = fdir.clone().cross(palm).normalize()
          const axis = world.applyQuaternion(bone.getWorldQuaternion(q).invert())
          const thumb = f === 'Thumb'
          this.joints.push({
            bone,
            axis,
            w: (thumb ? 0.5 : 1) * [1, 0.8, 0.6][k],
            phase: h * 1.7 + i * 0.9 + k * 0.25,
            side: h,
            finger: i,
            seg: k,
            q: new THREE.Quaternion()
          })
        }
      }
      // the wrist: flexing toward the palm, and tilting sideways
      const hand = this.rig.bones.get(`${s}Hand`)
      if (hand) {
        const toKnuckles = mp.clone().sub(hand.getWorldPosition(new THREE.Vector3())).normalize()
        const inv = hand.getWorldQuaternion(q).invert()
        this.wrists.push({
          bone: hand,
          flex: toKnuckles.clone().cross(palm).normalize().applyQuaternion(inv),
          sway: palm.clone().applyQuaternion(inv),
          side: h,
          q: new THREE.Quaternion()
        })
      }
    }
  }

  // ── public API ──

  /** true while a one-shot gesture (wave, stretch…) is playing */
  get gesturing(): boolean {
    return this.gesture !== null
  }

  /** a reading from the conversation (user message or reply sentence) */
  feel(r: Reading): void {
    if (r.intensity > 0.05 && r.emotion !== 'neutral') {
      // a stronger feeling overrides; a weaker one waits its turn
      if (r.intensity >= this.emotionIntensity * 0.7 || this.emotionHold <= 0) {
        this.emotion = r.emotion
        this.emotionIntensity = r.intensity
        this.emotionHold = 2.6 + r.intensity * 2.8
      }
    }
    if (r.gesture) this.play(r.gesture)
  }

  /** play a one-shot gesture clip (ignored while another is mid-flight) */
  play(name: Gesture | string, force = false): boolean {
    const track = this.tracks.get(name)
    // only one-shots are gestures; the state loops are driven by `state`
    if (!track || !isOneShot(name)) return false
    if (this.gesture && !force) return false
    if (this.gestureCooldown > 0 && !force) return false
    if (this.gesture) this.gesture.track.target = 0
    track.action.reset()
    track.action.play()
    track.target = 1
    this.gesture = { name, track, fadingOut: false }
    this.gestureCooldown = 1.2
    return true
  }

  /** the user poked her. Head → bashful headpat, body → a surprised giggle. */
  poke(point: THREE.Vector3): void {
    const head = point.y > 1.33
    if (head) {
      this.feel({ emotion: 'joy', intensity: 1 })
      this.blush = Math.max(this.blush, 0.9)
      this.lines = 1
      this.play('Shy', true)
    } else {
      const pick = Math.random()
      if (pick < 0.5) {
        this.feel({ emotion: 'surprised', intensity: 0.9 })
        this.play('Surprised', true)
      } else {
        this.feel({ emotion: 'joy', intensity: 0.9 })
        this.play('Happy', true)
      }
    }
  }

  // ── frame ──

  update(dt: number): void {
    dt = Math.min(dt, 0.1)
    this.time += dt
    shared.uTime.value = this.time

    this.updateBody(dt)
    // take last frame's finger drift back off first, in case a clip leaves a
    // joint unkeyed (the mixer would not reset it)
    for (const [bone, q] of this.layered) bone.quaternion.multiply(_q2.copy(q).invert())
    this.layered.clear()
    this.mixer.update(dt)
    this.applyHands()
    this.updateGaze(dt)
    this.applyHead(dt)
    this.updatePress()
    this.updateFace(dt)

    this.rig.root.updateWorldMatrix(true, true)
    // a faint, shifting breeze so hair and cloth never look frozen
    const t = this.time
    this.springs.external.set(
      Math.sin(t * 0.55) * 0.16 + Math.sin(t * 1.7 + 1.3) * 0.06,
      0,
      -0.08 + Math.sin(t * 0.8 + 0.4) * 0.07
    )
    const stepped = this.springs.update(dt) > 0
    this.applyBreath(stepped)

    // keep the face shading sphere glued to the moving head
    const head = this.rig.bones.get('head')
    if (head) shared.uHeadCenter.value.copy(this.headPivot).applyMatrix4(head.matrixWorld)
  }

  private updateBody(dt: number): void {
    const wantBase = BASE_CLIP[this.state] ?? 'Idle'
    if (wantBase !== this.baseName) {
      const prev = this.tracks.get(this.baseName)
      if (prev) prev.target = 0
      const next = this.tracks.get(wantBase)
      if (next) {
        if (next.w < 0.01) next.action.reset()
        next.action.play()
        next.target = 1
      }
      this.baseName = wantBase
    }

    // one-shot gestures: fade out just before the clip ends
    this.gestureCooldown = Math.max(0, this.gestureCooldown - dt)
    if (this.gesture) {
      const { track } = this.gesture
      const dur = track.action.getClip().duration
      if (!this.gesture.fadingOut && track.action.time >= dur - 0.35) {
        track.target = 0
        this.gesture.fadingOut = true
      }
      if (this.gesture.fadingOut && track.w < 0.02) {
        track.action.stop()
        track.w = 0
        this.gesture = null
      }
    }

    // ambient behaviour
    if (this.state === 'idle' && !this.gesture) {
      this.idleTimer -= dt
      if (this.idleTimer <= 0) {
        this.idleTimer = 18 + Math.random() * 22
        if (Math.random() < 0.45) this.play('Stretch')
        else this.feel({ emotion: 'relaxed', intensity: 0.7 })
      }
    } else {
      this.idleTimer = Math.max(this.idleTimer, 10)
    }
    if (this.state === 'speaking' && !this.gesture) {
      this.talkGestureTimer -= dt
      if (this.talkGestureTimer <= 0) {
        this.talkGestureTimer = 7 + Math.random() * 7
        this.play(Math.random() < 0.6 ? 'Explain' : 'Nod')
      }
    }

    // weights: the gesture takes its share, the base loops split the rest
    const gw = this.gesture ? this.gesture.track : null
    for (const [name, t] of this.tracks) {
      const isGesture = gw === t
      const rate = isGesture ? 7 : 3.2
      t.w += (t.target - t.w) * Math.min(1, dt * rate)
      if (!isGesture && !isOneShot(name) && t.target === 0 && t.w < 0.002 && name !== this.baseName) {
        if (t.action.isRunning()) t.action.stop()
        t.w = 0
      }
    }
    const g = gw ? gw.w : 0
    let baseSum = 0
    for (const [name, t] of this.tracks) if (!isOneShot(name)) baseSum += t.w
    for (const [name, t] of this.tracks) {
      if (isOneShot(name)) t.action.setEffectiveWeight(t === gw ? g : 0)
      else t.action.setEffectiveWeight(baseSum > 0 ? (t.w / baseSum) * (1 - g) : 0)
    }
  }

  private updateGaze(dt: number): void {
    // where she wants to look
    const preset = PRESETS[this.currentEmotion()]
    if (this.pointer) {
      this.gazeTarget.set(THREE.MathUtils.clamp(this.pointer.x * 1.4, -1, 1), THREE.MathUtils.clamp(this.pointer.y * 1.2 - 0.05, -1, 1))
    } else if (this.state === 'thinking') {
      this.gazeTarget.set(-0.55 + 0.15 * Math.sin(this.time * 0.7), 0.55 + 0.1 * Math.sin(this.time * 0.9))
    } else {
      this.gazeTarget.set(0, 0)
    }
    if (preset.gaze && !this.pointer) {
      const k = Math.min(1, this.emotionIntensity)
      this.gazeTarget.x += preset.gaze[0] * k
      this.gazeTarget.y += preset.gaze[1] * k
    }
    // micro-saccades keep the eyes alive
    this.saccadeTimer -= dt
    if (this.saccadeTimer <= 0) {
      this.saccadeTimer = 0.5 + Math.random() * 1.8
      this.saccade.set((Math.random() - 0.5) * 0.18, (Math.random() - 0.5) * 0.12)
    }
    const tx = THREE.MathUtils.clamp(this.gazeTarget.x + this.saccade.x, -1, 1)
    const ty = THREE.MathUtils.clamp(this.gazeTarget.y + this.saccade.y, -1, 1)
    // eyes are quick, the head follows lazily
    this.gaze.x += (tx - this.gaze.x) * Math.min(1, dt * 14)
    this.gaze.y += (ty - this.gaze.y) * Math.min(1, dt * 14)

    const m = this.rig.materials
    const [rx, ry] = this.rig.config.eyes.gaze
    const gx = this.gaze.x * rx
    const gy = this.gaze.y * ry
    ;(m.eyeL.uniforms.uGaze.value as THREE.Vector2).set(gx, gy)
    ;(m.eyeR.uniforms.uGaze.value as THREE.Vector2).set(gx, gy)
  }

  private applyHead(dt: number): void {
    const followYaw = this.gazeTarget.x * 22
    const followPitch = -this.gazeTarget.y * 12
    const tiltTarget =
      this.state === 'listening' ? -6 : this.currentEmotion() === 'shy' ? -8 : this.currentEmotion() === 'thinking' ? 5 : 0
    this.headYaw += (followYaw - this.headYaw) * Math.min(1, dt * 3)
    this.headPitch += (followPitch - this.headPitch) * Math.min(1, dt * 3)
    this.headTilt += (tiltTarget - this.headTilt) * Math.min(1, dt * 2)
    const sway = Math.sin(this.time * 0.6) * 1.2
    this.addRotation('neck', this.headPitch * 0.4, this.headYaw * 0.4, (this.headTilt + sway) * 0.4)
    this.addRotation('head', this.headPitch * 0.6, this.headYaw * 0.6, (this.headTilt + sway) * 0.6)
    // the upper body turns a touch toward what she's watching
    this.addRotation('upperChest', 0, this.headYaw * 0.12, 0)
  }

  /** the config's breath-synced lift, layered after the spring sim (which
   *  rewrites these bones every step, so this never accumulates) */
  /** Living hands, layered over whatever the clips pose:
   *  - every finger joint drifts a few degrees on its own slow, uneven rhythm
   *    — only ever lifting off its pose, so a hand resting on something
   *    never presses into it — and the free wrist breathes a little;
   *  - now and then a small "moment": fingers drumming or rippling on the
   *    resting hand; a flex, an opening, a thumb or a wrist turn on the free
   *    one. Livelier while she talks, calmer mid-gesture. */
  private applyHands(): void {
    const amp = this.rig.config.fingerLife
    if (!amp || !this.joints.length) return
    const t = this.time
    const lively = (this.state === 'speaking' ? 1.5 : 1) * (this.gesture ? 0.5 : 1)
    const drift = THREE.MathUtils.degToRad(amp) * lively
    this.scheduleMoment()
    for (const j of this.joints) {
      const c = Math.sin(t * 0.53 + j.phase) * 0.6 + Math.sin(t * 1.37 + 2.1 * j.phase) * 0.4
      const curl = -0.5 * (1 + c) * drift + this.momentCurl(j.side, j.finger)
      // a finger lifts at its knuckle — its outer joints barely straighten
      // (bending them all back reads as a squashed fingertip)
      const share = curl < 0 ? LIFT_SHARE[j.seg] / (j.finger === 0 ? 2 : 1) : j.w
      j.q.setFromAxisAngle(j.axis, curl * share)
      this.layer(j.bone, j.q)
    }
    const resting = this.restingSide()
    const D = THREE.MathUtils.degToRad
    for (const w of this.wrists) {
      if (w.side === resting) continue
      const ph = w.side * 2.3
      const flex = D(1.4) * lively * Math.sin(t * 0.41 + ph) + this.momentWrist(w.side)
      const sway = D(0.9) * lively * Math.sin(t * 0.29 + 1.1 + ph)
      w.q.setFromAxisAngle(w.flex, flex).multiply(_q3.setFromAxisAngle(w.sway, sway))
      this.layer(w.bone, w.q)
    }
  }

  /** the resting hand's wrist in hips space (null when the avatar has none) */
  private handOnHips(out = new THREE.Vector3()): THREE.Vector3 | null {
    const side = this.rig.config.restingHand
    const hand = side && this.rig.bones.get(`${side}Hand`)
    const hips = this.rig.bones.get('hips')
    if (!this.rig.config.handPress || !hand || !hips) return null
    hand.updateWorldMatrix(true, false)
    return hips.worldToLocal(hand.getWorldPosition(out))
  }

  /** the press under the resting hand: full while it rests where it was
   *  posed, gone once it has moved a few centimetres off */
  private updatePress(): void {
    if (!this.pressRest) return
    const now = this.handOnHips(_vPress)
    const d = now ? now.distanceTo(this.pressRest) : 1
    this.pressGoal = 1 - THREE.MathUtils.smoothstep(d, 0.015, 0.06)
  }

  /** 0 = left, 1 = right, -1 = neither: the hand her base pose rests on her */
  private restingSide(): number {
    const r = this.rig.config.restingHand
    return r === 'left' ? 0 : r === 'right' ? 1 : -1
  }

  private scheduleMoment(): void {
    if (this.moment && this.time > this.moment.start + this.moment.dur) this.moment = null
    if (this.moment || this.gesture || this.time < this.nextMoment) return
    const resting = this.restingSide()
    const free = resting === 0 ? 1 : 0
    const pool: [HandMoment, number, number][] = [
      ['flex', free, 1.5],
      ['open', free, 1.4],
      ['thumb', free, 0.9],
      ['wrist', free, 1.6]
    ]
    // a resting hand only ever lifts its fingers
    if (resting >= 0) pool.push(['tap', resting, 1.0], ['tap', resting, 1.0], ['ripple', resting, 1.1])
    const [kind, side, dur] = pool[Math.floor(Math.random() * pool.length)]
    this.moment = { kind, side, start: this.time, dur }
    const talking = this.state === 'speaking'
    this.nextMoment = this.time + dur + (talking ? 2.5 + Math.random() * 3 : 4.5 + Math.random() * 5.5)
  }

  /** the current moment's curl for one finger (radians; + curls, − lifts) */
  private momentCurl(side: number, finger: number): number {
    const m = this.moment
    if (!m || m.side !== side) return 0
    const u = (this.time - m.start) / m.dur
    if (u < 0 || u > 1) return 0
    const D = THREE.MathUtils.degToRad
    const bell = Math.sin(Math.PI * u) ** 2
    switch (m.kind) {
      case 'tap': {
        // index and middle drum twice on her hip, the middle a beat behind
        if (finger !== 1 && finger !== 2) return 0
        const lift = Math.max(0, Math.sin(4 * Math.PI * (u - (finger - 1) * 0.06)))
        return -D(16) * lift * Math.sin(Math.PI * u) ** 0.5
      }
      case 'ripple': {
        // little → index, each lifting a moment after the last
        if (finger === 0) return 0
        const v = Math.min(1, Math.max(0, (u - (4 - finger) * 0.12) / 0.55))
        return -D(12) * Math.sin(Math.PI * v) ** 2
      }
      case 'flex':
        return D(finger === 0 ? 7 : 11) * bell
      case 'open':
        return -D(finger === 0 ? 5 : 9) * bell
      case 'thumb':
        return finger === 0 ? D(16) * bell : 0
      default:
        return 0
    }
  }

  private momentWrist(side: number): number {
    const m = this.moment
    if (!m || m.side !== side || m.kind !== 'wrist') return 0
    const u = (this.time - m.start) / m.dur
    return u < 0 || u > 1 ? 0 : THREE.MathUtils.degToRad(7) * Math.sin(Math.PI * u) ** 2
  }

  private applyBreath(simStepped: boolean): void {
    const breath = this.rig.config.breath
    if (!breath) return
    const angle = Math.sin((this.time / breath.period) * Math.PI * 2) * THREE.MathUtils.degToRad(breath.degrees)
    for (const name of breath.bones) {
      const b = this.rig.bones.get(name)
      if (!b) continue
      // no sim step this frame → the bone still carries last frame's lift
      const prev = this.breathApplied.get(name)
      if (!simStepped && prev) b.quaternion.multiply(_q2.copy(prev).invert())
      // pitch about the world's left-right axis, expressed in the bone's frame
      b.getWorldQuaternion(_q).invert()
      const axis = _axis.set(1, 0, 0).applyQuaternion(_q)
      const lift = _q2.setFromAxisAngle(axis, angle)
      b.quaternion.multiply(lift)
      this.breathApplied.set(name, lift.clone())
    }
  }

  /** add a rotation expressed in the avatar's rest frame (degrees: pitch-down, yaw-left, tilt-left) */
  private addRotation(bone: string, pitch: number, yaw: number, tilt: number): void {
    const b = this.rig.bones.get(bone)
    const rest = this.restWorld.get(bone)
    if (!b || !rest) return
    const d = THREE.MathUtils.DEG2RAD
    _e.set(pitch * d, yaw * d, -tilt * d, 'YXZ')
    _q.setFromEuler(_e)
    // local *= R⁻¹ · Q · R
    _q2.copy(rest).invert().multiply(_q).multiply(rest)
    this.layer(b, _q2)
  }

  /** right-multiply a rotation onto a bone, remembering it so the next frame
   *  can take it back off before the mixer runs (see ``layered``) */
  private layer(bone: THREE.Bone, q: THREE.Quaternion): void {
    bone.quaternion.multiply(q)
    const prev = this.layered.get(bone)
    // two layers on one bone: (·A)(·B) is undone as (·B⁻¹)(·A⁻¹) = ·(AB)⁻¹
    if (prev) prev.multiply(q)
    else this.layered.set(bone, q.clone())
  }

  private currentEmotion(): Emotion {
    if (this.emotionHold > 0) return this.emotion
    return STATE_MOOD[this.state][0]
  }

  private updateFace(dt: number): void {
    // emotion decay → fall back to the state's resting mood
    this.emotionHold -= dt
    let emo: Emotion
    let amt: number
    if (this.emotionHold > 0) {
      emo = this.emotion
      amt = this.emotionIntensity * Math.min(1, this.emotionHold / 0.6)
    } else {
      ;[emo, amt] = STATE_MOOD[this.state]
      this.emotionIntensity = 0
    }
    const preset = PRESETS[emo]
    const neutral = PRESETS.neutral
    const target = new Map<string, number>()
    const add = (k: string, v: number): void => {
      if (SIDED.includes(k)) {
        target.set(k + '_L', (target.get(k + '_L') ?? 0) + v)
        target.set(k + '_R', (target.get(k + '_R') ?? 0) + v)
      } else target.set(k, (target.get(k) ?? 0) + v)
    }
    for (const [k, v] of Object.entries(neutral.m)) add(k, v * (1 - amt))
    for (const [k, v] of Object.entries(preset.m)) add(k, v * amt)

    // lip-sync on top: talking relaxes the expression's mouth a little
    // real audio when her voice is playing; a synthetic chatter while a
    // text-only reply streams, so her mouth still moves as she "talks"
    const talking = this.state === 'speaking'
    this.lipsync.update(dt, talking && this.speaking, talking && !this.speaking)
    const open = this.lipsync.openness
    for (const k of ['M_Joy', 'M_Small', 'M_Pout', 'M_Frown', 'M_Grin']) {
      if (target.has(k)) target.set(k, target.get(k)! * (1 - open * 0.75))
    }
    if (target.has('M_Smile')) target.set('M_Smile', target.get('M_Smile')! * (1 - open * 0.35))
    for (const v of VISEMES) add(v, this.lipsync.weights[v])

    // blinking — skipped while the eyes are already closed in a smile
    const closed = target.get('E_Happy_L') ?? 0
    let blink = 0
    this.blinkTimer -= dt
    if (this.blinkPhase < 0 && this.blinkTimer <= 0) {
      this.blinkPhase = 0
      this.doubleBlink = Math.random() < 0.18
    }
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt
      const p = this.blinkPhase
      blink = p < 0.06 ? p / 0.06 : p < 0.1 ? 1 : p < 0.2 ? 1 - (p - 0.1) / 0.1 : 0
      if (p >= 0.2) {
        if (this.doubleBlink) {
          this.blinkPhase = 0
          this.doubleBlink = false
        } else {
          this.blinkPhase = -1
          this.blinkTimer = 2.2 + Math.random() * 3.8
        }
      }
    }
    blink *= 1 - closed
    // blinking also follows big eye movements, like real people do
    if (Math.abs(this.gazeTarget.x - this.gaze.x) > 0.8 && this.blinkPhase < 0) this.blinkTimer = 0
    const eyelidLoad = (target.get('E_Relax_L') ?? 0) * 0.5 + closed
    add('E_Blink', Math.min(blink, 1 - Math.min(1, eyelidLoad)))
    // looking down lowers the lids a touch
    if (this.gaze.y < 0) add('E_Relax', -this.gaze.y * 0.25)

    const press = this.rig.config.handPress
    if (press) target.set(press, this.pressGoal)

    // smooth every channel toward its target
    for (const name of this.morphIndex.keys()) {
      const goal = THREE.MathUtils.clamp(target.get(name) ?? 0, 0, 1)
      const cur = this.weights.get(name) ?? 0
      const fast = name.startsWith('V_') || name.startsWith('E_Blink') || name === press
      const next = cur + (goal - cur) * Math.min(1, dt * (fast ? 30 : 7))
      this.weights.set(name, next)
      for (const { mesh, index } of this.morphIndex.get(name)!) mesh.morphTargetInfluences![index] = next
    }

    // shader-side expression channels
    const m = this.rig.materials
    const blushGoal =
      Math.max(preset.blush ?? 0.14, 0.12) * (emo === 'neutral' ? 1 : Math.max(0.35, amt)) * Math.min(1, this.blushScale + (preset.lines ?? 0))
    this.blush += (blushGoal - this.blush) * Math.min(1, dt * 2.5)
    this.lines += ((preset.lines ?? 0) * amt - this.lines) * Math.min(1, dt * 3)
    this.sparkle += ((preset.sparkle ?? 0) * amt - this.sparkle) * Math.min(1, dt * 4)
    this.pupil += ((preset.pupil ?? 1) - this.pupil) * Math.min(1, dt * 4)
    m.blush.uniforms.uAmount.value = this.blush
    m.blush.uniforms.uLines.value = this.lines
    m.eyeL.uniforms.uSparkle.value = m.eyeR.uniforms.uSparkle.value = this.sparkle
    m.eyeL.uniforms.uPupil.value = m.eyeR.uniforms.uPupil.value = this.pupil
    const w = (k: string): number => this.weights.get(k) ?? 0
    m.mouth.uniforms.uOpen.value = Math.min(1, open + w('M_Joy') * 0.95 + w('M_Small') * 0.8 + w('M_Grin') * 0.6)
    m.mouth.uniforms.uTeeth.value = Math.min(1, w('V_A') * 0.6 + w('V_E') * 0.9 + w('V_I') + w('M_Grin') + w('M_Joy') * 0.8)
  }

  /** world position of a bone (for the camera rig) */
  bonePosition(name: string, out: THREE.Vector3): THREE.Vector3 {
    const b = this.rig.bones.get(name)
    return b ? b.getWorldPosition(out) : out.set(0, 1.3, 0)
  }

  debugColliders(): { center: THREE.Vector3; radius: number }[] {
    return this.springs.debugColliders()
  }

  dispose(): void {
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.rig.root)
  }
}

function isOneShot(name: string): boolean {
  return !['Idle', 'Listen', 'Think', 'Talk'].includes(name)
}

