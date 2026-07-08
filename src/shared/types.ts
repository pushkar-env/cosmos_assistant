/** Domain types shared between main, preload and renderer. */

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'ollama'

export type ThemeId = 'cyber-blue' | 'crimson' | 'nebula-purple' | 'emerald' | 'arctic-white'

export type AssistantState = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** A saved chat session, shown in the sessions list. */
export interface ConversationMeta {
  id: number
  /** derived from the first user message, or a custom rename */
  title: string
  updatedAt: string
  messageCount: number
}

export interface ChatRequest {
  requestId: string
  provider: ProviderId
  model: string
  messages: ChatMessage[]
  system?: string
}

export interface GpuInfo {
  model: string
  vendor: string
  load: number | null
  temp: number | null
  /** MB */
  vramUsed: number | null
  /** MB */
  vramTotal: number | null
}

export interface SystemStats {
  cpu: { load: number; temp: number | null; cores: number; brand: string }
  gpus: GpuInfo[]
  mem: { used: number; total: number }
  net: { rxSec: number; txSec: number }
  battery: { hasBattery: boolean; percent: number; isCharging: boolean }
  uptime: number
}

export interface WeatherInfo {
  location: string
  tempC: number
  feelsLikeC: number
  windKph: number
  humidity: number
  code: number
  description: string
}

export type TtsProviderId = 'windows' | 'elevenlabs' | 'piper'

export type VoiceLanguageId = 'en' | 'hi'

/** A neural voice bundled inside the app (see resources/piper/voices). */
export interface PiperVoiceDef {
  /** file stem, e.g. 'en_US-hfc_female-medium' → voices/<id>.onnx */
  id: string
  language: VoiceLanguageId
  /** short label shown in the voice dropdown */
  label: string
  gender: 'male' | 'female'
}

export const VOICE_LANGUAGES: { id: VoiceLanguageId; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'हिन्दी · Hindi' }
]

/**
 * Voices shipped with the app. Their .onnx files live in
 * resources/piper/voices and are resolved at runtime from
 * process.resourcesPath, so no absolute path is ever stored — the app
 * works on any machine with zero configuration.
 */
export const BUNDLED_VOICES: PiperVoiceDef[] = [
  { id: 'en_US-hfc_female-medium', language: 'en', label: 'Female · HFC', gender: 'female' },
  { id: 'en_US-hfc_male-medium', language: 'en', label: 'Male · HFC', gender: 'male' },
  { id: 'hi_IN-priyamvada-medium', language: 'hi', label: 'Priyamvada · Female', gender: 'female' },
  { id: 'hi_IN-pratham-medium', language: 'hi', label: 'Pratham · Male', gender: 'male' }
]

export const DEFAULT_PIPER_VOICE = 'en_US-hfc_female-medium'

/** BCP-47 code Whisper expects for each conversation language. */
export const VOICE_LANGUAGE_CODES: Record<VoiceLanguageId, string> = {
  en: 'en',
  hi: 'hi'
}

/** The conversation language implied by the selected bundled voice. */
export function voiceLanguageOf(voiceId: string): VoiceLanguageId {
  return BUNDLED_VOICES.find((v) => v.id === voiceId)?.language ?? 'en'
}

export interface VoiceSettings {
  /** speak assistant replies aloud (typed or spoken input) */
  voiceReplies: boolean
  /** always-on mic: VAD segments speech, only "Cosmos …" utterances execute */
  handsFree: boolean
  ttsProvider: TtsProviderId
  elevenLabsKey: string
  elevenLabsVoiceId: string
  /** selected bundled voice id (resolved from resources at runtime) */
  piperVoiceId: string
  /** OPTIONAL override: absolute path to a custom piper.exe (advanced) */
  piperPath: string
  /** OPTIONAL override: absolute path to a custom .onnx voice (advanced) */
  piperModelPath: string
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voiceReplies: true,
  handsFree: false,
  ttsProvider: 'windows',
  elevenLabsKey: '',
  elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
  piperVoiceId: DEFAULT_PIPER_VOICE,
  piperPath: '',
  piperModelPath: ''
}

