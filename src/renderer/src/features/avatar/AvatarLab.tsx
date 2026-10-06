import { useEffect, useRef, useState } from 'react'
import type { AssistantState, AvatarId, ThemeId } from '@shared/types'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { applyTheme, THEMES } from '@/core/theme/themes'
import { voiceSignal } from '@/core/voice/voiceSignal'
import { AvatarScene, avatarBridge } from './AvatarScene'
import { AVATAR_IDS, AVATARS } from './avatars'
import { readUserMessage, readReplySentence, type Emotion } from './emotion'

/*
 * Dev-only Avatar Lab (src/renderer/avatar-lab.html — not part of the Electron
 * build). Serve src/renderer with plain Vite and open /avatar-lab.html to
 * drive Nova's states, feelings, gestures and a fake voice without the whole
 * assistant running.
 */

const STATES: AssistantState[] = ['idle', 'listening', 'thinking', 'speaking']
const EMOTIONS: Emotion[] = ['neutral', 'happy', 'joy', 'excited', 'relaxed', 'sad', 'surprised', 'angry', 'thinking', 'shy']
const GESTURES = ['Wave', 'Nod', 'Happy', 'Bow', 'Surprised', 'Shy', 'Explain', 'Stretch']

function useFakeVoice(on: boolean): void {
  useEffect(() => {
    if (!on) return
    let raf = 0
    let phase = 0
    let rate = 7
    let amp = 0.6
    let last = performance.now()
    const bands = [0.3, 0.4, 0.2, 0.1]
    voiceSignal.speaking = true
    const tick = (now: number): void => {
      const dt = (now - last) / 1000
      last = now
      const before = Math.floor(phase)
      phase += dt * rate
      if (Math.floor(phase) !== before) {
        rate = 5 + Math.random() * 3.5
        amp = Math.random() < 0.1 ? 0 : 0.3 + Math.random() * 0.5
        const v = Math.floor(Math.random() * 5) // a, i, u, e, o
        const shapes = [
          [0.3, 0.9, 0.35, 0.1],
          [0.5, 0.1, 0.3, 0.8],
          [0.8, 0.15, 0.08, 0.05],
          [0.25, 0.45, 0.6, 0.45],
          [0.6, 0.6, 0.1, 0.03]
        ][v]
        shapes.forEach((x, i) => (bands[i] = x * amp))
      }
      const env = amp * Math.pow(Math.max(0, Math.sin((phase % 1) * Math.PI)), 0.7)
      voiceSignal.level = env
      for (let i = 0; i < 4; i++) voiceSignal.bands[i] = bands[i] * env
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      voiceSignal.speaking = false
      voiceSignal.level = 0
      voiceSignal.bands.fill(0)
    }
  }, [on])
}

export function AvatarLab(): React.JSX.Element {
  const state = useAssistantStore((s) => s.state)
  const theme = useSettingsStore((s) => s.settings.theme)
  const avatarId = useSettingsStore((s) => s.settings.avatarId)
  const [talking, setTalking] = useState(false)
  const [text, setText] = useState('')
  const [failed, setFailed] = useState<string | null>(null)
  const firstSentence = useRef(true)
  useFakeVoice(talking)

  useEffect(() => {
    applyTheme(theme)
    ;(window as unknown as { __nova: typeof avatarBridge }).__nova = avatarBridge
  }, [theme])

  const setState = (s: AssistantState): void => {
    useAssistantStore.setState({ state: s })
    setTalking(s === 'speaking')
  }
  const setTheme = (t: ThemeId): void => {
    const st = useSettingsStore.getState()
    useSettingsStore.setState({ settings: { ...st.settings, theme: t } })
  }
  const setAvatar = (id: AvatarId): void => {
    const st = useSettingsStore.getState()
    useSettingsStore.setState({ settings: { ...st.settings, avatarId: id } })
  }
  const btn = 'rounded-md border border-white/10 px-2.5 py-1 font-ui text-[11px] uppercase tracking-wider hover:border-[var(--accent)] hover:text-[var(--accent-bright)]'
  const on = 'border-[var(--accent)] text-[var(--accent-bright)]'

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: 'var(--bg)' }}>
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 45%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 70%)' }}
      />
      <div className="absolute inset-0">
        {failed ? (
          <div className="grid h-full place-items-center text-red-300">{failed}</div>
        ) : (
          <AvatarScene onFail={(e) => setFailed(String(e))} />
        )}
      </div>
      <div className="absolute left-4 top-4 z-10 flex w-72 flex-col gap-3 rounded-xl border border-white/10 bg-black/50 p-3 text-body backdrop-blur">
        <div className="font-display text-xs font-bold tracking-[0.3em] text-[var(--accent-bright)]">AVATAR LAB</div>
        <Row label="Avatar">
          {AVATAR_IDS.map((id) => (
            <button key={id} className={`${btn} ${avatarId === id ? on : ''}`} onClick={() => setAvatar(id)}>
              {AVATARS[id]?.label}
            </button>
          ))}
        </Row>
        <Row label="State">
          {STATES.map((s) => (
            <button key={s} className={`${btn} ${state === s ? on : ''}`} onClick={() => setState(s)}>
              {s}
            </button>
          ))}
        </Row>
        <Row label="Feel">
          {EMOTIONS.map((e) => (
            <button key={e} className={btn} onClick={() => avatarBridge.ctrl?.feel({ emotion: e, intensity: 1 })}>
              {e}
            </button>
          ))}
        </Row>
        <Row label="Gesture">
          {GESTURES.map((g) => (
            <button key={g} className={btn} onClick={() => avatarBridge.ctrl?.play(g, true)}>
              {g}
            </button>
          ))}
        </Row>
        <Row label="Stage">
          {[
            ['walk ←', ['right']],
            ['walk →', ['left']],
            ['crouch', ['crouch']]
          ].map(([label, bits]) => (
            <button key={label as string} className={btn} onClick={() => avatarBridge.director?.playBits(bits as string[])}>
              {label as string}
            </button>
          ))}
          <button className={btn} onClick={() => avatarBridge.director?.userMessage()}>
            teleport home
          </button>
        </Row>
        <Row label="Voice">
          <button className={`${btn} ${talking ? on : ''}`} onClick={() => setTalking((t) => !t)}>
            {talking ? 'stop fake voice' : 'fake voice'}
          </button>
        </Row>
        <Row label="Theme">
          {(Object.keys(THEMES) as ThemeId[]).map((t) => (
            <button
              key={t}
              title={THEMES[t].label}
              onClick={() => setTheme(t)}
              className="h-5 w-5 rounded-full border-2"
              style={{ background: THEMES[t].tokens.accent, borderColor: theme === t ? 'white' : 'transparent' }}
            />
          ))}
        </Row>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const r = readUserMessage(text)
            avatarBridge.ctrl?.feel(r)
            setText('')
          }}
          className="flex flex-col gap-1"
        >
          <span className="font-ui text-[10px] uppercase tracking-widest text-dim">Say to her / reply line</span>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-sm focus:border-[var(--accent)] focus:outline-none"
            placeholder="hi nova! you're so cute"
          />
          <button
            type="button"
            className={btn}
            onClick={() => {
              avatarBridge.ctrl?.feel(readReplySentence(text, firstSentence.current))
              firstSentence.current = false
            }}
          >
            read as her reply
          </button>
        </form>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-ui text-[10px] uppercase tracking-widest text-dim">{label}</span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  )
}
