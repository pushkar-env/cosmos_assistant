/**
 * Synthesized UI sound design — no audio assets, everything is generated
 * with WebAudio primitives. All sounds are short, quiet and filtered so
 * they read as "interface", not "music".
 */

export type SoundId =
  | 'boot'
  | 'hover'
  | 'activate'
  | 'success'
  | 'error'
  | 'open'
  | 'close'
  | 'mic-on'
  | 'mic-off'
  // the avatar's hands on the glass
  | 'grab'
  | 'release'
  | 'tap'
  | 'snap'
  | 'whoosh'
  | 'teleport'

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
      // mic engaged: a bright two-note rise
      case 'mic-on':
        this.blip(ctx, master, t, 620, 0.07, 0.5)
        this.blip(ctx, master, t + 0.05, 940, 0.11, 0.55)
        break
      // mic disengaged: the same interval, falling
      case 'mic-off':
        this.blip(ctx, master, t, 700, 0.07, 0.45)
        this.blip(ctx, master, t + 0.05, 460, 0.12, 0.4)
        break
      // she takes hold of a card: a soft low catch with a glint on top
      case 'grab':
        this.blip(ctx, master, t, 330, 0.09, 0.45)
        this.blip(ctx, master, t + 0.02, 990, 0.07, 0.18)
        break
      // …and lets it go
      case 'release':
        this.blip(ctx, master, t, 760, 0.06, 0.22)
        this.blip(ctx, master, t + 0.05, 520, 0.09, 0.2)
        break
      // a fingertip on the glass
      case 'tap':
        this.blip(ctx, master, t, 1850, 0.035, 0.35)
        this.blip(ctx, master, t + 0.004, 2780, 0.03, 0.18)
        break
      // a finger snap: a crack of filtered noise and a click
      case 'snap':
        this.noise(ctx, master, t, 0.06, 2600, 0.9)
        this.blip(ctx, master, t, 2200, 0.025, 0.3)
        break
      // a card tossed / flicked
      case 'whoosh':
        this.noise(ctx, master, t, 0.28, 900, 0.35, 3200)
        break
      // she dissolves and re-forms: a shimmering fall and rise
      case 'teleport': {
        for (const [f0, f1, f2, d] of [
          [1400, 380, 1500, 0.95],
          [1407, 384, 1512, 0.95]
        ]) {
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.type = 'sine'
          osc.frequency.setValueAtTime(f0, t)
          osc.frequency.exponentialRampToValueAtTime(f1, t + d * 0.42)
          osc.frequency.exponentialRampToValueAtTime(f2, t + d)
          gain.gain.setValueAtTime(0.0001, t)
          gain.gain.exponentialRampToValueAtTime(0.16, t + 0.04)
          gain.gain.exponentialRampToValueAtTime(0.03, t + d * 0.45)
          gain.gain.exponentialRampToValueAtTime(0.12, t + d * 0.7)
          gain.gain.exponentialRampToValueAtTime(0.0001, t + d)
          osc.connect(gain)
          gain.connect(master)
          osc.start(t)
          osc.stop(t + d)
        }
        this.noise(ctx, master, t, 0.5, 4000, 0.18, 1200)
        break
      }
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

  private noiseBuf: AudioBuffer | null = null

  /** a burst of band-passed noise, its centre gliding from `freq` to `to` */
  private noise(
    ctx: AudioContext,
    out: AudioNode,
    t: number,
    dur: number,
    freq: number,
    vol: number,
    to = freq
  ): void {
    if (!this.noiseBuf) {
      const n = Math.floor(ctx.sampleRate * 0.6)
      this.noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate)
      const data = this.noiseBuf.getChannelData(0)
      for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1
    }
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuf
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.Q.value = 1.4
    filter.frequency.setValueAtTime(freq, t)
    if (to !== freq) filter.frequency.exponentialRampToValueAtTime(to, t + dur)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(vol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur)
    src.connect(filter)
    filter.connect(gain)
    gain.connect(out)
    src.start(t)
    src.stop(t + dur)
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
