import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { InstalledApp } from '@shared/types'
import { useUIStore } from '@/core/stores/useUIStore'
import { useNotificationStore } from '@/core/stores/useNotificationStore'
import { Glass } from '@/shared/ui/Glass'

/** strip spaces/hyphens/dots so "vs code" finds "Visual Studio Code" */
function collapse(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.]+/g, '')
}

function AppTile({ app }: { app: InstalledApp }): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  const launch = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await window.cosmos.apps.launch(app)
      if (!res.ok) {
        useNotificationStore.getState().push({
          title: 'Launch failed',
          body: res.message ?? `Couldn't launch ${app.name}`,
          kind: 'error'
        })
      }
    } finally {
      // hold the "launching" glow briefly — apps take a moment to appear
      setTimeout(() => setBusy(false), 1200)
    }
  }

  return (
    <button
      onClick={() => void launch()}
      title={app.name}
      className="group flex flex-col items-center gap-2 rounded-xl border border-white/5 bg-black/20 p-3 transition-colors hover:border-[var(--accent-dim)] hover:bg-white/5"
      style={busy ? { boxShadow: '0 0 12px var(--accent-dim)' } : undefined}
    >
      <div className="flex h-11 w-11 items-center justify-center">
        {app.icon ? (
          <img src={app.icon} alt="" draggable={false} className="h-10 w-10 object-contain" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 font-display text-base font-bold text-dim group-hover:text-body">
            {app.name.slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
      <span className="w-full truncate text-center font-ui text-[11px] leading-tight text-dim group-hover:text-body">
        {busy ? 'Launching…' : app.name}
      </span>
    </button>
  )
}

/**
 * The App Centre: every installed application on the system (desktop,
 * Store/UWP, games and launchers), searchable and launchable in place.
 */
export function AppCenterPanel(): React.JSX.Element {
  const activePanel = useUIStore((s) => s.activePanel)
  const setPanel = useUIStore((s) => s.setPanel)
  const open = activePanel === 'apps'

  const [apps, setApps] = useState<InstalledApp[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const loadedOnce = useRef(false)

  const load = async (refresh = false): Promise<void> => {
    setLoading(true)
    try {
      setApps(await window.cosmos.apps.list(refresh))
      loadedOnce.current = true
    } catch (err) {
      useNotificationStore.getState().push({
        title: 'App Centre',
        body: `Couldn't read the app list: ${err instanceof Error ? err.message : String(err)}`,
        kind: 'error'
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setQuery('')
    if (!loadedOnce.current) void load()
    // let the open animation start before grabbing focus
    const t = setTimeout(() => searchRef.current?.focus(), 80)
    return () => clearTimeout(t)
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return apps
    const qc = collapse(q)
    return apps.filter(
      (a) => a.name.toLowerCase().includes(q) || collapse(a.name).includes(qc)
    )
  }, [apps, query])

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
            <Glass brackets className="flex h-[600px] w-[860px] flex-col overflow-hidden">
              <div className="flex items-center gap-3 border-b border-white/5 px-5 py-3">
                <span className="font-display text-[10px] font-bold uppercase tracking-[0.3em] text-body">
                  App Centre
                </span>
                <span className="font-mono text-[10px] text-dim">
                  {loading ? 'scanning…' : `${filtered.length} apps`}
                </span>
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search apps…"
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 font-ui text-sm text-body placeholder:text-dim focus:border-[var(--accent-dim)] focus:outline-none"
                />
                <button
                  onClick={() => void load(true)}
                  disabled={loading}
                  className="rounded px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-dim hover:bg-white/5 hover:text-body disabled:opacity-40"
                >
                  Refresh
                </button>
                <button
                  onClick={() => setPanel('none')}
                  className="rounded-md px-2 py-1 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
                >
                  ESC
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {loading && apps.length === 0 ? (
                  <div className="flex h-full items-center justify-center">
                    <p className="font-mono text-xs text-dim">
                      Scanning installed applications…
                    </p>
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="flex h-full items-center justify-center">
                    <p className="font-ui text-xs text-dim">
                      {apps.length === 0
                        ? 'No apps found. Try Refresh.'
                        : `Nothing matches "${query}".`}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-6 gap-2.5">
                    {filtered.map((a) => (
                      <AppTile key={`${a.kind}:${a.target}`} app={a} />
                    ))}
                  </div>
                )}
              </div>
            </Glass>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
