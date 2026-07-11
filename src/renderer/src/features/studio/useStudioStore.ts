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

/** one integrated-terminal session in the UI, with its own scrollback */
export interface UITerminal {
  id: string
  title: string
  cwd: string
  ready: boolean
  segments: TermSegment[]
}

/** which docked panels are currently visible */
export type PanelId = 'explorer' | 'chat' | 'terminal' | 'preview'

interface PanelState {
  explorer: boolean
  chat: boolean
  terminal: boolean
  preview: boolean
}

interface SizeState {
  explorerWidth: number
  chatWidth: number
  terminalHeight: number
  previewWidth: number
}

interface StudioStore {
  root: string
  nodes: FileNode[]
  expanded: Set<string>
  tabs: OpenTab[]
  activePath: string | null
  loading: boolean
  git: GitStatus | null

  // ── layout ──
  panels: PanelState
  sizes: SizeState
  togglePanel: (panel: PanelId) => void
  setPanel: (panel: PanelId, open: boolean) => void
  setSize: <K extends keyof SizeState>(key: K, value: number) => void

  // ── terminals ──
  terminals: UITerminal[]
  activeTermId: string | null
  createTerminal: () => Promise<void>
  closeTerminal: (id: string) => Promise<void>
  setActiveTerm: (id: string) => void
  sendTerminal: (id: string, command: string) => void
  resetTerminal: (id: string) => Promise<void>
  clearTerminal: (id: string) => void

  // ── preview ──
  previewUrl: string
  setPreviewUrl: (url: string) => void
  /** serve a workspace file (or the whole workspace) over http and show it in
   *  the preview pane — this is what makes a plain HTML game playable in-app */
  openPreview: (relPath?: string) => Promise<void>

  init: () => Promise<void>
  refreshTree: () => Promise<void>
  refreshGit: () => Promise<void>
  toggleDir: (node: FileNode) => Promise<void>
  openFile: (path: string) => Promise<void>
  openFileDialog: () => Promise<void>
  setActive: (path: string) => void
  closeTab: (path: string) => void
  editActive: (content: string) => void
  saveActive: () => Promise<void>
  createNode: (parentDir: string, name: string, kind: 'file' | 'dir') => Promise<void>
  renameNode: (path: string, name: string) => Promise<void>
  deleteNode: (path: string) => Promise<void>
  pickRoot: () => Promise<void>
  reveal: (path?: string) => void
}

let wired = false
const MAX_TERM_SEGMENTS = 1200

// ── layout persistence ──────────────────────────────────────────────────────
const LAYOUT_KEY = 'cosmos.studio.layout'
const DEFAULT_PANELS: PanelState = { explorer: true, chat: true, terminal: true, preview: false }
const DEFAULT_SIZES: SizeState = {
  explorerWidth: 248,
  chatWidth: 360,
  terminalHeight: 240,
  previewWidth: 520
}

function loadLayout(): { panels: PanelState; sizes: SizeState; previewUrl: string } {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<{
        panels: PanelState
        sizes: SizeState
        previewUrl: string
      }>
      // our static preview server binds 127.0.0.1 on an ephemeral port, so a
      // persisted URL from last session is dead — drop it and show the empty
      // state (the user's own localhost:3000 dev-server URLs are kept)
      const savedUrl = p.previewUrl ?? 'http://localhost:3000'
      return {
        panels: { ...DEFAULT_PANELS, ...p.panels },
        sizes: { ...DEFAULT_SIZES, ...p.sizes },
        previewUrl: savedUrl.includes('127.0.0.1') ? '' : savedUrl
      }
    }
  } catch {
    /* corrupt / unavailable — fall back to defaults */
  }
  return { panels: DEFAULT_PANELS, sizes: DEFAULT_SIZES, previewUrl: 'http://localhost:3000' }
}

function saveLayout(s: StudioStore): void {
  try {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ panels: s.panels, sizes: s.sizes, previewUrl: s.previewUrl })
    )
  } catch {
    /* storage full / unavailable — layout just won't persist */
  }
}

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

const initialLayout = loadLayout()

