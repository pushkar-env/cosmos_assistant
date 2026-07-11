import { useRef } from 'react'

interface Props {
  /** 'x' resizes width (vertical bar), 'y' resizes height (horizontal bar) */
  axis: 'x' | 'y'
  /** current size in px */
  value: number
  /** which direction increases the value relative to pointer movement */
  invert?: boolean
  min: number
  max: number
  onChange: (next: number) => void
}

/**
 * A thin draggable divider used between Studio panes. Shows an accent hover
 * state and widens its hit-area with an invisible overlay while dragging so the
 * pointer never slips off during a fast drag.
 */
export function Resizer({ axis, value, invert, min, max, onChange }: Props): React.JSX.Element {
  const dragging = useRef(false)

  const onPointerDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    dragging.current = true
    const start = axis === 'x' ? e.clientX : e.clientY
    const startValue = value
    const move = (ev: PointerEvent): void => {
      if (!dragging.current) return
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start
      const signed = invert ? -delta : delta
      onChange(Math.min(max, Math.max(min, startValue + signed)))
    }
    const up = (): void => {
      dragging.current = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      onPointerDown={onPointerDown}
      className={
        axis === 'x'
          ? 'group relative z-10 w-1 shrink-0 cursor-col-resize'
          : 'group relative z-10 h-1 shrink-0 cursor-row-resize'
      }
    >
      <div
        className={
          axis === 'x'
            ? 'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/10 transition-colors group-hover:bg-[var(--accent)]'
            : 'absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/10 transition-colors group-hover:bg-[var(--accent)]'
        }
      />
    </div>
  )
}
