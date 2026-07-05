import { shell } from 'electron'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'

interface Shortcut {
  name: string
  path: string
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
 * Resolves human app names ("steam", "discord", "vs code") to something
 * launchable. The winning strategy on Windows is Start Menu shortcuts —
 * that's the same index the Start menu searches, so it covers Steam,
 * Spotify, Discord, games, etc. Falls back to App Paths / PATH via the
 * shell `start` builtin, and to a literal path.
 */
export class AppLauncher {
  private cache: Shortcut[] | null = null

  async launch(query: string): Promise<{ ok: boolean; message: string }> {
    const q = query.trim()
    if (!q) return { ok: false, message: 'No application specified' }

    // 1. explicit existing path
    if (/[\\/]/.test(q) || q.toLowerCase().endsWith('.exe')) {
      const err = await shell.openPath(q)
      if (!err) return { ok: true, message: `Launched ${q}` }
    }

    // 2. Start Menu shortcut (best name match, alias-aware)
    const shortcuts = await this.shortcuts()
    const match = this.bestMatch(shortcuts, q) ?? this.bestMatch(shortcuts, ALIASES[q.toLowerCase()] ?? '')
    if (match) {
      const err = await shell.openPath(match.path)
      if (!err) return { ok: true, message: `Launched ${match.name}` }
      return { ok: false, message: `Found "${match.name}" but failed to launch: ${err}` }
    }

    // 3. App Paths / PATH via `start`
    const viaStart = await this.tryStart(q)
    if (viaStart) return { ok: true, message: `Launched ${q}` }

    return {
      ok: false,
      message: `Couldn't find an app matching "${q}". Try the exact name as it appears in the Start menu, or give a full path.`
    }
  }

  /** ranked list of installed app names (for the model / diagnostics) */
  async listApps(filter?: string): Promise<string[]> {
    let items = await this.shortcuts()
    if (filter) {
      const f = filter.toLowerCase()
      items = items.filter((s) => s.name.toLowerCase().includes(f))
    }
    return [...new Set(items.map((s) => s.name))].sort().slice(0, 60)
  }

  private async shortcuts(): Promise<Shortcut[]> {
    if (this.cache) return this.cache
    const roots = [
      join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'),
      join(process.env.APPDATA ?? '', 'Microsoft\\Windows\\Start Menu\\Programs')
    ].filter(Boolean)

    const found: Shortcut[] = []
    for (const root of roots) await this.walk(root, found, 0)
    this.cache = found
    return found
  }

  private async walk(dir: string, out: Shortcut[], depth: number): Promise<void> {
    if (depth > 4) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await this.walk(full, out, depth + 1)
      } else if (e.name.toLowerCase().endsWith('.lnk')) {
        out.push({ name: e.name.slice(0, -4), path: full })
      }
    }
  }

  private bestMatch(shortcuts: Shortcut[], query: string): Shortcut | null {
    const q = query.toLowerCase().trim()
    if (!q) return null
    // collapsed form ignores spaces/hyphens so "anti gravity" == "antigravity"
    const qc = collapse(q)
    let best: { s: Shortcut; score: number } | null = null
    for (const s of shortcuts) {
      const name = s.name.toLowerCase()
      const nc = collapse(name)
      let score = 0
      if (name === q || nc === qc) score = 100
      else if (name.startsWith(q) || nc.startsWith(qc)) score = 80 - name.length * 0.1
      else if (name.includes(q) || nc.includes(qc)) score = 60 - name.length * 0.1
      else {
        // all query words present anywhere
        const words = q.split(/\s+/)
        if (words.every((w) => name.includes(w))) score = 40 - name.length * 0.1
      }
      // prefer the launcher over uninstallers/help entries
      if (/uninstall|readme|help|documentation|website/i.test(name)) score -= 50
      if (score > 0 && (!best || score > best.score)) best = { s, score }
    }
    return best?.s ?? null
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
