import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAssistantStore } from '@/core/stores/useAssistantStore'

/** compact relative time: "just now", "5m", "3h", "2d", else a date */
function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * Slide-down list of saved chat sessions, ChatGPT-style: start a new
 * chat, switch between past ones, rename (double-click or ✎) or delete.
 */
export function SessionList({ onClose }: { onClose: () => void }): React.JSX.Element {
  const sessions = useAssistantStore((s) => s.sessions)
  const currentId = useAssistantStore((s) => s.currentSessionId)
  const { switchSession, deleteSession, renameSession, clear, loadSessions } = useAssistantStore()

  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmId, setConfirmId] = useState<number | null>(null)

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  const startRename = (id: number, title: string): void => {
    setRenamingId(id)
    setRenameValue(title)
    setConfirmId(null)
  }
  const commitRename = (): void => {
    const id = renamingId
    const next = renameValue.trim()
    setRenamingId(null)
    if (id !== null && next) void renameSession(id, next)
  }

  const rootRef = useRef<HTMLDivElement>(null)

  return (
    <motion.div
      ref={rootRef}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18 }}
      className="absolute inset-x-0 top-full z-30 mt-1 max-h-[420px] overflow-hidden rounded-xl border border-white/10 bg-[color-mix(in_srgb,var(--bg)_92%,black)] shadow-2xl backdrop-blur-xl"
    >
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
        <span className="font-display text-[10px] font-bold uppercase tracking-[0.3em] text-body">
          Chats
        </span>
        <button
          onClick={() => {
            clear()
            onClose()
          }}
          className="flex items-center gap-1 rounded-md border border-[var(--accent-dim)] px-2 py-1 font-ui text-[10px] font-bold uppercase tracking-widest text-[var(--accent-bright)] transition-colors hover:bg-white/5"
        >
          <span className="text-sm leading-none">+</span> New chat
        </button>
      </div>

      <div className="smooth-scroll max-h-[370px] overflow-y-auto py-1">
        {sessions.length === 0 && (
          <p className="px-3 py-6 text-center font-ui text-xs text-dim">
            No saved chats yet. Start talking and this chat will be saved here.
          </p>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => {
              if (renamingId !== s.id) {
                void switchSession(s.id)
                onClose()
              }
            }}
            className={`group relative flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors ${
              s.id === currentId ? 'bg-white/5' : 'hover:bg-white/5'
            }`}
            style={s.id === currentId ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}
          >
            <div className="min-w-0 flex-1">
              {renamingId === s.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  className="w-full rounded border border-[var(--accent-dim)] bg-black/40 px-1.5 py-0.5 font-ui text-sm text-body focus:border-[var(--accent)] focus:outline-none"
                />
              ) : (
                <p className="truncate font-ui text-sm text-body">{s.title}</p>
              )}
              <p className="font-mono text-[10px] text-dim">
                {ago(s.updatedAt)} · {s.messageCount} msg{s.messageCount === 1 ? '' : 's'}
              </p>
            </div>

            {renamingId !== s.id && confirmId !== s.id && (
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    startRename(s.id, s.title)
                  }}
                  title="Rename"
                  className="rounded px-1 font-mono text-[11px] text-dim hover:text-body"
                >
                  ✎
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmId(s.id)
                  }}
                  title="Delete"
                  className="rounded px-1 font-mono text-[11px] text-dim hover:text-red-300"
                >
                  🗑
                </button>
              </div>
            )}

            {confirmId === s.id && (
              <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => {
                    void deleteSession(s.id)
                    setConfirmId(null)
                  }}
                  className="rounded border border-red-400/40 px-1.5 py-0.5 font-ui text-[10px] font-bold uppercase tracking-widest text-red-300 hover:bg-red-500/10"
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmId(null)}
                  className="rounded px-1.5 py-0.5 font-ui text-[10px] uppercase tracking-widest text-dim hover:text-body"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </motion.div>
  )
}
