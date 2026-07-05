import { useState } from 'react'
import { motion } from 'framer-motion'
import { useUIStore } from '@/core/stores/useUIStore'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import { MicButton } from '@/features/voice/MicButton'
import { OrbScene } from '@/features/orb/OrbScene'

/**
 * Compact mode: a small always-on-top COSMOS — orb, last exchange,
 * mic and a one-line composer. Toggled from the palette or ⧉.
 */
export function MiniView(): React.JSX.Element {
  const toggleCompact = useUIStore((s) => s.toggleCompact)
  const { messages, state, send } = useAssistantStore()
  const stopSpeech = useVoiceStore((s) => s.stopSpeech)
  const [input, setInput] = useState('')

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && !m.tool && m.content)
  const busy = state === 'thinking' || state === 'speaking'

  const submit = (): void => {
    if (!input.trim()) return
    void send(input)
    setInput('')
  }

  return (
    <motion.div
      className="flex h-full w-full flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <header
        className="flex h-9 shrink-0 items-center justify-between px-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="neon font-display text-[10px] font-bold tracking-[0.3em]">COSMOS</span>
        <div className="flex gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={toggleCompact}
            title="Expand"
            className="rounded px-2 py-0.5 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
          >
            ⛶
          </button>
          <button
            onClick={() => void window.cosmos.app.windowControl('close')}
            className="rounded px-2 py-0.5 font-mono text-xs text-dim hover:bg-red-500/20 hover:text-red-300"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="relative h-48 shrink-0">
        <OrbScene />
      </div>

      <div className="min-h-0 flex-1 select-text overflow-y-auto px-4 py-2">
        {lastAssistant ? (
          <p className="whitespace-pre-wrap font-body text-xs leading-relaxed text-body">
            {lastAssistant.content}
          </p>
        ) : (
          <p className="text-center font-ui text-xs text-dim">Standing by.</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-white/5 p-2.5">
        <MicButton />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Ask Cosmos…"
          className="h-[42px] min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 font-body text-sm text-body placeholder:text-dim focus:border-[var(--accent)] focus:outline-none"
        />
        {busy && (
          <button
            onClick={stopSpeech}
            className="h-[42px] rounded-lg border border-red-400/40 px-2.5 font-ui text-[10px] font-bold uppercase text-red-300"
          >
            Stop
          </button>
        )}
      </div>
    </motion.div>
  )
}
