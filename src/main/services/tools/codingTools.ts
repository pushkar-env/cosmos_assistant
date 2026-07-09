import { promises as fs } from 'fs'
import { dirname } from 'path'
import type { ToolSpec } from './ToolRegistry'
import type { WorkspaceService } from '../WorkspaceService'
import { resolveUserPath } from '../userPaths'

const MAX_READ_BYTES = 60_000

/**
 * Production-grade coding tools for agent mode: surgical edits (cheaper and
 * safer than rewriting whole files — essential for small local models),
 * a project overview, a ranged reader, and a workspace-scoped command runner
 * wired to the same terminal the user sees in the Studio.
 */
export function codingTools(workspace: WorkspaceService): ToolSpec[] {
  const resolve = (p: string, ctx: { workspaceRoot?: string }): string =>
    resolveUserPath(p, ctx.workspaceRoot)

  return [
    {
      def: {
        name: 'project_tree',
        description:
          'Show the folder/file tree of the current project workspace (skips node_modules, .git, build output). Call this FIRST when asked to improve, fix, or extend an existing project so you know its layout before reading or editing files.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Subfolder to start from (optional, relative to the workspace)' },
            depth: { type: 'number', description: 'Max depth, default 4' }
          }
        },
        sensitive: false
      },
      summary: (a) => `tree ${String(a.path ?? '(workspace)')}`,
      run: (a) => workspace.textTree(a.path ? String(a.path) : '', a.depth ? Number(a.depth) : 4)
    },
    {
      def: {
        name: 'read_file',
        description:
          'Read a text file from the project (optionally a line range). Use a range for large files. Prefer this over fs_read for code so you get line numbers to target edits precisely.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to the workspace, or absolute)' },
            startLine: { type: 'number', description: '1-based first line (optional)' },
            endLine: { type: 'number', description: '1-based last line (optional)' }
          },
          required: ['path']
        },
        sensitive: false
      },
      summary: (a) => String(a.path ?? ''),
      run: async (a, ctx) => {
        const file = resolve(String(a.path), ctx)
        const buf = await fs.readFile(file)
        const text = buf.subarray(0, MAX_READ_BYTES).toString('utf-8')
        const lines = text.split('\n')
        const start = a.startLine ? Math.max(1, Number(a.startLine)) : 1
        const end = a.endLine ? Math.min(lines.length, Number(a.endLine)) : lines.length
        const slice = lines.slice(start - 1, end)
        const numbered = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n')
        const trunc = buf.length > MAX_READ_BYTES ? `\n… [truncated, ${buf.length} bytes total]` : ''
        return numbered + trunc || '(empty file)'
      }
    },
    {
      def: {
        name: 'fs_edit',
        description:
          'Make a surgical edit to an existing file by replacing an exact snippet — far cheaper and safer than rewriting the whole file. `old_string` must appear EXACTLY once (include enough surrounding context to be unique) unless replace_all is true. Use this for bug fixes and incremental changes; use fs_write only for brand-new files or full rewrites.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string', description: 'Exact text to find (with surrounding context for uniqueness)' },
            new_string: { type: 'string', description: 'Replacement text' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' }
          },
          required: ['path', 'old_string', 'new_string']
        },
        sensitive: true
      },
      summary: (a) => String(a.path ?? ''),
      run: async (a, ctx) => {
        const file = resolve(String(a.path), ctx)
        const oldStr = String(a.old_string)
        const newStr = String(a.new_string)
        if (oldStr === newStr) throw new Error('old_string and new_string are identical.')
        let content: string
        try {
          content = await fs.readFile(file, 'utf-8')
        } catch {
          throw new Error(`Cannot edit — ${file} does not exist. Use fs_write to create it.`)
        }
        const occurrences = content.split(oldStr).length - 1
        if (occurrences === 0) {
          throw new Error('old_string was not found in the file. Read the file again and copy the exact text (including whitespace).')
        }
        if (occurrences > 1 && a.replace_all !== true) {
          throw new Error(`old_string appears ${occurrences} times — add more surrounding context to make it unique, or set replace_all:true.`)
        }
        const updated = a.replace_all === true ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr)
        await fs.mkdir(dirname(file), { recursive: true })
        await fs.writeFile(file, updated, 'utf-8')
        return `Edited ${file} — replaced ${a.replace_all === true ? occurrences : 1} occurrence(s).`
      }
    },
    {
      def: {
        name: 'run_command',
        description:
          "Run a shell command in the project workspace and get its output back. This is the agent's terminal — it shares the working directory and live output with the COSMOS Studio terminal the user sees, so `cd` persists between calls. Use it to scaffold projects (npm/npx/git/python/pip), install dependencies, build, run tests, and verify your changes actually work. For long-lived processes (a dev server), set background:true so the loop isn't blocked.",
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'PowerShell command line' },
            background: { type: 'boolean', description: 'Start without waiting (dev servers, watchers)' }
          },
          required: ['command']
        },
        sensitive: true
      },
      summary: (a) => String(a.command ?? '').slice(0, 120),
      run: (a) => workspace.agentRun(String(a.command), a.background === true)
    }
  ]
}
