import { ipcMain, type BrowserWindow } from 'electron'
import {
  IPC,
  type ApprovalDecision,
  type WindowControlAction,
  type WindowMode
} from '@shared/ipc'
import type {
  ChatRequest,
  InstalledApp,
  MemoryCategory,
  Settings,
  SystemCommandId,
  VoiceLanguageId
} from '@shared/types'
import type { AIService } from './services/ai/AIService'
import type { SettingsService } from './services/SettingsService'
import type { WeatherService } from './services/WeatherService'
import type { CommandService } from './services/CommandService'
import type { SttService } from './services/voice/SttService'
import type { TtsService } from './services/voice/TtsService'
import type { MemoryService } from './services/MemoryService'
import type { PluginService } from './services/PluginService'

interface WindowController {
  setMode: (mode: WindowMode) => void
  show: (mode?: WindowMode) => void
  hide: () => void
  quit: () => void
  onHandsFreeChanged: () => void
}

interface Services {
  ai: AIService
  settings: SettingsService
  weather: WeatherService
  commands: CommandService
  stt: SttService
  tts: TtsService
  memory: MemoryService
  plugins: PluginService
  window: WindowController
}

/** Binds every service to its IPC channel. Called once at startup. */
export function registerIpc(getWindow: () => BrowserWindow | null, services: Services): void {
  ipcMain.handle(IPC.AI_CHAT, async (_e, req: ChatRequest) => {
    const win = getWindow()
    if (!win) return
    // fire-and-forget: results stream back over AI_TOKEN / AI_DONE / AI_ERROR
    void services.ai.chat(win, req)
    return req.requestId
  })

  ipcMain.handle(IPC.AI_ABORT, (_e, requestId: string) => {
    services.ai.abort(requestId)
  })

  ipcMain.handle(IPC.AI_TRANSLATE, (_e, text: string, target: VoiceLanguageId) =>
    services.ai.translate(text, target)
  )

  ipcMain.handle(IPC.OLLAMA_LIST_MODELS, async () => {
    const base = (services.settings.get().ollamaUrl || 'http://localhost:11434').replace(/\/$/, '')
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) return []
      const data = (await res.json()) as { models?: { name?: string }[] }
      return (data.models ?? []).map((m) => m.name).filter((n): n is string => !!n)
    } catch {
      return [] // ollama not running / unreachable — picker falls back gracefully
    }
  })

  ipcMain.handle(IPC.SETTINGS_GET, () => services.settings.get())

  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch: Partial<Settings>) =>
    services.settings.set(patch)
  )

  ipcMain.handle(IPC.WEATHER_GET, () => services.weather.get())

  ipcMain.handle(IPC.COMMAND_RUN, (_e, id: SystemCommandId, arg?: string) =>
    services.commands.run(id, arg)
  )

  ipcMain.on(IPC.TOOL_APPROVAL_RESPONSE, (_e, approvalId: string, decision: ApprovalDecision) => {
    services.ai.resolveApproval(approvalId, decision)
  })

  ipcMain.handle(IPC.HISTORY_GET, () => services.memory.history())

  ipcMain.handle(IPC.HISTORY_NEW, () => services.memory.newConversation())

  ipcMain.handle(IPC.HISTORY_CLEAR_ALL, () => services.memory.clearAllHistory())

  ipcMain.handle(IPC.HISTORY_COUNT, () => services.memory.conversationCount())

  ipcMain.handle(IPC.SESSIONS_LIST, () => services.memory.listConversations())

  ipcMain.handle(IPC.SESSIONS_ACTIVE, () => services.memory.activeConversationId())

  ipcMain.handle(IPC.SESSIONS_SWITCH, (_e, id: number) => services.memory.switchConversation(id))

  ipcMain.handle(IPC.SESSIONS_DELETE, (_e, id: number) => services.memory.deleteConversation(id))

  ipcMain.handle(IPC.SESSIONS_RENAME, (_e, id: number, title: string) =>
    services.memory.renameConversation(id, title)
  )

  ipcMain.handle(IPC.MEMORY_LIST, () => services.memory.listMemories())

  ipcMain.handle(IPC.MEMORY_ADD, (_e, content: string, category: MemoryCategory) =>
    services.memory.saveMemory(content, category)
  )

  ipcMain.handle(IPC.MEMORY_DELETE, (_e, id: number) => services.memory.deleteMemory(id))

  ipcMain.handle(IPC.AUDIT_LIST, (_e, limit?: number) => services.memory.listAudit(limit))

  ipcMain.handle(IPC.NOTES_LIST, () => services.memory.listNotes())

  ipcMain.handle(IPC.NOTES_GET, (_e, id: number) => services.memory.getNote(id))

  ipcMain.handle(IPC.NOTES_SAVE, (_e, id: number | null, title: string, content: string) =>
    services.memory.saveNote(id, title, content)
  )

  ipcMain.handle(IPC.NOTES_DELETE, (_e, id: number) => services.memory.deleteNote(id))

  ipcMain.handle(IPC.PLUGINS_GET, () => services.plugins.list())

  ipcMain.handle(IPC.APPS_LIST, (_e, refresh?: boolean) =>
    services.commands.launcher.catalog(refresh)
  )

  ipcMain.handle(IPC.APPS_LAUNCH, (_e, app: InstalledApp) =>
    services.commands.launcher.launchEntry(app)
  )

  ipcMain.handle(IPC.WINDOW_SET_MODE, (_e, mode: WindowMode) => services.window.setMode(mode))

  ipcMain.handle(IPC.APP_QUIT, () => services.window.quit())

  // renderer tells main when hands-free changed so the tray checkbox stays in sync
  ipcMain.on(IPC.HANDSFREE_TOGGLE, () => services.window.onHandsFreeChanged())

  ipcMain.handle(IPC.STT_TRANSCRIBE, (_e, audio: ArrayBuffer, mime: string) =>
    services.stt.transcribe(audio, mime)
  )

  ipcMain.handle(IPC.TTS_SYNTHESIZE, (_e, text: string) => services.tts.synthesize(text))

  ipcMain.handle(IPC.VOICE_LIST_AVAILABLE, () => services.tts.availableVoiceIds())

  ipcMain.handle(IPC.ELEVEN_LIST_VOICES, () => services.tts.listElevenLabsVoices())

  ipcMain.handle(IPC.WINDOW_CONTROL, (_e, action: WindowControlAction) => {
    const win = getWindow()
    if (!win) return
    switch (action) {
      case 'minimize':
        win.minimize()
        break
      case 'maximize':
        win.isMaximized() ? win.unmaximize() : win.maximize()
        break
      case 'close':
        win.close() // close handler hides to tray unless quitting
        break
    }
  })
}
