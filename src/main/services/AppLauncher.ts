import { app, shell } from 'electron'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { InstalledApp } from '@shared/types'

type LaunchKind = 'appid' | 'url' | 'lnk'

interface AppEntry {
  name: string
  kind: LaunchKind
  /** AUMID (appid), protocol URL (steam://…), or a .lnk path */
  target: string
}

/** strip spaces, hyphens and dots for space-insensitive name matching */
function collapse(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.]+/g, '')
}

/** friendly names → the words that appear in the real shortcut/app */
const ALIASES: Record<string, string> = {
  'vs code': 'visual studio code',
  vscode: 'visual studio code',
  vs: 'visual studio',
  code: 'visual studio code',
  chrome: 'google chrome',
  edge: 'microsoft edge',
  word: 'microsoft word',
  excel: 'microsoft excel',
  powerpoint: 'microsoft powerpoint',
  outlook: 'microsoft outlook',
  teams: 'microsoft teams',
  vlc: 'vlc media player',
  photoshop: 'adobe photoshop'
}

/**
 * Resolves human app names ("steam", "discord", "apex legends") to a
 * launchable target. The comprehensive source is Windows' own "All apps"
 * list (Get-StartApps) — it covers desktop apps, Store/UWP apps AND
 * games/launchers (Steam, EA, Epic), far more than Start Menu shortcuts
 * alone. Games launch via their protocol (steam://…), Store apps via
 * shell:AppsFolder, and the rest via their shortcut.
 */
export class AppLauncher {
  private cache: AppEntry[] | null = null
  private catalogCache: InstalledApp[] | null = null

  async launch(query: string): Promise<{ ok: boolean; message: string }> {
    const q = query.trim()
    if (!q) return { ok: false, message: 'No application specified' }

    // 1. explicit existing path / exe
    if (/[\\/]/.test(q) || q.toLowerCase().endsWith('.exe')) {
      const err = await shell.openPath(q)
      if (!err) return { ok: true, message: `Launched ${q}` }
    }

    // 2. best match across every installed app (alias-aware)
    const apps = await this.index()
    const match = this.bestMatch(apps, q) ?? this.bestMatch(apps, ALIASES[q.toLowerCase()] ?? '')
    if (match) return this.dispatch(match)

    // 3. last resort: let Windows resolve the bare name
    if (await this.tryStart(q)) return { ok: true, message: `Launched ${q}` }

    return {
      ok: false,
      message: `Couldn't find an app matching "${q}". Ask me to list your apps to see what's installed.`
    }
  }

  private async dispatch(entry: AppEntry): Promise<{ ok: boolean; message: string }> {
    try {
      if (entry.kind === 'url') {
        await shell.openExternal(entry.target) // steam://, com.epicgames://, etc.
        return { ok: true, message: `Launched ${entry.name}` }
      }
      if (entry.kind === 'lnk') {
        const err = await shell.openPath(entry.target)
        return err
          ? { ok: false, message: `Found "${entry.name}" but couldn't launch it: ${err}` }
          : { ok: true, message: `Launched ${entry.name}` }
      }
      // appid (AUMID / registered app) → the Windows "Apps" folder launcher
      const ok = await this.tryStart(`shell:AppsFolder\\${entry.target}`)
      return ok
        ? { ok: true, message: `Launched ${entry.name}` }
        : { ok: false, message: `Found "${entry.name}" but couldn't launch it.` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  /** launch a specific catalog entry (App Centre tiles — no fuzzy matching) */
  launchEntry(entry: InstalledApp): Promise<{ ok: boolean; message: string }> {
    return this.dispatch({ name: entry.name, kind: entry.kind, target: entry.target })
  }

  /**
   * The deduplicated, user-presentable app list for the App Centre:
   * noise (uninstallers, web shortcuts, help files) is dropped, names are
   * unique, and .lnk entries carry their real icon as a data URL.
   */
  async catalog(refresh = false): Promise<InstalledApp[]> {
    if (refresh) {
      this.cache = null
      this.catalogCache = null
    }
    if (this.catalogCache) return this.catalogCache

    const noise = /uninstall|readme|help|documentation|website|support|^www\./i
    const byName = new Map<string, AppEntry>()
    for (const e of await this.index()) {
      if (noise.test(e.name)) continue
      if (e.kind === 'url' && /^https?:\/\//i.test(e.target)) continue // web shortcut, not an app
      const key = collapse(e.name)
      const existing = byName.get(key)
      // prefer the .lnk twin — it's the one we can pull an icon from
      if (!existing || (existing.kind !== 'lnk' && e.kind === 'lnk')) byName.set(key, e)
    }

    const items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    this.catalogCache = await Promise.all(
      items.map(async (e): Promise<InstalledApp> => {
        let icon: string | undefined
        if (e.kind === 'lnk') {
          try {
            const img = await app.getFileIcon(e.target, { size: 'large' })
            if (!img.isEmpty()) icon = img.toDataURL()
          } catch {
            /* no icon — the tile falls back to a letter */
          }
        }
        return { name: e.name, kind: e.kind, target: e.target, icon }
      })
    )
    return this.catalogCache
  }

  /** every installed app name (for the model / diagnostics) */
  async listApps(filter?: string): Promise<string[]> {
    let items = await this.index()
    if (filter) {
      const f = filter.toLowerCase()
      const fc = collapse(filter)
      items = items.filter((a) => a.name.toLowerCase().includes(f) || collapse(a.name).includes(fc))
    }
    return [...new Set(items.map((a) => a.name))].sort((a, b) => a.localeCompare(b))
  }

  /** Build the combined app index (cached): Get-StartApps + Start Menu .lnk. */
  private async index(): Promise<AppEntry[]> {
    if (this.cache) return this.cache
    const entries: AppEntry[] = []

    // 1. Windows "All apps" — comprehensive (UWP, games, launchers)
    try {
      const json = await this.runPs(
        'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress',
        12_000
      )
      const parsed = JSON.parse(json) as
        | { Name?: string; AppID?: string }
        | { Name?: string; AppID?: string }[]
      for (const it of Array.isArray(parsed) ? parsed : [parsed]) {
        const name = String(it.Name ?? '').trim()
        const appId = String(it.AppID ?? '').trim()
        if (!name || !appId) continue
        const kind: LaunchKind = /^[a-z][\w+.-]*:\/\//i.test(appId) ? 'url' : 'appid'
        entries.push({ name, kind, target: appId })
      }
    } catch {
      /* PowerShell/Get-StartApps unavailable — shortcuts still cover most apps */
    }

    // 2. Start Menu .lnk shortcuts (supplement anything Get-StartApps missed)
    for (const root of [
      join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'),
      join(process.env.APPDATA ?? '', 'Microsoft\\Windows\\Start Menu\\Programs')
    ].filter(Boolean)) {
      await this.walkShortcuts(root, entries, 0)
    }

    this.cache = entries
    return entries
  }

  private async walkShortcuts(dir: string, out: AppEntry[], depth: number): Promise<void> {
    if (depth > 4) return
    let items: import('fs').Dirent[]
    try {
      items = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of items) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await this.walkShortcuts(full, out, depth + 1)
      else if (e.name.toLowerCase().endsWith('.lnk')) {
        out.push({ name: e.name.slice(0, -4), kind: 'lnk', target: full })
      }
    }
  }

  private bestMatch(apps: AppEntry[], query: string): AppEntry | null {
    const q = query.toLowerCase().trim()
    if (!q) return null
    // collapsed form ignores spaces/hyphens so "anti gravity" == "antigravity"
    const qc = collapse(q)
    let best: { a: AppEntry; score: number } | null = null
    for (const a of apps) {
      const name = a.name.toLowerCase()
      const nc = collapse(name)
      let score = 0
      if (name === q || nc === qc) score = 100
      else if (name.startsWith(q) || nc.startsWith(qc)) score = 80 - name.length * 0.05
      else if (name.includes(q) || nc.includes(qc)) score = 60 - name.length * 0.05
      else {
        const words = q.split(/\s+/)
        if (words.every((w) => name.includes(w))) score = 40 - name.length * 0.05
      }
      // demote uninstallers/help/web-shortcut noise
      if (/uninstall|readme|help|documentation|website|support|^www\./i.test(name)) score -= 50
      // web shortcuts (http/https) are rarely the intended app → demote hard;
      // app protocols (steam://, com.epicgames://…) are legit game launches
      if (a.kind === 'url') score -= /^https?:\/\//i.test(a.target) ? 40 : 4
      if (score > 0 && (!best || score > best.score)) best = { a, score }
    }
    return best?.a ?? null
  }

  private runPs(script: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
      )
    })
  }

