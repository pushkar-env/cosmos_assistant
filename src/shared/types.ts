/** Domain types shared between main, preload and renderer. */

import { DEFAULT_PERSONALITY, type PersonalitySettings } from './personality'

export type { PersonalitySettings } from './personality'

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'ollama'

export type ThemeId = 'cyber-blue' | 'crimson' | 'nebula-purple' | 'emerald' | 'arctic-white'

export type AssistantState = 'idle' | 'listening' | 'thinking' | 'speaking'

/**
 * A file the user attached to a chat message. Images and PDFs travel to
 * vision-capable models as base64 blocks; text documents are extracted to
 * plain text and inlined into the prompt, so every provider can read them.
 */
export interface Attachment {
  id: string
  name: string
  /** MIME type, e.g. image/png, application/pdf, text/markdown */
  mime: string
  /** how the model consumes it */
  kind: 'image' | 'pdf' | 'text'
  /** base64-encoded bytes (no data: prefix) — set for image | pdf */
  data?: string
  /** extracted UTF-8 text — set for text documents */
  text?: string
  /** original size in bytes (for the UI) */
  size: number
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  /** files attached to this message (user messages only) */
  attachments?: Attachment[]
}

/** A saved chat session, shown in the sessions list. */
export interface ConversationMeta {
  id: number
  /** derived from the first user message, or a custom rename */
  title: string
  updatedAt: string
  messageCount: number
}

/**
 * How the assistant approaches a turn:
 *  - chat     — conversational, direct answers (still looks up current facts)
 *  - agent    — task execution: plans, uses tools, delegates to sub-agents
 *  - research — always researches, writes a detailed report, saves it to Notes
 *  - ultra    — auto-decides between chat / agent / research per query
 */
export type AssistantMode = 'chat' | 'agent' | 'research' | 'ultra'

export const ASSISTANT_MODES: { id: AssistantMode; label: string; hint: string }[] = [
  { id: 'chat', label: 'Chat', hint: 'Conversational, quick answers' },
  { id: 'agent', label: 'Agent', hint: 'Plans & executes multi-step tasks with tools' },
  { id: 'research', label: 'Research', hint: 'Deep research → detailed report, saved to Notes' },
  { id: 'ultra', label: 'Ultra', hint: 'Auto-picks chat, agent, or research per query' }
]

export interface ChatRequest {
  requestId: string
  provider: ProviderId
  model: string
  messages: ChatMessage[]
  system?: string
  mode?: AssistantMode
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

/** Speech-to-text engine the mic uses. */
export type SttProviderId = 'openai' | 'groq' | 'elevenlabs'

export const STT_PROVIDERS: { id: SttProviderId; label: string }[] = [
  { id: 'openai', label: 'OpenAI Whisper — accurate (OpenAI key)' },
  { id: 'groq', label: 'Groq Whisper — free & fast (free Groq key)' },
  { id: 'elevenlabs', label: 'ElevenLabs Scribe — multilingual (ElevenLabs key)' }
]

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

/** ElevenLabs TTS models offered in Settings (all multilingual — Hindi + English). */
export const ELEVEN_MODELS: { id: string; label: string }[] = [
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 — best quality (Hindi + English)' },
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5 — fast, multilingual (½ credits)' },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 — fastest, low latency (½ credits)' }
]

export const DEFAULT_ELEVEN_MODEL = 'eleven_turbo_v2_5'

