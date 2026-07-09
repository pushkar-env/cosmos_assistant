import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { FileNode } from '@shared/types'
import { useUIStore } from '@/core/stores/useUIStore'
import { Glass } from '@/shared/ui/Glass'
import { CodeEditor } from './CodeEditor'
import { useStudioStore } from './useStudioStore'

/** a file's language accent color, by extension — a subtle premium touch */
function extColor(name: string): string {
  const e = name.split('.').pop()?.toLowerCase() ?? ''
  if (['ts', 'tsx'].includes(e)) return '#3b82f6'
  if (['js', 'jsx', 'mjs', 'cjs'].includes(e)) return '#eab308'
  if (e === 'py') return '#22c55e'
  if (['html', 'htm'].includes(e)) return '#f97316'
  if (['css', 'scss', 'less'].includes(e)) return '#ec4899'
  if (e === 'json') return '#a3a3a3'
  if (['md', 'markdown'].includes(e)) return '#60a5fa'
  return 'var(--dim)'
}

function TreeRow({ node, depth }: { node: FileNode; depth: number }): React.JSX.Element {
  const expanded = useStudioStore((s) => s.expanded.has(node.path))
  const activePath = useStudioStore((s) => s.activePath)
  const toggleDir = useStudioStore((s) => s.toggleDir)
  const openFile = useStudioStore((s) => s.openFile)
  const renameNode = useStudioStore((s) => s.renameNode)
  const deleteNode = useStudioStore((s) => s.deleteNode)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(node.name)

  const isActive = activePath === node.path
  const commitRename = (): void => {
    setRenaming(false)
    const next = name.trim()
    if (next && next !== node.name) void renameNode(node.path, next)
    else setName(node.name)
  }

  return (
    <>
      <div
        className={`group flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-left transition-colors ${
          isActive ? 'bg-white/10' : 'hover:bg-white/5'
        }`}
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={() => (node.kind === 'dir' ? void toggleDir(node) : void openFile(node.path))}
      >
        <span className="w-3 shrink-0 text-center font-mono text-[10px] text-dim">
          {node.kind === 'dir' ? (expanded ? '▾' : '▸') : ''}
        </span>
        {node.kind === 'file' && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: extColor(node.name) }}
          />
        )}
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') {
                setName(node.name)
                setRenaming(false)
              }
            }}
            className="min-w-0 flex-1 rounded border border-[var(--accent-dim)] bg-black/40 px-1 font-ui text-xs text-body focus:border-[var(--accent)] focus:outline-none"
          />
        ) : (
          <span className={`min-w-0 flex-1 truncate font-ui text-xs ${isActive ? 'text-body' : 'text-dim group-hover:text-body'}`}>
            {node.name}
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            setRenaming(true)
          }}
          title="Rename"
          className="shrink-0 rounded px-1 font-mono text-[10px] text-dim opacity-0 hover:text-body group-hover:opacity-100"
        >
          ✎
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            void deleteNode(node.path)
          }}
          title="Move to Recycle Bin"
          className="shrink-0 rounded px-1 font-mono text-[10px] text-dim opacity-0 hover:text-red-300 group-hover:opacity-100"
        >
          🗑
        </button>
      </div>
      {node.kind === 'dir' && expanded && node.children && (
        <>
          {node.children.map((c) => (
            <TreeRow key={c.path} node={c} depth={depth + 1} />
          ))}
        </>
      )}
    </>
  )
}

