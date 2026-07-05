import { motion, AnimatePresence } from 'framer-motion'
import { useAgentStore } from './useAgentStore'

const RADIUS = 250

const ROLE_ICONS: Record<string, string> = {
  planner: '◆',
  researcher: '◉',
  coder: '❮❯',
  debugger: '✚',
  reviewer: '◎'
}

/**
 * Specialist agents materialize as chips orbiting the AI core while
 * they work — the live visualization of the multi-agent team.
 */
export function AgentRing(): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)

  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 z-10">
      <AnimatePresence>
        {agents.map((agent, i) => {
          const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(agents.length, 3)
          const x = Math.cos(angle) * RADIUS
          const y = Math.sin(angle) * RADIUS * 0.7
          const working = agent.status === 'started'
          return (
            <motion.div
              key={agent.agentId}
              className="glass brackets absolute flex items-center gap-2 px-3 py-1.5"
              style={{ translateX: '-50%', translateY: '-50%' }}
              initial={{ opacity: 0, scale: 0.6, x, y: y + 24 }}
              animate={{ opacity: 1, scale: 1, x, y }}
              exit={{ opacity: 0, scale: 0.7, filter: 'blur(6px)' }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              title={agent.task}
            >
              <motion.span
                className="font-mono text-xs"
                style={{
                  color:
                    agent.status === 'error'
                      ? 'var(--danger)'
                      : agent.status === 'done'
                        ? 'var(--success)'
                        : 'var(--accent-bright)'
                }}
                animate={working ? { opacity: [1, 0.35, 1] } : { opacity: 1 }}
                transition={working ? { duration: 1.2, repeat: Infinity } : undefined}
              >
                {agent.status === 'done' ? '✓' : agent.status === 'error' ? '✕' : ROLE_ICONS[agent.role]}
              </motion.span>
              <span className="font-display text-[10px] font-bold uppercase tracking-[0.25em] text-body">
                {agent.role}
              </span>
              {working && (
                <motion.span
                  className="h-1 w-1 rounded-full"
                  style={{ background: 'var(--accent)' }}
                  animate={{ scale: [1, 1.8, 1], opacity: [1, 0.4, 1] }}
                  transition={{ duration: 0.9, repeat: Infinity }}
                />
              )}
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
