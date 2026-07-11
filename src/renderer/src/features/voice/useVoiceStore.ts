import { create } from 'zustand'
import { MicRecorder } from '@/core/voice/MicRecorder'
import { SpeechPlayer } from '@/core/voice/SpeechPlayer'
import { subscribeAssistantEvents, useAssistantStore } from '@/core/stores/useAssistantStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useNotificationStore } from '@/core/stores/useNotificationStore'
import { sound } from '@/core/sound/SoundEngine'
import {
  EchoTracker,
  SentenceChunker,
  resolveHandsFree,
  pauseAfterMs,
  toSpeakable,
  type ChunkBoundary
} from './speech'

type MicMode = 'off' | 'ptt' | 'handsfree'
type MicStatus = 'idle' | 'listening' | 'transcribing'

interface VoiceStore {
  micMode: MicMode
  micStatus: MicStatus
  lastHeard: string | null
  error: string | null
  init: () => void
  /** what the composer mic button does: pause/resume hands-free when it's the
   *  active mode, otherwise a push-to-talk session */
  toggleMic: () => Promise<void>
  /** Ctrl+J / mic button: one listening session, auto-stops on silence */
  togglePushToTalk: () => Promise<void>
  /** always-on "Cosmos …" mode */
  setHandsFree: (on: boolean) => Promise<void>
  /** hard-stop everything voice-related (barge-in) */
  stopSpeech: () => void
  /** speak arbitrary text aloud (welcome greeting, announcements) */
  say: (text: string) => void
}

const FOLLOW_UP_MS = 12_000

/**
 * HMR-safe voice pipeline singletons. The assistant-event listener registry
 * lives on globalThis and SURVIVES a hot reload; if the recorder/player and the
 * synth state were plain module-level values, a re-eval of this module would
 * spin up a SECOND SpeechPlayer and subscribe a SECOND assistant listener while
 * the first stayed alive — so every reply got spoken twice, by two overlapping
 * voices. Stashing them on globalThis keeps exactly ONE recorder, ONE player and
 * ONE synth queue for the life of the page, across any number of hot reloads.
 */
interface VoiceGlobals {
  recorder: MicRecorder
  player: SpeechPlayer
  /** serial TTS pipeline: sentences in, ordered audio out */
  synthQueue: { text: string; pauseMs: number }[]
  synthesizing: boolean
  /**
   * Bumped by clearSpeech (barge-in / Stop). A synthesis already in flight when
   * speech was cleared must NOT enqueue its audio afterwards — that would
   * restart the player and flip the assistant back to "speaking" (leaving the
   * Stop button stuck). Each pump iteration captures the epoch and discards its
   * result if the epoch moved on.
   */
  speechEpoch: number
  lastSynthErrorAt: number
  /**
   * After a bare "Cosmos" (we answer "Yes?"), the actual command is often the
   * NEXT segment because the voice-activity detector cut the pause after the
   * wake word. During this window we accept that next utterance as the command
   * without requiring the wake word again. 0 = no window open.
   */
  followUpUntil: number
  /** everything COSMOS says, so mic pickups of its own voice can be recognized */
  echoTracker: EchoTracker
  initialized: boolean
  /** drop the previous assistant-event subscription before re-subscribing */
  offAssistant?: () => void
}

const shared: VoiceGlobals = ((
  globalThis as { __cosmosVoice?: VoiceGlobals }
).__cosmosVoice ??= {
  recorder: new MicRecorder(),
  player: new SpeechPlayer(),
  synthQueue: [],
  synthesizing: false,
  speechEpoch: 0,
  lastSynthErrorAt: 0,
  followUpUntil: 0,
  echoTracker: new EchoTracker(),
  initialized: false
})

const recorder = shared.recorder
const player = shared.player

async function pumpSynthQueue(): Promise<void> {
  if (shared.synthesizing) return
  shared.synthesizing = true
  while (shared.synthQueue.length > 0) {
    const { text, pauseMs } = shared.synthQueue.shift()!
    const epoch = shared.speechEpoch
    try {
      const { data } = await window.cosmos.voice.synthesize(text)
      if (epoch !== shared.speechEpoch) break // cleared mid-synth → drop the stray audio
      player.enqueue(data, pauseMs)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[voice] synthesis failed:', message)
      shared.synthQueue.length = 0
      // don't let TTS fail silently — the user needs to know WHY there's
      // no voice (e.g. a Piper path/exe problem). Throttle so one broken
      // response doesn't spam a toast per sentence.
      const now = Date.now()
      if (now - shared.lastSynthErrorAt > 4000) {
        shared.lastSynthErrorAt = now
        useNotificationStore.getState().push({
          title: 'Voice playback failed',
          body: `${message}. Check Settings → Voice.`,
          kind: 'error'
        })
      }
    }
  }
  shared.synthesizing = false
}

