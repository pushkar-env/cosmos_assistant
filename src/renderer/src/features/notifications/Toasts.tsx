import { motion, AnimatePresence } from 'framer-motion'
import { useNotificationStore } from '@/core/stores/useNotificationStore'

const KIND_COLOR = {
  info: 'var(--accent)',
  success: 'var(--success)',
  error: 'var(--danger)'
} as const

/** Top-right glass toast stack. */
export function Toasts(): React.JSX.Element {
  const items = useNotificationStore((s) => s.items)
  const dismiss = useNotificationStore((s) => s.dismissToast)
  const toasts = items.filter((i) => i.toast).slice(0, 4)

  return (
    <div className="pointer-events-none fixed right-4 top-14 z-50 flex w-80 flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, x: 60, filter: 'blur(6px)' }}
            animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: 40, transition: { duration: 0.2 } }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="glass brackets pointer-events-auto cursor-pointer px-4 py-3"
            style={{ borderLeft: `2px solid ${KIND_COLOR[t.kind]}` }}
            onClick={() => dismiss(t.id)}
          >
            <p className="font-display text-[10px] font-bold uppercase tracking-[0.25em]"
               style={{ color: KIND_COLOR[t.kind] }}>
              {t.title}
            </p>
            <p className="mt-1 font-ui text-sm leading-snug text-body">{t.body}</p>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
