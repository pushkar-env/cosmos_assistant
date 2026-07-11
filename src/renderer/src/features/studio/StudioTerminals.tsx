import { useLayoutEffect, useRef, useState } from 'react'
import { useStudioStore } from './useStudioStore'

/** short, ~-collapsed cwd for the prompt line */
function shortCwd(cwd: string): string {
  return cwd.replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~').replace(/\\/g, '/')
}

function TerminalView({ id }: { id: string }): React.JSX.Element {
  const term = useStudioStore((s) => s.terminals.find((t) => t.id === id))
  const send = useStudioStore((s) => s.sendTerminal)
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [hIdx, setHIdx] = useState(-1)
  const scroller = useRef<HTMLDivElement>(null)

  const segments = term?.segments ?? []

  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [segments])

  if (!term) return <></>

  const submit = (): void => {
    if (!input.trim()) return
    send(id, input)
    setHistory((h) => [...h, input])
    setHIdx(-1)
    setInput('')
  }

  return (
    <div className="flex h-full flex-col bg-black/40">
      <div
        ref={scroller}
        className="smooth-scroll flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {segments.length === 0 && (
          <p className="text-dim">
            Ready. Type a command below — this shell runs in your workspace
            {id === 'primary' ? ' and is shared with the agent.' : '.'}
          </p>
        )}
        <pre className="whitespace-pre-wrap break-words">
          {segments.map((seg, i) => (
            <span
              key={i}
              style={{
                color:
                  seg.stream === 'stderr'
                    ? '#fca5a5'
                    : seg.stream === 'system'
                      ? 'var(--accent)'
                      : 'var(--body)'
              }}
            >
              {seg.text}
            </span>
          ))}
        </pre>
      </div>
      <div className="flex items-center gap-2 border-t border-white/5 px-3 py-2">
        <span className="shrink-0 font-mono text-[11px] text-[var(--accent)]" title={term.cwd}>
          {shortCwd(term.cwd) || '~'} ❯
        </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          placeholder={term.ready ? 'run a command…' : 'running…'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            else if (e.key === 'ArrowUp') {
              e.preventDefault()
              const idx = hIdx === -1 ? history.length - 1 : Math.max(0, hIdx - 1)
              if (history[idx] !== undefined) {
                setHIdx(idx)
                setInput(history[idx])
              }
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              if (hIdx === -1) return
              const idx = hIdx + 1
              if (idx >= history.length) {
                setHIdx(-1)
                setInput('')
              } else {
                setHIdx(idx)
                setInput(history[idx])
              }
            }
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-body placeholder:text-dim focus:outline-none"
        />
        {!term.ready && (
          <span
            className="h-2 w-2 shrink-0 animate-pulse rounded-full"
            style={{ background: 'var(--accent)' }}
          />
        )}
      </div>
    </div>
  )
}

export function StudioTerminals(): React.JSX.Element {
  const terminals = useStudioStore((s) => s.terminals)
  const activeTermId = useStudioStore((s) => s.activeTermId)
  const setActiveTerm = useStudioStore((s) => s.setActiveTerm)
  const createTerminal = useStudioStore((s) => s.createTerminal)
  const closeTerminal = useStudioStore((s) => s.closeTerminal)
  const resetTerminal = useStudioStore((s) => s.resetTerminal)
  const clearTerminal = useStudioStore((s) => s.clearTerminal)
  const togglePanel = useStudioStore((s) => s.togglePanel)

  const activeId = activeTermId ?? terminals[0]?.id ?? null

  return (
    <div className="flex h-full flex-col">
      {/* terminal tab bar */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-white/5 px-2">
        <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
          Terminal
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {terminals.map((t) => (
            <div
              key={t.id}
              onClick={() => setActiveTerm(t.id)}
              className={`group flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 ${
                t.id === activeId ? 'bg-white/10' : 'hover:bg-white/5'
              }`}
              title={t.cwd}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: t.ready ? 'var(--dim)' : 'var(--accent)' }}
              />
              <span className="font-ui text-[11px] text-body">{t.title}</span>
              {terminals.length > 1 && t.id !== 'primary' && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeTerminal(t.id)
                  }}
                  className="rounded px-0.5 font-mono text-[10px] text-dim opacity-0 hover:text-body group-hover:opacity-100"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={() => void createTerminal()}
          title="New terminal"
          className="rounded px-1.5 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
        >
          +
        </button>
        {activeId && (
          <button
            onClick={() => clearTerminal(activeId)}
            className="rounded px-1.5 py-0.5 font-mono text-[10px] text-dim hover:bg-white/5 hover:text-body"
            title="Clear output"
          >
            clear
          </button>
        )}
        {activeId && (
          <button
            onClick={() => void resetTerminal(activeId)}
            className="rounded px-1.5 py-0.5 font-mono text-[10px] text-dim hover:bg-white/5 hover:text-body"
            title="Kill & restart this shell"
          >
            ♻
          </button>
        )}
        <button
          onClick={() => togglePanel('terminal')}
          title="Hide terminal"
          className="rounded px-1.5 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
        >
          ✕
        </button>
      </div>
      {/* keep every terminal mounted (preserves scroll/input); show only active */}
      <div className="relative min-h-0 flex-1">
        {terminals.map((t) => (
          <div key={t.id} className={`absolute inset-0 ${t.id === activeId ? '' : 'hidden'}`}>
            <TerminalView id={t.id} />
          </div>
        ))}
      </div>
    </div>
  )
}
