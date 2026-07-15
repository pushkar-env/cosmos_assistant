import { app, shell } from 'electron'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, normalize } from 'path'
import type {
  CleanResult,
  CleanScanResult,
  CleanerActionResult,
  DriveUsage,
  InstalledProgram,
  JunkCategory,
  LargeFile
} from '@shared/types'
import { runPs, psQuote } from './tools/fileTools'

/**
 * A known-safe junk location the cleaner can measure and clear. Every target
 * here is a cache or scratch area Windows/apps regenerate on demand — never
 * documents, settings, saved passwords or cookies. Arbitrary user paths never
 * reach these routines; they go through {@link CleanerService.deletePaths},
 * which is gated by {@link isProtectedPath}.
 */
interface JunkTarget {
  id: string
  label: string
  hint: string
  /** PowerShell expression that yields the folder path (may contain wildcards) */
  pathExpr: string
  /** optional -Filter — only top-level matching files are counted/removed */
  filter?: string
}

const JUNK_TARGETS: JunkTarget[] = [
  { id: 'temp-user', label: 'Temporary files', hint: 'Your user temp folder', pathExpr: '$env:TEMP' },
  {
    id: 'temp-windows',
    label: 'Windows temp',
    hint: 'System scratch files',
    pathExpr: '"$env:SystemRoot\\Temp"'
  },
  {
    id: 'inet-cache',
    label: 'Internet cache',
    hint: 'Windows/WinINet cached web files',
    pathExpr: '"$env:LOCALAPPDATA\\Microsoft\\Windows\\INetCache"'
  },
  {
    id: 'win-update',
    label: 'Windows Update cache',
    hint: 'Already-installed update downloads',
    pathExpr: '"$env:SystemRoot\\SoftwareDistribution\\Download"'
  },
  {
    id: 'delivery-opt',
    label: 'Delivery Optimization',
    hint: 'Peer update-sharing cache',
    pathExpr: '"$env:SystemRoot\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization\\Cache"'
  },
  {
    id: 'crash-dumps',
    label: 'Crash dumps',
    hint: 'App crash memory dumps',
    pathExpr: '"$env:LOCALAPPDATA\\CrashDumps"'
  },
  {
    id: 'error-reports',
    label: 'Error reports',
    hint: 'Windows Error Reporting queue',
    pathExpr: '"$env:LOCALAPPDATA\\Microsoft\\Windows\\WER"'
  },
  {
    id: 'thumbnails',
    label: 'Thumbnail cache',
    hint: 'Explorer thumbnail database',
    pathExpr: '"$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer"',
    filter: 'thumbcache_*.db'
  },
  {
    id: 'icon-cache',
    label: 'Icon cache',
    hint: 'Explorer icon database',
    pathExpr: '"$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer"',
    filter: 'iconcache_*.db'
  },
  {
    id: 'chrome-cache',
    label: 'Chrome cache',
    hint: 'Cached pages (keeps logins & passwords)',
    pathExpr: '"$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\*\\Cache\\Cache_Data"'
  },
  {
    id: 'edge-cache',
    label: 'Edge cache',
    hint: 'Cached pages (keeps logins & passwords)',
    pathExpr: '"$env:LOCALAPPDATA\\Microsoft\\Edge\\User Data\\*\\Cache\\Cache_Data"'
  },
  {
    id: 'firefox-cache',
    label: 'Firefox cache',
    hint: 'Cached pages (keeps logins & passwords)',
    pathExpr: '"$env:LOCALAPPDATA\\Mozilla\\Firefox\\Profiles\\*\\cache2"'
  }
]

/** The user content roots the large-file scan is allowed to walk. */
const LARGE_FILE_ROOT_KEYS = [
  'downloads',
  'desktop',
  'documents',
  'videos',
  'music',
  'pictures'
] as const

/**
 * True when `target` points at the OS, an app install, a profile root, or any
 * other location it would be dangerous to delete. This is the safety spine of
 * the whole feature — the assistant and the panel both delete only through
 * {@link CleanerService.deletePaths}, and this rejects anything protected. It
 * is deliberately conservative: better to refuse a delete than to harm the
 * system. (Junk-cache clearing uses the fixed {@link JUNK_TARGETS} list and
 * never touches these.)
 */
