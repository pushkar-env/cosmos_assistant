import { motion, AnimatePresence } from 'framer-motion'
import { useNotificationStore } from '@/core/stores/useNotificationStore'
import { Glass } from '@/shared/ui/Glass'

const KIND_ICON = { info: '◈', success: '✓', error: '✕' } as const

/** Bell dropdown listing recent notifications. */
export function NotificationCenter(): React.JSX.Element {
  const { items, centerOpen, toggleCenter, clear } = useNotificationStore()

  return (
    <AnimatePresence>
      {centerOpen && (
        <motion.div
          className="fixed right-4 top-12 z-40 w-96"
          initial={{ opacity: 0, y: -8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
        >
          <Glass brackets className="max-h-[420px] overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
              <span className="font-display text-[10px] font-bold uppercase tracking-[0.3em] text-body">
                Notifications
              </span>
              <div className="flex gap-2">
                <button
                  onClick={clear}
                  className="font-mono text-[10px] uppercase tracking-widest text-dim hover:text-body"
                >
                  Clear
                </button>
                <button
                  onClick={() => toggleCenter(false)}
                  className="font-mono text-[10px] text-dim hover:text-body"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="max-h-[360px] overflow-y-auto">
              {items.length === 0 && (
                <p className="px-4 py-8 text-center font-ui text-sm text-dim">All quiet.</p>
              )}
              {items.map((n) => (
                <div key={n.id} className="border-b border-white/5 px-4 py-3 last:border-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="font-mono text-xs"
                      style={{
                        color:
                          n.kind === 'error'
                            ? 'var(--danger)'
                            : n.kind === 'success'
                              ? 'var(--success)'
                              : 'var(--accent)'
                      }}
                    >
                      {KIND_ICON[n.kind]}
                    </span>
                    <span className="font-ui text-sm font-semibold text-body">{n.title}</span>
                    <span className="ml-auto font-mono text-[10px] text-dim">
                      {new Date(n.ts).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="mt-1 pl-6 font-ui text-xs text-dim">{n.body}</p>
                </div>
              ))}
            </div>
          </Glass>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
