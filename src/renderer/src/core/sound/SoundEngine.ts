/**
 * Synthesized UI sound design — no audio assets, everything is generated
 * with WebAudio primitives. All sounds are short, quiet and filtered so
 * they read as "interface", not "music".
 */

export type SoundId = 'boot' | 'hover' | 'activate' | 'success' | 'error' | 'open' | 'close'

class SoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  enabled = true

  private ensure(): { ctx: AudioContext; master: GainNode } | null {
    if (!this.enabled) return null
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.14
      this.master.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return { ctx: this.ctx, master: this.master! }
  }

  play(id: SoundId): void {
    const audio = this.ensure()
    if (!audio) return
    const { ctx, master } = audio
    const t = ctx.currentTime

    switch (id) {
      case 'hover':
        this.blip(ctx, master, t, 2100, 0.03, 0.25)
        break
      case 'activate':
        this.blip(ctx, master, t, 880, 0.08, 0.6)
        this.blip(ctx, master, t + 0.06, 1320, 0.1, 0.5)
        break
      case 'success':
        this.blip(ctx, master, t, 660, 0.09, 0.5)
        this.blip(ctx, master, t + 0.09, 830, 0.09, 0.5)
        this.blip(ctx, master, t + 0.18, 990, 0.14, 0.55)
        break
      case 'error': {
        const osc = ctx.createOscillator()
        const osc2 = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'square'
        osc2.type = 'square'
        osc.frequency.value = 140
        osc2.frequency.value = 147 // detuned pair -> unsettling beat
        gain.gain.setValueAtTime(0.18, t)
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
        osc.connect(gain)
        osc2.connect(gain)
        gain.connect(master)
        osc.start(t)
        osc2.start(t)
        osc.stop(t + 0.35)
        osc2.stop(t + 0.35)
        break
      }
      case 'open':
        this.sweep(ctx, master, t, 300, 1400, 0.22)
        break
      case 'close':
        this.sweep(ctx, master, t, 1400, 300, 0.18)
        break
      case 'boot': {
        // filtered saw swell — the "power on" moment
        const osc = ctx.createOscillator()
        const filter = ctx.createBiquadFilter()
        const gain = ctx.createGain()
        osc.type = 'sawtooth'
        osc.frequency.setValueAtTime(50, t)
        osc.frequency.exponentialRampToValueAtTime(180, t + 2.2)
        filter.type = 'lowpass'
        filter.frequency.setValueAtTime(120, t)
        filter.frequency.exponentialRampToValueAtTime(2400, t + 2.2)
        filter.Q.value = 6
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.exponentialRampToValueAtTime(0.22, t + 1.6)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 3.0)
        osc.connect(filter)
        filter.connect(gain)
        gain.connect(master)
        osc.start(t)
        osc.stop(t + 3.0)
        break
      }
    }
  }

  private blip(
    ctx: AudioContext,
    out: AudioNode,
    t: number,
    freq: number,
    dur: number,
    vol: number
  ): void {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(vol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur)
    osc.connect(gain)
    gain.connect(out)
    osc.start(t)
    osc.stop(t + dur)
  }

  private sweep(
    ctx: AudioContext,
    out: AudioNode,
    t: number,
    from: number,
    to: number,
    dur: number
  ): void {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(from, t)
    osc.frequency.exponentialRampToValueAtTime(to, t + dur)
    gain.gain.setValueAtTime(0.12, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur)
    osc.connect(gain)
    gain.connect(out)
    osc.start(t)
    osc.stop(t + dur)
  }
}

export const sound = new SoundEngine()
