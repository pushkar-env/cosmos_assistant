import { app, shell, type BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, watch, type FSWatcher } from 'fs'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'path'
import { IPC } from '@shared/ipc'
import type { FileNode, TerminalChunk } from '@shared/types'
import type { SettingsService } from './SettingsService'

/** dirs never shown in the tree / walked by project_tree — noise + huge */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'venv',
  '.venv',
  'env',
  'target',
  'bin',
  'obj',
  '.idea',
  '.vscode',
  '.gradle',
  'vendor',
  'Pods',
  '.DS_Store'
])

const MAX_TREE_ENTRIES = 4000
const MAX_FILE_BYTES = 2_000_000 // 2 MB — refuse to load anything larger in the editor
/** control-char sentinel PowerShell echoes after each command completes */
const STX = ''
const ETX = ''

/**
 * Owns the agent's project workspace: the root folder, sandboxed file
 * operations for the Studio editor + tree, a recursive change watcher, and
 * a persistent PowerShell terminal shared by the UI terminal and the agent's
 * run_command tool. One instance, created at startup.
 */
export class WorkspaceService {
  private getWindow: () => BrowserWindow | null = () => null
  private watcher: FSWatcher | null = null
  private watchDebounce: ReturnType<typeof setTimeout> | null = null
  private terminal: TerminalSession | null = null

  constructor(private readonly settings: SettingsService) {}

  /** wired at registerIpc time so async terminal/watcher output can reach the UI */
  attachWindow(getWindow: () => BrowserWindow | null): void {
    this.getWindow = getWindow
  }

  // ── root ────────────────────────────────────────────────────────────────

  /** the effective workspace root, created on disk if missing */
  async getRoot(): Promise<string> {
    const configured = this.settings.get().workspaceRoot?.trim()
    const root = configured && isAbsolute(configured) ? normalize(configured) : this.defaultRoot()
    if (!existsSync(root)) {
      try {
        await fs.mkdir(root, { recursive: true })
      } catch {
        /* fall through — callers surface a clear error on first use */
      }
    }
    return root
  }

  private defaultRoot(): string {
    let docs: string
    try {
      docs = app.getPath('documents')
    } catch {
      docs = join(homedir(), 'Documents')
    }
    return join(docs, 'COSMOS Projects')
  }

  /** persist a new root (from the folder picker / settings) */
  async setRoot(dir: string): Promise<string> {
    const root = normalize(dir)
    await fs.mkdir(root, { recursive: true })
    this.settings.set({ workspaceRoot: root })
    this.stopWatching() // re-attaches to the new root on next tree()
    if (this.terminal) {
      this.terminal.dispose()
      this.terminal = null
    }
    return root
  }

