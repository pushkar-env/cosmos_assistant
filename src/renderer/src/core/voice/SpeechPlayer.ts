import { voiceSignal } from './voiceSignal'

interface PlayerEvents {
  onStart: () => void
  onDrained: () => void
}

/**
 * Sequential playback queue for synthesized speech. Buffers are decoded
 * with WebAudio and routed through an AnalyserNode so the orb's speaking
 * animation follows the real audio envelope. `stop()` is instant —
 * barge-in interruption depends on it.
 */
export class SpeechPlayer {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private queue: ArrayBuffer[] = []
  private current: AudioBufferSourceNode | null = null
  private playing = false
  private raf = 0
  private events: PlayerEvents | null = null

  get active(): boolean {
    return this.playing || this.queue.length > 0
  }

  configure(events: PlayerEvents): void {
    this.events = events
  }

  enqueue(data: ArrayBuffer): void {
    if (data.byteLength === 0) return
    this.queue.push(data)
    if (!this.playing) void this.playNext()
  }

  stop(): void {
    this.queue = []
    if (this.current) {
      this.current.onended = null
      try {
        this.current.stop()
      } catch {
        /* already stopped */
      }
      this.current = null
    }
    this.endPlayback()
  }

  private async playNext(): Promise<void> {
    const data = this.queue.shift()
    if (!data) {
      this.endPlayback()
      this.events?.onDrained()
      return
    }

    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 512
      this.analyser.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume()

    let buffer: AudioBuffer
    try {
      buffer = await this.ctx.decodeAudioData(data.slice(0))
    } catch {
      // skip undecodable chunk, keep the queue moving
      void this.playNext()
      return
    }

    if (!this.playing) {
      this.playing = true
      voiceSignal.speaking = true
      this.events?.onStart()
      this.watchLevel()
    }

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.analyser!)
    source.onended = () => {
      this.current = null
      void this.playNext()
    }
    this.current = source
    source.start()
  }

  private watchLevel(): void {
    const data = new Float32Array(this.analyser!.fftSize)
    const tick = (): void => {
      if (!this.playing || !this.analyser) return
      this.analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      voiceSignal.level = Math.min(1, Math.sqrt(sum / data.length) * 5)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  private endPlayback(): void {
    this.playing = false
    voiceSignal.speaking = false
    voiceSignal.level = 0
    cancelAnimationFrame(this.raf)
  }
}