export function isProtectedPath(target: string): boolean {
  // strip trailing separators AND a trailing "." — normalize('C:') yields
  // 'C:.' on Windows (a drive-relative path), which must still read as a root
  const p = normalize(target).replace(/[\\/.]+$/, '').toLowerCase()
  if (!p) return true

  // a bare drive root ("c:", "c:\", "c:.")
  if (/^[a-z]:$/.test(p)) return true

  const home = homedir().toLowerCase().replace(/[\\/]+$/, '')
  if (p === home) return true // the profile folder itself (subfolders are fine)

  // C:\Users (the parent of all profiles)
  if (/^[a-z]:[\\/]+users$/.test(p)) return true

  const env = process.env
  const roots = [
    env.SystemRoot ?? 'C:\\Windows',
    env.windir ?? 'C:\\Windows',
    env.ProgramFiles ?? 'C:\\Program Files',
    env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    env.ProgramData ?? 'C:\\ProgramData'
  ].map((r) => normalize(r).replace(/[\\/]+$/, '').toLowerCase())

  for (const root of roots) {
    if (p === root || p.startsWith(root + '\\')) return true
  }

  // critical system areas that can appear on any drive
  if (p.includes('\\system volume information')) return true
  if (p.includes('$recycle.bin')) return true
  if (p.includes('\\windows\\')) return true // nested Windows installs / WinSxS

  return false
}

/**
 * The maintenance engine behind the Cleaner window and the cleaner_* agent
 * tools. It scans and clears known-safe caches, finds large/idle files, reads
 * disk usage and installed programs, and performs guarded uninstalls/deletes.
 * All heavy filesystem/registry work runs in short-lived PowerShell passes so
 * it stays off the main thread's event loop.
 */
export class CleanerService {
  /** Measure every safe junk category without deleting anything. */
  async scan(): Promise<CleanScanResult> {
    const measured = await this.measureTargets(JUNK_TARGETS)
    const categories: JunkCategory[] = JUNK_TARGETS.map((t) => {
      const m = measured.get(t.id) ?? { bytes: 0, count: 0 }
      return {
        id: t.id,
        label: t.label,
        hint: t.hint,
        bytes: m.bytes,
        count: m.count,
        recommended: true
      }
    })

    // Recycle Bin as its own category (measured via the shell namespace)
    const rb = await this.recycleBinSize()
    categories.push({
      id: 'recycle-bin',
      label: 'Recycle Bin',
      hint: 'Files you already sent to the bin',
      bytes: rb.bytes,
      count: rb.count,
      // emptying the bin is permanent, so it's opt-in rather than pre-ticked
      recommended: false
    })

    const withContent = categories.filter((c) => c.bytes > 0 || c.count > 0)
    const totalBytes = withContent.reduce((sum, c) => sum + c.bytes, 0)
    return { categories: withContent, totalBytes, scannedAt: new Date().toISOString() }
  }

  /** Clear the selected junk categories; returns bytes reclaimed per category. */
  async clean(categoryIds: string[]): Promise<CleanResult> {
    const ids = new Set(categoryIds)
    const targets = JUNK_TARGETS.filter((t) => ids.has(t.id))
    const items: CleanResult['items'] = []
    let freedBytes = 0

    if (targets.length) {
      const before = await this.measureTargets(targets)
      await this.clearTargets(targets)
      const after = await this.measureTargets(targets)
      for (const t of targets) {
        const freed = Math.max(0, (before.get(t.id)?.bytes ?? 0) - (after.get(t.id)?.bytes ?? 0))
        if (freed > 0) {
          items.push({ id: t.id, label: t.label, freedBytes: freed })
          freedBytes += freed
        }
      }
    }

    let recycleBinItems = -1
    if (ids.has('recycle-bin')) {
      const rb = await this.recycleBinSize()
      await runPs(`Clear-RecycleBin -Force -ErrorAction SilentlyContinue`, 60_000).catch(() => '')
      recycleBinItems = rb.count
      if (rb.bytes > 0) {
        items.push({ id: 'recycle-bin', label: 'Recycle Bin', freedBytes: rb.bytes })
        freedBytes += rb.bytes
      }
    }

    return { freedBytes, items, recycleBinItems }
  }

