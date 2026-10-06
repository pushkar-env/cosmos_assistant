import * as THREE from 'three'
import { animate, type MotionValue } from 'framer-motion'

/*
 * The on-screen things she can touch: the HUD's stat cards (which she can
 * pick up, carry, squash and toss — they're framer-motion draggables, so she
 * drives the same x / y / scale motion values your mouse does) and buttons
 * she can press (the chat's "New").
 *
 * They live on "the glass" — a plane just in front of her in the 3D scene
 * that every DOM panel is pinned to: a point on screen maps to a point on
 * that plane, and back.
 */

export interface CardMotion {
  x: MotionValue<number>
  y: MotionValue<number>
  scale: MotionValue<number>
  rotate: MotionValue<number>
  rotateY: MotionValue<number>
}

export interface StageWidget {
  id: string
  kind: 'card' | 'button'
  el: HTMLElement
  /** cards: the transform she drives */
  motion?: CardMotion
  /** buttons: what a press does */
  press?: () => void
}

const registry = new Map<string, StageWidget>()

export const widgets = {
  register(w: StageWidget): () => void {
    registry.set(w.id, w)
    return () => {
      if (registry.get(w.id) === w) registry.delete(w.id)
    }
  },
  get(id: string): StageWidget | undefined {
    const w = registry.get(id)
    return w && w.el.isConnected ? w : undefined
  },
  /** the cards on screen, top to bottom */
  cards(): StageWidget[] {
    return [...registry.values()]
      .filter((w) => w.kind === 'card' && w.motion && w.el.isConnected && visible(w.el))
      .sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top)
  }
}

function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 4 && r.height > 4 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight
}

export interface CardHome {
  x: number
  y: number
  scale: number
  rotate: number
  rotateY: number
}

export function cardState(w: StageWidget): CardHome {
  const m = w.motion!
  return { x: m.x.get(), y: m.y.get(), scale: m.scale.get(), rotate: m.rotate.get(), rotateY: m.rotateY.get() }
}

/** the card's centre on screen if its x/y offset were zero (its layout slot) */
export function layoutCenter(w: StageWidget): { x: number; y: number } {
  const r = w.el.getBoundingClientRect()
  const m = w.motion!
  return { x: r.left + r.width / 2 - m.x.get(), y: r.top + r.height / 2 - m.y.get() }
}

/** spring a card back to a saved state */
export function springTo(w: StageWidget, s: CardHome, delay = 0): void {
  const m = w.motion!
  const spring = { type: 'spring' as const, stiffness: 150, damping: 17, delay }
  animate(m.x, s.x, spring)
  animate(m.y, s.y, spring)
  animate(m.scale, s.scale, spring)
  animate(m.rotate, s.rotate, spring)
  animate(m.rotateY, s.rotateY, { ...spring, stiffness: 90, damping: 14 })
}

/** stop anything animating a card's transform (she's taking it) */
export function stopCard(w: StageWidget): void {
  const m = w.motion!
  for (const v of [m.x, m.y, m.scale, m.rotate, m.rotateY]) v.stop()
}

// ── the glass ────────────────────────────────────────────────────────────

/** how far in front of her home spot the glass hangs (world z, m) */
export const GLASS_Z = 0.34

const _ray = new THREE.Raycaster()
const _ndc = new THREE.Vector2()
const _plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -GLASS_Z)

export interface Projector {
  camera: THREE.Camera
  canvas: HTMLCanvasElement
}

export const view: Projector & { ready: boolean } = {
  camera: new THREE.PerspectiveCamera(),
  canvas: null as unknown as HTMLCanvasElement,
  ready: false
}

/** a screen point (CSS px) → the glass (world) */
export function screenToGlass(x: number, y: number, out = new THREE.Vector3(), z = GLASS_Z): THREE.Vector3 {
  const r = view.canvas.getBoundingClientRect()
  _ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1)
  view.camera.updateMatrixWorld()
  _ray.setFromCamera(_ndc, view.camera)
  _plane.constant = -z
  return _ray.ray.intersectPlane(_plane, out) ?? out.set(0, 1, z)
}

/** a world point → the screen (CSS px) */
export function worldToScreen(p: THREE.Vector3, out = { x: 0, y: 0 }): { x: number; y: number } {
  const r = view.canvas.getBoundingClientRect()
  view.camera.updateMatrixWorld()
  const v = p.clone().project(view.camera)
  out.x = r.left + ((v.x + 1) / 2) * r.width
  out.y = r.top + ((1 - v.y) / 2) * r.height
  return out
}

/** how many CSS px one metre spans on the glass, near a point */
export function pxPerMetre(at: THREE.Vector3): number {
  const a = worldToScreen(at)
  const b = worldToScreen(at.clone().add(new THREE.Vector3(0.1, 0, 0)))
  return Math.hypot(b.x - a.x, b.y - a.y) * 10
}

// ── DOM effects ──────────────────────────────────────────────────────────

let overlay: HTMLDivElement | null = null

function fxLayer(): HTMLDivElement {
  if (overlay && overlay.isConnected) return overlay
  overlay = document.createElement('div')
  overlay.className = 'stage-fx'
  document.body.appendChild(overlay)
  return overlay
}

/** a ring rippling out across the glass where she touched it */
export function touchRipple(x: number, y: number, kind: 'tap' | 'grab' | 'press' | 'release' = 'tap'): void {
  const el = document.createElement('div')
  el.className = `stage-ripple stage-ripple-${kind}`
  el.style.left = `${x}px`
  el.style.top = `${y}px`
  fxLayer().appendChild(el)
  setTimeout(() => el.remove(), 900)
}

/** a little burst of sparks (her finger snap) */
export function sparkBurst(x: number, y: number): void {
  const layer = fxLayer()
  for (let i = 0; i < 9; i++) {
    const el = document.createElement('div')
    el.className = 'stage-spark'
    const a = (i / 9) * Math.PI * 2 + Math.random() * 0.4
    const d = 26 + Math.random() * 22
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.setProperty('--dx', `${Math.cos(a) * d}px`)
    el.style.setProperty('--dy', `${Math.sin(a) * d}px`)
    layer.appendChild(el)
    setTimeout(() => el.remove(), 700)
  }
}

export function setHeld(w: StageWidget, on: boolean): void {
  if (on) w.el.dataset.stageHeld = 'true'
  else delete w.el.dataset.stageHeld
}

export function flashPressed(w: StageWidget, ms = 260): void {
  w.el.dataset.stagePressed = 'true'
  setTimeout(() => delete w.el.dataset.stagePressed, ms)
}
