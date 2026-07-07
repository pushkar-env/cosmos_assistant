import { create } from 'zustand'
import { MicRecorder } from '@/core/voice/MicRecorder'
import { SpeechPlayer } from '@/core/voice/SpeechPlayer'
import { subscribeAssistantEvents, useAssistantStore } from '@/core/stores/useAssistantStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useNotificationStore } from '@/core/stores/useNotificationStore'
import { sound } from '@/core/sound/SoundEngine'
import {
  SentenceChunker,
  extractWakeCommand,
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

let lastSynthErrorAt = 0

async function pumpSynthQueue(): Promise<void> {
  if (synthesizing) return
  synthesizing = true
  while (synthQueue.length > 0) {
    const { text, pauseMs } = synthQueue.shift()!
    try {
      const { data } = await window.cosmos.voice.synthesize(text)
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
      // hands-free: only utterances addressed to Cosmos are executed
      const command = extractWakeCommand(text)
      if (command === null) return
      set({ lastHeard: text, error: null })
      clearSpeech()
      if (command) {
        await useAssistantStore.getState().send(command)
      } else {
        speak('Yes?') // bare "Cosmos" — acknowledge and keep listening
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