  /**
   * Find the largest files inside the user's own content folders (Downloads,
   * Desktop, Documents, Videos, Music, Pictures). Read-only — it never deletes;
   * it surfaces candidates the user or assistant can choose to remove. Follows
   * no reparse points, so junctions/OneDrive links can't cause loops.
   */
  async findLargeFiles(minSizeMB = 100, maxResults = 60): Promise<LargeFile[]> {
    const roots: string[] = []
    for (const key of LARGE_FILE_ROOT_KEYS) {
      try {
        roots.push(app.getPath(key))
      } catch {
        /* folder not available on this profile */
      }
    }
    const existing = (
      await Promise.all(
        [...new Set(roots)].map(async (r) => ((await pathExists(r)) ? r : null))
      )
    ).filter((r): r is string => !!r)
    if (!existing.length) return []

    const minBytes = Math.max(1, Math.round(minSizeMB)) * 1024 * 1024
    const max = Math.min(Math.max(maxResults, 1), 200)
    const rootsLiteral = existing.map((r) => psQuote(r)).join(',')
    const script = `
$ErrorActionPreference='SilentlyContinue'
$roots = @(${rootsLiteral})
$min = ${minBytes}
$all = foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { -not $_.Attributes.ToString().Contains('ReparsePoint') -and $_.Length -ge $min }
}
$all | Sort-Object Length -Descending | Select-Object -First ${max} | ForEach-Object {
  [pscustomobject]@{
    path = $_.FullName
    name = $_.Name
    bytes = $_.Length
    modified = $_.LastWriteTimeUtc.ToString('o')
    accessed = $_.LastAccessTimeUtc.ToString('o')
    ext = $_.Extension
  }
} | ConvertTo-Json -Compress`
    const out = await runPs(script, 120_000)
    const rows = parseJsonArray<{
      path?: string
      name?: string
      bytes?: number
      modified?: string
      accessed?: string
      ext?: string
    }>(out)
    const now = Date.now()
    return rows
      .filter((r) => r.path && typeof r.bytes === 'number')
      .map((r) => {
        const accessed = r.accessed || r.modified || new Date(now).toISOString()
        const idleMs = now - new Date(accessed).getTime()
        return {
          path: r.path!,
          name: r.name || basename(r.path!),
          bytes: r.bytes!,
          modified: r.modified || accessed,
          accessed,
          ext: (r.ext || '').replace(/^\./, '').toLowerCase(),
          idleDays: Number.isFinite(idleMs) ? Math.max(0, Math.floor(idleMs / 86_400_000)) : 0
        }
      })
  }

  /** Per-drive free/total capacity for the fixed local disks. */
  async diskUsage(): Promise<DriveUsage[]> {
    const script = `
$ErrorActionPreference='SilentlyContinue'
Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  [pscustomobject]@{ drive = $_.DeviceID; label = $_.VolumeName; free = [int64]$_.FreeSpace; total = [int64]$_.Size }
} | ConvertTo-Json -Compress`
    const out = await runPs(script, 15_000)
    const rows = parseJsonArray<{ drive?: string; label?: string; free?: number; total?: number }>(out)
    return rows
      .filter((r) => r.drive && (r.total ?? 0) > 0)
      .map((r) => ({
        drive: r.drive!,
        label: r.label || 'Local Disk',
        freeBytes: r.free ?? 0,
        totalBytes: r.total ?? 0
      }))
  }

