import { useState } from 'react'
import type { FileNode } from '@shared/types'
import { useStudioStore } from './useStudioStore'

/** a file's language accent color, by extension — a subtle premium touch */
export function extColor(name: string): string {
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
          <span
            className={`min-w-0 flex-1 truncate font-ui text-xs ${
              isActive ? 'text-body' : 'text-dim group-hover:text-body'
            }`}
          >
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

export function FileExplorer(): React.JSX.Element {
  const nodes = useStudioStore((s) => s.nodes)
  const loading = useStudioStore((s) => s.loading)
  const refreshTree = useStudioStore((s) => s.refreshTree)
  const createNode = useStudioStore((s) => s.createNode)
  const openFileDialog = useStudioStore((s) => s.openFileDialog)
  const togglePanel = useStudioStore((s) => s.togglePanel)
  const [creating, setCreating] = useState<null | 'file' | 'dir'>(null)
  const [newName, setNewName] = useState('')

  const commitCreate = (): void => {
    const name = newName.trim()
    const kind = creating
    setCreating(null)
    setNewName('')
    if (name && kind) void createNode('', name, kind)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">Explorer</span>
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
            onClick={() => void openFileDialog()}
            title="Open file…"
            className="rounded px-1 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
          >
            ⎘
          </button>
          <button
            onClick={() => void refreshTree()}
            title="Refresh"
            className="rounded px-1 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
          >
            ⟳
          </button>
          <button
            onClick={() => togglePanel('explorer')}
            title="Collapse Explorer"
            className="rounded px-1 font-mono text-xs text-dim hover:bg-white/5 hover:text-body"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="smooth-scroll min-h-0 flex-1 overflow-y-auto py-1 pr-1">
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
  )
}
