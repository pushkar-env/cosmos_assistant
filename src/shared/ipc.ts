/** IPC channel names — the only place channel strings exist. */

export const IPC = {
  // main -> renderer (push)
  SYSTEM_STATS: 'system:stats',
  AI_TOKEN: 'ai:token',
  AI_DONE: 'ai:done',
  AI_ERROR: 'ai:error',
  TOOL_EVENT: 'ai:tool-event',
  TOOL_APPROVAL_REQUEST: 'ai:tool-approval-request',
  AGENT_EVENT: 'ai:agent-event',
  PALETTE_TOGGLE: 'app:palette-toggle',
  /** window came back from minimize/hidden → renderer re-arms the mic */
  WINDOW_SHOWN: 'app:window-shown',
  /** workspace files changed on disk (watcher) → renderer refreshes the tree */
  FILES_CHANGED: 'files:changed',
  /** a streamed chunk from the integrated terminal */
  TERM_DATA: 'term:data',

  // renderer -> main (invoke)
  AI_CHAT: 'ai:chat',
  AI_ABORT: 'ai:abort',
  AI_TRANSLATE: 'ai:translate',
  OLLAMA_LIST_MODELS: 'ai:ollama-list-models',
  // ── workspace / studio ──
  WORKSPACE_GET: 'workspace:get',
  WORKSPACE_PICK: 'workspace:pick',
  WORKSPACE_SET: 'workspace:set',
  FILES_TREE: 'files:tree',
  FILES_LIST: 'files:list',
  FILES_READ: 'files:read',
  FILES_WRITE: 'files:write',
  FILES_CREATE: 'files:create',
  FILES_RENAME: 'files:rename',
  FILES_DELETE: 'files:delete',
  FILES_REVEAL: 'files:reveal',
  TERM_START: 'term:start',
  TERM_INPUT: 'term:input',
  TERM_RESET: 'term:reset',
  // ── github / git ──
  GITHUB_CONNECT: 'github:connect',
  GITHUB_DISCONNECT: 'github:disconnect',
  GITHUB_IDENTITY: 'github:identity',
  GIT_STATUS: 'git:status',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  WEATHER_GET: 'weather:get',
  COMMAND_RUN: 'command:run',
  WINDOW_CONTROL: 'window:control',
  STT_TRANSCRIBE: 'voice:transcribe',
  TTS_SYNTHESIZE: 'voice:synthesize',
  VOICE_LIST_AVAILABLE: 'voice:list-available',
  ELEVEN_LIST_VOICES: 'voice:eleven-list-voices',
  TOOL_APPROVAL_RESPONSE: 'ai:tool-approval-response',
  HISTORY_GET: 'history:get',
  HISTORY_NEW: 'history:new',
  HISTORY_CLEAR_ALL: 'history:clear-all',
  HISTORY_COUNT: 'history:count',
  SESSIONS_LIST: 'sessions:list',
  SESSIONS_ACTIVE: 'sessions:active',
  SESSIONS_SWITCH: 'sessions:switch',
  SESSIONS_DELETE: 'sessions:delete',
  SESSIONS_RENAME: 'sessions:rename',
  MEMORY_LIST: 'vault:memory-list',
  MEMORY_ADD: 'vault:memory-add',
  MEMORY_DELETE: 'vault:memory-delete',
  AUDIT_LIST: 'vault:audit-list',
  NOTIFY: 'app:notify',
  NOTES_LIST: 'notes:list',
  NOTES_GET: 'notes:get',
  NOTES_SAVE: 'notes:save',
  NOTES_DELETE: 'notes:delete',
  PLUGINS_GET: 'plugins:get',
  APPS_LIST: 'apps:list',
  APPS_LAUNCH: 'apps:launch',
  WINDOW_SET_MODE: 'window:set-mode',
  WINDOW_MODE_CHANGED: 'window:mode-changed',
  APP_QUIT: 'app:quit',
  HANDSFREE_TOGGLE: 'app:handsfree-toggle',
  START_PTT: 'app:start-ptt'
} as const

/** approve = this once; always = grant the tool permanently; deny */
export type ApprovalDecision = 'approve' | 'always' | 'deny'

/** window presentation modes */
export type WindowMode = 'full' | 'compact' | 'orb'

export type WindowControlAction = 'minimize' | 'maximize' | 'close'

export interface AITokenEvent {
  requestId: string
  delta: string
}

export interface AIDoneEvent {
  requestId: string
}

export interface AIErrorEvent {
  requestId: string
  message: string
}