  /** Installed programs from the uninstall registry (with sizes), deduped. */
  async listPrograms(): Promise<InstalledProgram[]> {
    const script = `
$ErrorActionPreference='SilentlyContinue'
$roots = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
Get-ItemProperty $roots -ErrorAction SilentlyContinue |
  Where-Object {
    $_.DisplayName -and
    -not $_.SystemComponent -and
    -not $_.ReleaseType -and
    -not $_.ParentKeyName -and
    ($_.UninstallString -or $_.QuietUninstallString) -and
    $_.DisplayName -notmatch '^(KB[0-9]+|Update for|Security Update|Hotfix|Microsoft Visual C\\+\\+ [0-9]+ Redist)'
  } |
  ForEach-Object {
    [pscustomobject]@{
      id = $_.PSChildName
      name = $_.DisplayName
      publisher = "$($_.Publisher)"
      version = "$($_.DisplayVersion)"
      sizeKb = [int64]($_.EstimatedSize)
      installDate = "$($_.InstallDate)"
    }
  } | ConvertTo-Json -Compress`
    const out = await runPs(script, 30_000)
    const rows = parseJsonArray<{
      id?: string
      name?: string
      publisher?: string
      version?: string
      sizeKb?: number
      installDate?: string
    }>(out)

    const byName = new Map<string, InstalledProgram>()
    for (const r of rows) {
      if (!r.id || !r.name) continue
      const prog: InstalledProgram = {
        id: r.id,
        name: r.name.trim(),
        publisher: (r.publisher || '').trim(),
        version: (r.version || '').trim(),
        bytes: Math.max(0, (r.sizeKb ?? 0) * 1024),
        installedOn: parseRegistryDate(r.installDate),
        uninstallable: true
      }
      const key = prog.name.toLowerCase()
      const existing = byName.get(key)
      // keep the record that knows its size (registry sometimes lists a stub twin)
      if (!existing || (existing.bytes === 0 && prog.bytes > 0)) byName.set(key, prog)
    }
    return [...byName.values()].sort(
      (a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)
    )
  }

  /**
   * Launch a program's own uninstaller. We run the vendor's registered
   * uninstall command (its native UI or silent switch) rather than deleting
   * files ourselves — the honest, safe way to remove software. Returns once the
   * uninstaller has been started; completion is up to that installer.
   */
  async uninstall(id: string): Promise<CleanerActionResult> {
    const key = String(id).trim()
    if (!key) return { ok: false, message: 'No program specified.' }
    const script = `
$ErrorActionPreference='SilentlyContinue'
$roots = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${psRegSafe(key)}',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${psRegSafe(key)}',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${psRegSafe(key)}'
)
$e = $null
foreach ($r in $roots) { if (Test-Path -LiteralPath $r) { $e = Get-ItemProperty -LiteralPath $r; break } }
if (-not $e) { Write-Output 'ERR|Program not found in the uninstall registry.'; return }
$cmd = if ($e.QuietUninstallString) { $e.QuietUninstallString } else { $e.UninstallString }
if (-not $cmd) { Write-Output 'ERR|No uninstall command is registered for this program.'; return }
$cmd = $cmd -replace '/I\\{', '/X{'
try {
  Start-Process -FilePath cmd.exe -ArgumentList '/c', $cmd -WindowStyle Hidden
  Write-Output ('OK|' + $e.DisplayName)
} catch {
  Write-Output ('ERR|' + $_.Exception.Message)
}`
    const out = (await runPs(script, 20_000)).trim()
    const line = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
    const [status, rest] = line.split('|')
    if (status === 'OK') {
      return { ok: true, message: `Started the uninstaller for ${rest || 'the program'}.` }
    }
    return { ok: false, message: rest || 'Could not start the uninstaller.' }
  }