/**
 * Where media (songs/videos) plays:
 *  - dedicated — a COSMOS-controlled Chrome window that autoplays and can
 *    be paused/played/seeked by voice or tools
 *  - default   — your normal default browser (natural look; may not autoplay)
 */
export type MediaPlayerMode = 'dedicated' | 'default'

export interface Settings {
  provider: ProviderId
  /** the active model (for the current provider) */
  model: string
  /** the chosen model per provider — so switching providers restores your
   *  last model for that provider instead of resetting to a default */
  providerModels: Record<ProviderId, string>
  apiKeys: { anthropic: string; openai: string; gemini: string }
  ollamaUrl: string
  /** Ollama context window in tokens — larger = more room for agentic
   *  tool use (needs more VRAM). 8192 is a good default for tool tasks. */
  ollamaNumCtx: number
  theme: ThemeId
  soundEnabled: boolean
  userName: string
  location: { lat: number | null; lon: number | null; label: string }
  voice: VoiceSettings
  mediaPlayer: MediaPlayerMode
  /** tools granted permanent approval ("Always allow") */
  alwaysAllowTools: string[]
}

export type MemoryCategory = 'preference' | 'project' | 'fact' | 'goal'

export interface MemoryItem {
  id: number
  content: string
  category: MemoryCategory
  createdAt: string
  hasEmbedding: boolean
}

export interface AuditEntry {
  id: number
  ts: string
  tool: string
  summary: string
  status: 'ok' | 'error' | 'denied'
}

export interface NotificationPayload {
  title: string
  body: string
  kind: 'info' | 'success' | 'error'
}

export interface NoteMeta {
  id: number
  title: string
  updatedAt: string
}

export interface Note extends NoteMeta {
  content: string
}

/** Declarative plugin format v1 — see docs/PLUGINS.md */
export interface PluginCommand {
  id: string
  title: string
  keywords?: string[]
  /** url: open in browser · app: launch executable · shell: run PowerShell (always confirmed) */
  type: 'url' | 'app' | 'shell'
  target: string
}

export interface PluginManifest {
  name: string
  version: string
  author?: string
  commands: PluginCommand[]
}

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  ollama: 'llama3.2'
}

/**
 * Popular models offered in each provider's picker. The list is a
 * convenience — the field also accepts any custom model id the user
 * types. Ollama is populated live from the local server (installed
 * models), so its curated list is empty.
 */
export const PROVIDER_MODELS: Record<ProviderId, string[]> = {
  anthropic: [
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5',
    'claude-opus-4-7',
    'claude-fable-5'
  ],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o4-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  ollama: []
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  model: DEFAULT_MODELS.anthropic,
  providerModels: { ...DEFAULT_MODELS },
  apiKeys: { anthropic: '', openai: '', gemini: '' },
  ollamaUrl: 'http://localhost:11434',
  ollamaNumCtx: 8192,
  theme: 'cyber-blue',
  soundEnabled: true,
  userName: '',
  location: { lat: null, lon: null, label: '' },
  voice: DEFAULT_VOICE_SETTINGS,
  mediaPlayer: 'dedicated',
  alwaysAllowTools: []
}

export interface TranscriptionResult {
  text: string
}

export interface SynthesisResult {
  /** encoded audio (mp3 or wav) */
  data: ArrayBuffer
  mime: string
}

/** OS-level commands executable from the palette / assistant. */
export type SystemCommandId =
  | 'open-app'
  | 'close-app'
  | 'open-url'
  | 'open-path'
  | 'lock'
  | 'sleep'
  | 'restart'
  | 'shutdown'
  | 'empty-recycle-bin'
  | 'shell-exec'

export interface CommandResult {
  ok: boolean
  message?: string
}

/** An installed application, listed in the App Centre. */
export interface InstalledApp {
  name: string
  /** how it launches: registered app id, protocol URL, or a .lnk shortcut */
  kind: 'appid' | 'url' | 'lnk'
  target: string
  /** PNG data URL extracted from the shortcut, when resolvable */
  icon?: string
}
