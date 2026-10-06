import * as THREE from 'three'
import { animate } from 'framer-motion'
import { sound } from '@/core/sound/SoundEngine'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import type { Reading } from '../emotion'
import { Actor, SHAPES, defaultPole, isAborted, type HandShape, type HandTarget } from './actor'
import { sideSign, type Side } from './body'
import { CROUCH_DEPTH } from './locomotion'
import { useStageStore } from './bridge'
import {
  GLASS_Z,
  flashPressed,
  screenToGlass,
  sparkBurst,
  touchRipple,
  widgets,
  worldToScreen,
  type StageWidget
} from './widgets'

/*
 * The director: decides WHEN she acts and stages each scene —
 *   · idle play: left alone for a while, she wanders over to the HUD and
 *     plays with the cards (pulls one out and carries it about, squishes and
 *     stretches one between her palms, tosses one and catches it, boops one,
 *     flicks one into a spin, crouching for the low ones), then snaps her
 *     fingers and they all spring back home;
 *   · "start a new chat": she turns, walks to the chat window, presses "New"
 *     with a fingertip and tells you it's done;
 *   · interruptions: a message mid-scene dissolves her and she re-forms at
 *     home, ready to answer.
 */

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _Y = new THREE.Vector3(0, 1, 0)

type Kind = 'play' | 'newchat'

/** left alone, she plays every this many seconds — counted from the last
 *  thing you did or the end of her last play */
