import { useState } from 'react'
import { motion } from 'framer-motion'
import { useUIStore } from '@/core/stores/useUIStore'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import { OrbScene } from '@/features/orb/OrbScene'

/**
 * The floating round orb — a tiny always-on-top presence. The ring lights
 * up when hands-free is on or COSMOS is listening; click it to talk
 * (push-to-talk); the expand control opens the full window. Everything
 * outside the circle is transparent (the window is transparent).
 */
export function OrbWidget(): React.JSX.Element {
  const setMode = useUIStore((s) => s.setMode)
  const state = useAssistantStore((s) => s.state)
  const micMode = useVoiceStore((s) => s.micMode)
  const togglePTT = useVoiceStore((s) => s.togglePushToTalk)
  const [hover, setHover] = useState(false)

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
      style={{ background: 'transparent', WebkitAppRegion: 'drag' } as React.CSSProperties}
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

        {/* click target = push-to-talk (whole orb) */}
        <button
          onClick={() => void togglePTT()}
          title="Click to talk"
          className="absolute inset-0 rounded-full"
          style={{ WebkitAppRegion: 'no-drag', background: 'transparent' } as React.CSSProperties}
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

      {/* hover controls: expand + close-to-tray */}
      <motion.div
        className="absolute right-1 top-1 flex gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        initial={false}
        animate={{ opacity: hover ? 1 : 0 }}
        transition={{ duration: 0.15 }}
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
