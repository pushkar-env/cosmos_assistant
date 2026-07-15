import type { ToolSpec } from './ToolRegistry'
import type { CleanerService } from '../CleanerService'
import type { InstalledProgram } from '@shared/types'

/** Human-readable size, e.g. 512 MB / 2.4 GB. */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function collapse(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.]+/g, '')
}

/** Best case/space-insensitive match of a spoken program name to a registry entry. */
function matchProgram(programs: InstalledProgram[], query: string): InstalledProgram | null {
  const q = query.trim().toLowerCase()
  const qc = collapse(q)
  if (!qc) return null
  let best: { p: InstalledProgram; score: number } | null = null
  for (const p of programs) {
    const n = p.name.toLowerCase()
    const nc = collapse(p.name)
    let score = 0
    if (n === q || nc === qc) score = 100
    else if (nc.startsWith(qc)) score = 80 - p.name.length * 0.05
    else if (nc.includes(qc)) score = 60 - p.name.length * 0.05
    else if (q.split(/\s+/).every((w) => n.includes(w))) score = 40 - p.name.length * 0.05
    if (score > 0 && (!best || score > best.score)) best = { p, score }
  }
  return best?.p ?? null
}

/**
 * The System Cleaner tool set: a safe, CCleaner-grade maintenance surface the
 * assistant can drive. Read-only discovery tools (scan, find large files, disk
 * usage, list programs) are non-sensitive; anything that removes software or
 * clears caches is sensitive and confirmed by the user. Every destructive path
 * is guarded in CleanerService (protected system/profile locations are refused,
 * deletes go to the Recycle Bin) so the assistant can never harm the OS or the
 * user's important files.
 */