export const useStudioStore = create<StudioStore>((set, get) => ({
  root: '',
  nodes: [],
  expanded: new Set(),
  tabs: [],
  activePath: null,
  loading: false,
  git: null,

  panels: initialLayout.panels,
  sizes: initialLayout.sizes,
  terminals: [],
  activeTermId: null,
  previewUrl: initialLayout.previewUrl,

  togglePanel: (panel) => {
    set((s) => ({ panels: { ...s.panels, [panel]: !s.panels[panel] } }))
    saveLayout(get())
  },

  setPanel: (panel, open) => {
    set((s) => ({ panels: { ...s.panels, [panel]: open } }))
    saveLayout(get())
  },

  setSize: (key, value) => {
    set((s) => ({ sizes: { ...s.sizes, [key]: value } }))
    saveLayout(get())
  },

  setPreviewUrl: (url) => {
    set({ previewUrl: url })
    saveLayout(get())
  },

  openPreview: async (relPath) => {
    const url = await window.cosmos.preview.serve(relPath)
    set((s) => ({ previewUrl: url, panels: { ...s.panels, preview: true } }))
    saveLayout(get())
  },

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
      window.cosmos.terminal.onData((chunk) => appendTerm(chunk, set))
    }

    // populate terminals (ensures the shared primary exists), preserving any
    // scrollback we already have for still-live sessions
    const infos = await window.cosmos.terminal.list()
    set((s) => {
      const existing = new Map(s.terminals.map((t) => [t.id, t]))
      const terminals: UITerminal[] = infos.map(
        (info) =>
          existing.get(info.id) ?? {
            id: info.id,
            title: info.title,
            cwd: info.cwd,
            ready: true,
            segments: []
          }
      )
      const activeTermId =
        s.activeTermId && terminals.some((t) => t.id === s.activeTermId)
          ? s.activeTermId
          : (terminals[0]?.id ?? null)
      return { terminals, activeTermId }
    })
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

  openFileDialog: async () => {
    const res = await window.cosmos.workspace.pickFile()
    if (!res) return
    if (res.switchedRoot) {
      // opening a file outside the workspace re-rooted us — reload everything
      set({ root: res.root, tabs: [], activePath: null, expanded: new Set(), terminals: [], activeTermId: null })
      await get().init()
    }
    await get().openFile(res.relPath)
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
      tabs: s.tabs.map((t) => (t.path === s.activePath ? { ...t, content, dirty: true } : t))
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
    const prev = get().root
    const root = await window.cosmos.workspace.pick()
    // dialog cancelled (or same folder re-picked) → keep open tabs & terminals
    if (!root || root === prev) return
    set({
      root,
      tabs: [],
      activePath: null,
      expanded: new Set(),
      terminals: [],
      activeTermId: null
    })
    await get().init()
  },

  reveal: (path) => void window.cosmos.files.reveal(path),

  // ── terminals ──
  createTerminal: async () => {
    const info = await window.cosmos.terminal.create()
    set((s) => ({
      terminals: [
        ...s.terminals,
        { id: info.id, title: info.title, cwd: info.cwd, ready: true, segments: [] }
      ],
      activeTermId: info.id,
      panels: { ...s.panels, terminal: true }
    }))
    saveLayout(get())
  },

  closeTerminal: async (id) => {
    await window.cosmos.terminal.close(id)
    // the shared primary is never removed — closing it just clears its scrollback
    if (id === 'primary') {
      set((s) => ({
        terminals: s.terminals.map((t) => (t.id === id ? { ...t, segments: [], ready: true } : t))
      }))
      return
    }
    set((s) => {
      const terminals = s.terminals.filter((t) => t.id !== id)
      const activeTermId =
        s.activeTermId === id ? (terminals[terminals.length - 1]?.id ?? null) : s.activeTermId
      return { terminals, activeTermId }
    })
  },

  setActiveTerm: (id) => set({ activeTermId: id }),

  sendTerminal: (id, command) => {
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, ready: false } : t))
    }))
    void window.cosmos.terminal.input(id, command)
  },

  resetTerminal: async (id) => {
    const cwd = await window.cosmos.terminal.reset(id)
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, segments: [], cwd, ready: true } : t))
    }))
  },

  clearTerminal: (id) =>
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, segments: [] } : t))
    }))
}))

/** route a streamed chunk to its terminal: system ready-markers update cwd */
function appendTerm(
  chunk: TerminalChunk,
  set: (fn: (s: StudioStore) => Partial<StudioStore>) => void
): void {
  if (chunk.stream === 'system' && chunk.data.startsWith(STX) && chunk.data.endsWith(ETX)) {
    const cwd = chunk.data.slice(1, -1)
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === chunk.id ? { ...t, cwd, ready: true } : t))
    }))
    return
  }
  set((s) => ({
    terminals: s.terminals.map((t) => {
      if (t.id !== chunk.id) return t
      const segments = [...t.segments, { text: chunk.data, stream: chunk.stream }]
      if (segments.length > MAX_TERM_SEGMENTS) segments.splice(0, segments.length - MAX_TERM_SEGMENTS)
      return { ...t, segments }
    })
  }))
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