function Terminal(): React.JSX.Element {
  const term = useStudioStore((s) => s.term)
  const cwd = useStudioStore((s) => s.cwd)
  const ready = useStudioStore((s) => s.ready)
  const send = useStudioStore((s) => s.sendTerminal)
  const reset = useStudioStore((s) => s.resetTerminal)
  const clear = useStudioStore((s) => s.clearTerminal)
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [hIdx, setHIdx] = useState(-1)
  const scroller = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [term])

  const submit = (): void => {
    if (!input.trim()) return
    send(input)
    setHistory((h) => [...h, input])
    setHIdx(-1)
    setInput('')
  }

  const shortCwd = cwd.replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~').replace(/\\/g, '/')

  return (
    <div className="flex h-full flex-col bg-black/40">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">Terminal</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => clear()}
            className="rounded px-1.5 py-0.5 font-mono text-[10px] text-dim hover:bg-white/5 hover:text-body"
            title="Clear output"
          >
            clear
          </button>
          <button
            onClick={() => void reset()}
            className="rounded px-1.5 py-0.5 font-mono text-[10px] text-dim hover:bg-white/5 hover:text-body"
            title="Kill & restart the shell"
          >
            ♻ reset
          </button>
        </div>
      </div>
      <div ref={scroller} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed">
        {term.length === 0 && (
          <p className="text-dim">
            Ready. Type a command below — this shell runs in your workspace and is shared with the agent.
          </p>
        )}
        <pre className="whitespace-pre-wrap break-words">
          {term.map((seg, i) => (
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
        <span className="shrink-0 font-mono text-[11px] text-[var(--accent)]" title={cwd}>
          {shortCwd || '~'} ❯
        </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          placeholder={ready ? 'run a command…' : 'running…'}
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
        {!ready && (
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full" style={{ background: 'var(--accent)' }} />
        )}
      </div>
    </div>
  )
}

export function StudioPanel(): React.JSX.Element {
  const open = useUIStore((s) => s.activePanel === 'studio')
  const setPanel = useUIStore((s) => s.setPanel)
  const root = useStudioStore((s) => s.root)
  const nodes = useStudioStore((s) => s.nodes)
  const tabs = useStudioStore((s) => s.tabs)
  const activePath = useStudioStore((s) => s.activePath)
  const loading = useStudioStore((s) => s.loading)
  const init = useStudioStore((s) => s.init)
  const refreshTree = useStudioStore((s) => s.refreshTree)
  const createNode = useStudioStore((s) => s.createNode)
  const setActive = useStudioStore((s) => s.setActive)
  const closeTab = useStudioStore((s) => s.closeTab)
  const editActive = useStudioStore((s) => s.editActive)
  const saveActive = useStudioStore((s) => s.saveActive)
  const pickRoot = useStudioStore((s) => s.pickRoot)
  const reveal = useStudioStore((s) => s.reveal)

  const [creating, setCreating] = useState<null | 'file' | 'dir'>(null)
  const [newName, setNewName] = useState('')
  const [termHeight, setTermHeight] = useState(260)

  useEffect(() => {
    if (open) void init()
  }, [open, init])

  const activeTab = tabs.find((t) => t.path === activePath)

  const commitCreate = (): void => {
    const name = newName.trim()
    const kind = creating
    setCreating(null)
    setNewName('')
    if (name && kind) void createNode('', name, kind)
  }

  const shortRoot = root.replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)' }}
          onClick={() => setPanel('none')}
        >
          <motion.div
            initial={{ scale: 0.98, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="h-full w-full max-w-[1400px]"
          >
            <Glass brackets className="flex h-full w-full flex-col overflow-hidden">
              {/* header */}
              <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <span className="neon font-display text-xs font-bold tracking-[0.3em]">
                    COSMOS STUDIO
                  </span>
                  <button
                    onClick={() => reveal()}
                    title="Reveal in File Explorer"
                    className="max-w-[420px] truncate rounded bg-black/30 px-2 py-1 font-mono text-[10px] text-dim hover:text-body"
                  >
                    {shortRoot || 'workspace'}
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => void pickRoot()}
                    className="rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-dim hover:bg-white/5 hover:text-body"
                  >
                    Change folder
                  </button>
                  <button
                    onClick={() => setPanel('none')}
                    className="rounded-md px-2 py-1 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
                  >
                    ESC
                  </button>
                </div>
              </div>

              {/* body */}
              <div className="flex min-h-0 flex-1">
                {/* file tree */}
                <div className="flex w-60 shrink-0 flex-col border-r border-white/5">
                  <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
                      Explorer
                    </span>
                    <div className="flex items-center gap-0.5">
                      <button
                        onClick={() => {
                          setCreating('file')
                          setNewName('')
                        }}
                        title="New file"
                        className="rounded px-1 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
                      >
                        ⊕
                      </button>
                      <button
                        onClick={() => {
                          setCreating('dir')
                          setNewName('')
                        }}
                        title="New folder"
                        className="rounded px-1 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
                      >
                        ▤
                      </button>
                      <button
                        onClick={() => void refreshTree()}
                        title="Refresh"
                        className="rounded px-1 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
                      >
                        ⟳
                      </button>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto py-1 pr-1">
                    {creating && (
                      <div className="px-2 py-1">
                        <input
                          autoFocus
                          value={newName}
                          onChange={(e) => setNewName(e.target.value)}
                          onBlur={commitCreate}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitCreate()
                            if (e.key === 'Escape') {
                              setCreating(null)
                              setNewName('')
                            }
                          }}
                          placeholder={creating === 'file' ? 'file name…' : 'folder name…'}
                          className="w-full rounded border border-[var(--accent-dim)] bg-black/40 px-1.5 py-0.5 font-ui text-xs text-body placeholder:text-dim focus:border-[var(--accent)] focus:outline-none"
                        />
                      </div>
                    )}
                    {loading && nodes.length === 0 ? (
                      <p className="px-3 py-4 font-ui text-xs text-dim">Loading workspace…</p>
                    ) : nodes.length === 0 ? (
                      <p className="px-3 py-4 font-ui text-xs text-dim">
                        Empty workspace. Create a file, or ask COSMOS to build something here in Agent mode.
                      </p>
                    ) : (
                      nodes.map((n) => <TreeRow key={n.path} node={n} depth={0} />)
                    )}
                  </div>
                </div>

                {/* editor + terminal */}
                <div className="flex min-w-0 flex-1 flex-col">
                  {/* tab bar */}
                  <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-white/5 px-1">
                    {tabs.map((t) => (
                      <div
                        key={t.path}
                        onClick={() => setActive(t.path)}
                        className={`group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2.5 text-left ${
                          t.path === activePath ? 'bg-white/10' : 'hover:bg-white/5'
                        }`}
                        title={t.path}
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: extColor(t.name) }}
                        />
                        <span className="font-ui text-xs text-body">{t.name}</span>
                        {t.dirty && <span className="text-[var(--accent)]">●</span>}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            closeTab(t.path)
                          }}
                          className="rounded px-0.5 font-mono text-[11px] text-dim opacity-0 hover:text-body group-hover:opacity-100"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* editor */}
                  <div className="relative min-h-0 flex-1">
                    {activeTab ? (
                      activeTab.truncated ? (
                        <div className="flex h-full items-center justify-center p-6 text-center font-ui text-sm text-dim">
                          {activeTab.content}
                        </div>
                      ) : (
                        <CodeEditor
                          key={activeTab.path}
                          path={activeTab.path}
                          value={activeTab.content}
                          onChange={editActive}
                          onSave={() => void saveActive()}
                        />
                      )
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                        <span className="neon font-display text-2xl font-bold tracking-[0.3em] opacity-30">
                          COSMOS
                        </span>
                        <p className="font-ui text-xs text-dim">
                          Open a file from the Explorer, or ask COSMOS to build a project in Agent mode.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* terminal */}
                  <div className="shrink-0 border-t border-white/10" style={{ height: termHeight }}>
                    <div
                      className="h-1 w-full cursor-ns-resize hover:bg-[var(--accent-dim)]"
                      onMouseDown={(e) => {
                        const startY = e.clientY
                        const startH = termHeight
                        const move = (ev: MouseEvent): void =>
                          setTermHeight(Math.min(560, Math.max(120, startH + (startY - ev.clientY))))
                        const up = (): void => {
                          window.removeEventListener('mousemove', move)
                          window.removeEventListener('mouseup', up)
                        }
                        window.addEventListener('mousemove', move)
                        window.addEventListener('mouseup', up)
                      }}
                    />
                    <div style={{ height: termHeight - 4 }}>
                      <Terminal />
                    </div>
                  </div>
                </div>
              </div>
            </Glass>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
