import { create } from 'zustand'
import type { FileNode, GitStatus, TerminalChunk } from '@shared/types'

/** control-char sentinel the terminal uses to carry the ready prompt + cwd */
const STX = ''
const ETX = ''

export interface OpenTab {
  path: string
  name: string
  content: string
  dirty: boolean
  truncated: boolean
}

interface TermSegment {
  text: string
  stream: TerminalChunk['stream']
}

interface StudioStore {
  root: string
  nodes: FileNode[]
  expanded: Set<string>
  tabs: OpenTab[]
  activePath: string | null
  term: TermSegment[]
  cwd: string
  ready: boolean
  loading: boolean
  git: GitStatus | null

  init: () => Promise<void>
  refreshTree: () => Promise<void>
  refreshGit: () => Promise<void>
  toggleDir: (node: FileNode) => Promise<void>
  openFile: (path: string) => Promise<void>
  setActive: (path: string) => void
  closeTab: (path: string) => void
  editActive: (content: string) => void
  saveActive: () => Promise<void>
  createNode: (parentDir: string, name: string, kind: 'file' | 'dir') => Promise<void>
  renameNode: (path: string, name: string) => Promise<void>
  deleteNode: (path: string) => Promise<void>
  pickRoot: () => Promise<void>
  reveal: (path?: string) => void
  sendTerminal: (command: string) => void
  resetTerminal: () => Promise<void>
  clearTerminal: () => void
}

let wired = false
const MAX_TERM_SEGMENTS = 1200

/** replace the node at `path` inside a tree, returning a new tree */
function patchNode(nodes: FileNode[], path: string, fn: (n: FileNode) => FileNode): FileNode[] {
  return nodes.map((n) => {
    if (n.path === path) return fn(n)
    if (n.children && path.startsWith(n.path + '/')) {
      return { ...n, children: patchNode(n.children, path, fn) }
    }
    return n
  })
}

