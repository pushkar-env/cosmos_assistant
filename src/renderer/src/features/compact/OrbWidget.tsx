import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useUIStore } from '@/core/stores/useUIStore'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import { OrbScene } from '@/features/orb/OrbScene'

/** how far (px) the pointer must travel before a press counts as a drag,
 *  not a click. Small enough to feel responsive, large enough to absorb the
 *  jitter of a hand releasing a mouse button. */
const DRAG_THRESHOLD = 4

interface DragState {
  pointerId: number
  /** cursor offset within the window, captured once so the anchor never drifts */
  offsetX: number
  offsetY: number
  moved: boolean
  raf: number | null
  pending: { x: number; y: number } | null
}

/**
 * The floating round orb — a tiny always-on-top presence. The ring lights up
 * when hands-free is on or COSMOS is listening. CLICK it to talk
 * (push-to-talk); DRAG it to move the orb anywhere on screen.
 *
 * Dragging is driven manually in JS (pointer events → IPC), NOT the OS-native
 * -webkit-app-region: drag. On Windows that native region swallowed the
 * click-to-talk tap (the mic never toggled) and jittered the transparent
 * window as the compositor fought the WebGL repaint. We instead anchor to the
 * cursor's offset within the window and push one position update per animation
 * frame — clicks fire reliably, movement is smooth. The expand control opens
 * the full window. Everything outside the circle is transparent.
 */
export function OrbWidget(): React.JSX.Element {
  const setMode = useUIStore((s) => s.setMode)
  const state = useAssistantStore((s) => s.state)
  const micMode = useVoiceStore((s) => s.micMode)
  // unified toggle: hands-free → pause/resume listening; otherwise push-to-talk.
  // Same handler the chat composer uses, so the mic state stays in sync across
  // the orb and the full window.
  const toggleMic = useVoiceStore((s) => s.toggleMic)
  const [hover, setHover] = useState(false)

  // drag bookkeeping lives in a ref so the RAF flush reads fresh values
  // without forcing re-renders on every mouse move
  const drag = useRef<DragState | null>(null)

  // cancel any in-flight frame if the orb unmounts mid-drag
  useEffect(() => {
    return () => {
      if (drag.current?.raf != null) cancelAnimationFrame(drag.current.raf)
    }
  }, [])

  const flushMove = (): void => {
    const d = drag.current
    if (!d) return
    d.raf = null
    if (!d.pending) return
    window.cosmos.app.orbMove(d.pending.x, d.pending.y)
    d.pending = null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return // left button only
    // window.screenX/Y is the orb window's top-left on screen; the difference
    // from the cursor's screen position is a fixed offset we keep for the drag
    drag.current = {
      pointerId: e.pointerId,
      offsetX: e.screenX - window.screenX,
      offsetY: e.screenY - window.screenY,
      moved: false,
      raf: null,
      pending: null
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    if (!d.moved) {
      // still within the click tolerance? don't start moving the window yet
      const traveled = Math.hypot(e.screenX - (window.screenX + d.offsetX), e.screenY - (window.screenY + d.offsetY))
      if (traveled < DRAG_THRESHOLD) return
      d.moved = true
    }
    // target top-left = current cursor (screen) minus the fixed grab offset
    d.pending = { x: e.screenX - d.offsetX, y: e.screenY - d.offsetY }
    if (d.raf == null) d.raf = requestAnimationFrame(flushMove)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    if (d.raf != null) {
      cancelAnimationFrame(d.raf)
      flushMove() // land the final position immediately
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    const wasClick = !d.moved
    drag.current = null
    if (wasClick) void toggleMic() // a tap that never became a drag = toggle mic
  }

  const listening = micMode !== 'off' || state === 'listening'
  const active = state !== 'idle'
  const ringColor =
    state === 'speaking'
      ? 'var(--accent-bright)'
      : state === 'thinking'
        ? 'var(--accent)'
        : listening
          ? 'var(--success)'
          : 'var(--accent-dim)'

  return (
    <div
      className="relative flex h-screen w-screen items-center justify-center overflow-hidden"
      style={{ background: 'transparent' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* the orb itself */}
      <div className="relative h-[120px] w-[120px]">
        <div className="absolute inset-0">
          <OrbScene />
        </div>

        {/* status ring */}
        <motion.div
          className="pointer-events-none absolute inset-1 rounded-full"
          style={{ border: `2px solid ${ringColor}` }}
          animate={active || listening ? { opacity: [0.4, 1, 0.4] } : { opacity: 0.5 }}
          transition={active || listening ? { duration: 1.4, repeat: Infinity } : undefined}
        />

        {/* whole orb = click-to-talk AND drag surface. A tap toggles the mic;
            dragging past the threshold moves the window (manual JS drag). */}
        <button
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          title="Click to toggle the mic · drag to move"
          className="absolute inset-0 touch-none rounded-full"
          style={{ background: 'transparent', cursor: 'grab' }}
        />

        {/* mic glyph */}
        <div
          className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2"
          style={{ color: listening ? 'var(--accent-bright)' : 'var(--text-dim)' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z" />
            <path d="M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
          </svg>
        </div>
      </div>

      {/* hover controls: expand + close-to-tray. Separate elements from the orb
          drag surface, so their clicks never start a drag. */}
      <motion.div
        className="absolute right-1 top-1 z-10 flex gap-1"
        initial={false}
        animate={{ opacity: hover ? 1 : 0 }}
        transition={{ duration: 0.15 }}
        style={{ pointerEvents: hover ? 'auto' : 'none' }}
      >
        <button
          onClick={() => setMode('full')}
          title="Open COSMOS"
          className="glass flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px] text-dim hover:text-body"
        >
          ⛶
        </button>
        <button
          onClick={() => void window.cosmos.app.windowControl('close')}
          title="Hide to tray"
          className="glass flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px] text-dim hover:text-red-300"
        >
          ✕
        </button>
      </motion.div>
    </div>
  )
}
