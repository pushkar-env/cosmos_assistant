import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  BUNDLED_VOICES,
  DEFAULT_MODELS,
  ELEVEN_MODELS,
  PROVIDER_MODELS,
  STT_PROVIDERS,
  VOICE_LANGUAGES,
  type ElevenVoice,
  type GithubIdentity,
  type ProviderId,
  type SttProviderId,
  type ThemeId,
  type TtsProviderId,
  type VoiceLanguageId
} from '@shared/types'
import { resolvePreset } from '@shared/personality'
import { THEMES } from '@/core/theme/themes'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useNotificationStore } from '@/core/stores/useNotificationStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import { sound } from '@/core/sound/SoundEngine'
import { Glass } from '@/shared/ui/Glass'

/** the settings categories shown in the sidebar, in display order */
type GroupId = 'intelligence' | 'voice' | 'workspace' | 'personal'

const GROUPS: { id: GroupId; label: string; icon: string; desc: string }[] = [
  {
    id: 'intelligence',
    label: 'Intelligence',
    icon: '◈',
    desc: 'Model provider, API keys & local runtime'
  },
  {
    id: 'voice',
    label: 'Voice & Speech',
    icon: '◉',
    desc: 'How COSMOS listens to and speaks with you'
  },
  {
    id: 'workspace',
    label: 'Workspace',
    icon: '▨',
    desc: 'Agent projects, notes & connected accounts'
  },
  {
    id: 'personal',
    label: 'Personalization',
    icon: '✦',
    desc: 'Your identity, persona & the interface'
  }
]

interface SettingRow {
  id: string
  label: string
  group: GroupId
  keywords: string
  /** optional one-line helper shown under the label */
  hint?: string
  /** hide the row when false (engine-specific rows) */
  when?: boolean
  render: () => React.JSX.Element
}

