import { voiceSignal } from '@/core/voice/voiceSignal'

/*
 * Audio-driven lip-sync.
 *
 * The TTS stream is analysed live (voiceSignal.level + four formant bands).
 * Openness follows the loudness envelope; the vowel shape follows the band
 * balance, which tracks the first two formants well enough for anime
 * mouth flaps to read as speech:
 *   a — strong 500–1k (high F1)      i — low F1, strong 2–4k (high F2)
 *   u — weak, low-band dominated     e — mid F1 with bright F2
 *   o — low + mid, little treble (rounded, low F2)
 * Weights are softmaxed, scaled by openness and smoothed with a fast attack /
 * slower release so syllables pop open and settle without chattering.
 */

export const VISEMES = ['V_A', 'V_I', 'V_U', 'V_E', 'V_O'] as const
export type Viseme = (typeof VISEMES)[number]

export class LipSync {
  readonly weights: Record<Viseme, number> = { V_A: 0, V_I: 0, V_U: 0, V_E: 0, V_O: 0 }
  private env = 0
  private norm = 0.02
  private wobble = 0
  // synthetic chatter (text-only replies)
  private synPhase = 0
  private synRate = 7
  private synAmp = 0.6
  private synBands = new Float32Array([0.3, 0.4, 0.2, 0.1])

  update(dt: number, active: boolean, synthetic = false): void {
    let raw = active ? voiceSignal.level : 0
    let bands = voiceSignal.bands
    if (synthetic) {
      // ~7 syllables a second with varied vowels and the odd pause
      const before = Math.floor(this.synPhase)
      this.synPhase += dt * this.synRate
      if (Math.floor(this.synPhase) !== before) {
        this.synRate = 5.5 + Math.random() * 3
        this.synAmp = Math.random() < 0.12 ? 0 : 0.35 + Math.random() * 0.45
        for (let i = 0; i < 4; i++) this.synBands[i] = Math.random() * (i === 1 ? 1.4 : 1)
      }
      raw = this.synAmp * Math.pow(Math.max(0, Math.sin((this.synPhase % 1) * Math.PI)), 0.7)
      bands = this.synBands
      active = true
    }
    // envelope with a gentle noise gate
    const target = Math.max(0, raw - 0.03) * 1.35
    const k = target > this.env ? 22 : 9
    this.env += (target - this.env) * Math.min(1, dt * k)
    const open = Math.min(1, Math.pow(this.env, 0.8) * 1.5)

    const b = bands
    const total = b[0] + b[1] + b[2] + b[3]
    // adaptive normalisation so quiet and loud voices both shape well
    this.norm += (Math.max(total, 0.005) - this.norm) * Math.min(1, dt * 0.8)
    const t = Math.max(total, 1e-5)
    const r0 = b[0] / t
    const r1 = b[1] / t
    const r2 = b[2] / t
    const r3 = b[3] / t
    const loud = total / this.norm

    this.wobble += dt * 7.3
    const jitter = 0.08 * Math.sin(this.wobble) * Math.sin(this.wobble * 0.37)

    const score: Record<Viseme, number> = {
      V_A: r1 * 2.2 + r2 * 0.4 - r3 * 0.6 + (loud - 1) * 0.35 + jitter,
      V_I: r3 * 2.4 + r0 * 0.5 - r1 * 1.0,
      V_U: r0 * 1.9 - r2 * 0.6 - r3 * 1.0 - (loud - 1) * 0.4,
      V_E: r2 * 1.5 + r3 * 1.0 - r0 * 0.4 - jitter,
      V_O: (r0 + r1) * 1.25 - r3 * 1.4 - r2 * 0.2
    }
    let sum = 0
    const ex: Record<Viseme, number> = { V_A: 0, V_I: 0, V_U: 0, V_E: 0, V_O: 0 }
    for (const v of VISEMES) {
      ex[v] = Math.exp(score[v] * 3.2)
      sum += ex[v]
    }
    for (const v of VISEMES) {
      const goal = active && open > 0.02 ? (ex[v] / sum) * open : 0
      const w = this.weights[v]
      this.weights[v] = w + (goal - w) * Math.min(1, dt * (goal > w ? 18 : 11))
    }
  }

  /** 0..1 how open the mouth currently is (for the teeth/tongue shader) */
  get openness(): number {
    const w = this.weights
    return Math.min(1, w.V_A + w.V_E * 0.7 + w.V_O * 0.8 + w.V_I * 0.4 + w.V_U * 0.5)
  }
}
