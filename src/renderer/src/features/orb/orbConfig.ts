import type { AssistantState } from '@shared/types'

/** Per-state targets for the orb's shader uniforms and particle field. */
export interface OrbParams {
  /** vertex noise displacement amplitude */
  amp: number
  /** noise scroll speed */
  speed: number
  /** fresnel rim intensity */
  rim: number
  /** 0..1 — drives the "voice" pulse LFO in the shader */
  pulse: number
  /** particle shell radius multiplier (thinking contracts the cloud) */
  particleRadius: number
  /** particle orbital speed multiplier */
  particleSpeed: number
  /** gyro ring rotation speed */
  ringSpeed: number
}

/*
 * These state baselines are deliberately CALM and cohesive — the dynamic
 * "life" comes from the live voice envelope (see OrbScene), not from the state
 * itself. Keeping particleSpeed / ringSpeed / amp in a tight range avoids the
 * dramatic wave/rotation/particle bursts on "executing" (thinking) and on the
 * transition back when a reply finishes.
 */
export const ORB_STATES: Record<AssistantState, OrbParams> = {
  idle: {
    amp: 0.08,
    speed: 0.3,
    rim: 1.0,
    pulse: 0,
    particleRadius: 1.0,
    particleSpeed: 0.9,
    ringSpeed: 0.8
  },
  listening: {
    // gently alive — the strong voice reaction adds the real life on top
    amp: 0.13,
    speed: 0.7,
    rim: 1.45,
    pulse: 0.28,
    particleRadius: 1.06,
    particleSpeed: 1.35,
    ringSpeed: 1.25
  },
  thinking: {
    // Processing state. Reads as quietly focused, not a frantic burst — a
    // gentle inward draw with a bright rim. Deliberately close to idle so the
    // long stretch while a (slow, local) model generates, and the settle back
    // when it finishes, both feel smooth and premium rather than wild.
    amp: 0.11,
    speed: 0.72,
    rim: 1.35,
    pulse: 0.14,
    particleRadius: 0.93,
    particleSpeed: 1.18,
    ringSpeed: 1.22
  },
  speaking: {
    // composed with a bright rim; the voice reaction supplies the movement
    amp: 0.12,
    speed: 0.6,
    rim: 1.65,
    pulse: 0.3,
    particleRadius: 1.1,
    particleSpeed: 1.2,
    ringSpeed: 1.15
  }
}

// per-second interpolation toward the target state. A touch quicker than a
// plain crossfade so the orb settles cleanly the moment a reply finishes
// (no lingering high-energy state), while still easing rather than snapping.
export const LERP_RATE = 2.5

/*
 * Render rate for the core. On a 144/240Hz display an uncapped rAF loop draws
 * the orb two to four times more often than 60Hz for no visible gain — nothing
 * in the scene moves fast enough to resolve it, and the fbm shaders are not
 * cheap. Every phase in the rig is integrated against the real frame delta, so
 * pacing the loop changes the cost and nothing else: same motion, same speed.
 * On a 60Hz display this is a no-op. The rest of the UI still composites at the
 * panel's native refresh rate — this bounds the WebGL scene only.
 */
export const ORB_FPS = 60
