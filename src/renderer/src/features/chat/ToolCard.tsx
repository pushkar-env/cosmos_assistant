import { motion } from 'framer-motion'
import type { UIMessage } from '@/core/stores/useAssistantStore'

const STATUS_META = {
  running: { icon: '◌', color: 'var(--accent-bright)', label: 'running' },
  ok: { icon: '✓', color: 'var(--success)', label: 'done' },
  error: { icon: '✕', color: 'var(--danger)', label: 'failed' },
  denied: { icon: '⊘', color: 'var(--danger)', label: 'denied' }
} as const

/** Inline tool-activity line in the transcript. */
export function ToolCard({ tool }: { tool: NonNullable<UIMessage['tool']> }): React.JSX.Element {
  const meta = STATUS_META[tool.status]
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-center gap-2 rounded-lg border border-white/5 bg-black/25 px-3 py-1.5"
    >
      {tool.status === 'running' ? (
        <motion.span
          className="font-mono text-xs"
          style={{ color: meta.color }}
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
        >
          {meta.icon}
        </motion.span>
      ) : (
        <span className="font-mono text-xs" style={{ color: meta.color }}>
          {meta.icon}
        </span>
      )}
      {tool.agent && (
        <span
          className="rounded px-1 py-0.5 font-display text-[8px] font-bold uppercase tracking-[0.2em]"
          style={{ color: 'var(--accent-bright)', border: '1px solid var(--accent-dim)' }}
        >
          {tool.agent}
        </span>
      )}
      <span className="font-mono text-[11px] font-semibold" style={{ color: meta.color }}>
        {tool.name}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">{tool.summary}</span>
      <span className="font-mono text-[10px] uppercase tracking-widest text-dim">{meta.label}</span>
    </motion.div>
  )
}