  /**
   * Delete files/folders on the user's behalf. Every path is checked against
   * {@link isProtectedPath} first; protected paths are refused. Deletes go to
   * the Recycle Bin (recoverable) unless `permanent` is set.
   */
  async deletePaths(
    paths: string[],
    permanent = false
  ): Promise<{ path: string; ok: boolean; message: string }[]> {
    const results: { path: string; ok: boolean; message: string }[] = []
    for (const raw of paths) {
      const target = normalize(String(raw).trim())
      if (!target) {
        results.push({ path: raw, ok: false, message: 'Empty path.' })
        continue
      }
      if (isProtectedPath(target)) {
        results.push({
          path: target,
          ok: false,
          message: 'Refused — this is a protected system or profile location.'
        })
        continue
      }
      if (!(await pathExists(target))) {
        results.push({ path: target, ok: false, message: 'Nothing exists at this path.' })
        continue
      }
      try {
        if (permanent) {
          await fs.rm(target, { recursive: true, force: true })
          results.push({ path: target, ok: true, message: 'Permanently deleted.' })
        } else {
          await shell.trashItem(target)
          results.push({ path: target, ok: true, message: 'Moved to Recycle Bin.' })
        }
      } catch (err) {
        results.push({
          path: target,
          ok: false,
          message: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return results
  }

  /** Reveal a path in File Explorer (read-only convenience for the panel). */
  async reveal(target: string): Promise<void> {
    if (target && (await pathExists(target))) shell.showItemInFolder(target)
  }

  // ── internals ────────────────────────────────────────────────────

  /** Measure bytes+count for a set of junk targets in one PowerShell pass. */
  private async measureTargets(
    targets: JunkTarget[]
  ): Promise<Map<string, { bytes: number; count: number }>> {
    const result = new Map<string, { bytes: number; count: number }>()
    if (!targets.length) return result
    const blocks = targets.map((t) => this.measureBlock(t)).join('\n')
    const script = `
$ErrorActionPreference='SilentlyContinue'
$out = @()
${blocks}
$out | ConvertTo-Json -Compress`
    const out = await runPs(script, 120_000).catch(() => '')
    for (const r of parseJsonArray<{ id?: string; bytes?: number; count?: number }>(out)) {
      if (r.id) result.set(r.id, { bytes: r.bytes ?? 0, count: r.count ?? 0 })
    }
    return result
  }

  /** PowerShell that measures one target and appends an {id,bytes,count} record. */
  private measureBlock(t: JunkTarget): string {
    const filter = t.filter ? ` -Filter '${t.filter.replace(/'/g, "''")}'` : ''
    const gci = t.filter
      ? `Get-ChildItem -LiteralPath $base.FullName -Force -File${filter} -ErrorAction SilentlyContinue`
      : `Get-ChildItem -LiteralPath $base.FullName -Recurse -Force -File -ErrorAction SilentlyContinue`
    return `
$bytes = [int64]0; $count = 0
foreach ($base in @(Get-Item -Path ${t.pathExpr} -Force -ErrorAction SilentlyContinue)) {
  if ($base.PSIsContainer) {
    foreach ($f in @(${gci})) { $bytes += [int64]$f.Length; $count++ }
  }
}
$out += [pscustomobject]@{ id = '${t.id}'; bytes = $bytes; count = $count }`
  }

  /** Delete the contents of a set of junk targets (files locked in use are skipped). */
  private async clearTargets(targets: JunkTarget[]): Promise<void> {
    const blocks = targets
      .map((t) => {
        const filter = t.filter ? ` -Filter '${t.filter.replace(/'/g, "''")}'` : ''
        const removal = t.filter
          ? `Get-ChildItem -LiteralPath $base.FullName -Force -File${filter} -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue`
          : `Get-ChildItem -LiteralPath $base.FullName -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`
        return `
foreach ($base in @(Get-Item -Path ${t.pathExpr} -Force -ErrorAction SilentlyContinue)) {
  if ($base.PSIsContainer) { ${removal} }
}`
      })
      .join('\n')
    await runPs(`$ErrorActionPreference='SilentlyContinue'\n${blocks}`, 180_000).catch(() => '')
  }

  /** Recycle Bin size + item count across all drives, via the shell namespace. */
  private async recycleBinSize(): Promise<{ bytes: number; count: number }> {
    const script = `
$ErrorActionPreference='SilentlyContinue'
$rb = (New-Object -ComObject Shell.Application).Namespace(0xA)
$bytes = [int64]0; $count = 0
foreach ($i in $rb.Items()) { $bytes += [int64]$i.Size; $count++ }
[pscustomobject]@{ bytes = $bytes; count = $count } | ConvertTo-Json -Compress`
    const out = await runPs(script, 30_000).catch(() => '')
    try {
      const d = JSON.parse(out) as { bytes?: number; count?: number }
      return { bytes: d.bytes ?? 0, count: d.count ?? 0 }
    } catch {
      return { bytes: 0, count: 0 }
    }
  }
}

// ── module helpers ─────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Parse `ConvertTo-Json -Compress` output that may be a single object or array. */
function parseJsonArray<T>(out: string): T[] {
  const text = out.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as T | T[]
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/** Registry InstallDate is "yyyymmdd" — turn it into an ISO date (or ''). */
function parseRegistryDate(raw: string | undefined): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec((raw || '').trim())
  if (!m) return ''
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** Escape a registry sub-key name for safe interpolation into a PS path. */
function psRegSafe(key: string): string {
  // sub-key names are `{GUID}` or app ids — allow only registry-safe characters
  return key.replace(/[^A-Za-z0-9 _.\-{}()+]/g, '')
}
