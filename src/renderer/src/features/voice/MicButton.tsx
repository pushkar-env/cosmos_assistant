import { motion, AnimatePresence } from 'framer-motion'
import { useVoiceStore } from './useVoiceStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'

/**
 * Mic control for the chat composer. When hands-free is on, the button
 * pauses/resumes it; otherwise it's push-to-talk (or Ctrl+J). The ring
 * pulses while listening, spins while transcribing.
 */
export function MicButton(): React.JSX.Element {
  const micMode = useVoiceStore((s) => s.micMode)
  const micStatus = useVoiceStore((s) => s.micStatus)
  const toggle = useVoiceStore((s) => s.toggleMic)
  const handsFreeEnabled = useSettingsStore((s) => s.settings.voice.handsFree)

  const listening = micStatus === 'listening'
  const transcribing = micStatus === 'transcribing'
  const active = micMode !== 'off'

  const title = handsFreeEnabled
    ? micMode === 'handsfree'
      ? 'Hands-free active — say "Cosmos…" (click to pause the mic)'
      : 'Hands-free paused — click to resume listening'
    : listening
      ? 'Listening — click when done (Ctrl+J)'
      : 'Speak to COSMOS (Ctrl+J)'

  return (
    <button
      onClick={() => void toggle()}
      title={title}
      className="relative flex h-[42px] w-[42px] items-center justify-center rounded-lg border transition-colors"
      style={{
        borderColor: active ? 'var(--accent)' : 'rgba(255,255,255,0.1)',
        background: active ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
        color: active ? 'var(--accent-bright)' : 'var(--text-dim)'
      }}
    >
      <AnimatePresence>
        {listening && (
          <motion.span
            className="absolute inset-0 rounded-lg"
            style={{ border: '1px solid var(--accent)' }}
            initial={{ opacity: 0.8, scale: 1 }}
            animate={{ opacity: 0, scale: 1.35 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.1, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
      </AnimatePresence>
      {transcribing ? (
        <motion.span
          className="block h-4 w-4 rounded-full border-2 border-transparent"
          style={{ borderTopColor: 'var(--accent-bright)' }}
          animate={{ rotate: 360 }}
          transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
        />
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z" />
          <path d="M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
        </svg>
      )}
    </button>
  )
}
