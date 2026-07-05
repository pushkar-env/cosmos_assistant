import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { PluginManifest } from '@shared/types'
import { useUIStore } from '@/core/stores/useUIStore'
import { sound } from '@/core/sound/SoundEngine'
import { buildActions, matches, pluginActions, type Action, type ActionSection } from './actions'

const SECTION_LABELS: Record<ActionSection, string> = {
  apps: 'Applications',
  web: 'Web',
  system: 'System',
  ai: 'AI',
  theme: 'Themes',
  settings: 'Settings',
  plugins: 'Plugins'
}

export function CommandPalette(): React.JSX.Element {
  const open = useUIStore((s) => s.paletteOpen)
  const toggle = useUIStore((s) => s.togglePalette)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [confirming, setConfirming] = useState<Action | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const [plugins, setPlugins] = useState<PluginManifest[]>([])
  useEffect(() => {
    void window.cosmos.plugins.get().then(setPlugins)
  }, [])

  const actions = useMemo(() => [...buildActions(), ...pluginActions(plugins)], [plugins])
  const filtered = useMemo(() => actions.filter((a) => matches(a, query)), [actions, query])

  useEffect(() => {
    if (open) {
      sound.play('open')
      setQuery('')
      setSelected(0)
      setConfirming(null)
      requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      sound.play('close')
    }
  }, [open])

  useEffect(() => setSelected(0), [query])

  const execute = (action: Action): void => {
    if (action.danger) {
      setConfirming(action)
      return
    }
    void action.run()
    sound.play('activate')
    toggle(false)
  }

  const confirm = (): void => {
    if (!confirming) return
    void confirming.run()
    sound.play('activate')
    setConfirming(null)
    toggle(false)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (confirming) {
      if (e.key === 'Enter') confirm()
      if (e.key === 'Escape') setConfirming(null)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter' && filtered[selected]) {
      execute(filtered[selected])
    } else if (e.key === 'Escape') {
      toggle(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 flex items-start justify-center pt-[18vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          style={{ background: 'rgba(0, 0, 0, 0.5)', backdropFilter: 'blur(6px)' }}
          onClick={() => toggle(false)}
        >
          <motion.div
            className="glass brackets w-[560px] overflow-hidden"
            initial={{ scale: 0.96, y: -10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onKeyDown}
          >
            {confirming ? (
              <div className="p-6">
                <p className="font-display text-xs uppercase tracking-[0.3em] text-danger">
                  Confirmation required
                </p>
                <p className="mt-3 font-ui text-lg text-body">{confirming.title}</p>
                {confirming.subtitle && (
                  <p className="mt-1 font-ui text-sm text-dim">{confirming.subtitle}</p>
                )}
                <div className="mt-5 flex gap-3">
                  <button
                    autoFocus
                    onClick={confirm}
                    className="rounded-lg border border-red-400/50 px-4 py-2 font-ui text-xs font-bold uppercase tracking-widest text-red-300 transition-colors hover:bg-red-500/15"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setConfirming(null)}
                    className="rounded-lg border border-white/15 px-4 py-2 font-ui text-xs font-bold uppercase tracking-widest text-dim transition-colors hover:bg-white/5"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 border-b border-white/5 px-5 py-4">
                  <span className="neon font-display text-sm">⌘</span>
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Type a command…"
                    className="flex-1 bg-transparent font-ui text-base text-body placeholder:text-dim focus:outline-none"
                  />
                  <kbd className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-dim">
                    ESC
                  </kbd>
                </div>
                <div className="max-h-[340px] overflow-y-auto py-2">
                  {filtered.length === 0 && (
                    <p className="px-5 py-6 text-center font-ui text-sm text-dim">
                      No matching commands
                    </p>
                  )}
                  {filtered.map((action, i) => {
                    const prevSection = filtered[i - 1]?.section
                    return (
                      <div key={action.id}>
                        {action.section !== prevSection && (
                          <p className="px-5 pb-1 pt-3 font-display text-[10px] uppercase tracking-[0.3em] text-dim">
                            {SECTION_LABELS[action.section]}
                          </p>
                        )}
                        <button
                          onClick={() => execute(action)}
                          onMouseEnter={() => setSelected(i)}
                          className={`flex w-full items-center justify-between px-5 py-2.5 text-left transition-colors ${
                            i === selected ? 'bg-white/5' : ''
                          }`}
                          style={
                            i === selected
                              ? { boxShadow: 'inset 2px 0 0 var(--accent)' }
                              : undefined
                          }
                        >
                          <div>
                            <p
                              className={`font-ui text-sm ${
                                action.danger ? 'text-red-300' : 'text-body'
                              }`}
                            >
                              {action.title}
                            </p>
                            {action.subtitle && (
                              <p className="font-mono text-[11px] text-dim">{action.subtitle}</p>
                            )}
                          </div>
                          {i === selected && (
                            <kbd className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-dim">
                              ↵
                            </kbd>
                          )}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
