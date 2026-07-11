import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray
} from 'electron'
import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC, type WindowMode } from '@shared/ipc'
import { TRAY_ICON_PNG_BASE64 } from './trayIcon'
import { registerIpc } from './ipc'
import { SettingsService } from './services/SettingsService'
import { SystemStatsService } from './services/SystemStatsService'
import { WeatherService } from './services/WeatherService'
import { CommandService } from './services/CommandService'
import { AIService } from './services/ai/AIService'
import { SttService } from './services/voice/SttService'
import { TtsService } from './services/voice/TtsService'
import { ToolRegistry } from './services/tools/ToolRegistry'
import { MemoryService } from './services/MemoryService'
import { SecretsService } from './services/SecretsService'
import { EmbeddingService } from './services/EmbeddingService'
import { BrowserService } from './services/BrowserService'
import { VisionService } from './services/VisionService'
import { OcrService } from './services/OcrService'
import { UnityService } from './services/unity/UnityService'
import { UnrealService } from './services/UnrealService'
import { PluginService } from './services/PluginService'
import { MediaService } from './services/MediaService'
import { WorkspaceService } from './services/WorkspaceService'
import { PreviewServer } from './services/PreviewServer'
import { GitService } from './services/GitService'
import { NotesExportService } from './services/NotesExportService'

// Pin a stable identity BEFORE any service reads app.getPath('userData').
// This guarantees `npm run dev` and the installed .exe share one profile
// (%APPDATA%\COSMOS) — so safeStorage-encrypted API keys, memory and
// settings are the same in both. Without this, a dev run can resolve to
// the default "Electron" profile and appear to "lose" the keys.
app.setName('COSMOS')
try {
  app.setPath('userData', join(app.getPath('appData'), 'COSMOS'))
} catch {
  /* appData unavailable this early on some platforms; default is fine */
}

// dev only: expose CDP so tooling can inspect the running renderer
if (!app.isPackaged) app.commandLine.appendSwitch('remote-debugging-port', '9223')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let windowMode: WindowMode = 'full'
/** bounds of the last full-size window, restored when leaving compact/orb */
let fullBounds: Electron.Rectangle | null = null
/** full mode opens maximized by default; remember if the user un-maximized it */
let fullMaximized = true
/** where the user dragged the floating orb — restored instead of re-snapping
 *  it to the bottom-right corner every time orb mode is entered */
let orbPosition: { x: number; y: number } | null = null

const MODE_SIZES = {
  full: { width: 1500, height: 940 },
  compact: { width: 400, height: 560 },
  orb: { width: 128, height: 128 }
} as const

const settings = new SettingsService()
const stats = new SystemStatsService()
const weather = new WeatherService(settings)
const commands = new CommandService()
const embeddings = new EmbeddingService(settings)
const notesExport = new NotesExportService(settings)
const memory = new MemoryService(embeddings)
memory.attachNotesExport(notesExport) // mirror notes + research reports to .md
const secrets = new SecretsService() // encrypted API-key / password vault
const browser = new BrowserService()
const media = new MediaService(browser, settings)
const workspace = new WorkspaceService(settings)
const preview = new PreviewServer(workspace)
const git = new GitService(settings, workspace)
const tools = new ToolRegistry({
  stats,
  commands,
  memory,
  browser,
  vision: new VisionService(settings),
  ocr: new OcrService(),
  unity: new UnityService(),
  unreal: new UnrealService(),
  media,
  workspace,
  git,
  secrets
})
const ai = new AIService(settings, tools, memory, workspace)
const stt = new SttService(settings)
const tts = new TtsService(settings)
const plugins = new PluginService()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: MODE_SIZES.full.width,
    height: MODE_SIZES.full.height,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    frame: false,
    transparent: true, // enables the round orb mode; full mode paints opaque
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true, // Studio's live preview pane embeds a <webview>
      backgroundThrottling: false // keep voice/audio alive when hidden to tray
    }
  })

  mainWindow.on('ready-to-show', () => {
    // open full-screen (maximized) by default
    if (windowMode === 'full') mainWindow?.maximize()
    mainWindow?.show()
  })

  // track the user's own maximize/restore while in full mode
  mainWindow.on('maximize', () => {
    if (windowMode === 'full') fullMaximized = true
  })
  mainWindow.on('unmaximize', () => {
    if (windowMode === 'full') fullMaximized = false
  })

  // remember where the user drags the floating orb (native-drag 'moved' event)
  // so it reopens in the same spot instead of snapping back to the corner
  mainWindow.on('moved', () => {
    if (windowMode === 'orb' && mainWindow && !mainWindow.isDestroyed()) {
      const [x, y] = mainWindow.getPosition()
      orbPosition = { x, y }
    }
  })

  // Tell the renderer when the window comes back from minimize/hidden. The
  // Page Visibility API does NOT fire on minimize here (backgroundThrottling
  // is off), so hands-free relies on this to re-arm the mic — otherwise the
  // suspended audio capture never recovers without a manual mic toggle.
  const notifyShown = (): void => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send(IPC.WINDOW_SHOWN)
  }
  mainWindow.on('restore', notifyShown)
  mainWindow.on('show', notifyShown)

  // external links open in the OS browser, never inside the shell
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // closing the window hides COSMOS to the tray — it keeps running in the
  // background until the user explicitly quits from the tray menu.
  // In DEV, closing fully quits instead: otherwise a hidden dev instance keeps
  // holding the single-instance lock, and the next `npm run dev` bounces off it
  // and surfaces the OLD, stale instance's window (in whatever mode it was in)
  // rather than the freshly built code — which reads as the app "looking
  // different"/inconsistent between runs. Packaged builds keep hide-to-tray.
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    if (!app.isPackaged) {
      isQuitting = true
      app.quit()
      return
    }
    e.preventDefault()
    hideToTray()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Apply a presentation mode: full app, compact panel, or floating orb. */