export const useStudioStore = create<StudioStore>((set, get) => ({
  root: '',
  nodes: [],
  expanded: new Set(),
  tabs: [],
  activePath: null,
  term: [],
  cwd: '',
  ready: false,
  loading: false,
  git: null,

  init: async () => {
    set({ loading: true })
    const { root, nodes } = await window.cosmos.files.tree()
    set({ root, nodes, loading: false })
    void get().refreshGit()

    if (!wired) {
      wired = true
      // agent edits / external changes → refresh tree, reload open files, git
      window.cosmos.workspace.onFilesChanged(() => {
        void get().refreshTree()
        void reloadOpenTabs(get, set)
        void get().refreshGit()
      })
      window.cosmos.terminal.onData((chunk) => appendTerm(chunk, set, get))
    }
    const cwd = await window.cosmos.terminal.start()
    set({ cwd, ready: true })
  },

  refreshGit: async () => {
    try {
      set({ git: await window.cosmos.github.status() })
    } catch {
      set({ git: null })
    }
  },

  refreshTree: async () => {
    const { root, nodes } = await window.cosmos.files.tree()
    // preserve already-expanded dirs by re-fetching their children
    set({ root, nodes })
    for (const path of get().expanded) {
      try {
        const children = await window.cosmos.files.list(path)
        set((s) => ({ nodes: patchNode(s.nodes, path, (n) => ({ ...n, children })) }))
      } catch {
        /* dir vanished — ignore */
      }
    }
  },

  toggleDir: async (node) => {
    const expanded = new Set(get().expanded)
    if (expanded.has(node.path)) {
      expanded.delete(node.path)
      set({ expanded })
      return
    }
    expanded.add(node.path)
    if (!node.children) {
      const children = await window.cosmos.files.list(node.path)
      set((s) => ({
        expanded,
        nodes: patchNode(s.nodes, node.path, (n) => ({ ...n, children }))
      }))
    } else {
      set({ expanded })
    }
  },

  openFile: async (path) => {
    const existing = get().tabs.find((t) => t.path === path)
    if (existing) {
      set({ activePath: path })
      return
    }
    const { content, truncated } = await window.cosmos.files.read(path)
    const name = path.split('/').pop() ?? path
    set((s) => ({
      tabs: [...s.tabs, { path, name, content, dirty: false, truncated }],
      activePath: path
    }))
  },

  setActive: (path) => set({ activePath: path }),

  closeTab: (path) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.path !== path)
      const activePath =
        s.activePath === path ? (tabs[tabs.length - 1]?.path ?? null) : s.activePath
      return { tabs, activePath }
    }),

  editActive: (content) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === s.activePath ? { ...t, content, dirty: true } : t
      )
    })),

  saveActive: async () => {
    const tab = get().tabs.find((t) => t.path === get().activePath)
    if (!tab || !tab.dirty || tab.truncated) return
    await window.cosmos.files.write(tab.path, tab.content)
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === tab.path ? { ...t, dirty: false } : t))
    }))
  },

  createNode: async (parentDir, name, kind) => {
    const rel = parentDir ? `${parentDir}/${name}` : name
    const created = await window.cosmos.files.create(rel, kind)
    await get().refreshTree()
    if (kind === 'file') await get().openFile(created)
  },

  renameNode: async (path, name) => {
    const next = await window.cosmos.files.rename(path, name)
    // update any open tab pointing at the old path
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path ? { ...t, path: next, name: next.split('/').pop() ?? next } : t
      ),
      activePath: s.activePath === path ? next : s.activePath
    }))
    await get().refreshTree()
  },

  deleteNode: async (path) => {
    await window.cosmos.files.delete(path)
    set((s) => ({
      tabs: s.tabs.filter((t) => t.path !== path && !t.path.startsWith(path + '/')),
      activePath:
        s.activePath && (s.activePath === path || s.activePath.startsWith(path + '/'))
          ? null
          : s.activePath
    }))
    await get().refreshTree()
  },

  pickRoot: async () => {
    const root = await window.cosmos.workspace.pick()
    set({ root, tabs: [], activePath: null, expanded: new Set(), term: [] })
    await get().init()
  },

  reveal: (path) => void window.cosmos.files.reveal(path),

  sendTerminal: (command) => {
    set({ ready: false })
    void window.cosmos.terminal.input(command)
  },

  resetTerminal: async () => {
    const cwd = await window.cosmos.terminal.reset()
    set({ term: [], cwd, ready: true })
  },

  clearTerminal: () => set({ term: [] })
}))

/** parse a streamed chunk: system ready-markers update cwd, everything else prints */
function appendTerm(
  chunk: TerminalChunk,
  set: (fn: (s: StudioStore) => Partial<StudioStore>) => void,
  _get: () => StudioStore
): void {
  if (chunk.stream === 'system' && chunk.data.startsWith(STX) && chunk.data.endsWith(ETX)) {
    const cwd = chunk.data.slice(1, -1)
    set(() => ({ cwd, ready: true }))
    return
  }
  set((s) => {
    const term = [...s.term, { text: chunk.data, stream: chunk.stream }]
    if (term.length > MAX_TERM_SEGMENTS) term.splice(0, term.length - MAX_TERM_SEGMENTS)
    return { term }
  })
}

/** after an external change, silently reload the on-disk content of clean tabs */
async function reloadOpenTabs(
  get: () => StudioStore,
  set: (fn: (s: StudioStore) => Partial<StudioStore>) => void
): Promise<void> {
  for (const tab of get().tabs) {
    if (tab.dirty || tab.truncated) continue // never clobber unsaved edits
    try {
      const { content } = await window.cosmos.files.read(tab.path)
      if (content !== tab.content) {
        set((s) => ({
          tabs: s.tabs.map((t) => (t.path === tab.path ? { ...t, content } : t))
        }))
      }
    } catch {
      /* file removed — leave the tab, user can close it */
    }
  }
}
