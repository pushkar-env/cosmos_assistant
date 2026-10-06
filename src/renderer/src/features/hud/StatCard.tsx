import { motion, useMotionValue } from 'framer-motion'
import { useEffect, useRef, type ReactNode } from 'react'
import { sound } from '@/core/sound/SoundEngine'
import { stageBridge } from '@/features/avatar/stage/bridge'
import { widgets } from '@/features/avatar/stage/widgets'

interface StatCardProps {
  title: string
  children: ReactNode
  delay?: number
}

/** A draggable holographic stat card with the signature bracket frame. The
 *  avatar can pick it up too: she drives the same motion values a drag does. */
export function StatCard({ title, children, delay = 0 }: StatCardProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const scale = useMotionValue(1)
  const rotate = useMotionValue(0)
  const rotateY = useMotionValue(0)
  const id = `card-${title.toLowerCase()}`

  useEffect(() => {
    if (!ref.current) return
    return widgets.register({ id, kind: 'card', el: ref.current, motion: { x, y, scale, rotate, rotateY } })
  }, [id, x, y, scale, rotate, rotateY])

  return (
    <motion.div
      ref={ref}
      drag
      dragMomentum={false}
      whileDrag={{ scale: 1.04, zIndex: 40 }}
      onDragStart={() => stageBridge.userGrabbed(id)}
      style={{ x, y, scale, rotate, rotateY, transformPerspective: 900 }}
      className="glass glass-hover brackets w-52 cursor-grab px-4 py-3 active:cursor-grabbing"
      initial={{ opacity: 0, y: 14, filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ delay, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      onHoverStart={() => sound.play('hover')}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-display text-[10px] font-medium uppercase tracking-[0.25em] text-dim">
          {title}
        </span>
        <span className="h-1 w-1 rounded-full" style={{ background: 'var(--accent)' }} />
      </div>
      {children}
    </motion.div>
  )
}

/** Slim accent progress bar used inside cards. */
export function MeterBar({ value, danger = false }: { value: number; danger?: boolean }): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/5">
      <motion.div
        className="h-full rounded-full"
        style={{
          background: danger ? 'var(--danger)' : 'var(--accent)',
          boxShadow: `0 0 8px ${danger ? 'var(--danger)' : 'var(--glow)'}`
        }}
        animate={{ width: `${clamped}%` }}
        transition={{ type: 'spring', stiffness: 120, damping: 22 }}
      />
    </div>
  )
}

export function BigValue({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="tabular font-mono text-2xl font-semibold text-body">{children}</div>
  )
}

export function SubValue({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="tabular mt-0.5 font-ui text-xs text-dim">{children}</div>
}