function setWindowMode(mode: WindowMode): void {
  if (!mainWindow) return
  const wasFull = windowMode === 'full'
  if (wasFull && mode !== 'full' && !mainWindow.isMinimized()) {
    // remember how full mode was left so we can restore it exactly
    fullMaximized = mainWindow.isMaximized()
    if (!fullMaximized) fullBounds = mainWindow.getBounds()
  }
  windowMode = mode
  const size = MODE_SIZES[mode]

  if (mode === 'full') {
    mainWindow.setAlwaysOnTop(false)
    mainWindow.setMinimumSize(1100, 700)
    mainWindow.setResizable(true)
    if (fullMaximized) mainWindow.maximize()
    else if (fullBounds) mainWindow.setBounds(fullBounds)
    else mainWindow.setSize(size.width, size.height)
  } else {
    if (mainWindow.isMaximized()) mainWindow.unmaximize() // shrink cleanly to the widget
    // compact / orb: small, pinned, parked bottom-right of the display
    mainWindow.setResizable(false)
    mainWindow.setMinimumSize(size.width, size.height)
    mainWindow.setAlwaysOnTop(true, 'floating')
    mainWindow.setSize(size.width, size.height)
    // orb mode restores where the user dragged it (clamped back on-screen in
    // case it was left at an edge); otherwise park bottom-right
    if (mode === 'orb' && orbPosition) {
      const c = clampToScreen(orbPosition.x, orbPosition.y, size.width, size.height)
      mainWindow.setPosition(c.x, c.y)
    } else {
      const area = screen.getPrimaryDisplay().workArea
      const margin = 24
      mainWindow.setPosition(
        area.x + area.width - size.width - margin,
        area.y + area.height - size.height - margin
      )
    }
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.webContents.send(IPC.WINDOW_MODE_CHANGED, mode)
}

/**
 * Clamp a window position to the nearest display so the orb can never be
 * dropped fully off-screen and lost.
 */
function clampToScreen(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const { bounds } = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
  return {
    x: Math.round(Math.min(Math.max(x, bounds.x - w / 3), bounds.x + bounds.width - w / 1.5)),
    y: Math.round(Math.min(Math.max(y, bounds.y), bounds.y + bounds.height - h / 1.5))
  }
}

/**
 * Move the floating orb window to an absolute screen position. Driven by the
 * renderer's manual drag (we no longer use -webkit-app-region: drag, which on
 * Windows swallowed the click-to-talk tap and jittered the transparent window).
 * Only honored in orb mode; the `moved` handler keeps orbPosition in sync so it
 * reopens where the user left it. No animation → 1:1 with the cursor.
 */
function moveOrb(x: number, y: number): void {
  if (windowMode !== 'orb' || !mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setPosition(Math.round(x), Math.round(y), false)
}

function showMainWindow(mode: WindowMode = 'full'): void {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  setWindowMode(mode)
  mainWindow.show()
  mainWindow.focus()
}

function hideToTray(): void {
  mainWindow?.hide()
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`)
  tray = new Tray(icon)
  tray.setToolTip('COSMOS')
  tray.on('double-click', () => showMainWindow('full'))
  tray.on('click', () => showMainWindow(windowMode === 'full' ? 'full' : windowMode))
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (!tray) return
  const handsFree = settings.get().voice.handsFree
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open COSMOS', click: () => showMainWindow('full') },
      { label: 'Orb widget', click: () => showMainWindow('orb') },
      { type: 'separator' },
      {
        label: 'Hands-free',
        type: 'checkbox',
        checked: handsFree,
        click: () => {
          if (mainWindow && !mainWindow.isVisible()) mainWindow.show()
          mainWindow?.webContents.send(IPC.HANDSFREE_TOGGLE)
        }
      },
      { type: 'separator' },
      {
        label: 'Quit COSMOS',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
}

/**
 * One-time migration from the pre-rename install ("JARVIS X"): copies
 * the memory database, history and plugins into the new COSMOS
 * userData folder. IMPORTANT: safeStorage blobs are tied to the
 * profile's Local State key, NOT just the Windows user — encrypted
 * values from the old profile are unreadable here, so the settings
 * copy strips `enc:` values (those keys must be re-entered) instead of
 * letting them decay into empty strings. Never overwrites anything
 * COSMOS has already written; the old folder is left untouched.
 */
function migrateFromJarvisX(): void {
  const newDir = app.getPath('userData')
  const oldDir = join(app.getPath('appData'), 'JARVIS X')
  if (!existsSync(oldDir)) return
  const stripEnc = (v: unknown): string =>
    typeof v === 'string' && !v.startsWith('enc:') ? v : ''
  try {
    const oldSettings = join(oldDir, 'jarvis-settings.json')
    const newSettings = join(newDir, 'cosmos-settings.json')
    // never resurrect pre-rename settings when COSMOS settings exist in
    // any form — SettingsService recovers from its .bak on its own
    if (
      existsSync(oldSettings) &&
      !existsSync(newSettings) &&
      !existsSync(`${newSettings}.bak`)
    ) {
      const s = JSON.parse(readFileSync(oldSettings, 'utf-8')) as Record<string, unknown>
      const apiKeys = (s.apiKeys ?? {}) as Record<string, unknown>
      s.apiKeys = {
        anthropic: stripEnc(apiKeys.anthropic),
        openai: stripEnc(apiKeys.openai),
        gemini: stripEnc(apiKeys.gemini)
      }
      const voice = s.voice as Record<string, unknown> | undefined
      if (voice) voice.elevenLabsKey = stripEnc(voice.elevenLabsKey)
      writeFileSync(newSettings, JSON.stringify(s, null, 2), 'utf-8')
      console.log('[migrate] settings copied (encrypted keys require re-entry)')
    }
    for (const [oldName, newName] of [
      ['jarvis-memory.db', 'cosmos-memory.db'],
      ['jarvis-history.json', 'cosmos-history.json']
    ]) {
      const src = join(oldDir, oldName)
      const dest = join(newDir, newName)
      if (existsSync(src) && !existsSync(dest)) {
        copyFileSync(src, dest)
        console.log(`[migrate] ${oldName} → ${newName}`)
      }
    }
    const oldPlugins = join(oldDir, 'plugins')
    const newPlugins = join(newDir, 'plugins')
    if (existsSync(oldPlugins) && !existsSync(newPlugins)) {
      cpSync(oldPlugins, newPlugins, { recursive: true })
      console.log('[migrate] plugins folder copied')
    }
  } catch (err) {
    console.error('[migrate] migration failed (old data left untouched):', err)
  }
}

// single-instance: relaunching focuses the running COSMOS instead of a 2nd copy
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow('full'))

  void app.whenReady().then(() => {
    migrateFromJarvisX()

    // the voice system needs the microphone; everything else is denied
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media')
    })

    createWindow()
    createTray()
    registerIpc(() => mainWindow, {
      ai,
      settings,
      weather,
      commands,
      stt,
      tts,
      memory,
      secrets,
      plugins,
      workspace,
      preview,
      git,
      notesExport,
      window: {
        setMode: setWindowMode,
        show: showMainWindow,
        hide: hideToTray,
        quit: () => {
          isQuitting = true
          app.quit()
        },
        moveOrb,
        onHandsFreeChanged: refreshTrayMenu
      }
    })
    void stats.start(() => mainWindow)
    void memory.init()
    void secrets.init()
    void plugins.load()

    // Piper voices are bundled in resources and resolved live from the
    // selected voice id (TtsService.resolvePiper) — nothing to auto-fill.

    // CTRL+SPACE anywhere: summon COSMOS and toggle the command palette
    globalShortcut.register('CommandOrControl+Space', () => {
      if (!mainWindow) return
      if (windowMode !== 'full') setWindowMode('full')
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send(IPC.PALETTE_TOGGLE)
    })

    app.on('activate', () => showMainWindow('full'))
  })

  // do NOT quit when the window is hidden to tray; only a real quit ends it
  app.on('window-all-closed', () => {
    if (isQuitting) app.quit()
  })

  app.on('before-quit', () => {
    isQuitting = true
    stats.stop()
    workspace.dispose() // kills the persistent terminal + file watcher
    preview.dispose() // stops the static preview server
    void browser.close() // also closes the media tab
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    tray?.destroy()
  })
}
