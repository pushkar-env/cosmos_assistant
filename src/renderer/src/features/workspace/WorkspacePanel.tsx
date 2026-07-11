import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { NoteMeta } from '@shared/types'
import { useUIStore } from '@/core/stores/useUIStore'
import { Glass } from '@/shared/ui/Glass'
import { Markdown } from '@/shared/ui/Markdown'

/**
 * The AI Workspace: persistent notes (markdown-friendly), shared with
 * the agents — Cosmos writes research and docs here via note_write.
 */
export function WorkspacePanel(): React.JSX.Element {
  const activePanel = useUIStore((s) => s.activePanel)
  const setPanel = useUIStore((s) => s.setPanel)
  const open = activePanel === 'workspace'

  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [preview, setPreview] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)

  const refresh = useCallback(async (): Promise<NoteMeta[]> => {
    const list = await window.cosmos.notes.list()
    setNotes(list)
    return list
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh().then((list) => {
      if (list.length > 0 && activeId === null) void openNote(list[0].id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const openNote = async (id: number): Promise<void> => {
    await flush()
    const note = await window.cosmos.notes.get(id)
    if (!note) return
    setActiveId(note.id)
    setTitle(note.title)
    setContent(note.content)
  }

  const scheduleSave = (nextTitle: string, nextContent: string): void => {
    dirty.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void persist(nextTitle, nextContent)
    }, 600)
  }

  const persist = async (t: string, c: string): Promise<void> => {
    if (!dirty.current) return
    dirty.current = false
    const id = await window.cosmos.notes.save(activeId, t || 'Untitled', c)
    setActiveId(id)
    void refresh()
  }

  const flush = async (): Promise<void> => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    await persist(title, content)
  }

  const newNote = async (): Promise<void> => {
    await flush()
    setActiveId(null)
    setTitle('')
    setContent('')
    setPreview(false) // a fresh note opens ready to type
  }

  const remove = async (): Promise<void> => {
    if (activeId === null) return
    await window.cosmos.notes.delete(activeId)
    dirty.current = false
    setActiveId(null)
    setTitle('')
    setContent('')
    void refresh()
  }

  const close = async (): Promise<void> => {
    await flush()
    setPanel('none')
  }

  const startRename = (n: NoteMeta): void => {
    setRenamingId(n.id)
    setRenameValue(n.title)
  }

  const commitRename = async (): Promise<void> => {
    const id = renamingId
    const next = renameValue.trim()
    setRenamingId(null)
    if (id === null || !next) return
    const note = await window.cosmos.notes.get(id)
    await window.cosmos.notes.save(id, next, note?.content ?? '')
    if (id === activeId) setTitle(next)
    void refresh()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-30 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)' }}
          onClick={() => void close()}
        >
          <motion.div
            initial={{ scale: 0.97, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <Glass brackets className="flex h-[600px] w-[860px] overflow-hidden">
              {/* note list */}
              <div className="flex w-56 shrink-0 flex-col border-r border-white/5">
                <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
                  <span className="font-display text-[10px] font-bold uppercase tracking-[0.3em] text-body">
                    Workspace
                  </span>
                  <button
                    onClick={() => void newNote()}
                    title="New note"
                    className="rounded px-1.5 font-mono text-sm text-dim hover:bg-white/5 hover:text-body"
                  >
                    +
                  </button>
                </div>
                <div className="smooth-scroll flex-1 overflow-y-auto">
                  {notes.map((n) => (
                    <div
                      key={n.id}
                      onClick={() => renamingId !== n.id && void openNote(n.id)}
                      onDoubleClick={() => startRename(n)}
                      className={`group relative block w-full cursor-pointer border-b border-white/5 px-4 py-2.5 text-left transition-colors ${
                        n.id === activeId ? 'bg-white/5' : 'hover:bg-white/5'
                      }`}
                      style={n.id === activeId ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}
                    >
                      {renamingId === n.id ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={() => void commitRename()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitRename()
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          className="w-full rounded border border-[var(--accent-dim)] bg-black/40 px-1.5 py-0.5 font-ui text-sm text-body focus:border-[var(--accent)] focus:outline-none"
                        />
                      ) : (
                        <>
                          <div className="flex items-center gap-1">
                            <p className="min-w-0 flex-1 truncate font-ui text-sm text-body">{n.title}</p>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                startRename(n)
                              }}
                              title="Rename (or double-click)"
                              className="shrink-0 rounded px-1 font-mono text-[11px] text-dim opacity-0 transition-opacity hover:text-body group-hover:opacity-100"
                            >
                              ✎
                            </button>
                          </div>
                          <p className="font-mono text-[10px] text-dim">
                            {new Date(n.updatedAt).toLocaleString()}
                          </p>
                        </>
                      )}
                    </div>
                  ))}
                  {notes.length === 0 && (
                    <p className="px-4 py-6 font-ui text-xs text-dim">
                      No notes yet. Write one, or ask Cosmos to research something into a note.
                    </p>
                  )}
                </div>
              </div>

              {/* editor */}
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
                  <input
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value)
                      scheduleSave(e.target.value, content)
                    }}
                    placeholder="Untitled"
                    className="flex-1 bg-transparent font-ui text-base font-semibold text-body placeholder:text-dim focus:outline-none"
                  />
                  <button
                    onClick={() => setPreview((p) => !p)}
                    title={preview ? 'Back to editing' : 'Preview rendered markdown'}
                    className={`flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors ${
                      preview
                        ? 'text-[var(--accent-bright)]'
                        : 'text-dim hover:bg-white/5 hover:text-body'
                    }`}
                  >
                    {preview ? '✎ Edit' : '◉ Preview'}
                  </button>
                  {activeId !== null && (
                    <button
                      onClick={() => void remove()}
                      className="rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-dim hover:text-red-300"
                    >
                      Delete
                    </button>
                  )}
                  <button
                    onClick={() => void close()}
                    className="rounded-md px-2 py-1 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
                  >
                    ESC
                  </button>
                </div>
                {preview ? (
                  <div className="smooth-scroll flex-1 select-text overflow-y-auto px-5 py-4 font-body text-sm leading-relaxed text-body">
                    {content.trim() ? (
                      <Markdown>{content}</Markdown>
                    ) : (
                      <p className="font-ui text-sm text-dim">Nothing to preview yet — write some markdown.</p>
                    )}
                  </div>
                ) : (
                  <textarea
                    value={content}
                    onChange={(e) => {
                      setContent(e.target.value)
                      scheduleSave(title, e.target.value)
                    }}
                    placeholder="Write in markdown…  (auto-saves)"
                    spellCheck={false}
                    className="smooth-scroll flex-1 resize-none select-text bg-transparent px-5 py-4 font-mono text-sm leading-relaxed text-body placeholder:text-dim focus:outline-none"
                  />
                )}
              </div>
            </Glass>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
