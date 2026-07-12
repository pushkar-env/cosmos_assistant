import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import gsap from 'gsap'
import { sound } from '@/core/sound/SoundEngine'
import { useUIStore } from '@/core/stores/useUIStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import { personaGreeting } from '@shared/personality'
import { BootParticles } from './BootParticles'

/** Speak the welcome greeting the moment the COSMOS wordmark reveals. */
function speakWelcome(): void {
  const settings = useSettingsStore.getState().settings
  if (!settings.voice.voiceReplies) return
  const greeting = personaGreeting(settings.personality, {
    name: settings.userName,
    hour: new Date().getHours(),
    lang: settings.voice.language === 'hi' ? 'hi' : 'en'
  })
  useVoiceStore.getState().say(greeting)
}

const BOOT_LINES = [
  'INITIALIZE AI CORE',
  'LOADING NEURAL ENGINE',
  'VOICE SYSTEM ONLINE',
  'MEMORY LOADED',
  'SYSTEM READY'
]

const LINE_INTERVAL_MS = 620
const WORDMARK_AT_MS = BOOT_LINES.length * LINE_INTERVAL_MS + 500
const FINISH_AT_MS = WORDMARK_AT_MS + 2600

const GLYPHS = '!<>-_\\/[]{}—=+*^?#________'

/** GSAP-driven scramble: random glyphs resolve left-to-right into the text. */
function ScrambleLine({ text, onDone }: { text: string; onDone?: () => void }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const proxy = { progress: 0 }
    const tween = gsap.to(proxy, {
      progress: 1,
      duration: 0.5,
      ease: 'power2.out',
      onUpdate: () => {
        const resolved = Math.floor(proxy.progress * text.length)
        let out = text.slice(0, resolved)
        for (let i = resolved; i < text.length; i++) {
          out += text[i] === ' ' ? ' ' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
        }
        el.textContent = out
      },
      onComplete: () => {
        el.textContent = text
        onDone?.()
      }
    })
    return () => {
      tween.kill()
    }
  }, [text, onDone])

  return <span ref={ref} />
}

export function BootSequence(): React.JSX.Element {
  const finishBoot = useUIStore((s) => s.finishBoot)
  const [visibleLines, setVisibleLines] = useState(0)
  const [showWordmark, setShowWordmark] = useState(false)

  useEffect(() => {
    sound.play('boot')
    const timers: ReturnType<typeof setTimeout>[] = []
    BOOT_LINES.forEach((_, i) => {
      timers.push(setTimeout(() => setVisibleLines(i + 1), 400 + i * LINE_INTERVAL_MS))
    })
    timers.push(
      setTimeout(() => {
        setShowWordmark(true)
        sound.play('activate')
        speakWelcome() // greet the moment the big COSMOS text appears
      }, WORDMARK_AT_MS)
    )
    timers.push(setTimeout(finishBoot, FINISH_AT_MS))
    return () => timers.forEach(clearTimeout)
  }, [finishBoot])

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden"
      style={{ background: 'var(--bg)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, filter: 'blur(12px)' }}
      transition={{ duration: 0.8 }}
    >
      <BootParticles />
      <div className="scanline" />

      <div className="relative z-10 flex flex-col items-center gap-10">
        <AnimatePresence mode="wait">
          {!showWordmark ? (
            <motion.div
              key="lines"
              className="flex flex-col gap-3 font-mono text-sm tracking-[0.3em]"
              exit={{ opacity: 0, y: -16, transition: { duration: 0.3 } }}
            >
              {BOOT_LINES.slice(0, visibleLines).map((line, i) => (
                <motion.div
                  key={line}
                  className="flex items-center gap-3"
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.35 }}
                >
                  <span className="neon">▸</span>
                  <span className={i === visibleLines - 1 ? 'text-body' : 'text-dim'}>
                    <ScrambleLine text={line} />
                  </span>
                  {i < visibleLines - 1 && <span className="text-success text-xs">OK</span>}
                </motion.div>
              ))}
            </motion.div>
          ) : (
            <motion.div
              key="wordmark"
              className="flex flex-col items-center gap-4"
              initial={{ opacity: 0, scale: 0.9, filter: 'blur(16px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
              transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
            >
              <h1 className="neon font-display text-7xl font-black tracking-[0.35em]">
                COSMOS
              </h1>
              <motion.div
                className="h-px w-full"
                style={{
                  background:
                    'linear-gradient(90deg, transparent, var(--accent), transparent)'
                }}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ delay: 0.5, duration: 0.8 }}
              />
              <motion.p
                className="font-ui text-sm uppercase tracking-[0.5em] text-dim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.9, duration: 0.6 }}
              >
                At your service
              </motion.p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