export function SettingsPanel(): React.JSX.Element {
  const activePanel = useUIStore((s) => s.activePanel)
  const setPanel = useUIStore((s) => s.setPanel)
  const { settings, update } = useSettingsStore()
  const [search, setSearch] = useState('')
  const [activeGroup, setActiveGroup] = useState<GroupId>('intelligence')
  const [availableVoiceIds, setAvailableVoiceIds] = useState<string[]>([])
  const [elevenVoices, setElevenVoices] = useState<ElevenVoice[]>([])
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [customModel, setCustomModel] = useState(false)
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [notesFolder, setNotesFolder] = useState('')
  const [ghIdentity, setGhIdentity] = useState<GithubIdentity | null>(null)
  const [ghToken, setGhToken] = useState('')
  const [ghBusy, setGhBusy] = useState(false)
  const [ghError, setGhError] = useState('')

  useEffect(() => {
    void window.cosmos.voice.listAvailableVoices().then(setAvailableVoiceIds)
  }, [])

  // fetch the ElevenLabs account voices when the panel is open on that engine
  // (and whenever the key changes), so the voice picker lists real voices
  const elevenKey = settings.voice.elevenLabsKey
  const settingsOpenForEleven =
    activePanel === 'settings' && settings.voice.ttsProvider === 'elevenlabs'
  useEffect(() => {
    if (settingsOpenForEleven && elevenKey) {
      void window.cosmos.voice
        .listElevenLabsVoices()
        .then((v) => setElevenVoices((prev) => (v.length ? v : prev)))
    }
  }, [settingsOpenForEleven, elevenKey])

  // auto-detect installed Ollama models — refetched every time the panel
  // opens (and on provider change) so newly-pulled models show up, and a
  // transient empty result (Ollama not warmed up yet at boot) is retried
  // instead of leaving the dropdown stuck on a single model
  const settingsOpen = activePanel === 'settings'
  useEffect(() => {
    if (settingsOpen && settings.provider === 'ollama') {
      void window.cosmos.ai
        .listOllamaModels()
        .then((m) => setOllamaModels((prev) => (m.length ? m : prev)))
    }
  }, [settingsOpen, settings.provider])

  // leave "custom" mode automatically when switching providers
  useEffect(() => {
    setCustomModel(false)
  }, [settings.provider])

  // resolve the effective workspace folder (default is filled in by main)
  useEffect(() => {
    if (settingsOpen) void window.cosmos.workspace.getRoot().then(setWorkspaceRoot)
  }, [settingsOpen, settings.workspaceRoot])

  // reflect the connected GitHub account
  useEffect(() => {
    if (settingsOpen) void window.cosmos.github.identity().then(setGhIdentity)
  }, [settingsOpen])

  const connectGithub = (): void => {
    setGhBusy(true)
    setGhError('')
    void window.cosmos.github
      .connect(ghToken)
      .then((id) => {
        setGhIdentity(id)
        setGhToken('')
      })
      .catch((e: Error) => setGhError(e.message))
      .finally(() => setGhBusy(false))
  }

  const disconnectGithub = (): void => {
    void window.cosmos.github.disconnect().then(() => setGhIdentity(null))
  }

  const changeWorkspace = (): void => {
    void window.cosmos.workspace.pick().then((root) => {
      setWorkspaceRoot(root)
      void update({ workspaceRoot: root })
    })
  }

  // resolve the notes/research .md export folder
  useEffect(() => {
    if (settingsOpen) void window.cosmos.notes.getFolder().then(setNotesFolder)
  }, [settingsOpen, settings.notesFolder])

  const changeNotesFolder = (): void => {
    void window.cosmos.notes.pickFolder().then((dir) => {
      setNotesFolder(dir)
      void update({ notesFolder: dir })
    })
  }

  const setModel = (model: string): void =>
    void update({
      model,
      providerModels: { ...settings.providerModels, [settings.provider]: model }
    })

  // only offer voices whose model actually shipped (all 4 do, but this
  // stays correct if a build omits one); fall back to the full list until
  // the async check returns so the dropdown is never empty
  const voices =
    availableVoiceIds.length > 0
      ? BUNDLED_VOICES.filter((v) => availableVoiceIds.includes(v.id))
      : BUNDLED_VOICES
  const lang = settings.voice.language
  // the Piper voice shown always matches the chosen language
  const currentVoice =
    voices.find((v) => v.id === settings.voice.piperVoiceId && v.language === lang) ??
    voices.find((v) => v.language === lang) ??
    voices[0]

  // selecting a voice also clears any legacy custom path so the id wins
  const selectVoice = (id: string): void =>
    void update({ voice: { ...settings.voice, piperVoiceId: id, piperPath: '', piperModelPath: '' } })

  // unified language: sets STT + reply language, and keeps the Piper voice in-language
  const selectLanguage = (next: VoiceLanguageId): void => {
    const piperVoice = voices.find((v) => v.language === next)?.id ?? settings.voice.piperVoiceId
    void update({
      voice: {
        ...settings.voice,
        language: next,
        piperVoiceId: piperVoice,
        piperPath: '',
        piperModelPath: ''
      }
    })
  }

  const setElevenVoiceId = (id: string): void =>
    void update({ voice: { ...settings.voice, elevenLabsVoiceId: id } })
  const setElevenModel = (m: string): void =>
    void update({ voice: { ...settings.voice, elevenLabsModel: m } })

  const rows = useMemo((): SettingRow[] => {
    const textInput = (
      value: string,
      onChange: (v: string) => void,
      placeholder: string,
      password = false
    ): React.JSX.Element => (
      <input
        // key on the value so a programmatic fill (e.g. Detect) remounts
        // the uncontrolled input and shows the new path
        key={value}
        type={password ? 'password' : 'text'}
        defaultValue={value}
        onBlur={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-body placeholder:text-dim focus:border-[var(--accent)] focus:outline-none"
      />
    )

    const toggle = (value: boolean, onChange: (v: boolean) => void): React.JSX.Element => (
      <button
        onClick={() => onChange(!value)}
        className={`rounded-lg border px-4 py-2 font-ui text-xs font-bold uppercase tracking-widest transition-colors ${
          value
            ? 'border-[var(--accent-dim)] text-[var(--accent-bright)]'
            : 'border-white/10 text-dim'
        }`}
      >
        {value ? 'Enabled' : 'Disabled'}
      </button>
    )

    return [
      {
        id: 'provider',
        label: 'AI Provider',
        group: 'intelligence',
        hint: 'The brain COSMOS thinks with',
        keywords: 'ai provider model claude gpt gemini ollama llm',
        render: () => (
          <select
            value={settings.provider}
            onChange={(e) => {
              const provider = e.target.value as ProviderId
              // restore this provider's last model instead of resetting
              const model = settings.providerModels[provider] ?? DEFAULT_MODELS[provider]
              void update({ provider, model })
            }}
            className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="anthropic">Anthropic — Claude</option>
            <option value="openai">OpenAI — GPT</option>
            <option value="gemini">Google — Gemini</option>
            <option value="ollama">Ollama — Local</option>
          </select>
        )
      },
      {
        id: 'model',
        label: 'Model',
        group: 'intelligence',
        hint: 'Saved separately for each provider',
        keywords: 'model name version claude gpt gemini ollama llm dropdown custom',
        // dropdown of popular models (installed models for Ollama), plus a
        // "custom" escape hatch to type any model id. Saved per provider.
        render: () => {
          const base =
            settings.provider === 'ollama' ? ollamaModels : PROVIDER_MODELS[settings.provider]
          // always include the current model so it shows selected even if custom
          const options = base.includes(settings.model)
            ? base
            : [settings.model, ...base].filter(Boolean)

          if (customModel) {
            return (
              <div className="flex items-center gap-2">
                {textInput(settings.model, setModel, DEFAULT_MODELS[settings.provider])}
                <button
                  onClick={() => setCustomModel(false)}
                  className="shrink-0 rounded-lg border border-white/10 px-3 py-2 font-ui text-[10px] font-bold uppercase tracking-widest text-dim transition-colors hover:border-[var(--accent-dim)] hover:text-body"
                >
                  List
                </button>
              </div>
            )
          }
          return (
            <select
              value={settings.model}
              onChange={(e) => {
                if (e.target.value === '__custom__') setCustomModel(true)
                else setModel(e.target.value)
              }}
              className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body focus:border-[var(--accent)] focus:outline-none"
            >
              {options.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value="__custom__">✎ Custom model…</option>
            </select>
          )
        }
      },
      {
        id: 'key-anthropic',
        label: 'Anthropic API Key',
        group: 'intelligence',
        keywords: 'api key anthropic claude secret',
        render: () =>
          textInput(
            settings.apiKeys.anthropic,
            (v) => void update({ apiKeys: { ...settings.apiKeys, anthropic: v } }),
            'sk-ant-…',
            true
          )
      },
      {
        id: 'key-openai',
        label: 'OpenAI API Key',
        group: 'intelligence',
        keywords: 'api key openai gpt secret',
        render: () =>
          textInput(
            settings.apiKeys.openai,
            (v) => void update({ apiKeys: { ...settings.apiKeys, openai: v } }),
            'sk-…',
            true
          )
      },
      {
        id: 'key-gemini',
        label: 'Gemini API Key',
        group: 'intelligence',
        keywords: 'api key gemini google secret',
        render: () =>
          textInput(
            settings.apiKeys.gemini,
            (v) => void update({ apiKeys: { ...settings.apiKeys, gemini: v } }),
            'AIza…',
            true
          )
      },
      {
        id: 'ollama-url',
        label: 'Ollama URL',
        group: 'intelligence',
        when: settings.provider === 'ollama',
        keywords: 'ollama local url endpoint',
        render: () =>
          textInput(settings.ollamaUrl, (v) => void update({ ollamaUrl: v }), 'http://localhost:11434')
      },
      {
        id: 'ollama-ctx',
        label: 'Ollama Context',
        group: 'intelligence',
        hint: 'Larger contexts need more VRAM',
        when: settings.provider === 'ollama',
        keywords: 'ollama context window num_ctx tokens agentic tools memory size',
        render: () => (
          <select
            value={String(settings.ollamaNumCtx)}
            onChange={(e) => void update({ ollamaNumCtx: Number(e.target.value) })}
            className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="4096">4096 — light (less VRAM)</option>
            <option value="8192">8192 — recommended for tools</option>
            <option value="16384">16384 — long tasks (more VRAM)</option>
            <option value="32768">32768 — max (needs lots of VRAM)</option>
          </select>
        )
      },
      {
        id: 'voice-replies',
        label: 'Voice Replies',
        group: 'voice',
        hint: 'Speak responses aloud',
        keywords: 'voice speak tts replies speech talk audio',
        render: () =>
          toggle(settings.voice.voiceReplies, (v) =>
            void update({ voice: { ...settings.voice, voiceReplies: v } })
          )
      },
      {
        id: 'hands-free',
        label: 'Hands-Free ("Cosmos…")',
        group: 'voice',
        hint: 'Always-on wake word listening',
        keywords: 'voice wake word cosmos hands free always listening mic',
        render: () =>
          toggle(settings.voice.handsFree, (v) => void useVoiceStore.getState().setHandsFree(v))
      },
      {
        id: 'voice-language',
        label: 'Conversation Language',
        group: 'voice',
        hint: 'Sets both speech input and replies',
        keywords: 'voice language english hindi हिंदी conversation speech stt reply unified',
        render: () => (
          <select
            value={lang}
            onChange={(e) => selectLanguage(e.target.value as VoiceLanguageId)}
            className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body focus:border-[var(--accent)] focus:outline-none"
          >
            {VOICE_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        )
      },
      {
        id: 'stt-provider',
        label: 'Speech-to-Text Engine',
        group: 'voice',
        keywords:
          'speech to text stt transcription mic whisper openai groq elevenlabs scribe free source voice input dictation',
        render: () => (
          <select
            value={settings.voice.sttProvider}
            onChange={(e) =>
              void update({
                voice: { ...settings.voice, sttProvider: e.target.value as SttProviderId }
              })
            }
            className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body focus:border-[var(--accent)] focus:outline-none"
          >
            {STT_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )
      },
      {
        id: 'groq-key',
        label: 'Groq API Key',
        group: 'voice',
        keywords: 'groq api key whisper stt speech free source secret',
        when: settings.voice.sttProvider === 'groq',
        render: () => (
          <div className="flex flex-col gap-1.5">
            {textInput(
              settings.voice.groqApiKey,
              (v) => void update({ voice: { ...settings.voice, groqApiKey: v } }),
              'gsk_…',
              true
            )}
            <button
              onClick={() =>
                void window.cosmos.commands.run('open-url', 'https://console.groq.com/keys')
              }
              className="self-start font-ui text-[10px] text-dim underline-offset-2 hover:text-body hover:underline"
            >
              Get a free Groq API key →
            </button>
          </div>
        )
      },
      {
        id: 'tts-provider',
        label: 'Voice Engine',
        group: 'voice',
        keywords: 'voice tts engine elevenlabs piper windows sapi speech synthesis',
        render: () => (
          <select
            value={settings.voice.ttsProvider}
            onChange={(e) =>
              void update({
                voice: { ...settings.voice, ttsProvider: e.target.value as TtsProviderId }
              })
            }
            className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="windows">Windows — built-in (offline)</option>
            <option value="elevenlabs">ElevenLabs — premium multilingual (API key)</option>
            <option value="piper">Piper — neural (offline, bundled)</option>
          </select>
        )
      },
      {
        id: 'elevenlabs-key',
        label: 'ElevenLabs API Key',
        group: 'voice',
        keywords: 'elevenlabs api key voice tts stt scribe speech secret',
        // needed for ElevenLabs TTS and/or ElevenLabs speech-to-text
        when:
          settings.voice.ttsProvider === 'elevenlabs' ||
          settings.voice.sttProvider === 'elevenlabs',
        render: () =>
          textInput(
            settings.voice.elevenLabsKey,
            (v) => void update({ voice: { ...settings.voice, elevenLabsKey: v } }),
            'xi-… or sk-…',
            true
          )
      },
      {
        id: 'elevenlabs-voice',
        label: 'ElevenLabs Voice',
        group: 'voice',
        keywords: 'elevenlabs voice id tts janet multilingual dropdown account',
        when: settings.voice.ttsProvider === 'elevenlabs',
        // a dropdown of the account's voices when we could fetch them; a plain
        // id field otherwise (no/invalid key, offline) so it's never a dead end
        render: () =>
          elevenVoices.length > 0 ? (
            <select
              value={
                elevenVoices.some((v) => v.id === settings.voice.elevenLabsVoiceId)
                  ? settings.voice.elevenLabsVoiceId
                  : ''
              }
              onChange={(e) => setElevenVoiceId(e.target.value)}
              className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body focus:border-[var(--accent)] focus:outline-none"
            >
              {!elevenVoices.some((v) => v.id === settings.voice.elevenLabsVoiceId) && (
                <option value="">Select a voice…</option>
              )}
              {elevenVoices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.accent ? ` · ${v.accent}` : ''}
                </option>
              ))}
            </select>
          ) : (
            textInput(settings.voice.elevenLabsVoiceId, setElevenVoiceId, 'voice id (add key to list)')
          )
      },
      {
        id: 'elevenlabs-model',
        label: 'ElevenLabs Model',
        group: 'voice',
        keywords: 'elevenlabs model turbo flash multilingual v2 quality latency credits',
        when: settings.voice.ttsProvider === 'elevenlabs',
        render: () => (
          <select
            value={settings.voice.elevenLabsModel}
            onChange={(e) => setElevenModel(e.target.value)}
            className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body focus:border-[var(--accent)] focus:outline-none"
          >
            {ELEVEN_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )
      },
      {
        id: 'piper-voice',
        label: 'Piper Voice',
        group: 'voice',
        keywords: 'piper voice select male female hindi english neural offline bundled hfc pratham priyamvada',
        when: settings.voice.ttsProvider === 'piper',
        render: () => (
          <select
            value={currentVoice?.id ?? ''}
            onChange={(e) => selectVoice(e.target.value)}
            className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body focus:border-[var(--accent)] focus:outline-none"
          >
            {voices
              .filter((v) => v.language === lang)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
          </select>
        )
      },
      {
        id: 'workspace',
        label: 'Agent Workspace',
        group: 'workspace',
        hint: 'Where the Studio builds projects',
        keywords: 'workspace project folder studio agent code files directory build',
        render: () => (
          <div className="flex items-center gap-2">
            <span
              className="w-64 truncate rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-body"
              title={workspaceRoot}
            >
              {workspaceRoot || 'Documents\\COSMOS Projects'}
            </span>
            <button
              onClick={changeWorkspace}
              className="shrink-0 rounded-lg border border-white/10 px-3 py-2 font-ui text-[10px] font-bold uppercase tracking-widest text-dim transition-colors hover:border-[var(--accent-dim)] hover:text-body"
            >
              Change
            </button>
            <button
              onClick={() => setPanel('studio')}
              className="shrink-0 rounded-lg border border-[var(--accent-dim)] px-3 py-2 font-ui text-[10px] font-bold uppercase tracking-widest text-[var(--accent-bright)] transition-colors hover:bg-white/5"
            >
              Open Studio
            </button>
          </div>
        )
      },
      {
        id: 'notes-folder',
        label: 'Notes Folder',
        group: 'workspace',
        hint: 'Where research & reports are saved',
        keywords: 'notes folder research reports markdown md save location export documents',
        render: () => (
          <div className="flex items-center gap-2">
            <span
              className="w-64 truncate rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-body"
              title={notesFolder}
            >
              {notesFolder || 'Documents\\COSMOS Notes'}
            </span>
            <button
              onClick={changeNotesFolder}
              className="shrink-0 rounded-lg border border-white/10 px-3 py-2 font-ui text-[10px] font-bold uppercase tracking-widest text-dim transition-colors hover:border-[var(--accent-dim)] hover:text-body"
            >
              Change
            </button>
            <button
              onClick={() => void window.cosmos.notes.revealFolder()}
              className="shrink-0 rounded-lg border border-white/10 px-3 py-2 font-ui text-[10px] font-bold uppercase tracking-widest text-dim transition-colors hover:border-[var(--accent-dim)] hover:text-body"
            >
              Open
            </button>
          </div>
        )
      },
      {
        id: 'agent-autorun',
        label: 'Autonomous Builder',
        group: 'workspace',
        keywords: 'autonomous builder auto run approve agent terminal commands install packages build trust yolo',
        render: () => (
          <div className="flex items-center gap-3">
            {toggle(settings.agentAutoApprove, (v) => void update({ agentAutoApprove: v }))}
            <span className="max-w-[260px] font-ui text-[10px] leading-tight text-dim">
              In Agent/Ultra mode, let COSMOS run its own terminal & file commands (install, build, test) without approving each step. Stop always interrupts.
            </span>
          </div>
        )
      },
      {
        id: 'github',
        label: 'GitHub Account',
        group: 'workspace',
        hint: 'Commit, push & clone from the agent',
        keywords: 'github git connect account commit push pull clone token pat repository version control source',
        render: () =>
          ghIdentity ? (
            <div className="flex items-center gap-3">
              {ghIdentity.avatarUrl && (
                <img
                  src={ghIdentity.avatarUrl}
                  alt=""
                  className="h-8 w-8 rounded-full border border-white/10"
                />
              )}
              <div className="min-w-0">
                <p className="truncate font-ui text-sm text-body">
                  {ghIdentity.name || ghIdentity.login}
                </p>
                <p className="truncate font-mono text-[10px] text-[var(--accent-bright)]">
                  @{ghIdentity.login} · connected
                </p>
              </div>
              <button
                onClick={disconnectGithub}
                className="ml-auto shrink-0 rounded-lg border border-white/10 px-3 py-2 font-ui text-[10px] font-bold uppercase tracking-widest text-dim transition-colors hover:border-red-400/40 hover:text-red-300"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={ghToken}
                  onChange={(e) => setGhToken(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && ghToken.trim() && !ghBusy) connectGithub()
                  }}
                  placeholder="ghp_… Personal Access Token"
                  className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-body placeholder:text-dim focus:border-[var(--accent)] focus:outline-none"
                />
                <button
                  onClick={connectGithub}
                  disabled={ghBusy || !ghToken.trim()}
                  className="shrink-0 rounded-lg border border-[var(--accent-dim)] px-3 py-2 font-ui text-[10px] font-bold uppercase tracking-widest text-[var(--accent-bright)] transition-colors hover:bg-white/5 disabled:opacity-40"
                >
                  {ghBusy ? 'Connecting…' : 'Connect'}
                </button>
              </div>
              {ghError && <p className="font-ui text-[10px] text-red-300">{ghError}</p>}
              <button
                onClick={() =>
                  void window.cosmos.commands.run(
                    'open-url',
                    'https://github.com/settings/tokens/new?scopes=repo&description=COSMOS'
                  )
                }
                className="self-start font-ui text-[10px] text-dim underline-offset-2 hover:text-body hover:underline"
              >
                Create a token (needs the “repo” scope) →
              </button>
            </div>
          )
      },
      {
        id: 'name',
        label: 'Your Name',
        group: 'personal',
        hint: 'How COSMOS addresses you',
        keywords: 'name user identity call me',
        render: () =>
          textInput(settings.userName, (v) => void update({ userName: v }), 'How COSMOS addresses you')
      },
      {
        id: 'personality',
        label: 'Personality',
        group: 'personal',
        hint: 'Persona, tone & trait dials',
        keywords:
          'personality persona character girlfriend boyfriend assistant funny sarcastic sassy flirty bestie mentor zen tone mood vibe style attitude sweetheart roleplay voice',
        render: () => {
          const preset = resolvePreset(settings.personality.presetId)
          return (
            <div className="flex items-center gap-2">
              <span
                className="flex w-40 items-center gap-2 truncate rounded-lg border px-3 py-2 font-ui text-sm text-body"
                style={{ borderColor: `${preset.color}55`, background: `${preset.color}12` }}
              >
                <span>{preset.emoji}</span>
                <span className="truncate">{preset.label}</span>
              </span>
              <button
                onClick={() => setPanel('personality')}
                className="shrink-0 rounded-lg border border-[var(--accent-dim)] px-3 py-2 font-ui text-[10px] font-bold uppercase tracking-widest text-[var(--accent-bright)] transition-colors hover:bg-white/5"
              >
                Customize
              </button>
            </div>
          )
        }
      },
      {
        id: 'theme',
        label: 'Theme',
        group: 'personal',
        hint: 'Accent color across the interface',
        keywords: 'theme appearance color blue red purple emerald white',
        render: () => (
          <div className="flex gap-2">
            {(Object.keys(THEMES) as ThemeId[]).map((id) => (
              <button
                key={id}
                title={THEMES[id].label}
                onClick={() => void update({ theme: id })}
                className="h-8 w-8 rounded-full border-2 transition-transform hover:scale-110"
                style={{
                  background: THEMES[id].tokens.accent,
                  borderColor:
                    settings.theme === id ? 'var(--text)' : 'transparent',
                  boxShadow: settings.theme === id ? `0 0 12px ${THEMES[id].tokens.glow}` : 'none'
                }}
              />
            ))}
          </div>
        )
      },
      {
        id: 'sound',
        label: 'Interface Sounds',
        group: 'personal',
        hint: 'UI clicks, chimes & feedback',
        keywords: 'sound audio mute volume effects',
        render: () => (
          <button
            onClick={() => {
              const next = !settings.soundEnabled
              sound.enabled = next
              void update({ soundEnabled: next })
            }}
            className={`rounded-lg border px-4 py-2 font-ui text-xs font-bold uppercase tracking-widest transition-colors ${
              settings.soundEnabled
                ? 'border-[var(--accent-dim)] text-[var(--accent-bright)]'
                : 'border-white/10 text-dim'
            }`}
          >
            {settings.soundEnabled ? 'Enabled' : 'Muted'}
          </button>
        )
      },
      {
        id: 'media-player',
        label: 'Media Playback',
        group: 'personal',
        hint: 'How music & video open',
        keywords: 'media music video youtube play browser default dedicated autoplay',
        render: () => (
          <select
            value={settings.mediaPlayer}
            onChange={(e) => void update({ mediaPlayer: e.target.value as 'dedicated' | 'default' })}
            className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="dedicated">COSMOS player — autoplays, controllable</option>
            <option value="default">Default browser — natural look</option>
          </select>
        )
      }
    ]
    // ollamaModels + customModel + elevenVoices drive their dropdowns; without
    // them the memo keeps a stale closure and the dropdown never updates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, update, availableVoiceIds, elevenVoices, ollamaModels, customModel, workspaceRoot, notesFolder, ghIdentity, ghToken, ghBusy, ghError])

  const query = search.trim().toLowerCase()
  const searching = query.length > 0

  // rows visible after the engine-specific `when` gate and the text search
  const visibleRows = rows.filter(
    (r) =>
      r.when !== false &&
      (!searching || `${r.label} ${r.keywords}`.toLowerCase().includes(query))
  )

  // when searching we surface every matching group; otherwise just the one
  // the user selected in the sidebar
  const shownGroups = searching
    ? GROUPS.filter((g) => visibleRows.some((r) => r.group === g.id))
    : GROUPS.filter((g) => g.id === activeGroup)

  // a live count per group for the sidebar (respects `when` gating)
  const countFor = (id: GroupId): number => rows.filter((r) => r.group === id && r.when !== false).length

  const renderRow = (row: SettingRow): React.JSX.Element => (
    <div
      key={row.id}
      className="flex items-center justify-between gap-4 border-b border-white/5 px-4 py-3.5 last:border-0"
    >
      <div className="min-w-0">
        <span className="font-ui text-sm font-semibold text-body">{row.label}</span>
        {row.hint && (
          <p className="mt-0.5 font-ui text-[11px] leading-tight text-dim">{row.hint}</p>
        )}
      </div>
      <div className="shrink-0">{row.render()}</div>
    </div>
  )

  return (
    <AnimatePresence>
      {activePanel === 'settings' && (
        <motion.div
          className="fixed inset-0 z-30 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)' }}
          onClick={() => setPanel('none')}
        >
          <motion.div
            initial={{ scale: 0.97, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <Glass brackets className="flex h-[600px] w-[820px] flex-col overflow-hidden">
              {/* header */}
              <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
                <div>
                  <h2 className="font-display text-sm font-bold uppercase tracking-[0.3em] text-body">
                    System Settings
                  </h2>
                  <p className="mt-1 font-ui text-[11px] text-dim">
                    Configure COSMOS — every change saves instantly
                  </p>
                </div>
                <button
                  onClick={() => setPanel('none')}
                  className="rounded-md px-2 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
                >
                  ESC
                </button>
              </div>

              {/* body: sidebar + content */}
              <div className="flex min-h-0 flex-1">
                {/* sidebar nav */}
                <nav className="flex w-56 shrink-0 flex-col gap-1 border-r border-white/5 p-3">
                  {GROUPS.map((g) => {
                    const active = !searching && g.id === activeGroup
                    return (
                      <button
                        key={g.id}
                        onClick={() => {
                          setSearch('')
                          setActiveGroup(g.id)
                        }}
                        className={`group flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                          active
                            ? 'border-[var(--accent-dim)] bg-[var(--accent)]/10'
                            : 'border-transparent hover:bg-white/5'
                        }`}
                      >
                        <span
                          className={`text-base leading-none transition-colors ${
                            active ? 'text-[var(--accent-bright)]' : 'text-dim group-hover:text-body'
                          }`}
                        >
                          {g.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block truncate font-ui text-xs font-bold uppercase tracking-widest ${
                              active ? 'text-[var(--accent-bright)]' : 'text-body'
                            }`}
                          >
                            {g.label}
                          </span>
                        </span>
                        <span className="font-mono text-[10px] text-dim">{countFor(g.id)}</span>
                      </button>
                    )
                  })}

                  <div className="mt-auto px-1 pt-3">
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search settings…"
                      className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-xs text-body placeholder:text-dim focus:border-[var(--accent)] focus:outline-none"
                    />
                  </div>
                </nav>

                {/* content */}
                <div className="smooth-scroll min-w-0 flex-1 overflow-y-auto px-6 py-5">
                  {shownGroups.map((g) => {
                    const groupRows = visibleRows.filter((r) => r.group === g.id)
                    if (groupRows.length === 0) return null
                    return (
                      <section key={g.id} className="mb-6 last:mb-0">
                        <div className="mb-3 flex items-baseline gap-3">
                          <span className="text-base text-[var(--accent-bright)]">{g.icon}</span>
                          <div>
                            <h3 className="font-display text-xs font-bold uppercase tracking-[0.25em] text-body">
                              {g.label}
                            </h3>
                            <p className="mt-0.5 font-ui text-[11px] text-dim">{g.desc}</p>
                          </div>
                        </div>
                        <div className="rounded-2xl border border-white/5 bg-white/[0.02]">
                          {groupRows.map(renderRow)}
                        </div>
                      </section>
                    )
                  })}
                  {visibleRows.length === 0 && (
                    <p className="py-16 text-center font-ui text-sm text-dim">
                      No settings match “{search.trim()}”
                    </p>
                  )}
                </div>
              </div>
            </Glass>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