function speak(text: string, boundary: ChunkBoundary = 'sentence'): void {
  const speakable = toSpeakable(text)
  if (!speakable) return
  shared.echoTracker.note(speakable)
  // pacing is judged on the raw text — markdown structure (headings,
  // paragraph breaks) carries pause cues that toSpeakable strips
  shared.synthQueue.push({ text: speakable, pauseMs: pauseAfterMs(text, boundary) })
  void pumpSynthQueue()
}

export const useVoiceStore = create<VoiceStore>((set, get) => {
  const chunker = new SentenceChunker(speak)

  const clearSpeech = (): void => {
    shared.speechEpoch++ // invalidate any synthesis currently in flight
    chunker.reset()
    shared.synthQueue.length = 0
    player.stop()
  }

  const handleTranscript = async (blob: Blob, duringSpeech = false): Promise<void> => {
    const mode = get().micMode
    set({ micStatus: mode === 'ptt' ? 'transcribing' : get().micStatus })
    try {
      const { text } = await window.cosmos.voice.transcribe(await blob.arrayBuffer(), blob.type)
      // Hands-free: a segment that overlapped COSMOS's own speech may just be
      // its TTS echoing back — but it may equally be the USER talking over it
      // (e.g. answering right after "जी?" before playback fully ends). Dropping
      // all of these made hands-free feel randomly deaf, so instead compare the
      // transcript against what was actually spoken and drop only real echoes.
      // Genuine speech passes through → wake-word barge-in works.
      if (mode === 'handsfree' && duringSpeech && shared.echoTracker.isEcho(text)) return
      if (mode === 'ptt') {
        recorder.stop()
        set({ micMode: 'off', micStatus: 'idle' })
        if (text) {
          set({ lastHeard: text, error: null })
          clearSpeech()
          await useAssistantStore.getState().send(text)
        } else {
          set({ error: "I didn't catch that" })
        }
        return
      }
      // hands-free: an utterance must address Cosmos — EXCEPT within the
      // follow-up window right after a bare "Cosmos", where the VAD likely
      // split the command into this next segment.
      const action = resolveHandsFree(text, shared.followUpUntil > Date.now())
      if (action.kind === 'ignore') return // not addressed / echo → keep window as-is
      shared.followUpUntil = 0 // acting on this utterance → close the window
      set({ lastHeard: text, error: null })
      clearSpeech()
      if (action.kind === 'command') {
        await useAssistantStore.getState().send(action.text)
      } else {
        // bare "Cosmos": acknowledge (in the conversation language), then
        // listen for the command in the next segment without the wake word
        const hindi = useSettingsStore.getState().settings.voice.language === 'hi'
        speak(hindi ? 'जी?' : 'Yes?')
        shared.followUpUntil = Date.now() + FOLLOW_UP_MS
      }
    } catch (err) {
      set({
        micStatus: 'idle',
        error: err instanceof Error ? err.message : String(err)
      })
      if (mode === 'ptt') {
        recorder.stop()
        set({ micMode: 'off' })
      }
    }
  }

  const handlers = {
    onSegment: (blob: Blob, duringSpeech: boolean) => void handleTranscript(blob, duringSpeech),
    onError: (err: Error) => {
      recorder.stop()
      set({ micMode: 'off', micStatus: 'idle', error: err.message })
      useAssistantStore.getState().setState('idle')
    }
  }

  return {
    micMode: 'off',
    micStatus: 'idle',
    lastHeard: null,
    error: null,

    init: () => {
      if (shared.initialized) return
      shared.initialized = true

      player.configure({
        onStart: () => useAssistantStore.getState().setState('speaking'),
        onDrained: () => {
          const assistant = useAssistantStore.getState()
          assistant.setState(assistant.activeRequestId ? 'thinking' : 'idle')
        }
      })

      // exactly one assistant-event → speech subscription, ever. Drop a prior
      // one first so a hot reload can never leave two listeners driving TTS.
      shared.offAssistant?.()
      shared.offAssistant = subscribeAssistantEvents((e) => {
        const voiceReplies = useSettingsStore.getState().settings.voice.voiceReplies
        switch (e.type) {
          case 'delta':
            if (voiceReplies) chunker.add(e.text)
            break
          case 'done':
            if (voiceReplies) chunker.flush()
            break
          case 'error':
            clearSpeech()
            break
        }
      })

      // resume hands-free mode if it was on last session
      if (useSettingsStore.getState().settings.voice.handsFree) {
        void get().setHandsFree(true)
      }

      // When the window returns from minimize/hidden, the mic pipeline (its
      // AudioContext + capture) can be left suspended by Chromium and never
      // recover on its own — so hands-free stops hearing "Cosmos…" until a
      // manual mic toggle. Re-arm it automatically the moment we're visible
      // again. (Debounced so rapid visibility churn doesn't thrash the mic.)
      let rearmAt = 0
      const rearmHandsFree = (): void => {
        if (get().micMode !== 'handsfree') return
        const now = Date.now()
        if (now - rearmAt < 1500) return
        rearmAt = now
        recorder.stop()
        set({ micMode: 'handsfree', micStatus: 'listening', error: null })
        void recorder.start(true, handlers).then(() => {
          if (!recorder.active) set({ micMode: 'off', micStatus: 'idle' })
        })
      }
      // main fires this on window restore/show (the reliable signal here —
      // minimize does NOT change Page Visibility with backgroundThrottling off)
      window.cosmos.app.onWindowShown(rearmHandsFree)
      // secondary trigger for hide/occlusion cases that DO change visibility
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') rearmHandsFree()
      })
    },

    toggleMic: async () => {
      // When hands-free is the user's active mode, the composer mic button is a
      // pause/resume for it — it must NOT drop into push-to-talk. Only when
      // hands-free is off does the button act as push-to-talk.
      const handsFreeEnabled = useSettingsStore.getState().settings.voice.handsFree
      if (handsFreeEnabled) {
        if (get().micMode === 'handsfree') {
          sound.play('mic-off')
          recorder.stop()
          clearSpeech()
          set({ micMode: 'off', micStatus: 'idle' })
          useAssistantStore.getState().setState('idle')
        } else {
          // resume hands-free listening (the setting stays on)
          sound.play('mic-on')
          set({ micMode: 'handsfree', micStatus: 'listening', error: null })
          await recorder.start(true, handlers)
          if (!recorder.active) set({ micMode: 'off', micStatus: 'idle' })
        }
        return
      }
      await get().togglePushToTalk()
    },

    togglePushToTalk: async () => {
      const { micMode } = get()
      if (micMode === 'ptt') {
        // second press = toggle the mic OFF. If a spoken segment was already
        // captured, flush it so the utterance is still sent (the transcript
        // handler then stops the mic); if nothing was heard yet, stop the
        // recorder right away so the tap reliably turns the mic off instead
        // of leaving it silently listening.
        sound.play('mic-off')
        if (recorder.hasSpeech) {
          recorder.flush(handlers)
        } else {
          recorder.stop()
          set({ micMode: 'off', micStatus: 'idle' })
          useAssistantStore.getState().setState('idle')
        }
        return
      }
      if (micMode === 'handsfree') recorder.stop()

      clearSpeech()
      useAssistantStore.getState().interrupt()
      set({ micMode: 'ptt', micStatus: 'listening', error: null })
      sound.play('mic-on')
      useAssistantStore.getState().setState('listening')
      await recorder.start(false, handlers)
      if (!recorder.active) {
        set({ micMode: 'off', micStatus: 'idle' })
        useAssistantStore.getState().setState('idle')
      }
    },

    setHandsFree: async (on) => {
      void useSettingsStore.getState().update({
        voice: { ...useSettingsStore.getState().settings.voice, handsFree: on }
      })
      if (on) {
        recorder.stop()
        set({ micMode: 'handsfree', micStatus: 'listening', error: null })
        await recorder.start(true, handlers)
        if (!recorder.active) set({ micMode: 'off', micStatus: 'idle' })
      } else if (get().micMode === 'handsfree') {
        recorder.stop()
        set({ micMode: 'off', micStatus: 'idle' })
      }
    },

    stopSpeech: () => {
      clearSpeech()
      useAssistantStore.getState().interrupt()
    },

    say: (text: string) => {
      // the assistant orb reflects speaking while the greeting plays
      useAssistantStore.getState().setState('speaking')
      speak(text)
    }
  }
})
