import { voiceSignal, spectralPitch } from './voiceSignal'

export interface SegmentHandlers {
  /** a complete speech segment was captured. `duringSpeech` is true when the
   *  assistant was speaking while it was captured — i.e. it's likely the
   *  assistant's own voice echoing back, not the user. */
  onSegment: (blob: Blob, duringSpeech: boolean) => void
  onError: (err: Error) => void
}

interface SegmenterOptions {
  /** RMS threshold that counts as speech */
  threshold: number
  /** ms of sustained sound before a segment counts as containing speech */
  minSpeechMs: number
  /** ms of silence that ends a segment */
  silenceMs: number
  /** discard-and-restart interval when nothing is being said */
  idleRecycleMs: number
  /** hard cap on a single segment */
  maxSegmentMs: number
}

const PUSH_TO_TALK: SegmenterOptions = {
  threshold: 0.015,
  minSpeechMs: 120,
  silenceMs: 1200,
  idleRecycleMs: 8000,
  maxSegmentMs: 60_000
}

const HANDS_FREE: SegmenterOptions = {
  threshold: 0.022,
  // a snappy "Cosmos" can be well under 220ms of sustained energy — requiring
  // that much made the wake word get dropped as sub-threshold noise, so the
  // first try "didn't respond". 170ms still rejects transient clicks/taps.
  minSpeechMs: 170,
  silenceMs: 950,
  idleRecycleMs: 12_000,
  maxSegmentMs: 30_000
}

/** VAD analysis cadence (ms). A timer, not rAF, so it survives window blur. */
const TICK_MS = 40

/**
 * Continuous microphone capture with energy-based voice activity
 * detection. The recorder runs uninterrupted, so segments always contain
 * the full utterance — including the wake word — with no clipped onset.
 * When silence follows speech, the segment is cut and handed off; silent
 * stretches are discarded and recording restarts to bound memory.
 */
export class MicRecorder {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  private segmentStartedAt = 0
  private speechMs = 0
  private lastLoudAt = 0
  private hadSpeech = false
  private lastFrameAt = 0
  /** did the assistant speak at any point during the current segment? */
  private heardWhileSpeaking = false
  /** assistant speaking-state on the previous frame (edge detection) */
  private lastSpeaking = false

  get active(): boolean {
    return this.running
  }

  /** whether the current segment has already captured qualifying speech — lets
   *  a manual stop decide between submitting the utterance and just turning the
   *  mic off. */
  get hasSpeech(): boolean {
    return this.running && this.hadSpeech
  }

  async start(handsFree: boolean, handlers: SegmentHandlers): Promise<void> {
    if (this.running) return
    const opts = handsFree ? HANDS_FREE : PUSH_TO_TALK

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
    } catch {
      handlers.onError(new Error('Microphone access denied or no microphone found'))
      return
    }

    this.ctx = new AudioContext()
    const source = this.ctx.createMediaStreamSource(this.stream)
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 1024
    source.connect(this.analyser)
    // an AudioContext often starts suspended (auto-start with no user gesture)
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})

    this.running = true
    this.lastFrameAt = 0
    this.beginSegment(handlers)

    const timeData = new Float32Array(this.analyser.fftSize)
    const freqData = new Uint8Array(this.analyser.frequencyBinCount)

    // NB: a setInterval (not requestAnimationFrame) drives VAD — rAF is paused
    // when the window is hidden and throttled when it's unfocused, which is
    // exactly when hands-free must keep listening. We also re-resume the
    // AudioContext each tick: Chromium suspends it when the window is
    // backgrounded, which silently freezes the analyser until a manual restart.
    const tick = (): void => {
      if (!this.running || !this.analyser || !this.ctx) return
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})

      const now = performance.now()
      const dt = this.lastFrameAt ? now - this.lastFrameAt : TICK_MS
      this.lastFrameAt = now

      this.analyser.getFloatTimeDomainData(timeData)
      let sum = 0
      for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i]
      const rms = Math.sqrt(sum / timeData.length)
      voiceSignal.level = Math.min(1, rms * 8)
      // spectral brightness → the orb's pitch reaction (skip on near-silence so
      // it settles instead of chasing room noise)
      if (rms > 0.008 && this.ctx) {
        this.analyser.getByteFrequencyData(freqData)
        voiceSignal.pitch = spectralPitch(freqData, this.ctx.sampleRate, this.analyser.fftSize)
      } else {
        voiceSignal.pitch = 0
      }

      // Flag segments that overlap the assistant's own playback (the store's
      // echo filter decides whether they're echo or the user talking over it).
      // The instant playback ends, cut the current segment: if it heard speech,
      // hand it over — the user may have started their command during the tail —
      // otherwise discard silently and start clean.
      const speakingNow = voiceSignal.speaking
      if (speakingNow) {
        this.heardWhileSpeaking = true
      } else if (this.lastSpeaking) {
        this.lastSpeaking = false
        this.cutSegment(this.hadSpeech, handlers) // → beginSegment (fresh)
        return
      }
      this.lastSpeaking = speakingNow

      const loud = rms > opts.threshold
      if (loud) {
        this.speechMs += dt
        this.lastLoudAt = now
        if (this.speechMs >= opts.minSpeechMs) this.hadSpeech = true
      } else if (!this.hadSpeech) {
        this.speechMs = Math.max(0, this.speechMs - dt * 2)
      }

      const segmentAge = now - this.segmentStartedAt
      const silence = now - this.lastLoudAt

      if (this.hadSpeech && (silence >= opts.silenceMs || segmentAge >= opts.maxSegmentMs)) {
        this.cutSegment(true, handlers)
      } else if (!this.hadSpeech && segmentAge >= opts.idleRecycleMs) {
        this.cutSegment(false, handlers)
      }
    }
    this.timer = setInterval(tick, TICK_MS)
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.lastSpeaking = false
    voiceSignal.level = 0
    voiceSignal.pitch = 0
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null
      this.recorder.stop()
    }
    this.recorder = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.ctx?.close()
    this.ctx = null
    this.analyser = null
    this.lastFrameAt = 0
  }

  /** finish the current segment immediately (manual stop while talking) */
  flush(handlers: SegmentHandlers): void {
    if (this.running && this.hadSpeech) this.cutSegment(true, handlers)
  }

  private beginSegment(handlers: SegmentHandlers): void {
    if (!this.stream) return
    this.chunks = []
    this.hadSpeech = false
    this.speechMs = 0
    this.heardWhileSpeaking = false
    this.segmentStartedAt = performance.now()
    this.lastLoudAt = performance.now()

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    this.recorder = new MediaRecorder(this.stream, { mimeType: mime })
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    this.recorder.onerror = () => handlers.onError(new Error('Recording failed'))
    this.recorder.start()
  }

  private cutSegment(emit: boolean, handlers: SegmentHandlers): void {
    const rec = this.recorder
    if (!rec || rec.state === 'inactive') return
    const duringSpeech = this.heardWhileSpeaking
    rec.onstop = () => {
      if (emit && this.chunks.length > 0) {
        handlers.onSegment(new Blob(this.chunks, { type: rec.mimeType }), duringSpeech)
      }
      // seamlessly roll into the next segment while still running
      if (this.running) this.beginSegment(handlers)
    }
    rec.stop()
  }
}
