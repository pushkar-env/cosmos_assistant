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
import { EmbeddingService } from './services/EmbeddingService'
import { BrowserService } from './services/BrowserService'
import { VisionService } from './services/VisionService'
import { OcrService } from './services/OcrService'
import { UnityService } from './services/unity/UnityService'
import { UnrealService } from './services/UnrealService'
import { PluginService } from './services/PluginService'
import { MediaService } from './services/MediaService'

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
const memory = new MemoryService(embeddings)
const browser = new BrowserService()
const media = new MediaService(browser, settings)
const tools = new ToolRegistry({
  stats,
  commands,
  memory,
  browser,
  vision: new VisionService(settings),
  ocr: new OcrService(),
  unity: new UnityService(),
  unreal: new UnrealService(),
  media
})
const ai = new AIService(settings, tools, memory)
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

  // external links open in the OS browser, never inside the shell
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // closing the window hides COSMOS to the tray — it keeps running in the
  // background until the user explicitly quits from the tray menu
  mainWindow.on('close', (e) => {
    if (isQuitting) return
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
    const area = screen.getPrimaryDisplay().workArea
    const margin = 24
    mainWindow.setPosition(
      area.x + area.width - size.width - margin,
      area.y + area.height - size.height - margin
    )
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.webContents.send(IPC.WINDOW_MODE_CHANGED, mode)
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
      plugins,
      window: {
        setMode: setWindowMode,
        show: showMainWindow,
        hide: hideToTray,
        quit: () => {
          isQuitting = true
          app.quit()
        },
        onHandsFreeChanged: refreshTrayMenu
      }
    })
    void stats.start(() => mainWindow)
    void memory.init()
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
    void browser.close() // also closes the media tab
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    tray?.destroy()
  })
}
