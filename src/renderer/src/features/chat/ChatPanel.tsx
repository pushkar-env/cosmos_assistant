import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { DEFAULT_MODELS, type ProviderId } from '@shared/types'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import { MicButton } from '@/features/voice/MicButton'
import { ToolCard } from './ToolCard'
import { ApprovalCard } from './ApprovalCard'
import { Glass } from '@/shared/ui/Glass'
import { StatusDot } from '@/shared/ui/StatusDot'
import { Markdown } from '@/shared/ui/Markdown'

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'anthropic', label: 'Claude' },
  { id: 'openai', label: 'GPT' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'ollama', label: 'Ollama' }
]

export function ChatPanel(): React.JSX.Element {
  const { messages, state, send, clear } = useAssistantStore()
  const { settings, update } = useSettingsStore()
  const voiceError = useVoiceStore((s) => s.error)
  const micMode = useVoiceStore((s) => s.micMode)
  const stopSpeech = useVoiceStore((s) => s.stopSpeech)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** stay pinned to the bottom only while the user hasn't scrolled up */
  const stickToBottom = useRef(true)

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottom.current = distanceFromBottom < 60
  }

  useEffect(() => {
    const el = scrollRef.current
    // instant jump (not smooth) so rapid streaming tokens don't stack
    // overlapping scroll animations; respect the user reading higher up
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const busy = state === 'thinking' || state === 'speaking'

  const submit = (): void => {
    if (!input.trim()) return
    stickToBottom.current = true // a fresh message always scrolls into view
    void send(input)
    setInput('')
  }

  const switchProvider = (id: ProviderId): void => {
    // restore this provider's last-used model instead of resetting to default
    const model = settings.providerModels[id] ?? DEFAULT_MODELS[id]
    void update({ provider: id, model })
  }

  return (
    <motion.div
      className="absolute inset-y-0 right-0 z-20 flex w-[380px] flex-col justify-center py-8 pr-6"
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.3, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
    >
      <Glass className="flex max-h-full min-h-[70%] flex-col overflow-hidden">
        {/* provider switcher */}
        <div className="flex items-center gap-1 border-b border-white/5 px-4 py-3">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => switchProvider(p.id)}
              className={`rounded-md px-2.5 py-1 font-ui text-xs font-semibold uppercase tracking-widest transition-all ${
                settings.provider === p.id
                  ? 'neon bg-white/5'
                  : 'text-dim hover:bg-white/5 hover:text-body'
              }`}
            >
              {p.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={clear}
              disabled={messages.length === 0}
              title="New chat (clears the current conversation)"
              className="flex items-center gap-1 rounded-md px-2 py-1 font-ui text-xs font-semibold uppercase tracking-widest text-dim transition-colors hover:bg-white/5 hover:text-body disabled:pointer-events-none disabled:opacity-30"
            >
              <span className="text-sm leading-none">+</span> New
            </button>
            <StatusDot active={busy} />
          </div>
        </div>

        {/* transcript */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-4 py-4 select-text"
        >
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <p className="neon font-display text-sm uppercase tracking-[0.3em]">
                Welcome to COSMOS
              </p>
              <p className="max-w-[240px] font-ui text-sm text-dim">
                I'm online and ready. Ask me anything, tell me to open an app or play a song, or
                press <span className="neon">Ctrl+Space</span> for the command palette.
              </p>
            </div>
          )}
          <AnimatePresence initial={false}>
            {messages
              .filter(
                (m, i) =>
                  m.tool || m.content !== '' || (i === messages.length - 1 && busy)
              )
              .map((m) =>
                m.tool ? (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                  >
                    <ToolCard tool={m.tool} />
                  </motion.div>
                ) : (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
              >
                <div
                  className={`max-w-[85%] break-words [overflow-wrap:anywhere] rounded-xl px-3.5 py-2.5 font-body text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'whitespace-pre-wrap rounded-br-sm bg-white/10 text-body'
                      : m.error
                        ? 'whitespace-pre-wrap rounded-bl-sm border border-red-500/30 text-red-300'
                        : 'rounded-bl-sm text-body'
                  }`}
                  style={
                    m.role === 'assistant' && !m.error
                      ? { background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }
                      : undefined
                  }
                >
                  {m.content ? (
                    m.role === 'assistant' && !m.error ? (
                      <Markdown>{m.content}</Markdown>
                    ) : (
                      m.content
                    )
                  ) : (
                    <span className="inline-flex gap-1">
                      {[0, 1, 2].map((i) => (
                        <motion.span
                          key={i}
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: 'var(--accent)' }}
                          animate={{ opacity: [0.2, 1, 0.2] }}
                          transition={{ repeat: Infinity, duration: 1, delay: i * 0.18 }}
                        />
                      ))}
                    </span>
                  )}
                </div>
              </motion.div>
                )
              )}
          </AnimatePresence>
        </div>

        <ApprovalCard />

        {/* composer */}
        <div className="border-t border-white/5 p-3">
          {(voiceError || micMode === 'handsfree') && (
            <p
              className={`mb-2 px-1 font-mono text-[10px] uppercase tracking-widest ${
                voiceError ? 'text-red-300' : 'neon'
              }`}
            >
              {voiceError ?? 'Hands-free active — say "Cosmos…"'}
            </p>
          )}
          <div className="flex items-end gap-2">
            <MicButton />
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              rows={1}
              placeholder={`Message ${PROVIDERS.find((p) => p.id === settings.provider)?.label}…`}
              className="max-h-32 min-h-[42px] flex-1 resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 font-body text-sm text-body placeholder:text-dim focus:border-[var(--accent)] focus:outline-none"
            />
            {busy ? (
              <button
                onClick={stopSpeech}
                className="h-[42px] rounded-lg border border-red-400/40 px-3 font-ui text-xs font-bold uppercase tracking-widest text-red-300 transition-colors hover:bg-red-500/10"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!input.trim()}
                className="h-[42px] rounded-lg px-4 font-ui text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-30"
                style={{
                  background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
                  border: '1px solid var(--accent-dim)',
                  color: 'var(--accent-bright)'
                }}
              >
                Send
              </button>
            )}
          </div>
          <p className="mt-1.5 px-1 font-mono text-[10px] text-dim">
            {settings.model} · Enter to send · Shift+Enter for newline
          </p>
        </div>
      </Glass>
    </motion.div>
  )
}
