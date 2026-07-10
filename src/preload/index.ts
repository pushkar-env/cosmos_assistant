import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AIDoneEvent,
  type AIErrorEvent,
  type AITokenEvent,
  type ApprovalDecision,
  type WindowControlAction,
  type WindowMode
} from '@shared/ipc'
import type {
  AuditEntry,
  ChatMessage,
  ChatRequest,
  CommandResult,
  ConversationMeta,
  ElevenVoice,
  FileNode,
  GitStatus,
  GithubIdentity,
  InstalledApp,
  MemoryCategory,
  MemoryItem,
  Note,
  NoteMeta,
  NotificationPayload,
  PluginManifest,
  Settings,
  SynthesisResult,
  SystemCommandId,
  SystemStats,
  TerminalChunk,
  TranscriptionResult,
  VoiceLanguageId,
  WeatherInfo
} from '@shared/types'
import type { AgentEvent, ToolApprovalRequest, ToolEvent } from '@shared/tools'

type Unsubscribe = () => void

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** The complete, typed surface the renderer may touch. */
export const cosmosApi = {
  system: {
    onStats: (cb: (stats: SystemStats) => void): Unsubscribe =>
      subscribe(IPC.SYSTEM_STATS, cb)
  },
  weather: {
    get: (): Promise<WeatherInfo | null> => ipcRenderer.invoke(IPC.WEATHER_GET)
  },
  ai: {
    chat: (req: ChatRequest): Promise<string> => ipcRenderer.invoke(IPC.AI_CHAT, req),
    abort: (requestId: string): Promise<void> => ipcRenderer.invoke(IPC.AI_ABORT, requestId),
    translate: (text: string, target: VoiceLanguageId): Promise<string> =>
      ipcRenderer.invoke(IPC.AI_TRANSLATE, text, target),
    listOllamaModels: (): Promise<string[]> => ipcRenderer.invoke(IPC.OLLAMA_LIST_MODELS),
    onToken: (cb: (e: AITokenEvent) => void): Unsubscribe => subscribe(IPC.AI_TOKEN, cb),
    onDone: (cb: (e: AIDoneEvent) => void): Unsubscribe => subscribe(IPC.AI_DONE, cb),
    onError: (cb: (e: AIErrorEvent) => void): Unsubscribe => subscribe(IPC.AI_ERROR, cb)
  },
  tools: {
    onEvent: (cb: (e: ToolEvent) => void): Unsubscribe => subscribe(IPC.TOOL_EVENT, cb),
    onAgentEvent: (cb: (e: AgentEvent) => void): Unsubscribe => subscribe(IPC.AGENT_EVENT, cb),
    onApprovalRequest: (cb: (e: ToolApprovalRequest) => void): Unsubscribe =>
      subscribe(IPC.TOOL_APPROVAL_REQUEST, cb),
    respondApproval: (approvalId: string, decision: ApprovalDecision): void =>
      ipcRenderer.send(IPC.TOOL_APPROVAL_RESPONSE, approvalId, decision)
  },
  history: {
    get: (): Promise<ChatMessage[]> => ipcRenderer.invoke(IPC.HISTORY_GET),
    new: (): Promise<number> => ipcRenderer.invoke(IPC.HISTORY_NEW),
    clearAll: (): Promise<void> => ipcRenderer.invoke(IPC.HISTORY_CLEAR_ALL),
    count: (): Promise<number> => ipcRenderer.invoke(IPC.HISTORY_COUNT)
  },
  sessions: {
    list: (): Promise<ConversationMeta[]> => ipcRenderer.invoke(IPC.SESSIONS_LIST),
    active: (): Promise<number> => ipcRenderer.invoke(IPC.SESSIONS_ACTIVE),
    switch: (id: number): Promise<ChatMessage[]> => ipcRenderer.invoke(IPC.SESSIONS_SWITCH, id),
    delete: (id: number): Promise<{ activeId: number; messages: ChatMessage[] }> =>
      ipcRenderer.invoke(IPC.SESSIONS_DELETE, id),
    rename: (id: number, title: string): Promise<void> =>
      ipcRenderer.invoke(IPC.SESSIONS_RENAME, id, title)
  },
  vault: {
    listMemories: (): Promise<MemoryItem[]> => ipcRenderer.invoke(IPC.MEMORY_LIST),
    addMemory: (content: string, category: MemoryCategory): Promise<number> =>
      ipcRenderer.invoke(IPC.MEMORY_ADD, content, category),
    deleteMemory: (id: number): Promise<void> => ipcRenderer.invoke(IPC.MEMORY_DELETE, id),
    listAudit: (limit?: number): Promise<AuditEntry[]> =>
      ipcRenderer.invoke(IPC.AUDIT_LIST, limit)
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke(IPC.SETTINGS_SET, patch)
  },
  commands: {
    run: (id: SystemCommandId, arg?: string): Promise<CommandResult> =>
      ipcRenderer.invoke(IPC.COMMAND_RUN, id, arg)
  },
  voice: {
    transcribe: (audio: ArrayBuffer, mime: string): Promise<TranscriptionResult> =>
      ipcRenderer.invoke(IPC.STT_TRANSCRIBE, audio, mime),
    synthesize: (text: string): Promise<SynthesisResult> =>
      ipcRenderer.invoke(IPC.TTS_SYNTHESIZE, text),
    listAvailableVoices: (): Promise<string[]> => ipcRenderer.invoke(IPC.VOICE_LIST_AVAILABLE),
    listElevenLabsVoices: (): Promise<ElevenVoice[]> =>
      ipcRenderer.invoke(IPC.ELEVEN_LIST_VOICES)
  },
  notes: {
    list: (): Promise<NoteMeta[]> => ipcRenderer.invoke(IPC.NOTES_LIST),
    get: (id: number): Promise<Note | null> => ipcRenderer.invoke(IPC.NOTES_GET, id),
    save: (id: number | null, title: string, content: string): Promise<number> =>
      ipcRenderer.invoke(IPC.NOTES_SAVE, id, title, content),
    delete: (id: number): Promise<void> => ipcRenderer.invoke(IPC.NOTES_DELETE, id)
  },
  plugins: {
    get: (): Promise<PluginManifest[]> => ipcRenderer.invoke(IPC.PLUGINS_GET)
  },
  apps: {
    list: (refresh?: boolean): Promise<InstalledApp[]> =>
      ipcRenderer.invoke(IPC.APPS_LIST, refresh),
    launch: (app: InstalledApp): Promise<CommandResult> =>
      ipcRenderer.invoke(IPC.APPS_LAUNCH, app)
  },
  workspace: {
    getRoot: (): Promise<string> => ipcRenderer.invoke(IPC.WORKSPACE_GET),
    pick: (): Promise<string> => ipcRenderer.invoke(IPC.WORKSPACE_PICK),
    setRoot: (dir: string): Promise<string> => ipcRenderer.invoke(IPC.WORKSPACE_SET, dir),
    onFilesChanged: (cb: () => void): Unsubscribe => subscribe(IPC.FILES_CHANGED, cb)
  },
  files: {
    tree: (): Promise<{ root: string; nodes: FileNode[] }> => ipcRenderer.invoke(IPC.FILES_TREE),
    list: (relPath: string): Promise<FileNode[]> => ipcRenderer.invoke(IPC.FILES_LIST, relPath),
    read: (relPath: string): Promise<{ content: string; truncated: boolean }> =>
      ipcRenderer.invoke(IPC.FILES_READ, relPath),
    write: (relPath: string, content: string): Promise<void> =>
      ipcRenderer.invoke(IPC.FILES_WRITE, relPath, content),
    create: (relPath: string, kind: 'file' | 'dir'): Promise<string> =>
      ipcRenderer.invoke(IPC.FILES_CREATE, relPath, kind),
    rename: (relPath: string, name: string): Promise<string> =>
      ipcRenderer.invoke(IPC.FILES_RENAME, relPath, name),
    delete: (relPath: string): Promise<void> => ipcRenderer.invoke(IPC.FILES_DELETE, relPath),
    reveal: (relPath?: string): Promise<void> => ipcRenderer.invoke(IPC.FILES_REVEAL, relPath)
  },
  terminal: {
    start: (): Promise<string> => ipcRenderer.invoke(IPC.TERM_START),
    input: (command: string): Promise<void> => ipcRenderer.invoke(IPC.TERM_INPUT, command),
    reset: (): Promise<string> => ipcRenderer.invoke(IPC.TERM_RESET),
    onData: (cb: (chunk: TerminalChunk) => void): Unsubscribe => subscribe(IPC.TERM_DATA, cb)
  },
  github: {
    connect: (token: string): Promise<GithubIdentity> => ipcRenderer.invoke(IPC.GITHUB_CONNECT, token),
    disconnect: (): Promise<void> => ipcRenderer.invoke(IPC.GITHUB_DISCONNECT),
    identity: (): Promise<GithubIdentity | null> => ipcRenderer.invoke(IPC.GITHUB_IDENTITY),
    status: (): Promise<GitStatus> => ipcRenderer.invoke(IPC.GIT_STATUS)
  },
  app: {
    onPaletteToggle: (cb: () => void): Unsubscribe => subscribe(IPC.PALETTE_TOGGLE, cb),
    onNotify: (cb: (n: NotificationPayload) => void): Unsubscribe => subscribe(IPC.NOTIFY, cb),
    windowControl: (action: WindowControlAction): Promise<void> =>
      ipcRenderer.invoke(IPC.WINDOW_CONTROL, action),
    setMode: (mode: WindowMode): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_SET_MODE, mode),
    onModeChanged: (cb: (mode: WindowMode) => void): Unsubscribe =>
      subscribe(IPC.WINDOW_MODE_CHANGED, cb),
    // window returned from minimize / hidden (for re-arming hands-free)
    onWindowShown: (cb: () => void): Unsubscribe => subscribe(IPC.WINDOW_SHOWN, cb),
    quit: (): Promise<void> => ipcRenderer.invoke(IPC.APP_QUIT),
    // tray asked the renderer to toggle hands-free
    onHandsFreeToggle: (cb: () => void): Unsubscribe => subscribe(IPC.HANDSFREE_TOGGLE, cb),
    // renderer tells main hands-free state changed (keeps tray checkbox synced)
    notifyHandsFreeChanged: (): void => ipcRenderer.send(IPC.HANDSFREE_TOGGLE)
  }
}

export type CosmosApi = typeof cosmosApi

contextBridge.exposeInMainWorld('cosmos', cosmosApi)