export function cleanerTools(cleaner: CleanerService): ToolSpec[] {
  return [
    {
      def: {
        name: 'cleaner_scan',
        description:
          'Scan the PC for reclaimable junk and report how much space each safe category holds (temp files, caches, Windows Update leftovers, crash dumps, thumbnails, browser caches, Recycle Bin). Read-only — it finds and reports, it does NOT delete. Use for "scan my PC", "how much junk can I clear", "what can I clean", or before cleaning so you can tell the user what will be freed. To actually clear it, use system_cleanup (all safe junk) or cleaner_clean (specific categories).',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'scan for junk',
      run: async () => {
        const res = await cleaner.scan()
        if (!res.categories.length) return 'Nothing to clean — the system is already tidy.'
        const lines = res.categories
          .sort((a, b) => b.bytes - a.bytes)
          .map((c) => `  • ${c.label}: ${fmtBytes(c.bytes)} (${c.count} item${c.count === 1 ? '' : 's'})`)
        return (
          `Found about ${fmtBytes(res.totalBytes)} of reclaimable junk:\n${lines.join('\n')}\n` +
          `Category ids: ${res.categories.map((c) => c.id).join(', ')}. ` +
          `Clear all safe junk with system_cleanup, or specific categories with cleaner_clean.`
        )
      }
    },
    {
      def: {
        name: 'cleaner_clean',
        description:
          'Clear specific junk categories found by cleaner_scan (e.g. just the browser caches, or just temp files). Pass their category ids. For a plain "clean my PC / free up space" that clears ALL safe junk at once, prefer system_cleanup instead. Reports what was actually reclaimed. Emptying the Recycle Bin is permanent, so it only happens when its id is included or includeRecycleBin is true.',
        inputSchema: {
          type: 'object',
          properties: {
            categories: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Category ids to clear, e.g. ["temp-user","chrome-cache"]. Omit to clear every safe category found (excludes the Recycle Bin unless includeRecycleBin is set).'
            },
            includeRecycleBin: {
              type: 'boolean',
              description: 'Also empty the Recycle Bin (permanent). Default false.'
            }
          }
        },
        sensitive: true
      },
      summary: (a) => {
        const cats = Array.isArray(a.categories) ? (a.categories as string[]) : []
        return cats.length ? `clean: ${cats.join(', ')}` : 'clean all safe junk'
      },
      run: async (a) => {
        const scan = await cleaner.scan()
        const safeIds = scan.categories.filter((c) => c.id !== 'recycle-bin').map((c) => c.id)
        let ids = Array.isArray(a.categories)
          ? (a.categories as unknown[]).map(String).filter((id) => scan.categories.some((c) => c.id === id))
          : [...safeIds]
        if (a.includeRecycleBin === true && !ids.includes('recycle-bin')) ids.push('recycle-bin')
        if (!ids.length) return 'No matching categories to clean. Run cleaner_scan to see available ids.'
        const res = await cleaner.clean(ids)
        if (res.freedBytes <= 0 && res.recycleBinItems <= 0) {
          return 'Those categories were already clear — nothing to reclaim.'
        }
        const lines = res.items.map((i) => `  • ${i.label}: ${fmtBytes(i.freedBytes)}`)
        if (res.recycleBinItems >= 0) {
          lines.push(`  • Recycle Bin: emptied (${res.recycleBinItems} item${res.recycleBinItems === 1 ? '' : 's'})`)
        }
        return `Reclaimed ~${fmtBytes(res.freedBytes)}:\n${lines.join('\n')}`
      }
    },
    {
      def: {
        name: 'find_large_files',
        description:
          "Find the biggest files in the user's own folders (Downloads, Desktop, Documents, Videos, Music, Pictures) so they can free space by deleting ones they no longer need. Read-only — it only lists candidates with their size and how long since each was opened; it never deletes. Use for \"find large files\", \"what's taking up space\", \"biggest files I can delete\". To delete one the user confirms, use fs_delete (to Recycle Bin).",
        inputSchema: {
          type: 'object',
          properties: {
            minSizeMB: {
              type: 'number',
              description: 'Only list files at least this many MB (default 100).'
            }
          }
        },
        sensitive: false
      },
      summary: (a) => `large files ≥ ${Number(a.minSizeMB) || 100} MB`,
      run: async (a) => {
        const files = await cleaner.findLargeFiles(Number(a.minSizeMB) || 100, 40)
        if (!files.length) {
          return `No files larger than ${Number(a.minSizeMB) || 100} MB found in your Downloads, Desktop, Documents, Videos, Music or Pictures.`
        }
        const lines = files.map(
          (f) => `  • ${fmtBytes(f.bytes)} — ${f.path} (idle ${f.idleDays} day${f.idleDays === 1 ? '' : 's'})`
        )
        return `Largest files (review before deleting):\n${lines.join('\n')}`
      }
    },
    {
      def: {
        name: 'disk_usage',
        description:
          'Report free and total space on each local drive. Use for "how much disk space do I have", "is my C drive full", "check storage".',
        inputSchema: { type: 'object', properties: {} },
        sensitive: false
      },
      summary: () => 'disk usage',
      run: async () => {
        const drives = await cleaner.diskUsage()
        if (!drives.length) return 'Could not read any local drives.'
        return drives
          .map((d) => {
            const usedPct = d.totalBytes ? Math.round(((d.totalBytes - d.freeBytes) / d.totalBytes) * 100) : 0
            return `${d.drive} ${d.label}: ${fmtBytes(d.freeBytes)} free of ${fmtBytes(d.totalBytes)} (${usedPct}% used)`
          })
          .join('\n')
      }
    },
    {
      def: {
        name: 'list_programs',
        description:
          'List installed programs with their sizes, so the user can decide what to uninstall. Read-only. Optional filter substring narrows it (e.g. "adobe"). Use for "what\'s installed", "what can I uninstall", "which apps are biggest". To remove one, use uninstall_app.',
        inputSchema: {
          type: 'object',
          properties: { filter: { type: 'string', description: 'Optional name substring to narrow the list.' } }
        },
        sensitive: false
      },
      summary: (a) => (a.filter ? `programs: ${String(a.filter)}` : 'installed programs'),
      run: async (a) => {
        let progs = await cleaner.listPrograms()
        const filter = a.filter ? String(a.filter).toLowerCase() : ''
        if (filter) progs = progs.filter((p) => p.name.toLowerCase().includes(filter))
        if (!progs.length) return filter ? `No installed programs match "${a.filter}".` : 'No installed programs found.'
        const lines = progs
          .slice(0, 60)
          .map((p) => `  • ${p.name}${p.bytes ? ` — ${fmtBytes(p.bytes)}` : ''}${p.publisher ? ` (${p.publisher})` : ''}`)
        const more = progs.length > 60 ? `\n… and ${progs.length - 60} more` : ''
        return `Installed programs${filter ? ` matching "${a.filter}"` : ''}:\n${lines.join('\n')}${more}`
      }
    },
    {
      def: {
        name: 'uninstall_app',
        description:
          "Uninstall an installed program by name. Launches the program's own uninstaller (its native flow), the safe way to remove software. Use for \"uninstall <program>\", \"remove <program>\". This is confirmed with the user before it runs. If the name is ambiguous or not found, the result lists close matches — retry with the exact name.",
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The program name to uninstall, e.g. "Spotify".' }
          },
          required: ['name']
        },
        sensitive: true
      },
      summary: (a) => `uninstall ${String(a.name ?? '')}`,
      run: async (a) => {
        const query = String(a.name ?? '').trim()
        if (!query) return 'No program name given.'
        const progs = await cleaner.listPrograms()
        const match = matchProgram(progs, query)
        if (!match) {
          const near = progs
            .filter((p) => collapse(p.name).includes(collapse(query).slice(0, 4)))
            .slice(0, 6)
            .map((p) => p.name)
          return near.length
            ? `No program exactly named "${query}". Close matches: ${near.join(', ')}. Retry with the exact name.`
            : `No installed program matching "${query}" was found.`
        }
        const res = await cleaner.uninstall(match.id)
        return res.ok ? res.message : `Couldn't uninstall ${match.name}: ${res.message}`
      }
    }
  ]
}