/** A voice fetched from the user's ElevenLabs account. */
export interface ElevenVoice {
  id: string
  name: string
  /** e.g. 'american', 'british', 'indian' when the account tags it */
  accent?: string
  /** ISO language when tagged (multilingual voices handle any language) */
  language?: string
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
  /** which speech-to-text engine transcribes the mic */
  sttProvider: SttProviderId
  /** Groq API key (free Whisper large-v3) — encrypted at rest */
  groqApiKey: string
  /**
   * Unified conversation language — drives speech-to-text transcription, the
   * reply language, and the wake-word acknowledgement. Independent of the TTS
   * engine (ElevenLabs multilingual voices speak both en + hi).
   */
  language: VoiceLanguageId
  ttsProvider: TtsProviderId
  elevenLabsKey: string
  elevenLabsVoiceId: string
  /** ElevenLabs model id (see ELEVEN_MODELS) */
  elevenLabsModel: string
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
  sttProvider: 'openai',
  groqApiKey: '',
  language: 'en',
  ttsProvider: 'windows',
  elevenLabsKey: '',
  elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
  elevenLabsModel: DEFAULT_ELEVEN_MODEL,
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

/** A connected GitHub account. The token is stored encrypted at rest. */
export interface GithubSettings {
  /** Personal Access Token — encrypted on disk (safeStorage) */
  token: string
  /** @handle, shown when connected */
  login: string
  /** display name */
  name: string
  /** commit email — the account's primary email, or a noreply fallback */
  email: string
  /** avatar image URL */
  avatarUrl: string
}

export const DEFAULT_GITHUB_SETTINGS: GithubSettings = {
  token: '',
  login: '',
  name: '',
  email: '',
  avatarUrl: ''
}

/** Public GitHub identity surfaced to the renderer (never includes the token). */
export interface GithubIdentity {
  login: string
  name: string
  avatarUrl: string
}

/** Workspace git status for the Studio source-control indicator. */
export interface GitStatus {
  isRepo: boolean
  branch: string
  /** commits ahead / behind the upstream, when known */
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  /** true when there is nothing to commit */
  clean: boolean
  /** origin remote URL, when set */
  remote?: string
}

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
   *  tool use (needs more VRAM). Acts as a baseline: the Ollama provider
   *  automatically raises it to fit the active tool payload (so tool
   *  definitions never truncate), but a larger value here always wins. */
  ollamaNumCtx: number
  theme: ThemeId
  soundEnabled: boolean
  userName: string
  location: { lat: number | null; lon: number | null; label: string }
  voice: VoiceSettings
  mediaPlayer: MediaPlayerMode
  /** how the assistant approaches each turn (chat/agent/research/ultra) */
  assistantMode: AssistantMode
  /**
   * The agent's project workspace — where files are created/edited when the
   * user doesn't name a folder, and the root shown in the Studio (editor +
   * terminal). Empty → resolved lazily to Documents/COSMOS Projects.
   */
  workspaceRoot: string
  /**
   * Where notes & research reports are also written as .md files on disk.
   * Empty → resolved lazily to Documents/COSMOS Notes.
   */
  notesFolder: string
  /**
   * Autonomous Builder: in Agent/Ultra mode, auto-approve the agent's coding
   * tools (run_command, fs_write, fs_edit, fs_mkdir, fs_move) so it can build a
   * whole project — install packages, scaffold, build, test — without a prompt
   * per step. Off by default; Stop always interrupts. Other sensitive tools
   * (delete, power, close app…) still ask.
   */
  agentAutoApprove: boolean
  /** the connected GitHub account (token encrypted at rest) */
  github: GithubSettings
  /** tools granted permanent approval ("Always allow") */
  alwaysAllowTools: string[]
  /** the assistant's persona — how it talks (preset + trait dials + nickname) */
  personality: PersonalitySettings
}

/** A node in the Studio file tree (dirs listed before files). */
export interface FileNode {
  name: string
  /** path relative to the workspace root, POSIX separators */
  path: string
  kind: 'file' | 'dir'
  /** child nodes for a dir (absent = not yet loaded / a file) */
  children?: FileNode[]
}

/** A single streamed chunk from the integrated terminal. */
export interface TerminalChunk {
  /** which terminal session this chunk belongs to */
  id: string
  data: string
  stream: 'stdout' | 'stderr' | 'system'
}

