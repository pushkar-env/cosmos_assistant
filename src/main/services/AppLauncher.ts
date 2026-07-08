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

    // Resolve real icons up front in two batched PowerShell passes that run in
    // parallel: shortcuts → their real target .exe (so we pull the app's own
    // embedded icon instead of the generic .lnk document glyph), and Store/UWP
    // apps → their package logo PNG (previously they had no icon at all). This
    // is what turns the grid from a wall of blank white documents into a
    // premium, recognisable launcher.
    const [lnkTargets, uwpIcons] = await Promise.all([
      this.resolveLnkTargets(items.filter((e) => e.kind === 'lnk').map((e) => e.target)),
      this.resolveUwpIcons(items.filter((e) => e.kind === 'appid').map((e) => e.target))
    ])

    // Extract the real .exe/.ico icon for every shortcut — from its resolved
    // target when we have one, else the shortcut itself — in a single shell
    // pass. (Electron's app.getFileIcon returns a shared generic icon when
    // hammered with 100+ concurrent calls, so we pull them ourselves at a
    // crisp 48px straight from the Windows shell image list.)
    const iconSources = [
      ...new Set(
        items.filter((e) => e.kind === 'lnk').map((e) => lnkTargets.get(e.target) || e.target)
      )
    ]
    const exeIcons = await this.resolveExeIcons(iconSources)

    this.catalogCache = items.map((e) => ({
      name: e.name,
      kind: e.kind,
      target: e.target,
      icon: this.iconFor(e, lnkTargets, uwpIcons, exeIcons)
    }))
    return this.catalogCache
  }

  /** Best icon we found for a catalog entry, as a PNG data URL. */
  private iconFor(
    e: AppEntry,
    lnkTargets: Map<string, string>,
    uwpIcons: Map<string, string>,
    exeIcons: Map<string, string>
  ): string | undefined {
    if (e.kind === 'appid') return uwpIcons.get(e.target)
    if (e.kind === 'lnk') return exeIcons.get(lnkTargets.get(e.target) || e.target)
    return undefined // protocol/game launchers → the UI's premium letter tile
  }

  /**
   * Batch-resolve a list of .lnk shortcuts to their real target paths via one
   * WScript.Shell pass, so we can extract each app's own exe icon rather than
   * the shortcut's generic document icon. Returns lnkPath → targetPath.
   */
  private async resolveLnkTargets(lnks: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    if (lnks.length === 0) return map
    const tmp = join(app.getPath('temp'), `cosmos-lnk-${Date.now()}.txt`)
    try {
      await fs.writeFile(tmp, lnks.join('\n'), 'utf8')
      const script = `
$ErrorActionPreference='SilentlyContinue'
$sh = New-Object -ComObject WScript.Shell
$out = foreach ($p in Get-Content -LiteralPath '${tmp}') {
  $p = "$p".Trim()  # strip Get-Content note-properties so JSON emits a plain string
  if (-not $p) { continue }
  $t = ''
  try { $t = $sh.CreateShortcut($p).TargetPath } catch {}
  [pscustomobject]@{ lnk = $p; target = $t }
}
$out | ConvertTo-Json -Compress`
      const json = await this.runPs(script, 20_000)
      const parsed = JSON.parse(json) as
        | { lnk?: string; target?: string }
        | { lnk?: string; target?: string }[]
      for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
        if (r?.lnk && r.target) map.set(r.lnk, r.target)
      }
    } catch {
      /* resolution failed — iconFor falls back to the .lnk path */
    } finally {
      void fs.unlink(tmp).catch(() => {})
    }
    return map
  }

  /**
   * Batch-extract crisp 48px icons for a list of .exe/.ico paths, pulled
   * straight from the Windows shell image list (SHIL_EXTRALARGE) — exactly the
   * icon Explorer shows — and returned as PNG data URLs. Returns path → dataURL.
   */
  private async resolveExeIcons(paths: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    if (paths.length === 0) return map
    const tmp = join(app.getPath('temp'), `cosmos-exe-${Date.now()}.txt`)
    try {
      await fs.writeFile(tmp, paths.join('\n'), 'utf8')
      const script = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class CosmosIco {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
  struct SHFILEINFO { public IntPtr hIcon; public int iIcon; public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string szTypeName; }
  [DllImport("shell32.dll", CharSet=CharSet.Auto)]
  static extern IntPtr SHGetFileInfo(string p, uint a, ref SHFILEINFO f, uint cb, uint fl);
  [DllImport("shell32.dll", EntryPoint="#727")]
  static extern int SHGetImageList(int i, ref Guid riid, out IntPtr ppv);
  [DllImport("comctl32.dll")] static extern IntPtr ImageList_GetIcon(IntPtr h, int i, int fl);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
  public static string B64(string path) {
    try {
      Bitmap bmp = null;
      if (path.EndsWith(".ico", StringComparison.OrdinalIgnoreCase)) {
        using (var ico = new Icon(path, 48, 48)) bmp = ico.ToBitmap();
      } else {
        var sfi = new SHFILEINFO();
        if (SHGetFileInfo(path, 0, ref sfi, (uint)Marshal.SizeOf(sfi), 0x4000) == IntPtr.Zero) return "";
        var iid = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");
        IntPtr himl; if (SHGetImageList(2, ref iid, out himl) != 0) return "";
        IntPtr hicon = ImageList_GetIcon(himl, sfi.iIcon, 0x1);
        if (hicon == IntPtr.Zero) return "";
        try { using (var ic = Icon.FromHandle(hicon)) bmp = ic.ToBitmap(); }
        finally { DestroyIcon(hicon); }
      }
      if (bmp == null) return "";
      using (bmp) using (var ms = new MemoryStream()) {
        bmp.Save(ms, ImageFormat.Png);
        return Convert.ToBase64String(ms.ToArray());
      }
    } catch { return ""; }
  }
}
'@
$out = foreach ($p in Get-Content -LiteralPath '${tmp}') {
  $p = "$p".Trim()  # strip Get-Content note-properties so JSON emits a plain string
  if (-not $p) { continue }
  [pscustomobject]@{ path = $p; b64 = [CosmosIco]::B64($p) }
}
$out | ConvertTo-Json -Compress`
      const json = await this.runPs(script, 45_000)
      const parsed = JSON.parse(json) as
        | { path?: string; b64?: string }
        | { path?: string; b64?: string }[]
      for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
        if (r?.path && r.b64) map.set(r.path, `data:image/png;base64,${r.b64}`)
      }
    } catch {
      /* extraction unavailable — those tiles use the letter fallback */
    } finally {
      void fs.unlink(tmp).catch(() => {})
    }
    return map
  }

  /**
   * Batch-resolve Store/UWP app-user-model-IDs to their package logo PNG,
   * returned already base64-encoded. Picks the crispest asset available
   * (preferring transparent "unplated" variants), so Store apps get their
   * genuine icons instead of a blank tile. Returns aumid → PNG data URL.
   */
  private async resolveUwpIcons(aumids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    if (aumids.length === 0) return map
    const tmp = join(app.getPath('temp'), `cosmos-uwp-${Date.now()}.txt`)
    try {
      await fs.writeFile(tmp, aumids.join('\n'), 'utf8')
      const script = `
$ErrorActionPreference='SilentlyContinue'
$ids = Get-Content -LiteralPath '${tmp}'
$pkgs = @{}
foreach ($p in Get-AppxPackage) { if ($p.PackageFamilyName) { $pkgs[$p.PackageFamilyName] = $p.InstallLocation } }
function Pick-Asset($loc, $rel) {
  $rel = $rel -replace '/', '\\'
  $exact = Join-Path $loc $rel
  $adir = Split-Path $exact -Parent
  $base = [IO.Path]::GetFileNameWithoutExtension($rel)
  $ext = [IO.Path]::GetExtension($rel); if (-not $ext) { $ext = '.png' }
  if (-not (Test-Path -LiteralPath $adir)) { if (Test-Path -LiteralPath $exact) { return $exact } else { return '' } }
  $cands = Get-ChildItem -LiteralPath $adir -Filter ($base + '*' + $ext) -File
  if (-not $cands) { if (Test-Path -LiteralPath $exact) { return $exact } else { return '' } }
  $scored = foreach ($c in $cands) {
    $n = $c.Name.ToLower(); $sz = 44
    if ($n -match 'targetsize-(\\d+)') { $sz = [int]$Matches[1] }
    elseif ($n -match 'scale-(\\d+)') { $sz = [int]([int]$Matches[1] * 44 / 100) }
    # theme fitness for a DARK UI: prefer transparent default-theme (unplated),
    # then plated colour tiles; avoid light-theme and high-contrast variants
    # (dark glyphs that would be invisible on the glass).
    $theme = 3
    if ($n -match 'contrast-') { $theme = 0 }
    elseif ($n -match 'lightunplated') { $theme = 1 }
    elseif ($n -match 'altform-unplated') { $theme = 4 }
    $fit = if ($sz -ge 48 -and $sz -le 128) { 2 } elseif ($sz -gt 128) { 1 } else { 0 }
    [pscustomobject]@{ path = $c.FullName; theme = $theme; fit = $fit; sz = $sz }
  }
  ($scored | Sort-Object @{e={$_.theme};Descending=$true}, @{e={$_.fit};Descending=$true}, @{e={$_.sz};Descending=$true} | Select-Object -First 1).path
}
$out = foreach ($id in $ids) {
  $id = "$id".Trim()
  $b64 = ''
  if ($id) {
    $fam = $id.Split('!')[0]
    $loc = $pkgs[$fam]
    if ($loc) {
      $mani = Join-Path $loc 'AppxManifest.xml'
      try {
        $raw = Get-Content -LiteralPath $mani -Raw
        $rel = ''
        foreach ($pat in @('Square44x44Logo="([^"]+)"', 'Square30x30Logo="([^"]+)"', '<Logo>([^<]+)</Logo>', 'Square150x150Logo="([^"]+)"')) {
          $m = [regex]::Match($raw, $pat)
          if ($m.Success) { $rel = $m.Groups[1].Value; break }
        }
        if ($rel) {
          $f = Pick-Asset $loc $rel
          if ($f -and (Test-Path -LiteralPath $f)) { $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f)) }
        }
      } catch {}
    }
  }
  [pscustomobject]@{ id = $id; b64 = $b64 }
}
$out | ConvertTo-Json -Compress`
      const json = await this.runPs(script, 25_000)
      const parsed = JSON.parse(json) as
        | { id?: string; b64?: string }
        | { id?: string; b64?: string }[]
      for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
        if (r?.id && r.b64) map.set(r.id, `data:image/png;base64,${r.b64}`)
      }
    } catch {
      /* Appx enumeration unavailable — those tiles use the letter fallback */
    } finally {
      void fs.unlink(tmp).catch(() => {})
    }
    return map
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
   * GRACEFUL by default: asks each window to close (like clicking its X or
   * File → Exit) so the app can flush unsaved data and release its own
   * locks — force-killing is what leaves stale lock files (e.g. JetBrains'
   * .port socket) that break the NEXT launch. Only when `force` is true
   * (the user explicitly asked to force/kill) does it fall back to a hard
   * Stop-Process. Always re-queries so the result is truthful.
   */
  async close(query: string, force = false): Promise<{ ok: boolean; message: string }> {
    if (!query.trim()) return { ok: false, message: 'No application specified' }
    // collapse spaces/hyphens/dots on BOTH sides so "Anti-Gravity",
    // "anti gravity" and "antigravity" all match a process "Antigravity"
    const q = collapse(query).replace(/'/g, "''")
    if (!q) return { ok: false, message: 'No application specified' }

    const script = [
      `$q='${q}'`,
      `$force=$${force ? 'true' : 'false'}`,
      `function norm($s){ if($null -eq $s){return ''}; ($s -replace '[\\s\\-_.]','').ToLower() }`,
      `function match { Get-Process | Where-Object { $_.SessionId -ne 0 -and ((norm $_.ProcessName).Contains($q) -or ($_.MainWindowTitle -and (norm $_.MainWindowTitle).Contains($q))) } }`,
      `$procs = match`,
      `$names = $procs | Select-Object -ExpandProperty ProcessName -Unique`,
      `if (-not $names) { Write-Output 'NONE'; exit }`,
      // graceful: send WM_CLOSE to each window-bearing process (like clicking X)
      `$procs | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }`,
      // wait up to ~6s for a clean exit
      `for ($i=0; $i -lt 12; $i++) { Start-Sleep -Milliseconds 500; if (-not (match)) { break } }`,
      `$survivors = match | Select-Object -ExpandProperty ProcessName -Unique`,
      `if (-not $survivors) { Write-Output ('OK|' + ($names -join ',')); exit }`,
      // still running: without force, leave it (likely a save/confirm prompt)
      `if (-not $force) { Write-Output ('OPEN|' + ($survivors -join ',')); exit }`,
      // force fallback — only when explicitly requested
      `foreach ($n in $survivors) { Stop-Process -Name $n -Force -ErrorAction SilentlyContinue }`,
      `Start-Sleep -Milliseconds 500`,
      `$s2 = match | Select-Object -ExpandProperty ProcessName -Unique`,
      `if ($s2) { Write-Output ('PARTIAL|' + ($s2 -join ',')) } else { Write-Output ('FORCED|' + ($survivors -join ',')) }`
    ].join('; ')

    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { windowsHide: true, timeout: 15_000 },
          (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim()))
        )
      })
      if (out === 'NONE' || out === '') {
        return { ok: false, message: `No running app matching "${query}" was found — it may already be closed.` }
      }
      const [status, names] = out.split('|')
      const list = (names ?? '').replace(/,/g, ', ')
      if (status === 'OK') return { ok: true, message: `Closed ${list}.` }
      if (status === 'FORCED') return { ok: true, message: `Force-closed ${list}.` }
      if (status === 'OPEN') {
        // graceful close asked but the app is still up (unsaved-changes prompt,
        // or no window to close) — report honestly, don't silently force
        return {
          ok: false,
          message:
            `Asked ${list} to close, but it's still running — it may be showing a ` +
            `"save changes?" prompt, or has no window to close. Check the app; if ` +
            `you want it killed anyway, say "force close ${query}".`
        }
      }
      // PARTIAL: force couldn't kill it (elevated / protected)
      return {
        ok: false,
        message: `Could not fully close "${query}" — ${list} is still running (it may require administrator rights).`
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
