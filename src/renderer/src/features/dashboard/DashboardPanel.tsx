import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { AuditEntry } from '@shared/types'
import { useUIStore } from '@/core/stores/useUIStore'
import { useSystemStore } from '@/core/stores/useSystemStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import { Glass } from '@/shared/ui/Glass'

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-white/5 bg-black/20 px-3 py-2.5">
      <p className="font-display text-[9px] uppercase tracking-[0.25em] text-dim">{label}</p>
      <p className="tabular mt-1 font-mono text-lg font-semibold text-body">{value}</p>
    </div>
  )
}

/** Command deck overview: everything COSMOS knows right now, live. */
export function DashboardPanel(): React.JSX.Element {
  const activePanel = useUIStore((s) => s.activePanel)
  const setPanel = useUIStore((s) => s.setPanel)
  const open = activePanel === 'dashboard'
  const stats = useSystemStore((s) => s.stats)
  const weather = useSystemStore((s) => s.weather)
  const userName = useSettingsStore((s) => s.settings.userName)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [memoryCount, setMemoryCount] = useState(0)
  const [noteCount, setNoteCount] = useState(0)

  useEffect(() => {
    if (!open) return
    void window.cosmos.vault.listAudit(100).then(setAudit)
    void window.cosmos.vault.listMemories().then((m) => setMemoryCount(m.length))
    void window.cosmos.notes.list().then((n) => setNoteCount(n.length))
  }, [open])

  const hour = new Date().getHours()
  const greeting = hour < 5 ? 'Burning the midnight oil' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const today = new Date().toDateString()
  const actionsToday = audit.filter((a) => new Date(a.ts).toDateString() === today)
  const memPct = stats ? Math.round((stats.mem.used / stats.mem.total) * 100) : 0
  const uptimeH = stats ? Math.floor(stats.uptime / 3600) : 0

  const quick = [
    { label: 'New Chat', run: () => { useAssistantStore.getState().clear(); setPanel('none') } },
    { label: 'Speak (Ctrl+J)', run: () => { setPanel('none'); void useVoiceStore.getState().togglePushToTalk() } },
    { label: 'Workspace', run: () => setPanel('workspace') },
    { label: 'Vault', run: () => setPanel('vault') },
    { label: 'Compact Mode', run: () => useUIStore.getState().toggleCompact() }
  ]

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
            <Glass brackets className="w-[760px] p-6">
              <div className="flex items-baseline justify-between">
                <h2 className="font-display text-lg font-bold tracking-[0.15em] text-body">
                  {greeting}
                  {userName ? `, ${userName}` : ''}.
                </h2>
                <span className="font-mono text-xs text-dim">
                  {new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
                </span>
              </div>

              <div className="mt-5 grid grid-cols-4 gap-3">
                <Stat label="CPU" value={stats ? `${stats.cpu.load.toFixed(0)}%` : '—'} />
                <Stat label="Memory" value={`${memPct}%`} />
                <Stat label="Uptime" value={`${uptimeH}h`} />
                <Stat
                  label="Weather"
                  value={weather ? `${Math.round(weather.tempC)}°C` : '—'}
                />
                <Stat label="Actions today" value={String(actionsToday.length)} />
                <Stat label="Memories" value={String(memoryCount)} />
                <Stat label="Notes" value={String(noteCount)} />
                <Stat
                  label="Denials today"
                  value={String(actionsToday.filter((a) => a.status === 'denied').length)}
                />
              </div>

              <div className="mt-5 grid grid-cols-5 gap-2">
                {quick.map((q) => (
                  <button
                    key={q.label}
                    onClick={q.run}
                    className="glass-hover rounded-lg border border-white/10 px-2 py-2 font-ui text-xs font-semibold uppercase tracking-widest text-dim transition-colors hover:text-body"
                  >
                    {q.label}
                  </button>
                ))}
              </div>

              <div className="mt-5">
                <p className="mb-2 font-display text-[10px] uppercase tracking-[0.3em] text-dim">
                  Recent activity
                </p>
                <div className="max-h-40 overflow-y-auto rounded-lg border border-white/5 bg-black/20">
                  {audit.slice(0, 12).map((a) => (
                    <div key={a.id} className="flex items-center gap-3 border-b border-white/5 px-3 py-1.5 last:border-0">
                      <span className="font-mono text-[10px]" style={{ color: a.status === 'ok' ? 'var(--success)' : 'var(--danger)' }}>
                        {a.status === 'ok' ? '✓' : '✕'}
                      </span>
                      <span className="w-28 shrink-0 font-mono text-[11px] text-body">{a.tool}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">{a.summary}</span>
                    </div>
                  ))}
                  {audit.length === 0 && (
                    <p className="px-3 py-4 font-ui text-xs text-dim">No activity yet today.</p>
                  )}
                </div>
              </div>
            </Glass>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
