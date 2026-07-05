import { shell } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { execFile } from 'child_process'
import type { ToolSpec } from './ToolRegistry'
import { resolveUserPath } from '../userPaths'

const MAX_READ_BYTES = 50_000
const MAX_LIST_ENTRIES = 200

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
    run: async (a) => {
      const dir = resolveUserPath(String(a.path))
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
    run: async (a) => {
      const buf = await fs.readFile(resolveUserPath(String(a.path)))
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
    run: async (a) => {
      const file = resolveUserPath(String(a.path))
      try {
        await fs.mkdir(dirname(file), { recursive: true })
        await fs.writeFile(file, String(a.content), 'utf-8')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EPERM' || code === 'EACCES') {
          throw new Error(
            `Permission denied writing to ${file}. That location is protected — ` +
              `try a folder like Desktop, Documents or Downloads.`
          )
        }
        throw err
      }
      return `Wrote ${String(a.content).length} chars to ${file}`
    }
  },
  {
    def: {
      name: 'fs_mkdir',
      description: 'Create a folder (recursively).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      },
      sensitive: false
    },
    summary: (a) => String(a.path ?? ''),
    run: async (a) => {
      const dir = resolveUserPath(String(a.path))
      await fs.mkdir(dir, { recursive: true })
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
    run: async (a) => {
      const root = resolveUserPath(String(a.directory))
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
      description: 'Move or rename a file or folder.',
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
    run: async (a) => {
      const src = resolveUserPath(String(a.source))
      const dest = resolveUserPath(String(a.destination))
      await fs.mkdir(dirname(dest), { recursive: true })
      try {
        await fs.rename(src, dest)
      } catch (err) {
        // cross-drive move: copy then trash the original
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
        await fs.cp(src, dest, { recursive: true })
        await shell.trashItem(src)
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
    run: async (a) => {
      const target = resolveUserPath(String(a.path))
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
    run: async (a) => {
      const src = resolveUserPath(String(a.source))
      const zip = resolveUserPath(String(a.zipPath))
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
    run: async (a) => {
      const zip = resolveUserPath(String(a.zipPath))
      const dest = resolveUserPath(String(a.destination))
      await runPs(
        `Expand-Archive -Path ${psQuote(zip)} -DestinationPath ${psQuote(dest)} -Force`,
        180_000
      )
      return `Extracted to ${dest}`
    }
  }
]

export { runPs, psQuote }
