import { motion } from 'framer-motion'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useNotificationStore } from '@/core/stores/useNotificationStore'
import { StatusDot } from '@/shared/ui/StatusDot'

const STATE_LABELS: Record<string, string> = {
  idle: 'Standing by',
  listening: 'Listening',
  thinking: 'Processing',
  speaking: 'Responding'
}

/** Frameless-window titlebar: wordmark, assistant state, window controls. */
export function StatusBar(): React.JSX.Element {
  const state = useAssistantStore((s) => s.state)
  const setPanel = useUIStore((s) => s.setPanel)
  const setMode = useUIStore((s) => s.setMode)
  const toggleCompact = useUIStore((s) => s.toggleCompact)
  const unread = useNotificationStore((s) => s.items.filter((i) => !i.read).length)
  const toggleCenter = useNotificationStore((s) => s.toggleCenter)

  return (
    <motion.header
      className="absolute inset-x-0 top-0 z-30 flex h-11 items-center justify-between px-4"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <div className="flex items-center gap-3">
        <span className="neon font-display text-sm font-bold tracking-[0.35em]">COSMOS</span>
        <div className="flex items-center gap-1.5 rounded-full border border-white/5 bg-black/20 px-2.5 py-1">
          <StatusDot active={state !== 'idle'} />
          <span className="font-mono text-[10px] uppercase tracking-widest text-dim">
            {STATE_LABELS[state]}
          </span>
        </div>
      </div>

      <div
        className="flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={() => setPanel('dashboard')}
          className="rounded-md px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
          title="Dashboard"
        >
          ▦
        </button>
        <button
          onClick={() => setPanel('workspace')}
          className="rounded-md px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
          title="Workspace — notes"
        >
          ✎
        </button>
        <button
          onClick={() => toggleCenter()}
          className="relative rounded-md px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
          title="Notifications"
        >
          ◔
          {unread > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 font-mono text-[8px] font-bold"
              style={{ background: 'var(--accent)', color: 'var(--bg)' }}
            >
              {unread}
            </span>
          )}
        </button>
        <button
          onClick={() => setMode('orb')}
          className="rounded-md px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
          title="Shrink to floating orb"
        >
          ◉
        </button>
        <button
          onClick={toggleCompact}
          className="rounded-md px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
          title="Compact mode — floating Cosmos"
        >
          ⧉
        </button>
        <button
          onClick={() => setPanel('vault')}
          className="rounded-md px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
          title="Vault — memories, permissions, audit log"
        >
          ◈
        </button>
        <button
          onClick={() => setPanel('settings')}
          className="rounded-md px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
          title="Settings"
        >
          ⚙
        </button>
        <button
          onClick={() => void window.cosmos.app.windowControl('minimize')}
          className="rounded-md px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
        >
          —
        </button>
        <button
          onClick={() => void window.cosmos.app.windowControl('maximize')}
          className="rounded-md px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
        >
          ☐
        </button>
        <button
          onClick={() => void window.cosmos.app.windowControl('close')}
          className="rounded-md px-2.5 py-1 font-mono text-xs text-dim transition-colors hover:bg-red-500/20 hover:text-red-300"
          title="Hide to tray (COSMOS keeps running — quit from the tray icon)"
        >
          ✕
        </button>
      </div>
    </motion.header>
  )
}
