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
    // focused, not frantic — was the source of the extreme waves/rotations
    amp: 0.16,
    speed: 1.05,
    rim: 1.25,
    pulse: 0.1,
    particleRadius: 0.86,
    particleSpeed: 1.85,
    ringSpeed: 1.9
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

export const LERP_RATE = 2.0 // per-second interpolation toward the target state