export const IDLE_LOOP = 30

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const shuffle = <T>(xs: T[]): T[] => xs.map((x) => [Math.random(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x)

export class Director {
  private run: { ctl: AbortController; kind: Kind } | null = null
  private teleporting: Promise<void> | null = null
  private idleFor = 0
  private pressDone = false
  private readonly offs: (() => void)[] = []

  constructor(
    private readonly actor: Actor,
    private readonly feel: (r: Reading) => void
  ) {
    const bump = (): void => {
      this.idleFor = 0
    }
    for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) {
      window.addEventListener(ev, bump, { passive: true })
      this.offs.push(() => window.removeEventListener(ev, bump))
    }
    // only a pointer that really moved counts: Chromium also fires moves when
    // the page shifts under a resting cursor (cards springing home, the HUD
    // updating), which would keep her waiting forever
    let px = NaN
    let py = NaN
    const moved = (e: PointerEvent): void => {
      if (Math.abs(e.screenX - px) + Math.abs(e.screenY - py) > 2 || Number.isNaN(px)) bump()
      px = e.screenX
      py = e.screenY
    }
    window.addEventListener('pointermove', moved, { passive: true })
    this.offs.push(() => window.removeEventListener('pointermove', moved))
  }

  dispose(): void {
    this.offs.forEach((f) => f())
    this.run?.ctl.abort()
    this.actor.releaseAll()
    this.actor.tidy(0)
    useStageStore.getState().setActing(false)
  }

  get busy(): boolean {
    return this.run !== null || this.teleporting !== null
  }

  // ── triggers ───────────────────────────────────────────────────────────

  /** every frame: count idle time, and start playing when it's been long enough */
  tick(dt: number): void {
    const ui = useUIStore.getState()
    const as = useAssistantStore.getState()
    const quiet =
      as.state === 'idle' &&
      !as.activeRequestId &&
      ui.mode === 'full' &&
      ui.activePanel === 'none' &&
      !ui.paletteOpen &&
      ui.windowVisible &&
      useVoiceStore.getState().micMode !== 'ptt'
    if (!quiet || this.busy) {
      this.idleFor = 0
      return
    }
    this.idleFor += dt
    if (this.idleFor < IDLE_LOOP) return
    this.idleFor = 0
    if (useSettingsStore.getState().settings.avatarPlay === false) return
    this.playNow()
  }

  /** a play session, now (false if she's busy or there's nothing to play with) */
  playNow(): boolean {
    if (this.busy || widgets.cards().length === 0) return false
    void this.perform('play', (sig) => this.play(sig))
    return true
  }

  /** dev/testing aid: play chosen bits — with the HUD: 'squish' | 'toss'
   *  (after a carry), 'carry', 'boop', 'flip', 'peek'; anywhere: 'left' |
   *  'right' (a stroll), 'crouch' — then tidy and go home */
  playBits(bits: string[]): boolean {
    const cardBits = ['squish', 'toss', 'carry', 'boop', 'flip', 'peek']
    const needsCards = bits.some((b) => cardBits.includes(b))
    if (this.busy || (needsCards && widgets.cards().length === 0)) return false
    void this.perform('play', async (sig) => {
      const a = this.actor
      for (const b of bits) {
        if (b === 'left' || b === 'right') {
          const sg = b === 'left' ? 1 : -1
          await a.walkTo(a.loco.pos.x + sg * 0.7, 0.02, sg * 0.25, sig)
          await a.wait(0.6, sig)
        } else if (b === 'crouch') {
          await a.crouchTo(1, sig)
          await a.wait(0.8, sig)
          await a.crouchTo(0, sig)
        } else if (b === 'squish' || b === 'toss' || b === 'carry') {
          const w = await this.carryOut(sig)
          if (w && b === 'squish') await this.squish(w, sig)
          if (w && b === 'toss') await this.toss(w, sig)
        } else if (b === 'boop') await this.boop(sig)
        else if (b === 'flip') await this.flip(sig)
        else if (b === 'peek') await this.peekLow(sig)
      }
      if (needsCards) await this.snapTidy(sig)
    })
    return true
  }

  /** could she walk over and press New now (or once she's back home)? */
  canAct(): boolean {
    const ui = useUIStore.getState()
    return !!widgets.get('chat-new') && ui.mode === 'full' && ui.activePanel === 'none' && ui.windowVisible && this.run === null
  }

  /** walk to the chat and press New. Resolves true once she pressed it. */
  async newChat(): Promise<boolean> {
    if (this.teleporting) await this.teleporting
    if (!this.canAct()) return false
    this.pressDone = false
    let pressed!: (ok: boolean) => void
    const done = new Promise<boolean>((r) => (pressed = r))
    void this.perform('newchat', (sig) => this.pressNew(sig, () => pressed(true))).then(() => {
      // interrupted before the press: say it wasn't her
      pressed(this.pressDone)
    })
    return done
  }

  /** a message arrived: anything she's in the middle of, she drops */
  userMessage(): void {
    if (!this.run) return
    const kind = this.run.kind
    this.run.ctl.abort()
    this.run = null
    // a new chat she hadn't pressed yet still happens — you asked for it
    if (kind === 'newchat' && !this.pressDone) {
      this.pressDone = true
      useAssistantStore.getState().clear()
    }
    this.teleport()
  }

  /** your hand took a card from hers: she lets you have it and goes home
   *  (the others she put back; that one is yours now) */
  userGrabbed(id: string): void {
    const w = widgets.get(id)
    if (!w || !this.run) return
    this.actor.forget(w)
    this.userMessage()
  }

  private teleport(): void {
    if (this.teleporting) return
    sound.play('teleport')
    this.teleporting = this.actor.teleportHome().finally(() => {
      this.teleporting = null
      if (!this.run) useStageStore.getState().setActing(false)
    })
  }

  // ── running a scene ────────────────────────────────────────────────────

  private async perform(kind: Kind, scene: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.busy) return
    const ctl = new AbortController()
    this.run = { ctl, kind }
    useStageStore.getState().setActing(true)
    const a = this.actor
    a.begin()
    try {
      await scene(ctl.signal)
      await this.goHome(ctl.signal)
      await a.end(ctl.signal)
    } catch (e) {
      if (!isAborted(e)) {
        console.error('[stage] scene failed:', e)
        if (this.run?.ctl === ctl) {
          this.run = null
          this.teleport()
        }
      }
    } finally {
      if (this.run?.ctl === ctl) {
        this.run = null
        if (!this.teleporting) useStageStore.getState().setActing(false)
      }
    }
  }

  private async goHome(signal: AbortSignal): Promise<void> {
    const a = this.actor
    a.lookAtViewer()
    await Promise.all([a.rest('left', 0.6, signal), a.rest('right', 0.6, signal)])
    await a.crouchTo(0, signal)
    const far = Math.hypot(a.loco.pos.x - a.home.x, a.loco.pos.z - a.home.z)
    await a.walkTo(a.home.x, a.home.z, 0, signal, far > 0.5 ? 0.75 : 0.5)
    a.lookAt(null)
    await a.wait(0.15, signal)
  }

  // ── hands on the glass ─────────────────────────────────────────────────

  /** a palm laid on the glass at `at` (fingers up, leaning out) */
  private palmOn(side: Side, at: () => THREE.Vector3, shape: HandShape = SHAPES.touch): HandTarget {
    const sg = sideSign(side)
    return {
      at,
      dir: new THREE.Vector3(sg * 0.32, 1, 0).normalize(),
      palm: new THREE.Vector3(0, 0, 1),
      contact: 'palm',
      pole: defaultPole(side, this.actor.loco.yaw),
      shape
    }
  }

  /** an index fingertip on the glass at `at`: up at the shoulder and above
   *  (pad to the glass), pointing in at it lower down (a bent wrist pointing
   *  a finger UP at something below the shoulder looks broken) */
  private fingerOn(side: Side, at: () => THREE.Vector3): HandTarget {
    const sg = sideSign(side)
    const a = this.actor
    const shoulder = a.body.shoulderHeight - a.loco.crouch * CROUCH_DEPTH * 1.15
    const low = smoothstep(-0.08, -0.42, at().y - shoulder)
    return {
      at,
      dir: new THREE.Vector3(sg * (0.12 + 0.2 * low), 1 - 0.8 * low, 0.1 + 0.9 * low).normalize(),
      palm: new THREE.Vector3(0, -0.1 - 0.9 * low, 1 - 0.8 * low).normalize(),
      contact: 'index',
      pole: new THREE.Vector3(sg * 0.6, -1, -0.15).applyAxisAngle(_Y, this.actor.loco.yaw).normalize(),
      shape: SHAPES.point
    }
  }

  /** a point on a card, on the glass (or `back` m behind it) — live */
  private onCard(w: StageWidget, fx: number, fy: number, back = 0): () => THREE.Vector3 {
    const out = new THREE.Vector3()
    return () => {
      const r = w.el.getBoundingClientRect()
      return screenToGlass(r.left + r.width * fx, r.top + r.height * fy, out, GLASS_Z - back)
    }
  }

  /** stand where `side`'s hand reaches `p`, crouching if it's low */
  private async approach(p: THREE.Vector3, side: Side, signal: AbortSignal): Promise<void> {
    const a = this.actor
    const st = a.standFor(p, side)
    const far = Math.hypot(st.x - a.loco.pos.x, st.z - a.loco.pos.z)
    if (far > 0.12 && a.loco.crouch > 0.05) await a.crouchTo(0, signal)
    if (far > 0.02 || Math.abs(st.yaw - a.loco.yaw) > 0.05) await a.walkTo(st.x, st.z, st.yaw, signal)
    await a.crouchTo(st.crouch, signal, undefined, side)
  }

  /** the card nearest her side of the HUD, or a random one */
  private cardFor(prefer?: (w: StageWidget) => number): StageWidget | null {
    const cards = widgets.cards()
    if (!cards.length) return null
    if (!prefer) return pick(cards)
    return cards.map((w) => [prefer(w) + Math.random() * 0.4, w] as const).sort((x, y) => y[0] - x[0])[0][1]
  }

  /** which hand reaches a card: the one on its side of her */
  private sideFor(w: StageWidget): Side {
    const p = this.actor.cardPoint(w, 0.5, 0.5, _v)
    return p.x < this.actor.loco.pos.x ? 'right' : 'left'
  }

  // ── idle play ──────────────────────────────────────────────────────────

  private async play(signal: AbortSignal): Promise<void> {
    const a = this.actor
    this.feel({ emotion: 'happy', intensity: 0.75 })
    const first = this.cardFor()
    if (!first) return
    // a mischievous look at the cards before heading over
    a.lookAt(this.onCard(first, 0.5, 0.5), 0.9)
    await a.wait(0.7, signal)

    const solo = [() => this.boop(signal), () => this.flip(signal), () => this.peekLow(signal)]
    const carried = [(w: StageWidget) => this.squish(w, signal), (w: StageWidget) => this.toss(w, signal)]
    // a carry with a trick on the card she pulled out, plus one or two solo bits
    const plan: (() => Promise<void>)[] = shuffle(solo).slice(0, 1 + Math.round(Math.random()))
    plan.splice(Math.floor(Math.random() * (plan.length + 1)), 0, async () => {
      const w = await this.carryOut(signal)
      if (w) await pick(carried)(w)
    })
    for (const step of plan) await step()
    await this.snapTidy(signal)
  }

  /** pull a card out of the HUD and carry it toward the middle */
  private async carryOut(signal: AbortSignal): Promise<StageWidget | null> {
    const a = this.actor
    const w = this.cardFor((c) => {
      const p = a.cardPoint(c, 0.5, 0.5, _v)
      // middling heights are the nicest to carry
      return 1 - Math.abs(p.y - 1.15)
    })
    if (!w) return null
    const side = this.sideFor(w)
    const sg = sideSign(side)
    const grab = this.onCard(w, side === 'right' ? 0.62 : 0.38, 0.52)
    const g0 = grab().clone()
    await this.approach(g0, side, signal)
    a.lookAt(grab)
    await a.reach(side, this.palmOn(side, () => _v2.copy(grab()).setZ(GLASS_Z - 0.07)), 0.75, signal, new THREE.Vector3(-sg * 0.04, 0.05, -0.02))
    await a.reach(side, this.palmOn(side, grab), 0.16, signal)
    sound.play('grab')
    a.grab(w, [side])
    await a.setShape(side, SHAPES.grip, 0.14, signal)
    this.feel({ emotion: 'happy', intensity: 0.8 })

    // carry: the hand rides with her as she side-steps toward the middle
    const rel = new THREE.Vector3(g0.x - a.loco.pos.x, g0.y, 0)
    const carry = (): THREE.Vector3 => _v2.set(a.loco.pos.x + rel.x, rel.y, GLASS_Z)
    await a.reach(side, this.palmOn(side, carry, SHAPES.grip), 0.3, signal)
    // stand up for the walk if she crouched for it
    const lift = Math.max(0, a.atShoulder(-0.25) - rel.y)
    if (a.loco.crouch > 0.05) {
      await Promise.all([
        a.crouchTo(0, signal, 0.6),
        a.tween(0.6, (u) => (rel.y = g0.y + lift * u), signal)
      ])
    }
    const toX = a.loco.pos.x - sg * (0.28 + Math.random() * 0.12)
    await a.walkTo(toX, a.loco.pos.z, -sg * 0.12, signal, 0.5, 0.25)
    // bring it in front of her and give it a little shake
    const goal = new THREE.Vector3(-sg * 0.16, a.atShoulder(-0.19 + Math.random() * 0.12), 0)
    const start = rel.clone()
    await a.tween(0.7, (u) => rel.lerpVectors(start, goal, u * u * (3 - 2 * u)), signal)
    a.lookAt(() => a.handPoint(side, _v))
    for (let i = 0; i < 2; i++) {
      const y0 = rel.y
      await a.tween(0.16, (u) => (rel.y = y0 + 0.025 * Math.sin(u * Math.PI)), signal)
    }
    return w
  }

  /** she holds `w` in one hand (the carry): squeeze it small, stretch it big */
  private async squish(w: StageWidget, signal: AbortSignal): Promise<void> {
    const a = this.actor
    const held = this.heldBy(w)
    if (!held) return
    const other: Side = held === 'left' ? 'right' : 'left'
    // bring it down to her middle first (stretched big it mustn't hide her face)
    {
      const r0 = w.el.getBoundingClientRect()
      const c0 = screenToGlass(r0.left + r0.width / 2, r0.top + r0.height / 2, new THREE.Vector3())
      const h0 = a.handPoint(held).clone()
      h0.y += a.atShoulder(-0.27) - c0.y
      await a.reach(held, this.palmOn(held, () => h0, SHAPES.grip), 0.5, signal)
    }
    // let go with the holding hand, then palms on both edges
    a.release(w)
    const r = w.el.getBoundingClientRect()
    const centre = screenToGlass(r.left + r.width / 2, r.top + r.height / 2, new THREE.Vector3())
    const half = r.width / 2 / a.pxPerMetre()
    // each palm sits `k` of the half-width out from the middle
    let k = 0.78
    const at = (side: Side): (() => THREE.Vector3) => {
      const out = new THREE.Vector3()
      return () => out.set(centre.x + sideSign(side) * half * k, centre.y, GLASS_Z)
    }
    const palm = (side: Side): HandTarget => ({ ...this.palmOn(side, at(side), SHAPES.grip), dir: new THREE.Vector3(sideSign(side) * 0.45, 1, 0).normalize() })
    a.lookAt(() => centre)
    await Promise.all([
      a.reach(held, palm(held), 0.45, signal),
      a.reach(other, palm(other), 0.8, signal, new THREE.Vector3(0, 0.05, -0.03))
    ])
    sound.play('grab')
    a.grab(w, ['left', 'right'], true)
    this.feel({ emotion: 'excited', intensity: 0.8 })
    // squeeze… stretch… settle
    const squeeze = async (to: number, dur: number): Promise<void> => {
      const from = k
      await a.tween(dur, (u) => (k = from + (to - from) * (u * u * (3 - 2 * u))), signal)
    }
    await squeeze(0.5, 0.7)
    await a.wait(0.15, signal)
    await squeeze(1.04, 0.8)
    await a.wait(0.2, signal)
    await squeeze(0.78, 0.5)
    sound.play('release')
    a.release(w)
    await Promise.all([a.setShape('left', SHAPES.touch, 0.12, signal), a.setShape('right', SHAPES.touch, 0.12, signal)])
    const back = (side: Side): HandTarget => this.palmOn(side, () => _v.copy(at(side)()).setZ(GLASS_Z - 0.07))
    await Promise.all([a.reach('left', back('left'), 0.25, signal), a.reach('right', back('right'), 0.25, signal)])
    await Promise.all([a.rest('left', 0.7, signal), a.rest('right', 0.7, signal)])
  }

  /** she holds `w` in one hand: toss it up and catch it */
  private async toss(w: StageWidget, signal: AbortSignal): Promise<void> {
    const a = this.actor
    const side = this.heldBy(w)
    if (!side) return
    const sg = sideSign(side)
    const h0 = a.handPoint(side).clone()
    const rel = new THREE.Vector3(h0.x - a.loco.pos.x, h0.y, 0)
    const hand = (): THREE.Vector3 => _v2.set(a.loco.pos.x + rel.x, rel.y, GLASS_Z)
    await a.reach(side, this.palmOn(side, hand, SHAPES.grip), 0.12, signal)
    // wind up, then flick
    const y0 = rel.y
    await a.tween(0.32, (u) => (rel.y = y0 - 0.09 * (u * u * (3 - 2 * u))), signal)
    await a.tween(0.13, (u) => (rel.y = y0 - 0.09 + 0.2 * u), signal)
    sound.play('whoosh')
    // the catch: open palm, a little toward her middle and lower
    const catchRel = new THREE.Vector3(rel.x - sg * 0.16, y0 - 0.02, 0)
    const r = w.el.getBoundingClientRect()
    const hp = worldToScreen(a.handPoint(side, _v))
    const grip = { x: r.left + r.width / 2 - hp.x, y: r.top + r.height / 2 - hp.y }
    // up as high as the window allows (the card's top stays on screen)
    const apex = Math.max(90, Math.min(240, r.top - 70 + r.height * 0.2))
    const flight = a.fly(
      w,
      () => {
        const p = worldToScreen(a.handPoint(side, _v))
        return { x: p.x + grip.x, y: p.y + grip.y }
      },
      0.95,
      apex,
      360
    )
    a.lookAt(() => {
      const rr = w.el.getBoundingClientRect()
      return screenToGlass(rr.left + rr.width / 2, rr.top + rr.height / 2, _v)
    })
    this.feel({ emotion: 'excited', intensity: 0.9 })
    const start = rel.clone()
    await Promise.all([
      a.setShape(side, SHAPES.open, 0.2, signal),
      a.tween(0.85, (u) => rel.lerpVectors(start, catchRel, u * u * (3 - 2 * u)), signal),
      flight
    ])
    if (signal.aborted) return
    sound.play('grab')
    a.grab(w, [side])
    await a.setShape(side, SHAPES.grip, 0.1, signal)
    // the catch lands with a little give
    const yc = rel.y
    await a.tween(0.28, (u) => (rel.y = yc - 0.03 * Math.sin(u * Math.PI)), signal)
    this.feel({ emotion: 'joy', intensity: 0.9 })
    await a.wait(0.35, signal)
    sound.play('release')
    a.release(w)
    await a.setShape(side, SHAPES.touch, 0.12, signal)
    await a.reach(side, this.palmOn(side, () => _v.copy(hand()).setZ(GLASS_Z - 0.07)), 0.22, signal)
    await a.rest(side, 0.6, signal)
  }

  /** boop a card twice with a fingertip — it jiggles */
  private async boop(signal: AbortSignal, w0?: StageWidget): Promise<void> {
    const a = this.actor
    const w = w0 ?? this.cardFor()
    if (!w) return
    a.remember(w)
    const side = this.sideFor(w)
    const spot = this.onCard(w, side === 'right' ? 0.66 : 0.34, 0.45)
    await this.approach(spot().clone(), side, signal)
    a.lookAt(spot)
    const hover = (): THREE.Vector3 => _v2.copy(spot()).setZ(GLASS_Z - 0.06)
    await a.reach(side, this.fingerOn(side, hover), 0.7, signal)
    for (let i = 0; i < 2; i++) {
      await a.reach(side, this.fingerOn(side, spot), 0.11, signal)
      const p = worldToScreen(a.handPoint(side, _v))
      touchRipple(p.x, p.y, 'tap')
      sound.play('tap')
      this.jiggle(w)
      if (i === 0) this.feel({ emotion: 'joy', intensity: 0.85 })
      await a.reach(side, this.fingerOn(side, hover), 0.16, signal)
      await a.wait(0.18, signal)
    }
    await a.rest(side, 0.6, signal)
  }

  /** for the lowest card: crouch down to it and boop it */
  private async peekLow(signal: AbortSignal): Promise<void> {
    const a = this.actor
    const w = this.cardFor((c) => -a.cardPoint(c, 0.5, 0.5, _v).y)
    if (!w) return
    await this.boop(signal, w)
  }

  /** flick a card's edge: it spins round */
  private async flip(signal: AbortSignal): Promise<void> {
    const a = this.actor
    const w = this.cardFor()
    if (!w) return
    a.remember(w)
    const side = this.sideFor(w)
    const near = side === 'right' ? 0.92 : 0.08
    const far = side === 'right' ? 0.6 : 0.4
    const start = this.onCard(w, near, 0.5)
    await this.approach(start().clone(), side, signal)
    a.lookAt(this.onCard(w, 0.5, 0.5))
    await a.reach(side, this.fingerOn(side, () => _v2.copy(start()).setZ(GLASS_Z - 0.05)), 0.65, signal)
    await a.reach(side, this.fingerOn(side, start), 0.1, signal)
    const p = worldToScreen(a.handPoint(side, _v))
    touchRipple(p.x, p.y, 'tap')
    sound.play('whoosh')
    // the flick runs across the edge as the card starts to turn
    const end = this.onCard(w, far, 0.42, 0.05)
    const m = w.motion!
    const rot = m.rotateY.get()
    void animate(m.rotateY, rot + 360 * (side === 'right' ? -1 : 1), { duration: 1.1, ease: [0.2, 0.7, 0.3, 1] }).then(() => m.rotateY.set(rot))
    await a.reach(side, this.fingerOn(side, end), 0.16, signal)
    this.feel({ emotion: 'excited', intensity: 0.9 })
    await a.wait(0.9, signal)
    await a.rest(side, 0.6, signal)
  }

  /** a finger snap by her shoulder — and every card she moved springs home */
  private async snapTidy(signal: AbortSignal): Promise<void> {
    const a = this.actor
    if (!a.touchedCards.length) return
    await a.crouchTo(0, signal)
    const side: Side = 'right'
    const sg = sideSign(side)
    const at = (): THREE.Vector3 => _v2.set(a.loco.pos.x + sg * 0.24, a.atShoulder(0.07), a.loco.pos.z + 0.24)
    a.lookAtViewer()
    await a.reach(
      side,
      {
        at,
        dir: new THREE.Vector3(sg * 0.25, 1, 0.15).normalize(),
        palm: new THREE.Vector3(-sg * 0.75, 0, 0.65).normalize(),
        contact: 'wrist',
        pole: defaultPole(side, a.loco.yaw),
        shape: SHAPES.snapReady
      },
      0.65,
      signal
    )
    await a.wait(0.12, signal)
    await a.setShape(side, SHAPES.snapped, 0.07, signal)
    sound.play('snap')
    const tip = worldToScreen(a.handPoint(side, _v))
    sparkBurst(tip.x, tip.y - 20)
    a.tidy(0.07)
    this.feel({ emotion: 'joy', intensity: 0.9 })
    await a.wait(0.55, signal)
    await a.rest(side, 0.6, signal)
  }

  private heldBy(w: StageWidget): Side | null {
    const r = w.el.dataset.stageHeld ? w.el.getBoundingClientRect() : null
    if (!r) return null
    const c = screenToGlass(r.left + r.width / 2, r.top + r.height / 2, _v)
    const dl = c.distanceTo(this.actor.handPoint('left', new THREE.Vector3()))
    const dr = c.distanceTo(this.actor.handPoint('right', new THREE.Vector3()))
    return dl < dr ? 'left' : 'right'
  }

  private jiggle(w: StageWidget): void {
    const m = w.motion!
    const s = m.scale.get()
    void animate(m.scale, [s, s * 0.92, s * 1.05, s], { duration: 0.42, ease: 'easeOut' })
    const r = m.rotate.get()
    void animate(m.rotate, [r, r - 4, r + 3, r], { duration: 0.42, ease: 'easeOut' })
  }

  // ── "start a new chat" ─────────────────────────────────────────────────

  private async pressNew(signal: AbortSignal, onPressed: () => void): Promise<void> {
    const a = this.actor
    const btn = widgets.get('chat-new')
    if (!btn) return
    const target = (): THREE.Vector3 => {
      const r = btn.el.getBoundingClientRect()
      return screenToGlass(r.left + r.width / 2, r.top + r.height / 2, _v)
    }
    const p = target().clone()
    const side: Side = p.x >= a.loco.pos.x ? 'left' : 'right'
    // a glance at the chat, then she goes
    a.lookAt(target, 0.9)
    this.feel({ emotion: 'happy', intensity: 0.7 })
    await a.wait(0.15, signal)
    const st = a.standFor(p, side)
    await a.walkTo(st.x, st.z, st.yaw, signal, 0.9)
    await a.crouchTo(st.crouch, signal)
    // raise a fingertip to just behind the button, then press it
    const high = p.y > a.body.shoulderHeight + 0.1
    if (high) a.shrug(side, 0.14)
    const hover = (): THREE.Vector3 => _v2.copy(target()).setZ(GLASS_Z - 0.06)
    await a.reach(side, this.fingerOn(side, hover), 0.65, signal, new THREE.Vector3(sideSign(side) * 0.05, 0.02, -0.04))
    await a.wait(0.06, signal)
    await a.reach(side, this.fingerOn(side, target), 0.12, signal)
    const tip = worldToScreen(a.handPoint(side, _v))
    touchRipple(tip.x, tip.y, 'press')
    flashPressed(btn)
    sound.play('tap')
    this.pressDone = true
    btn.press?.()
    onPressed()
    await a.wait(0.14, signal)
    await a.reach(side, this.fingerOn(side, hover), 0.18, signal)
    a.shrug(side, 0)
    // turn to you with a thumbs up, and tell you
    a.lookAtViewer()
    this.feel({ emotion: 'joy', intensity: 0.9 })
    const thumb: Side = side === 'left' ? 'right' : 'left'
    const tg = sideSign(thumb)
    const thumbAt = (): THREE.Vector3 => _v2.set(a.loco.pos.x + tg * 0.1, a.atShoulder(-0.13), a.loco.pos.z + 0.3)
    await Promise.all([
      a.rest(side, 0.6, signal),
      a.turnTo(0, signal),
      a.reach(
        thumb,
        {
          at: thumbAt,
          dir: new THREE.Vector3(-tg * 0.25, 0.1, 1).normalize(),
          palm: new THREE.Vector3(-tg, 0, 0),
          contact: 'wrist',
          pole: defaultPole(thumb, 0),
          shape: SHAPES.thumbsUp
        },
        0.6,
        signal
      )
    ])
    useAssistantStore.getState().confirmNewChat()
    await a.wait(1.1, signal)
    await a.rest(thumb, 0.5, signal)
  }
}
