import * as THREE from 'three'
import type { AssistantState } from '@shared/types'
import type { NovaRig } from './avatarAsset'
import type { Emotion, Gesture, Reading } from './emotion'
import { LipSync, VISEMES } from './lipsync'
import { SpringBones } from './springBones'
import { shared } from './toonMaterials'

/*
 * Nova's "nervous system": everything that makes the model feel alive,
 * evaluated once per frame in a fixed order —
 *
 *   1. body clips   — a looping base per assistant state (Idle/Listen/Think/
 *                     Talk) crossfaded by hand, plus one-shot gestures on top
 *   2. head & gaze  — eyes track the cursor (or you), with saccades; the neck
 *                     and head follow part of the way, layered on the clip
 *   3. face         — emotion preset + natural blinking + lip-sync, blended
 *                     into the blendshapes with per-channel smoothing
 *   4. hair         — spring bones react to whatever the body just did
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
const _e = new THREE.Euler()
const HEAD_PIVOT_OFFSET = new THREE.Vector3(0, 0.085, 0.006)

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

  private rig: NovaRig
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
  private blush = 0.14
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

  constructor(rig: NovaRig) {
    this.rig = rig
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

    this.setupSprings()
    // settle the first pose so the springs start from the idle stance
    this.mixer.update(0)
    rig.root.updateWorldMatrix(true, true)
    this.springs.reset()
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
    const back = { stiffness: 0.85, drag: 0.32, gravity: 0.25, radius: 0.016 }
    for (const g of ['hair_back_C', 'hair_back_L', 'hair_back_R']) this.springs.addChain(chain(g), back)
    for (const g of ['hair_side_L', 'hair_side_R']) this.springs.addChain(chain(g), { stiffness: 1.1, drag: 0.38, gravity: 0.2, radius: 0.008 })
    this.springs.addChain(chain('hair_ahoge'), { stiffness: 3.2, drag: 0.22, gravity: 0, radius: 0 })

    const col = (bone: string, x: number, y: number, z: number, r: number): void => {
      const bb = b(bone)
      if (bb) this.springs.addCollider(bb, new THREE.Vector3(x, y, z), r)
    }
    col('head', 0, 1.405, -0.004, 0.1)
    col('neck', 0, 1.27, 0.0, 0.038)
    col('upperChest', 0, 1.15, -0.005, 0.088)
    col('chest', 0, 1.05, 0.0, 0.088)
    col('spine', 0, 0.96, 0.0, 0.09)
    col('hips', 0, 0.86, -0.005, 0.11)
    col('leftUpperArm', 0.15, 1.16, 0, 0.055)
    col('rightUpperArm', -0.15, 1.16, 0, 0.055)
  }

  // ── public API ──

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
    this.mixer.update(dt)
    this.updateGaze(dt)
    this.applyHead(dt)
    this.updateFace(dt)

    this.rig.root.updateWorldMatrix(true, true)
    this.springs.update(dt)

    // keep the face shading sphere glued to the moving head
    const head = this.rig.bones.get('head')
    if (head) shared.uHeadCenter.value.copy(HEAD_PIVOT_OFFSET).applyMatrix4(head.matrixWorld)
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
    const gx = this.gaze.x * 0.0072
    const gy = this.gaze.y * 0.0045
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
    b.quaternion.multiply(_q2)
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

    // smooth every channel toward its target
    for (const name of this.morphIndex.keys()) {
      const goal = THREE.MathUtils.clamp(target.get(name) ?? 0, 0, 1)
      const cur = this.weights.get(name) ?? 0
      const fast = name.startsWith('V_') || name.startsWith('E_Blink')
      const next = cur + (goal - cur) * Math.min(1, dt * (fast ? 30 : 7))
      this.weights.set(name, next)
      for (const { mesh, index } of this.morphIndex.get(name)!) mesh.morphTargetInfluences![index] = next
    }

    // shader-side expression channels
    const m = this.rig.materials
    const blushGoal = Math.max(preset.blush ?? 0.14, 0.12) * (emo === 'neutral' ? 1 : Math.max(0.35, amt))
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

