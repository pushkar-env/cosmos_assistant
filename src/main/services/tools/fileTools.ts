import { shell } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { dirname, join } from 'path'
import { execFile } from 'child_process'
import type { ToolSpec } from './ToolRegistry'
import { resolveUserPath } from '../userPaths'

const MAX_READ_BYTES = 50_000
const MAX_LIST_ENTRIES = 200

/** turn a raw fs error into an actionable message for protected/bad paths */
function fsError(err: unknown, target: string): Error {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EPERM' || code === 'EACCES') {
    return new Error(
      `Permission denied at ${target}. That location is protected (Windows needs ` +
        `admin rights there) — use a normal folder like Desktop, Documents or Downloads.`
    )
  }
  if (code === 'ENOENT') {
    return new Error(
      `Path not available: ${target}. Use an existing folder such as Desktop, ` +
        `Documents or Downloads (I can't create new folders directly under C:\\Users).`
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function runPs(script: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) rej(new Error(stderr.trim() || err.message))
        else res(stdout.trim())
      }
    )
  })
}

export const fileTools: ToolSpec[] = [
  {
    def: {
      name: 'fs_list',
      description: 'List the contents of a directory (names, types, sizes).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute directory path' } },
        required: ['path']
      },
      sensitive: false
    },
    summary: (a) => String(a.path ?? ''),
    run: async (a, ctx) => {
      const dir = resolveUserPath(String(a.path), ctx.workspaceRoot)
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const lines = await Promise.all(
        entries.slice(0, MAX_LIST_ENTRIES).map(async (e) => {
          if (e.isDirectory()) return `[dir]  ${e.name}`
          try {
            const st = await fs.stat(join(dir, e.name))
            return `[file] ${e.name} (${st.size} bytes)`
          } catch {
            return `[file] ${e.name}`
          }
        })
      )
      const more = entries.length > MAX_LIST_ENTRIES ? `\n… ${entries.length - MAX_LIST_ENTRIES} more` : ''
      return lines.join('\n') + more || '(empty directory)'
    }
  },
  {
    def: {
      name: 'fs_read',
      description: `Read a text file (truncated to ${MAX_READ_BYTES} bytes).`,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute file path' } },
        required: ['path']
      },
      sensitive: false
    },
    summary: (a) => String(a.path ?? ''),
    run: async (a, ctx) => {
      const buf = await fs.readFile(resolveUserPath(String(a.path), ctx.workspaceRoot))
      const text = buf.subarray(0, MAX_READ_BYTES).toString('utf-8')
      return buf.length > MAX_READ_BYTES
        ? `${text}\n… [truncated, ${buf.length} bytes total]`
        : text
    }
  },
  {
    def: {
      name: 'fs_write',
      description:
        'Write text content to a file, creating parent folders. Overwrites existing files. Paths may be absolute, use ~, or start with a known folder (Desktop, Documents, Downloads) — e.g. "Desktop/notes.txt".',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path — absolute, ~/…, or Desktop/Documents/Downloads relative'
          },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      },
      sensitive: true
    },
    summary: (a) => String(a.path ?? ''),
    run: async (a, ctx) => {
      const file = resolveUserPath(String(a.path), ctx.workspaceRoot)
      try {
        await fs.mkdir(dirname(file), { recursive: true })
        await fs.writeFile(file, String(a.content), 'utf-8')
      } catch (err) {
        throw fsError(err, file)
      }
      return `Wrote ${String(a.content).length} chars to ${file}`
    }
  },
  {
    def: {
      name: 'open_path',
      description:
        'Open a local file or folder with its default handler — an .html file opens in the browser, a .txt/.md in the editor, a folder in File Explorer. Use THIS to preview or open a file or folder you just created (NOT url_open, which is only for web http(s) links, and NOT app_open, which is only for installed apps). Accepts relative paths like "Desktop/snake_game/index.html" or "~/…".',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File or folder path' } },
        required: ['path']
      },
      sensitive: false
    },
    summary: (a) => String(a.path ?? ''),
    run: async (a, ctx) => {
      const target = resolveUserPath(String(a.path), ctx.workspaceRoot)
      if (!existsSync(target)) {
        throw new Error(
          `Nothing exists at ${target}. Create the file first, then open it (use the ` +
            `same path you wrote to).`
        )
      }
      const err = await shell.openPath(target)
      if (err) throw new Error(`Couldn't open ${target}: ${err}`)
      return `Opened ${target}`
    }
  },
  {
    def: {
      name: 'fs_mkdir',
      description:
        'Create a folder (recursively). Prefer a relative path like "Desktop/MyFolder" or "~/MyFolder" — do NOT build a C:\\Users\\<name> path from the user\'s name; the real home is resolved for you.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      },
      sensitive: false
    },
    summary: (a) => String(a.path ?? ''),
    run: async (a, ctx) => {
      const dir = resolveUserPath(String(a.path), ctx.workspaceRoot)
      try {
        await fs.mkdir(dir, { recursive: true })
      } catch (err) {
        throw fsError(err, dir)
      }
      return `Created ${dir}`
    }
  },
  {
    def: {
      name: 'fs_search',
      description: 'Search a directory tree for files/folders whose name contains a query (case-insensitive).',
      inputSchema: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Root directory to search' },
          query: { type: 'string', description: 'Substring to match in names' },
          maxResults: { type: 'number', description: 'Default 50' }
        },
        required: ['directory', 'query']
      },
      sensitive: false
    },
    summary: (a) => `"${String(a.query ?? '')}" in ${String(a.directory ?? '')}`,
    run: async (a, ctx) => {
      const root = resolveUserPath(String(a.directory), ctx.workspaceRoot)
      const query = String(a.query).toLowerCase()
      const max = Math.min(Number(a.maxResults) || 50, 200)
      const hits: string[] = []
      const skip = new Set(['node_modules', '.git', 'AppData', '$RECYCLE.BIN'])

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (hits.length >= max || depth > 6) return
        let entries
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (hits.length >= max) return
          if (e.name.toLowerCase().includes(query)) hits.push(join(dir, e.name))
          if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) {
            await walk(join(dir, e.name), depth + 1)
          }
        }
      }
      await walk(root, 0)
      return hits.length ? hits.join('\n') : 'No matches found.'
    }
  },
  {
    def: {
      name: 'fs_move',
      description:
        'Move or rename a file or folder. Use relative paths like "Desktop/file.txt" where possible — do NOT build a C:\\Users\\<name> path from the user\'s name; the real home is resolved for you.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          destination: { type: 'string' }
        },
        required: ['source', 'destination']
      },
      sensitive: true
    },
    summary: (a) => `${String(a.source ?? '')} → ${String(a.destination ?? '')}`,
    run: async (a, ctx) => {
      const src = resolveUserPath(String(a.source), ctx.workspaceRoot)
      const dest = resolveUserPath(String(a.destination), ctx.workspaceRoot)
      try {
        await fs.mkdir(dirname(dest), { recursive: true })
        try {
          await fs.rename(src, dest)
        } catch (err) {
          // cross-drive move: copy then trash the original
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
          await fs.cp(src, dest, { recursive: true })
          await shell.trashItem(src)
        }
      } catch (err) {
        throw fsError(err, dest)
      }
      return `Moved to ${dest}`
    }
  },
  {
    def: {
      name: 'fs_delete',
      description: 'Delete a file or folder (moves it to the Recycle Bin, recoverable).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      },
      sensitive: true
    },
    summary: (a) => String(a.path ?? ''),
    run: async (a, ctx) => {
      const target = resolveUserPath(String(a.path), ctx.workspaceRoot)
      await shell.trashItem(target)
      return `Moved to Recycle Bin: ${target}`
    }
  },
  {
    def: {
      name: 'fs_zip',
      description: 'Compress a file or folder into a .zip archive.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'File or folder to compress' },
          zipPath: { type: 'string', description: 'Destination .zip path' }
        },
        required: ['source', 'zipPath']
      },
      sensitive: true
    },
    summary: (a) => `${String(a.source ?? '')} → ${String(a.zipPath ?? '')}`,
    run: async (a, ctx) => {
      const src = resolveUserPath(String(a.source), ctx.workspaceRoot)
      const zip = resolveUserPath(String(a.zipPath), ctx.workspaceRoot)
      await runPs(
        `Compress-Archive -Path ${psQuote(src)} -DestinationPath ${psQuote(zip)} -Force`,
        180_000
      )
      return `Created ${zip}`
    }
  },
  {
    def: {
      name: 'fs_unzip',
      description: 'Extract a .zip archive into a folder.',
      inputSchema: {
        type: 'object',
        properties: {
          zipPath: { type: 'string' },
          destination: { type: 'string' }
        },
        required: ['zipPath', 'destination']
      },
      sensitive: true
    },
    summary: (a) => `${String(a.zipPath ?? '')} → ${String(a.destination ?? '')}`,
    run: async (a, ctx) => {
      const zip = resolveUserPath(String(a.zipPath), ctx.workspaceRoot)
      const dest = resolveUserPath(String(a.destination), ctx.workspaceRoot)
      await runPs(
        `Expand-Archive -Path ${psQuote(zip)} -DestinationPath ${psQuote(dest)} -Force`,
        180_000
      )
      return `Extracted to ${dest}`
    }
  }
]

export { runPs, psQuote }