/** Metadata for one integrated-terminal session. */
export interface TerminalInfo {
  id: string
  /** human label shown on the terminal tab, e.g. "pwsh 1" */
  title: string
  /** current working directory */
  cwd: string
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

// ── secrets vault ────────────────────────────────────────────────

/** The kind of secret stored — drives the badge, icon and colour. */
export type SecretCategory =
  | 'api-key'
  | 'password'
  | 'token'
  | 'ssh-key'
  | 'database'
  | 'card'
  | 'note'
  | 'other'

/** A category descriptor for the picker + badge rendering. */
export interface SecretCategoryDef {
  id: SecretCategory
  label: string
  /** short mono glyph shown on the card badge */
  glyph: string
}

export const SECRET_CATEGORIES: SecretCategoryDef[] = [
  { id: 'api-key', label: 'API Key', glyph: 'API' },
  { id: 'token', label: 'Access Token', glyph: 'TKN' },
  { id: 'password', label: 'Password', glyph: 'PWD' },
  { id: 'ssh-key', label: 'SSH Key', glyph: 'SSH' },
  { id: 'database', label: 'Database URL', glyph: 'DB' },
  { id: 'card', label: 'Card / Payment', glyph: 'CRD' },
  { id: 'note', label: 'Secure Note', glyph: 'NTE' },
  { id: 'other', label: 'Other', glyph: 'SEC' }
]

/**
 * A stored secret as it travels to the renderer for LISTING — note the
 * absence of `value`. The plaintext secret never leaves the main process
 * unless explicitly requested via reveal(), keeping ciphertext off the UI
 * layer until the user asks to see or copy it.
 */
export interface SecretMeta {
  id: number
  label: string
  category: SecretCategory
  /** optional service/provider grouping, e.g. "OpenAI", "AWS" */
  service: string
  /** freeform notes (not the secret) */
  notes: string
  /** masked hint, e.g. "sk-…4f2a" — safe to show without revealing */
  preview: string
  /** whether the stored ciphertext could be decrypted with this profile */
  locked: boolean
  createdAt: string
  updatedAt: string
}

/** The fields the user supplies when creating or editing a secret. */
export interface SecretInput {
  label: string
  value: string
  category: SecretCategory
  service?: string
  notes?: string
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
  assistantMode: 'chat',
  workspaceRoot: '',
  notesFolder: '',
  agentAutoApprove: false,
  github: DEFAULT_GITHUB_SETTINGS,
  alwaysAllowTools: [],
  personality: DEFAULT_PERSONALITY
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

// ── System Cleaner ───────────────────────────────────────────────
// A CCleaner/CleanMaster-grade maintenance surface. Everything here is
// backed by CleanerService (main) and mirrored to the agent as tools, so
// the panel and the assistant drive one safe engine.

/** A category of removable junk located by a cleaner scan (never deleted yet). */
export interface JunkCategory {
  /** stable id used when requesting a clean (e.g. "temp-user") */
  id: string
  label: string
  /** one-line description of what this clears */
  hint: string
  /** reclaimable bytes found in this category */
  bytes: number
  /** number of files/items */
  count: number
  /** ticked by default — every scanned category is a known-safe cache */
  recommended: boolean
}

/** The outcome of a read-only cleaner scan. */
export interface CleanScanResult {
  categories: JunkCategory[]
  totalBytes: number
  /** ISO timestamp the scan completed */
  scannedAt: string
}

/** The outcome of running a clean over selected categories. */
export interface CleanResult {
  freedBytes: number
  items: { id: string; label: string; freedBytes: number }[]
  /** number of Recycle Bin items removed, when the bin was included (else -1) */
  recycleBinItems: number
}

/** A large (and possibly stale) file surfaced for the user's review. */
export interface LargeFile {
  path: string
  name: string
  bytes: number
  /** last-modified ISO */
  modified: string
  /** last-accessed ISO */
  accessed: string
  /** lowercase extension without the dot, e.g. "mp4" */
  ext: string
  /** whole days since the file was last accessed */
  idleDays: number
}

/** Per-drive disk usage, for the cleaner's capacity gauges. */
export interface DriveUsage {
  /** e.g. "C:" */
  drive: string
  label: string
  freeBytes: number
  totalBytes: number
}

/** An installed program read from the Windows uninstall registry. */
export interface InstalledProgram {
  /** stable key (the registry sub-key name) used to target an uninstall */
  id: string
  name: string
  publisher: string
  version: string
  /** estimated install size in bytes (0 when Windows doesn't record it) */
  bytes: number
  /** ISO install date, when known */
  installedOn: string
  /** whether a usable uninstall command exists */
  uninstallable: boolean
}

/** Result of a destructive cleaner action (uninstall / delete). */
export interface CleanerActionResult {
  ok: boolean
  message: string
}
