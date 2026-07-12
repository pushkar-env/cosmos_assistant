import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ASSISTANT_MODES, DEFAULT_MODELS, type Attachment, type ProviderId } from '@shared/types'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import { useNotificationStore } from '@/core/stores/useNotificationStore'
import { MicButton } from '@/features/voice/MicButton'
import { ToolCard } from './ToolCard'
import { ApprovalCard } from './ApprovalCard'
import { SessionList } from './SessionList'
import { AttachmentChips } from './AttachmentChips'
import { processFiles } from './attachments'
import { Glass } from '@/shared/ui/Glass'
import { StatusDot } from '@/shared/ui/StatusDot'
import { Markdown } from '@/shared/ui/Markdown'
import { localize, resolvePreset } from '@shared/personality'

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'anthropic', label: 'Claude' },
  { id: 'openai', label: 'GPT' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'ollama', label: 'Ollama' }
]

export function ChatPanel(): React.JSX.Element {
  const { messages, state, send, clear } = useAssistantStore()
  const sessions = useAssistantStore((s) => s.sessions)
  const currentSessionId = useAssistantStore((s) => s.currentSessionId)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const { settings, update } = useSettingsStore()
  const voiceError = useVoiceStore((s) => s.error)
  const micMode = useVoiceStore((s) => s.micMode)
  const stopSpeech = useVoiceStore((s) => s.stopSpeech)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** stay pinned to the bottom only while the user hasn't scrolled up */
  const stickToBottom = useRef(true)
  const notify = useNotificationStore((s) => s.push)

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
  const canSend = input.trim().length > 0 || attachments.length > 0

  const submit = (): void => {
    if (!canSend) return
    stickToBottom.current = true // a fresh message always scrolls into view
    void send(input, attachments)
    setInput('')
    setAttachments([])
  }

  /** ingest picked / dropped / pasted files, surfacing any per-file problems */
  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const { attachments: added, errors } = await processFiles(files, attachments.length)
    if (added.length) setAttachments((prev) => [...prev, ...added])
    if (errors.length) {
      notify({ title: 'Attachment', body: errors[0], kind: 'error' })
    }
  }

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files?.length) void addFiles(e.target.files)
    e.target.value = '' // allow re-picking the same file
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files)
  }

  const onPaste = (e: React.ClipboardEvent): void => {
    const files = Array.from(e.clipboardData.files)
    if (files.length) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const removeAttachment = (id: string): void =>
    setAttachments((prev) => prev.filter((a) => a.id !== id))

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
      <Glass
        className="relative flex max-h-full min-h-[70%] flex-col overflow-hidden"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            if (!dragging) setDragging(true)
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={onDrop}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center rounded-[inherit] border-2 border-dashed border-[var(--accent)] bg-black/70 backdrop-blur-sm">
            <p className="neon font-display text-sm uppercase tracking-[0.3em]">
              Drop to attach
            </p>
          </div>
        )}
        {/* sessions bar */}
        <div className="relative flex items-center gap-2 border-b border-white/5 px-4 py-2">
          <button
            onClick={() => setSessionsOpen((o) => !o)}
            title="Chats — switch, rename, delete"
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 font-ui text-xs text-dim transition-colors hover:bg-white/5 hover:text-body ${
              sessionsOpen ? 'bg-white/5 text-body' : ''
            }`}
          >
            <span className="text-sm leading-none">☰</span>
            <span className="truncate font-semibold">
              {sessions.find((s) => s.id === currentSessionId)?.title ?? 'New chat'}
            </span>
            <span className="ml-auto shrink-0 text-[9px]">▾</span>
          </button>
          <button
            onClick={clear}
            disabled={messages.length === 0}
            title="New chat"
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-ui text-xs font-semibold uppercase tracking-widest text-dim transition-colors hover:bg-white/5 hover:text-body disabled:pointer-events-none disabled:opacity-30"
          >
            <span className="text-sm leading-none">+</span> New
          </button>
          <StatusDot active={busy} />
          {sessionsOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setSessionsOpen(false)} />
              <AnimatePresence>
                <SessionList onClose={() => setSessionsOpen(false)} />
              </AnimatePresence>
            </>
          )}
        </div>

        {/* provider switcher */}
        <div className="flex items-center gap-1 border-b border-white/5 px-4 py-2">
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
        </div>

        {/* transcript */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="smooth-scroll flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-4 py-4 select-text"
        >
          {messages.length === 0 &&
            (() => {
              const persona = resolvePreset(settings.personality.presetId)
              const plang = settings.voice.language === 'hi' ? 'hi' : 'en'
              return (
                <div className="flex h-full flex-col items-center justify-center gap-2.5 text-center">
                  <span className="text-2xl leading-none">{persona.emoji}</span>
                  <p
                    className="font-display text-sm uppercase tracking-[0.3em]"
                    style={{ color: persona.color }}
                  >
                    {persona.label}
                  </p>
                  <p className="max-w-[260px] font-body text-sm italic text-body">
                    “{localize(persona.sample, plang)}”
                  </p>
                  <p className="max-w-[240px] font-ui text-xs text-dim">
                    Ask me anything, or press <span className="neon">Ctrl+Space</span> for commands ·{' '}
                    <button
                      onClick={() => useUIStore.getState().setPanel('personality')}
                      className="underline decoration-dotted underline-offset-2 transition-colors hover:text-body"
                    >
                      change personality
                    </button>
                  </p>
                </div>
              )
            })()}
          <AnimatePresence initial={false}>
            {messages
              .filter(
                (m, i) =>
                  m.tool ||
                  m.content !== '' ||
                  (m.attachments?.length ?? 0) > 0 ||
                  (i === messages.length - 1 && busy)
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
                  {m.attachments?.length ? (
                    <div className={m.content ? 'mb-2' : ''}>
                      <AttachmentChips attachments={m.attachments} />
                    </div>
                  ) : null}
                  {m.content ? (
                    m.role === 'assistant' && !m.error ? (
                      <Markdown>{m.content}</Markdown>
                    ) : (
                      m.content
                    )
                  ) : m.role === 'assistant' && !m.attachments?.length ? (
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
                  ) : null}
                </div>
              </motion.div>
                )
              )}
          </AnimatePresence>
        </div>

        <ApprovalCard />

        {/* composer */}
        <div className="border-t border-white/5 p-3">
          {/* mode selector: Chat / Agent / Research / Ultra */}
          <div className="mb-2 flex items-center gap-1">
            {ASSISTANT_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => void update({ assistantMode: m.id })}
                title={m.hint}
                className={`flex-1 rounded-md px-1.5 py-1 font-ui text-[10px] font-bold uppercase tracking-wider transition-colors ${
                  settings.assistantMode === m.id
                    ? 'border border-[var(--accent-dim)] bg-white/5 text-[var(--accent-bright)]'
                    : 'border border-transparent text-dim hover:bg-white/5 hover:text-body'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {(voiceError || micMode === 'handsfree') && (
            <p
              className={`mb-2 px-1 font-mono text-[10px] uppercase tracking-widest ${
                voiceError ? 'text-red-300' : 'neon'
              }`}
            >
              {voiceError ?? 'Hands-free active — say "Cosmos…"'}
            </p>
          )}
          {attachments.length > 0 && (
            <div className="mb-2">
              <AttachmentChips attachments={attachments} onRemove={removeAttachment} />
            </div>
          )}
          <div className="flex items-end gap-2">
            <MicButton />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.csv,.json,.xml,.yaml,.yml,.log,.py,.js,.ts,.tsx,.jsx,.html,.css,.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.sh,.sql"
              onChange={onPickFiles}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              title="Attach image or document"
              className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-lg border border-white/10 bg-transparent text-dim transition-colors hover:border-[var(--accent-dim)] hover:text-[var(--accent-bright)]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
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
                disabled={!canSend}
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
            {settings.model} · Enter to send · Shift+Enter for newline · 📎 to attach
          </p>
        </div>
      </Glass>
    </motion.div>
  )
}
