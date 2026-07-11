import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { AuditEntry, MemoryCategory, MemoryItem } from '@shared/types'
import { useUIStore } from '@/core/stores/useUIStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { Glass } from '@/shared/ui/Glass'

type Tab = 'memories' | 'permissions' | 'audit'

const CATEGORY_COLORS: Record<MemoryCategory, string> = {
  preference: 'var(--accent)',
  project: 'var(--success)',
  fact: 'var(--text-dim)',
  goal: 'var(--accent-bright)'
}

/**
 * The Vault: everything COSMOS remembers and everything he has done.
 * Memories (browse/add/forget) · Permissions (revoke "always allow"
 * grants) · Audit (recent tool executions).
 */
export function VaultPanel(): React.JSX.Element {
  const activePanel = useUIStore((s) => s.activePanel)
  const setPanel = useUIStore((s) => s.setPanel)
  const open = activePanel === 'vault'

  const [tab, setTab] = useState<Tab>('memories')
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [newMemory, setNewMemory] = useState('')
  const { settings, update } = useSettingsStore()

  useEffect(() => {
    if (!open) return
    void window.cosmos.vault.listMemories().then(setMemories)
    void window.cosmos.vault.listAudit(100).then(setAudit)
  }, [open, tab])

  const addMemory = async (): Promise<void> => {
    const content = newMemory.trim()
    if (!content) return
    setNewMemory('')
    await window.cosmos.vault.addMemory(content, 'fact')
    setMemories(await window.cosmos.vault.listMemories())
  }

  const forget = async (id: number): Promise<void> => {
    await window.cosmos.vault.deleteMemory(id)
    setMemories((prev) => prev.filter((m) => m.id !== id))
  }

  const revoke = (tool: string): void => {
    void update({ alwaysAllowTools: settings.alwaysAllowTools.filter((t) => t !== tool) })
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
          onClick={() => setPanel('none')}
        >
          <motion.div
            initial={{ scale: 0.97, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <Glass brackets className="flex h-[580px] w-[720px] flex-col overflow-hidden">
              <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
                <h2 className="font-display text-sm font-bold uppercase tracking-[0.3em] text-body">
                  Vault
                </h2>
                <div className="flex gap-1">
                  {(['memories', 'permissions', 'audit'] as Tab[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`rounded-md px-3 py-1 font-ui text-xs font-semibold uppercase tracking-widest transition-colors ${
                        tab === t ? 'neon bg-white/5' : 'text-dim hover:bg-white/5 hover:text-body'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setPanel('none')}
                  className="rounded-md px-2 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
                >
                  ESC
                </button>
              </div>

              {tab === 'memories' && (
                <>
                  <div className="flex gap-2 border-b border-white/5 px-6 py-3">
                    <input
                      value={newMemory}
                      onChange={(e) => setNewMemory(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void addMemory()}
                      placeholder="Teach COSMOS a fact… (Enter to save)"
                      className="flex-1 bg-transparent font-ui text-sm text-body placeholder:text-dim focus:outline-none"
                    />
                  </div>
                  <div className="smooth-scroll flex-1 overflow-y-auto px-6 py-3">
                    {memories.length === 0 && (
                      <p className="py-10 text-center font-ui text-sm text-dim">
                        Nothing remembered yet. Tell COSMOS about yourself — durable facts get
                        saved automatically.
                      </p>
                    )}
                    {[...memories].reverse().map((m) => (
                      <div
                        key={m.id}
                        className="group flex items-start gap-3 border-b border-white/5 py-3 last:border-0"
                      >
                        <span
                          className="mt-1 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest"
                          style={{
                            color: CATEGORY_COLORS[m.category],
                            border: `1px solid color-mix(in srgb, ${CATEGORY_COLORS[m.category]} 40%, transparent)`
                          }}
                        >
                          {m.category}
                        </span>
                        <p className="flex-1 select-text font-body text-sm text-body">{m.content}</p>
                        <button
                          onClick={() => void forget(m.id)}
                          className="rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-dim opacity-0 transition-all hover:text-red-300 group-hover:opacity-100"
                        >
                          Forget
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {tab === 'permissions' && (
                <div className="smooth-scroll flex-1 overflow-y-auto px-6 py-4">
                  <p className="mb-4 font-ui text-xs text-dim">
                    Tools granted permanent approval via “Always”. Revoked tools ask again next
                    time.
                  </p>
                  {settings.alwaysAllowTools.length === 0 && (
                    <p className="py-10 text-center font-ui text-sm text-dim">
                      No standing grants — every sensitive action asks for approval.
                    </p>
                  )}
                  {settings.alwaysAllowTools.map((tool) => (
                    <div
                      key={tool}
                      className="flex items-center justify-between border-b border-white/5 py-3 last:border-0"
                    >
                      <span className="font-mono text-sm text-body">{tool}</span>
                      <button
                        onClick={() => revoke(tool)}
                        className="rounded-lg border border-white/15 px-3 py-1 font-ui text-[10px] font-bold uppercase tracking-widest text-dim transition-colors hover:border-red-400/40 hover:text-red-300"
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {tab === 'audit' && (
                <div className="flex-1 overflow-y-auto px-6 py-3">
                  {audit.length === 0 && (
                    <p className="py-10 text-center font-ui text-sm text-dim">
                      No tool activity recorded yet.
                    </p>
                  )}
                  {audit.map((a) => (
                    <div key={a.id} className="flex items-center gap-3 border-b border-white/5 py-2 last:border-0">
                      <span
                        className="font-mono text-xs"
                        style={{
                          color:
                            a.status === 'ok'
                              ? 'var(--success)'
                              : a.status === 'denied'
                                ? 'var(--danger)'
                                : 'var(--danger)'
                        }}
                      >
                        {a.status === 'ok' ? '✓' : a.status === 'denied' ? '⊘' : '✕'}
                      </span>
                      <span className="w-28 shrink-0 font-mono text-[11px] font-semibold text-body">
                        {a.tool}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">
                        {a.summary}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-dim">
                        {new Date(a.ts).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Glass>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
