import { create } from 'zustand'
import { MicRecorder } from '@/core/voice/MicRecorder'
import { SpeechPlayer } from '@/core/voice/SpeechPlayer'
import { subscribeAssistantEvents, useAssistantStore } from '@/core/stores/useAssistantStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useNotificationStore } from '@/core/stores/useNotificationStore'
import { sound } from '@/core/sound/SoundEngine'
import {
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
  /** Ctrl+J / mic button: one listening session, auto-stops on silence */
  togglePushToTalk: () => Promise<void>
  /** always-on "Cosmos …" mode */
  setHandsFree: (on: boolean) => Promise<void>
  /** hard-stop everything voice-related (barge-in) */
  stopSpeech: () => void
  /** speak arbitrary text aloud (welcome greeting, announcements) */
  say: (text: string) => void
}

const recorder = new MicRecorder()
const player = new SpeechPlayer()

/** serial TTS pipeline: sentences in, ordered audio out */
const synthQueue: { text: string; pauseMs: number }[] = []
let synthesizing = false
/**
 * Bumped by clearSpeech (barge-in / Stop). A synthesis that was already in
 * flight when speech was cleared must NOT enqueue its audio afterwards — that
 * would restart the player and flip the assistant back to "speaking" (leaving
 * the Stop button stuck). Each pump iteration captures the epoch and discards
 * its result if the epoch moved on.
 */
let speechEpoch = 0

let lastSynthErrorAt = 0

/**
 * After a bare "Cosmos" (we answer "Yes?"), the actual command is often the
 * NEXT segment because the voice-activity detector cut the pause after the
 * wake word. During this window we accept that next utterance as the command
 * without requiring the wake word again. 0 = no window open.
 */
let followUpUntil = 0
const FOLLOW_UP_MS = 12_000

async function pumpSynthQueue(): Promise<void> {
  if (synthesizing) return
  synthesizing = true
  while (synthQueue.length > 0) {
    const { text, pauseMs } = synthQueue.shift()!
    const epoch = speechEpoch
    try {
      const { data } = await window.cosmos.voice.synthesize(text)
      if (epoch !== speechEpoch) break // cleared mid-synth → drop the stray audio
      player.enqueue(data, pauseMs)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[voice] synthesis failed:', message)
      synthQueue.length = 0
      // don't let TTS fail silently — the user needs to know WHY there's
      // no voice (e.g. a Piper path/exe problem). Throttle so one broken
      // response doesn't spam a toast per sentence.
      const now = Date.now()
      if (now - lastSynthErrorAt > 4000) {
        lastSynthErrorAt = now
        useNotificationStore.getState().push({
          title: 'Voice playback failed',
          body: `${message}. Check Settings → Voice.`,
          kind: 'error'
        })
      }
    }
  }
  synthesizing = false
}

function speak(text: string, boundary: ChunkBoundary = 'sentence'): void {
  const speakable = toSpeakable(text)
  if (!speakable) return
  // pacing is judged on the raw text — markdown structure (headings,
  // paragraph breaks) carries pause cues that toSpeakable strips
  synthQueue.push({ text: speakable, pauseMs: pauseAfterMs(text, boundary) })
  void pumpSynthQueue()
}

let initialized = false

export const useVoiceStore = create<VoiceStore>((set, get) => {
  const chunker = new SentenceChunker(speak)

  const clearSpeech = (): void => {
    speechEpoch++ // invalidate any synthesis currently in flight
    chunker.reset()
    synthQueue.length = 0
    player.stop()
  }

  const handleTranscript = async (blob: Blob): Promise<void> => {
    const mode = get().micMode
    set({ micStatus: mode === 'ptt' ? 'transcribing' : get().micStatus })
    try {
      const { text } = await window.cosmos.voice.transcribe(await blob.arrayBuffer(), blob.type)
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
      const action = resolveHandsFree(text, followUpUntil > Date.now())
      if (action.kind === 'ignore') return // not addressed / echo → keep window as-is
      followUpUntil = 0 // acting on this utterance → close the window
      set({ lastHeard: text, error: null })
      clearSpeech()
      if (action.kind === 'command') {
        await useAssistantStore.getState().send(action.text)
      } else {
        // bare "Cosmos": acknowledge, then listen for the command in the next
        // segment without needing the wake word again
        speak('Yes?')
        followUpUntil = Date.now() + FOLLOW_UP_MS
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
    onSegment: (blob: Blob) => void handleTranscript(blob),
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
      if (initialized) return
      initialized = true

      player.configure({
        onStart: () => useAssistantStore.getState().setState('speaking'),
        onDrained: () => {
          const assistant = useAssistantStore.getState()
          assistant.setState(assistant.activeRequestId ? 'thinking' : 'idle')
        }
      })

      subscribeAssistantEvents((e) => {
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
    },

    togglePushToTalk: async () => {
      const { micMode } = get()
      if (micMode === 'ptt') {
        // second press while talking = "I'm done" — cut the segment now
        recorder.flush(handlers)
        return
      }
      if (micMode === 'handsfree') recorder.stop()

      clearSpeech()
      useAssistantStore.getState().interrupt()
      set({ micMode: 'ptt', micStatus: 'listening', error: null })
      sound.play('activate')
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
