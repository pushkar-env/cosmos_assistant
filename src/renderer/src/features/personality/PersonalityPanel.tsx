import { useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  PERSONA_PRESETS,
  PERSONA_TRAITS,
  localize,
  resolvePreset,
  type PersonaPreset,
  type PersonaTraitId
} from '@shared/personality'
import { useUIStore } from '@/core/stores/useUIStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import { sound } from '@/core/sound/SoundEngine'
import { Glass } from '@/shared/ui/Glass'

/**
 * The Personality studio — a premium picker for COSMOS's persona. Choose a
 * curated character (Assistant, Sweetheart, Bestie, Wit, Overlord…), fine-tune
 * seven trait dials, set what it calls you, and preview the voice live.
 */
export function PersonalityPanel(): React.JSX.Element {
  const open = useUIStore((s) => s.activePanel === 'personality')
  const setPanel = useUIStore((s) => s.setPanel)
  const { settings, update } = useSettingsStore()
  const p = settings.personality
  // the picker previews content in the user's conversation language, so a Hindi
  // user sees Hindi samples and hears the Hindi voice preview
  const lang = settings.voice.language === 'hi' ? 'hi' : 'en'
  const preset = useMemo(() => resolvePreset(p.presetId), [p.presetId])
  const accent = preset.color
  const isCustom = preset.id === 'custom'

  // switching persona replaces the trait dials wholesale; the nickname is an
  // override that resolves to the persona's own term per language, so we leave
  // any custom nickname the user set intact (customPrompt/assistantName too)
  const applyPreset = (next: PersonaPreset): void => {
    sound.play('activate')
    void update({ personality: { ...p, presetId: next.id, traits: { ...next.traits } } })
  }

  const setTrait = (id: PersonaTraitId, value: number): void =>
    void update({ personality: { ...p, traits: { ...p.traits, [id]: value } } })

  // reset dials to the persona's defaults and clear the nickname override so
  // the persona's natural term (per language) takes over again
  const resetTraits = (): void => {
    sound.play('close')
    void update({ personality: { ...p, traits: { ...preset.traits }, nickname: '' } })
  }

  const surprise = (): void => {
    const pool = PERSONA_PRESETS.filter((x) => x.id !== 'custom' && x.id !== p.presetId)
    const pick = pool[Math.floor(Math.random() * pool.length)]
    applyPreset(pick)
  }

  const sampleText =
    isCustom && !p.customPrompt.trim()
      ? localize(
          {
            en: 'Describe who you want me to be below, and I become them.',
            hi: 'नीचे बताओ मुझे कौन बनना है, और मैं वही बन जाऊँगा।'
          },
          lang
        )
      : localize(preset.sample, lang)
  const personaNick = localize(preset.nickname, lang)
  const callsYou = p.nickname.trim() || personaNick || settings.userName.trim() || 'you'

  const preview = (): void => {
    sound.play('success')
    useVoiceStore.getState().say(localize(preset.sample, lang))
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-30 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }}
          onClick={() => setPanel('none')}
        >
          <motion.div
            initial={{ scale: 0.97, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <Glass brackets className="flex h-[640px] w-[780px] max-w-[94vw] flex-col overflow-hidden">
              {/* header */}
              <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
                <div className="flex items-center gap-3">
                  <span
                    className="grid h-9 w-9 place-items-center rounded-lg text-lg"
                    style={{ background: `${accent}22`, boxShadow: `0 0 18px ${accent}44` }}
                  >
                    {preset.emoji}
                  </span>
                  <div>
                    <h2 className="font-display text-sm font-bold uppercase tracking-[0.3em] text-body">
                      Personality
                    </h2>
                    <p className="font-ui text-[11px] text-dim">Shape how COSMOS talks to you</p>
                  </div>
                </div>
                <button
                  onClick={() => setPanel('none')}
                  className="rounded-md px-2 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
                >
                  ESC
                </button>
              </div>

              <div className="smooth-scroll flex-1 overflow-y-auto px-6 py-5">
                {/* persona grid */}
                <SectionLabel>Choose a persona</SectionLabel>
                <div className="grid grid-cols-3 gap-2.5">
                  {PERSONA_PRESETS.map((x) => {
                    const active = x.id === p.presetId
                    return (
                      <button
                        key={x.id}
                        onClick={() => applyPreset(x)}
                        className="group relative flex flex-col gap-1 rounded-xl border p-3 text-left transition-all"
                        style={{
                          borderColor: active ? x.color : 'rgba(255,255,255,0.08)',
                          background: active ? `${x.color}14` : 'rgba(255,255,255,0.02)',
                          boxShadow: active ? `0 0 22px ${x.color}33, inset 0 0 22px ${x.color}11` : 'none'
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-lg leading-none">{x.emoji}</span>
                          <span
                            className="font-ui text-[13px] font-semibold"
                            style={{ color: active ? x.color : 'var(--text)' }}
                          >
                            {x.label}
                          </span>
                        </div>
                        <span className="font-ui text-[10px] leading-tight text-dim">{x.tagline}</span>
                      </button>
                    )
                  })}
                </div>

                {/* live preview */}
                <div
                  className="mt-5 rounded-xl border p-4"
                  style={{ borderColor: `${accent}55`, background: `${accent}0d` }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-ui text-[10px] font-bold uppercase tracking-[0.25em] text-dim">
                      Live preview
                    </span>
                    <button
                      onClick={preview}
                      className="rounded-md border px-2.5 py-1 font-ui text-[10px] font-bold uppercase tracking-widest transition-colors hover:bg-white/5"
                      style={{ borderColor: `${accent}66`, color: accent }}
                    >
                      ▶ Hear it
                    </button>
                  </div>
                  <p className="font-body text-sm leading-relaxed text-body">“{sampleText}”</p>
                  <p className="mt-2 font-ui text-[11px] text-dim">
                    Calls you <span style={{ color: accent }}>{callsYou}</span>
                    {p.assistantName.trim() && (
                      <>
                        {' '}· goes by <span style={{ color: accent }}>{p.assistantName.trim()}</span>
                      </>
                    )}
                  </p>
                </div>

                {/* custom persona editor */}
                {isCustom && (
                  <div className="mt-5">
                    <SectionLabel>Your persona</SectionLabel>
                    <textarea
                      defaultValue={p.customPrompt}
                      key={`custom-${p.presetId}`}
                      onBlur={(e) => void update({ personality: { ...p, customPrompt: e.target.value } })}
                      placeholder="e.g. You are a witty 1920s detective who narrates everything like a noir mystery, but always solves the case…"
                      rows={4}
                      className="w-full resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 font-body text-sm text-body placeholder:text-dim focus:border-[var(--accent)] focus:outline-none"
                    />
                    <p className="mt-1 font-ui text-[10px] text-dim">
                      Describe exactly who COSMOS should be. Tone only — it stays just as capable.
                    </p>
                  </div>
                )}

                {/* identity fields */}
                <div className="mt-5 grid grid-cols-2 gap-4">
                  <div>
                    <SectionLabel>It calls you</SectionLabel>
                    <input
                      key={`nick-${p.presetId}-${lang}`}
                      defaultValue={p.nickname}
                      onBlur={(e) => void update({ personality: { ...p, nickname: e.target.value } })}
                      placeholder={personaNick || settings.userName || (lang === 'hi' ? 'जान, बॉस…' : 'babe, boss, captain…')}
                      className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body placeholder:text-dim focus:border-[var(--accent)] focus:outline-none"
                    />
                  </div>
                  <div>
                    <SectionLabel>It goes by</SectionLabel>
                    <input
                      key={`aname-${p.presetId}`}
                      defaultValue={p.assistantName}
                      onBlur={(e) => void update({ personality: { ...p, assistantName: e.target.value } })}
                      placeholder="COSMOS"
                      className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body placeholder:text-dim focus:border-[var(--accent)] focus:outline-none"
                    />
                  </div>
                </div>

                {/* trait dials */}
                <div className="mt-6 flex items-center justify-between">
                  <SectionLabel>Fine-tune the vibe</SectionLabel>
                  <button
                    onClick={resetTraits}
                    className="font-ui text-[10px] uppercase tracking-widest text-dim transition-colors hover:text-body"
                  >
                    ↺ Reset to {preset.label}
                  </button>
                </div>
                <div className="mt-1 flex flex-col gap-3.5">
                  {PERSONA_TRAITS.map((t) => (
                    <div key={t.id}>
                      <div className="mb-1 flex items-center justify-between font-ui text-[11px]">
                        <span className="font-semibold text-body">{t.label}</span>
                        <span className="text-dim">{t.hint}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="w-16 shrink-0 text-right font-ui text-[10px] text-dim">
                          {t.low}
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={5}
                          value={p.traits[t.id]}
                          onChange={(e) => setTrait(t.id, Number(e.target.value))}
                          className="persona-range h-1.5 flex-1 cursor-pointer appearance-none rounded-full"
                          style={{
                            color: accent,
                            accentColor: accent,
                            background: `linear-gradient(90deg, ${accent} ${p.traits[t.id]}%, rgba(255,255,255,0.12) ${p.traits[t.id]}%)`
                          }}
                        />
                        <span className="w-16 shrink-0 font-ui text-[10px] text-dim">{t.high}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* footer */}
                <div className="mt-6 flex items-center justify-between border-t border-white/5 pt-4">
                  <p className="max-w-[70%] font-ui text-[10px] leading-tight text-dim">
                    Personality changes take effect on your next message. It shapes tone only — COSMOS
                    stays fully capable, accurate, and tool-ready.
                  </p>
                  <button
                    onClick={surprise}
                    className="shrink-0 rounded-lg border border-[var(--accent-dim)] px-3 py-2 font-ui text-[10px] font-bold uppercase tracking-widest text-[var(--accent-bright)] transition-colors hover:bg-white/5"
                  >
                    🎲 Surprise me
                  </button>
                </div>
              </div>
            </Glass>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mb-2 font-ui text-[10px] font-bold uppercase tracking-[0.25em] text-dim">{children}</p>
  )
}
