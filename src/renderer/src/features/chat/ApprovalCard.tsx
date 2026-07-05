import { motion, AnimatePresence } from 'framer-motion'
import { useApprovalStore } from './useApprovalStore'

/**
 * Permission gate: sensitive tool calls pause the agent loop until the
 * user approves or denies. Rendered above the composer.
 */
export function ApprovalCard(): React.JSX.Element {
  const queue = useApprovalStore((s) => s.queue)
  const respond = useApprovalStore((s) => s.respond)
  const current = queue[0]

  return (
    <AnimatePresence>
      {current && (
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="brackets mx-3 mb-2 rounded-xl border px-4 py-3"
          style={{
            borderColor: 'color-mix(in srgb, var(--danger) 45%, transparent)',
            background: 'color-mix(in srgb, var(--danger) 7%, transparent)'
          }}
        >
          <p className="font-display text-[10px] uppercase tracking-[0.3em] text-danger">
            Permission required
          </p>
          <p className="mt-1.5 font-mono text-xs text-body">
            <span className="font-semibold">{current.tool}</span>
            <span className="text-dim"> — {current.summary}</span>
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => respond(current.approvalId, 'approve')}
              className="rounded-lg px-4 py-1.5 font-ui text-xs font-bold uppercase tracking-widest transition-all"
              style={{
                background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
                border: '1px solid var(--accent-dim)',
                color: 'var(--accent-bright)'
              }}
            >
              Approve
            </button>
            <button
              onClick={() => respond(current.approvalId, 'always')}
              title={`Never ask again for ${current.tool} (revoke in the Vault)`}
              className="rounded-lg border border-white/15 px-3 py-1.5 font-ui text-xs font-bold uppercase tracking-widest text-dim transition-colors hover:bg-white/5 hover:text-body"
            >
              Always
            </button>
            <button
              onClick={() => respond(current.approvalId, 'deny')}
              className="rounded-lg border border-white/15 px-4 py-1.5 font-ui text-xs font-bold uppercase tracking-widest text-dim transition-colors hover:bg-white/5"
            >
              Deny
            </button>
            {queue.length > 1 && (
              <span className="ml-auto font-mono text-[10px] text-dim">
                +{queue.length - 1} queued
              </span>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
