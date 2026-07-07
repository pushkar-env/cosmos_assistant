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

  // renderer -> main (invoke)
  AI_CHAT: 'ai:chat',
  AI_ABORT: 'ai:abort',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  WEATHER_GET: 'weather:get',
  COMMAND_RUN: 'command:run',
  WINDOW_CONTROL: 'window:control',
  STT_TRANSCRIBE: 'voice:transcribe',
  TTS_SYNTHESIZE: 'voice:synthesize',
  VOICE_DETECT_PIPER: 'voice:detect-piper',
  VOICE_LIST_AVAILABLE: 'voice:list-available',
  TOOL_APPROVAL_RESPONSE: 'ai:tool-approval-response',
  HISTORY_GET: 'history:get',
  HISTORY_NEW: 'history:new',
  HISTORY_CLEAR_ALL: 'history:clear-all',
  HISTORY_COUNT: 'history:count',
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
