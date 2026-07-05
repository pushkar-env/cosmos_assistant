/**
 * Frame-rate audio telemetry shared between the voice system and the orb.
 * A plain mutable singleton (not a store) so the R3F frame loop can read
 * it at 60–120 FPS without triggering React renders.
 */
export const voiceSignal = {
  /** 0..1 live envelope — mic input while listening, TTS output while speaking */
  level: 0,
  /** true while synthesized speech is audible */
  speaking: false
}