  /**
   * Resolve a path inside the workspace. Relative paths join the root;
   * absolute paths are honored (the agent may work outside), but Studio file
   * ops pass sandbox=true to forbid escaping the root.
   */
  async resolve(input: string, sandbox = false): Promise<string> {
    const root = await this.getRoot()
    const raw = String(input).trim().replace(/^["']|["']$/g, '')
    const abs = isAbsolute(raw) ? normalize(raw) : normalize(join(root, raw))
    if (sandbox) {
      const rel = relative(root, abs)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error('Path is outside the workspace folder.')
      }
    }
    return abs
  }

  /** POSIX-relative path from the root, for FileNode.path */
  private async rel(abs: string): Promise<string> {
    const root = await this.getRoot()
    return relative(root, abs).split(sep).join('/')
  }

  // ── file tree / ops ───────────────────────────────────────────────────────

  /** the workspace file tree, one level lazily-expandable at a time */
  async tree(): Promise<{ root: string; nodes: FileNode[] }> {
    const root = await this.getRoot()
    this.startWatching(root)
    const counter = { n: 0 }
    const nodes = await this.readDir(root, counter, 0)
    return { root, nodes }
  }

  private async readDir(dir: string, counter: { n: number }, depth: number): Promise<FileNode[]> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const dirs: FileNode[] = []
    const files: FileNode[] = []
    for (const e of entries) {
      if (counter.n >= MAX_TREE_ENTRIES) break
      if (e.name.startsWith('.') && IGNORED_DIRS.has(e.name)) continue
      if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue
      counter.n++
      const abs = join(dir, e.name)
      const node: FileNode = { name: e.name, path: await this.rel(abs), kind: e.isDirectory() ? 'dir' : 'file' }
      if (e.isDirectory()) {
        // eagerly expand the top two levels so the tree feels instant
        if (depth < 2) node.children = await this.readDir(abs, counter, depth + 1)
        dirs.push(node)
      } else {
        files.push(node)
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => a.name.localeCompare(b.name))
    return [...dirs, ...files]
  }

  /**
   * A compact, indented text tree for the agent to orient itself in a
   * project. Skips build/dependency dirs; capped so it never floods context.
   */
  async textTree(startRel = '', maxDepth = 4, maxLines = 400): Promise<string> {
    const base = startRel ? await this.resolve(startRel) : await this.getRoot()
    const lines: string[] = []
    const walk = async (dir: string, depth: number, prefix: string): Promise<void> => {
      if (depth > maxDepth || lines.length >= maxLines) return
      let entries: import('fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      const dirs = entries.filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
      const files = entries.filter((e) => e.isFile())
      const ordered = [...dirs, ...files].sort((a, b) => a.name.localeCompare(b.name))
      for (const e of ordered) {
        if (lines.length >= maxLines) {
          lines.push(`${prefix}… (truncated)`)
          return
        }
        lines.push(`${prefix}${e.isDirectory() ? '📁 ' : '   '}${e.name}`)
        if (e.isDirectory()) await walk(join(dir, e.name), depth + 1, prefix + '  ')
      }
    }
    await walk(base, 1, '')
    return lines.length ? `${base}\n${lines.join('\n')}` : `${base}\n(empty)`
  }

  /** expand a single directory on demand (tree lazy-load) */
  async listDir(relPath: string): Promise<FileNode[]> {
    const abs = await this.resolve(relPath, true)
    return this.readDir(abs, { n: 0 }, 2) // depth 2 → children are leaves unless expanded
  }

  async readFile(relPath: string): Promise<{ content: string; truncated: boolean }> {
    const abs = await this.resolve(relPath, true)
    const stat = await fs.stat(abs)
    if (stat.size > MAX_FILE_BYTES) {
      return { content: `[This file is ${(stat.size / 1_000_000).toFixed(1)} MB — too large to open in the editor.]`, truncated: true }
    }
    const buf = await fs.readFile(abs)
    return { content: buf.toString('utf-8'), truncated: false }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = await this.resolve(relPath, true)
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf-8')
  }

  /** create an empty file or a folder; returns the new relative path */
  async create(relPath: string, kind: 'file' | 'dir'): Promise<string> {
    const abs = await this.resolve(relPath, true)
    if (existsSync(abs)) throw new Error('Already exists.')
    if (kind === 'dir') await fs.mkdir(abs, { recursive: true })
    else {
      await fs.mkdir(dirname(abs), { recursive: true })
      await fs.writeFile(abs, '', 'utf-8')
    }
    return this.rel(abs)
  }

  async rename(relPath: string, nextName: string): Promise<string> {
    const abs = await this.resolve(relPath, true)
    const dest = join(dirname(abs), basename(nextName))
    await fs.rename(abs, dest)
    return this.rel(dest)
  }

  /** move a file/folder to the Recycle Bin (recoverable) */
  async trash(relPath: string): Promise<void> {
    const abs = await this.resolve(relPath, true)
    await shell.trashItem(abs)
  }

  async reveal(relPath?: string): Promise<void> {
    const abs = relPath ? await this.resolve(relPath, true) : await this.getRoot()
    if (existsSync(abs)) shell.showItemInFolder(abs)
  }

  // ── change watcher ────────────────────────────────────────────────────────

  private startWatching(root: string): void {
    if (this.watcher) return
    try {
      this.watcher = watch(root, { recursive: true }, () => {
        if (this.watchDebounce) clearTimeout(this.watchDebounce)
        this.watchDebounce = setTimeout(() => {
          const win = this.getWindow()
          if (win && !win.isDestroyed()) win.webContents.send(IPC.FILES_CHANGED)
        }, 250)
      })
    } catch {
      /* recursive watch unsupported here — the UI can still refresh manually */
    }
  }

  private stopWatching(): void {
    this.watcher?.close()
    this.watcher = null
  }

  // ── terminal ──────────────────────────────────────────────────────────────

  private async ensureTerminal(): Promise<TerminalSession> {
    // respawn if never started, or if a previous hang/crash killed the shell
    if (!this.terminal || this.terminal.dead) {
      this.terminal?.dispose()
      const root = await this.getRoot()
      this.terminal = new TerminalSession(root, (chunk) => {
        const win = this.getWindow()
        if (win && !win.isDestroyed()) win.webContents.send(IPC.TERM_DATA, chunk)
      })
    }
    return this.terminal
  }

  /** start (or reuse) the UI terminal; returns the current working directory */
  async terminalStart(): Promise<string> {
    const term = await this.ensureTerminal()
    return term.cwd
  }

  /** a line typed into the UI terminal (output streams over TERM_DATA) */
  async terminalInput(command: string): Promise<void> {
    const term = await this.ensureTerminal()
    void term.exec(command).catch(() => {})
  }

  /** hard reset: kill and respawn the shell in the workspace root */
  async terminalReset(): Promise<string> {
    if (this.terminal) {
      this.terminal.dispose()
      this.terminal = null
    }
    const term = await this.ensureTerminal()
    return term.cwd
  }

  /**
   * Run a command for the agent: it streams into the same UI terminal AND the
   * captured output is returned. Uses an IDLE timeout, not a fixed one, so a
   * long-but-active build (npm install, pip, cargo, docker) runs as long as it
   * keeps producing output — only a genuinely stuck command is cut off (and the
   * shell is then respawned). `background:true` starts it without waiting (dev
   * servers, watchers) so the loop isn't blocked.
   */
  async agentRun(command: string, background = false): Promise<string> {
    const term = await this.ensureTerminal()
    if (background) return term.runBackground(command)
    const out = await term.exec(command)
    return out.trim() || '(command produced no output)'
  }

  dispose(): void {
    this.stopWatching()
    this.terminal?.dispose()
    this.terminal = null
  }
}

/**
 * A persistent PowerShell process fed commands line-by-line over stdin.
 * After each command we echo a control-char sentinel carrying the exit code
 * and new working directory, which lets us (a) detect completion, (b) track
 * cwd, and (c) capture per-command output for the agent — all without a PTY.
 */
interface TermEntry {
  marker: string
  capture: string
  resolve: (out: string) => void
  idleTimer: ReturnType<typeof setTimeout> | null
  hardTimer: ReturnType<typeof setTimeout> | null
}

/** no output for this long on a foreground command → assume it's stuck */
const IDLE_TIMEOUT_MS = 180_000
/** absolute ceiling for any single foreground command */
const HARD_TIMEOUT_MS = 1_200_000

class TerminalSession {
  private proc: ChildProcessWithoutNullStreams
  cwd: string
  private seq = 0
  private queue: TermEntry[] = []
  private buffer = ''
  private disposed = false
  /** detached long-lived children (dev servers) — killed on dispose */
  private bgProcs = new Set<ChildProcessWithoutNullStreams>()

  constructor(
    root: string,
    private readonly onData: (chunk: TerminalChunk) => void
  ) {
    this.cwd = root
    // -ExecutionPolicy Bypass so the agent can run project build scripts (.ps1,
    // npm/pnpm shims) without a policy prompt; -Command - reads stdin line by
    // line with no prompt/echo noise (see cosmos-project memory).
    this.proc = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', '-'],
      { cwd: root, windowsHide: true }
    )
    this.proc.stdout.setEncoding('utf-8')
    this.proc.stderr.setEncoding('utf-8')
    this.proc.stdout.on('data', (d: string) => this.onStdout(d))
    this.proc.stderr.on('data', (d: string) => this.onStderr(d))
    this.proc.on('exit', () => {
      // free every waiter so the agent loop never hangs on a dead shell
      for (const e of this.queue) {
        this.clearTimers(e)
        e.resolve(e.capture + '\n[terminal exited]')
      }
      this.queue = []
      if (!this.disposed) this.onData({ data: '\n[terminal exited]\n', stream: 'system' })
    })
    // silence the default `PS C:\...>` prompt — we render our own
    this.proc.stdin.write("function prompt { '' }\n")
    this.onData({ data: `Workspace: ${root}\n`, stream: 'system' })
  }

  /** true once the shell has crashed / been killed — triggers a respawn */
  get dead(): boolean {
    return this.disposed || this.proc.exitCode !== null || this.proc.killed
  }

  /** run a command; resolves with its stdout+stderr once the sentinel lands */
  exec(command: string): Promise<string> {
    if (this.dead) return Promise.resolve('[terminal is not running]')
    const marker = `${STX}${++this.seq}`
    return new Promise<string>((resolve) => {
      const entry: TermEntry = { marker, capture: '', resolve, idleTimer: null, hardTimer: null }
      this.queue.push(entry)
      this.armTimers(entry)
      // echo the command so the UI shows what ran, then the sentinel line
      this.onData({ data: `❯ ${command}\n`, stream: 'system' })
      this.proc.stdin.write(`${command}\n`)
      this.proc.stdin.write(
        `Write-Output "${marker}:$($LASTEXITCODE):$((Get-Location).Path)${ETX}"\n`
      )
    })
  }

  /**
   * Launch a long-lived command (a dev server) as its OWN detached process so
   * it never blocks the interactive shell's pipeline. Output still streams to
   * the terminal UI, tagged so it's clear it's the background task.
   */
  runBackground(command: string): string {
    if (this.dead) return '[terminal is not running]'
    this.onData({ data: `❯ [background] ${command}\n`, stream: 'system' })
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { cwd: this.cwd, windowsHide: true }
    )
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (d: string) => this.onData({ data: d, stream: 'stdout' }))
    child.stderr.on('data', (d: string) => this.onData({ data: d, stream: 'stderr' }))
    child.on('exit', (code) => {
      this.bgProcs.delete(child)
      this.onData({ data: `\n[background task exited (code ${code})]\n`, stream: 'system' })
    })
    this.bgProcs.add(child)
    return `Started in the background (PID ${child.pid ?? '?'}), streaming to the COSMOS terminal. Working directory: ${this.cwd}`
  }

  /** (re)arm the idle + hard timeouts for the front-of-queue command */
  private armTimers(entry: TermEntry): void {
    this.clearTimers(entry)
    entry.idleTimer = setTimeout(() => this.fireTimeout(entry, 'idle'), IDLE_TIMEOUT_MS)
    if (!entry.hardTimer) {
      entry.hardTimer = setTimeout(() => this.fireTimeout(entry, 'hard'), HARD_TIMEOUT_MS)
    }
  }

  private clearTimers(entry: TermEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    if (entry.hardTimer) clearTimeout(entry.hardTimer)
    entry.idleTimer = null
    entry.hardTimer = null
  }

  private fireTimeout(entry: TermEntry, kind: 'idle' | 'hard'): void {
    if (this.queue[0] !== entry) return
    this.clearTimers(entry)
    this.queue.shift()
    const secs = Math.round((kind === 'idle' ? IDLE_TIMEOUT_MS : HARD_TIMEOUT_MS) / 1000)
    entry.resolve(
      entry.capture +
        `\n[the command was killed — ${kind === 'idle' ? `no output for ${secs}s (looked stuck)` : `hit the ${secs}s ceiling`}. The terminal was restarted. For a long-lived process (a dev server), run it with background:true.]`
    )
    // a stuck command blocks the shell's stdin pipeline — kill so it respawns
    this.disposed = false
    try {
      this.proc.kill()
    } catch {
      /* already gone */
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      this.handleLine(line)
    }
  }

  private handleLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const sentinel = line.indexOf(STX)
    if (sentinel !== -1 && line.includes(ETX)) {
      const payload = line.slice(sentinel + 1, line.indexOf(ETX))
      // payload = "<seq>:<exitcode>:<cwd>"
      const firstColon = payload.indexOf(':')
      const secondColon = payload.indexOf(':', firstColon + 1)
      const cwd = payload.slice(secondColon + 1)
      if (cwd) this.cwd = cwd
      const entry = this.queue.shift()
      if (entry) {
        this.clearTimers(entry)
        entry.resolve(entry.capture)
      }
      // tell the UI the prompt is ready again (carries the new cwd)
      this.onData({ data: `${STX}${this.cwd}${ETX}`, stream: 'system' })
      return
    }
    const current = this.queue[0]
    if (current) {
      current.capture += line + '\n'
      this.armTimers(current) // output → not stuck, reset the idle timer
    }
    this.onData({ data: line + '\n', stream: 'stdout' })
  }

  private onStderr(chunk: string): void {
    const current = this.queue[0]
    if (current) {
      current.capture += chunk
      this.armTimers(current)
    }
    this.onData({ data: chunk, stream: 'stderr' })
  }

  dispose(): void {
    this.disposed = true
    for (const e of this.queue) {
      this.clearTimers(e)
      e.resolve(e.capture)
    }
    this.queue = []
    for (const child of this.bgProcs) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    this.bgProcs.clear()
    try {
      this.proc.kill()
    } catch {
      /* already gone */
    }
  }
}
