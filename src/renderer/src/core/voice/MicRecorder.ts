import { voiceSignal } from './voiceSignal'

export interface SegmentHandlers {
  /** a complete speech segment was captured */
  onSegment: (blob: Blob) => void
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
  minSpeechMs: 220,
  silenceMs: 950,
  idleRecycleMs: 12_000,
  maxSegmentMs: 30_000
}

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
  private raf = 0
  private running = false

  private segmentStartedAt = 0
  private speechMs = 0
  private lastLoudAt = 0
  private hadSpeech = false
  private lastFrameAt = 0

  get active(): boolean {
    return this.running
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

    this.running = true
    this.beginSegment(handlers)

    const timeData = new Float32Array(this.analyser.fftSize)

    const frame = (now: number): void => {
      if (!this.running || !this.analyser) return
      const dt = this.lastFrameAt ? now - this.lastFrameAt : 16
      this.lastFrameAt = now

      this.analyser.getFloatTimeDomainData(timeData)
      let sum = 0
      for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i]
      const rms = Math.sqrt(sum / timeData.length)
      voiceSignal.level = Math.min(1, rms * 8)

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

      this.raf = requestAnimationFrame(frame)
    }
    this.raf = requestAnimationFrame(frame)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
    voiceSignal.level = 0
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
    rec.onstop = () => {
      if (emit && this.chunks.length > 0) {
        handlers.onSegment(new Blob(this.chunks, { type: rec.mimeType }))
      }
      // seamlessly roll into the next segment while still running
      if (this.running) this.beginSegment(handlers)
    }
    rec.stop()
  }
}
