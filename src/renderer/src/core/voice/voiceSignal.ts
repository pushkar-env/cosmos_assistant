/**
 * Frame-rate audio telemetry shared between the voice system and the orb.
 * A plain mutable singleton (not a store) so the R3F frame loop can read
 * it at 60–120 FPS without triggering React renders.
 */
export const voiceSignal = {
  /** 0..1 live envelope — mic input while listening, TTS output while speaking */
  level: 0,
  /** 0..1 spectral brightness of the current voice — a proxy for pitch:
   *  low/chesty speech sits low, bright/high speech rides high. Lets the orb
   *  shift colour/shimmer with pitch, not just swell with volume. */
  pitch: 0,
  /** true while synthesized speech is audible */
  speaking: false,
  /** TTS energy in four speech bands (~150–500 Hz, 500–1k, 1–2k, 2–4k), each
   *  0..1. The avatar reads the balance between them as a vowel estimate for
   *  lip-sync (open "a" lifts the second band, "i"/"e" the top ones…). */
  bands: new Float32Array(4)
}

/** band edges in Hz for voiceSignal.bands */
const BAND_EDGES = [150, 500, 1000, 2000, 4000]

/** Fill ``out`` with the mean (roughly linear) energy of each speech band. */
export function speechBands(freq: Uint8Array, sampleRate: number, fftSize: number, out: Float32Array): void {
  const hz = sampleRate / fftSize
  for (let b = 0; b < 4; b++) {
    const lo = Math.max(1, Math.floor(BAND_EDGES[b] / hz))
    const hi = Math.min(freq.length - 1, Math.ceil(BAND_EDGES[b + 1] / hz))
    let sum = 0
    for (let i = lo; i <= hi; i++) {
      // byte spectrum is dB-scaled; lift it back toward linear energy
      const m = freq[i] / 255
      sum += m * m * m
    }
    out[b] = sum / Math.max(1, hi - lo + 1)
  }
}

/**
 * Energy-weighted spectral centroid of an FFT magnitude spectrum, mapped to a
 * perceptual 0..1 "pitch/brightness" for the orb. Finds the centre frequency of
 * the voice's energy, then maps the speech-relevant band (~150 Hz → 2 kHz) onto
 * 0..1. Returns 0 on silence so the orb doesn't drift on noise.
 */
export function spectralPitch(freq: Uint8Array, sampleRate: number, fftSize: number): number {
  let num = 0
  let den = 0
  for (let i = 1; i < freq.length; i++) {
    const m = freq[i]
    num += i * m
    den += m
  }
  if (den < 1) return 0
  const centroidHz = (num / den) * (sampleRate / fftSize)
  return Math.min(1, Math.max(0, (centroidHz - 150) / (2000 - 150)))
}