  /**
   * Close a running application by name (process name or window title).
   * Kills every matching process by NAME (handles multi-process apps like
   * Chrome), then RE-QUERIES to confirm they are actually gone — so the
   * result is truthful, never an optimistic "closed" for a survivor.
   */
  async close(query: string): Promise<{ ok: boolean; message: string }> {
    if (!query.trim()) return { ok: false, message: 'No application specified' }
    // collapse spaces/hyphens/dots on BOTH sides so "Anti-Gravity",
    // "anti gravity" and "antigravity" all match a process "Antigravity"
    const q = collapse(query).replace(/'/g, "''")
    if (!q) return { ok: false, message: 'No application specified' }

    const script = [
      `$q='${q}'`,
      `function norm($s){ if($null -eq $s){return ''}; ($s -replace '[\\s\\-_.]','').ToLower() }`,
      `function match { Get-Process | Where-Object { $_.SessionId -ne 0 -and ((norm $_.ProcessName).Contains($q) -or ($_.MainWindowTitle -and (norm $_.MainWindowTitle).Contains($q))) } }`,
      `$names = match | Select-Object -ExpandProperty ProcessName -Unique`,
      `if (-not $names) { Write-Output 'NONE'; exit }`,
      // kill by name (all instances / child processes), twice for stubborn apps
      `foreach ($n in $names) { Stop-Process -Name $n -Force -ErrorAction SilentlyContinue }`,
      `Start-Sleep -Milliseconds 500`,
      `$survivors = match | Select-Object -ExpandProperty ProcessName -Unique`,
      `if ($survivors) { Write-Output ('PARTIAL|' + ($survivors -join ',')) } else { Write-Output ('OK|' + ($names -join ',')) }`
    ].join('; ')

    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { windowsHide: true, timeout: 12_000 },
          (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim()))
        )
      })
      if (out === 'NONE' || out === '') {
        return { ok: false, message: `No running app matching "${query}" was found — it may already be closed.` }
      }
      const [status, names] = out.split('|')
      if (status === 'OK') return { ok: true, message: `Closed ${names.replace(/,/g, ', ')}.` }
      // PARTIAL: some processes refused to die (elevated / protected)
      return {
        ok: false,
        message: `Could not fully close "${query}" — ${names} is still running (it may require administrator rights).`
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Launch a bare command/name via PowerShell Start-Process. NOTE: the
   * cmd `start` builtin invoked through exec() hangs indefinitely under
   * Electron — Start-Process returns immediately and fails fast for
   * unknown names, so it is the only safe fallback here.
   */
  private tryStart(app: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `Start-Process -FilePath '${app.replace(/'/g, "''")}'`],
        { windowsHide: true, timeout: 8000 },
        (err) => resolve(!err)
      )
    })
  }
}
