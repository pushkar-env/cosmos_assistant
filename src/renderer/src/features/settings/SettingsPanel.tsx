import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  DEFAULT_MODELS,
  type ProviderId,
  type ThemeId,
  type TtsProviderId
} from '@shared/types'
import { THEMES } from '@/core/theme/themes'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import { sound } from '@/core/sound/SoundEngine'
import { Glass } from '@/shared/ui/Glass'

interface SettingRow {
  id: string
  label: string
  keywords: string
  render: () => React.JSX.Element
}

export function SettingsPanel(): React.JSX.Element {
  const activePanel = useUIStore((s) => s.activePanel)
  const setPanel = useUIStore((s) => s.setPanel)
  const { settings, update } = useSettingsStore()
  const [search, setSearch] = useState('')

  const rows = useMemo((): SettingRow[] => {
    const textInput = (
      value: string,
      onChange: (v: string) => void,
      placeholder: string,
      password = false
    ): React.JSX.Element => (
      <input
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
        keywords: 'ai provider model claude gpt gemini ollama llm',
        render: () => (
          <select
            value={settings.provider}
            onChange={(e) => {
              const provider = e.target.value as ProviderId
              void update({ provider, model: DEFAULT_MODELS[provider] })
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
        keywords: 'model name version',
        render: () => textInput(settings.model, (v) => void update({ model: v }), 'model id')
      },
      {
        id: 'key-anthropic',
        label: 'Anthropic API Key',
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
        keywords: 'ollama local url endpoint',
        render: () =>
          textInput(settings.ollamaUrl, (v) => void update({ ollamaUrl: v }), 'http://localhost:11434')
      },
      {
        id: 'theme',
        label: 'Theme',
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
        id: 'name',
        label: 'Your Name',
        keywords: 'name user identity call me',
        render: () =>
          textInput(settings.userName, (v) => void update({ userName: v }), 'How COSMOS addresses you')
      },
      {
        id: 'voice-replies',
        label: 'Voice Replies',
        keywords: 'voice speak tts replies speech talk audio',
        render: () =>
          toggle(settings.voice.voiceReplies, (v) =>
            void update({ voice: { ...settings.voice, voiceReplies: v } })
          )
      },
      {
        id: 'hands-free',
        label: 'Hands-Free ("Cosmos…")',
        keywords: 'voice wake word cosmos hands free always listening mic',
        render: () =>
          toggle(settings.voice.handsFree, (v) => void useVoiceStore.getState().setHandsFree(v))
      },
      {
        id: 'tts-provider',
        label: 'Voice Engine',
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
            <option value="elevenlabs">ElevenLabs — premium (API key)</option>
            <option value="piper">Piper — neural (offline, needs install)</option>
          </select>
        )
      },
      {
        id: 'elevenlabs-key',
        label: 'ElevenLabs API Key',
        keywords: 'elevenlabs api key voice tts secret',
        render: () =>
          textInput(
            settings.voice.elevenLabsKey,
            (v) => void update({ voice: { ...settings.voice, elevenLabsKey: v } }),
            'xi-…',
            true
          )
      },
      {
        id: 'elevenlabs-voice',
        label: 'ElevenLabs Voice ID',
        keywords: 'elevenlabs voice id tts',
        render: () =>
          textInput(
            settings.voice.elevenLabsVoiceId,
            (v) => void update({ voice: { ...settings.voice, elevenLabsVoiceId: v } }),
            'voice id'
          )
      },
      {
        id: 'piper-path',
        label: 'Piper Executable',
        keywords: 'piper exe path offline tts',
        render: () =>
          textInput(
            settings.voice.piperPath,
            (v) => void update({ voice: { ...settings.voice, piperPath: v } }),
            'C:\\tools\\piper\\piper.exe'
          )
      },
      {
        id: 'piper-model',
        label: 'Piper Voice Model',
        keywords: 'piper model onnx voice offline tts',
        render: () =>
          textInput(
            settings.voice.piperModelPath,
            (v) => void update({ voice: { ...settings.voice, piperModelPath: v } }),
            'C:\\tools\\piper\\en_US-….onnx'
          )
      }
    ]
  }, [settings, update])

  const filtered = rows.filter(
    (r) =>
      !search.trim() ||
      `${r.label} ${r.keywords}`.toLowerCase().includes(search.trim().toLowerCase())
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
            <Glass brackets className="flex h-[560px] w-[640px] flex-col overflow-hidden">
              <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
                <h2 className="font-display text-sm font-bold uppercase tracking-[0.3em] text-body">
                  System Settings
                </h2>
                <button
                  onClick={() => setPanel('none')}
                  className="rounded-md px-2 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
                >
                  ESC
                </button>
              </div>
              <div className="border-b border-white/5 px-6 py-3">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search settings…"
                  className="w-full bg-transparent font-ui text-sm text-body placeholder:text-dim focus:outline-none"
                />
              </div>
              <div className="flex-1 overflow-y-auto px-6 py-2">
                {filtered.map((row) => (
                  <div
                    key={row.id}
                    className="flex items-center justify-between border-b border-white/5 py-4 last:border-0"
                  >
                    <span className="font-ui text-sm font-semibold text-body">{row.label}</span>
                    {row.render()}
                  </div>
                ))}
                {filtered.length === 0 && (
                  <p className="py-8 text-center font-ui text-sm text-dim">No settings match</p>
                )}
              </div>
            </Glass>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
