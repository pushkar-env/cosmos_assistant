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
  speaking: false
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
