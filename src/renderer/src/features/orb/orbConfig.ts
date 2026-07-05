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

export const ORB_STATES: Record<AssistantState, OrbParams> = {
  idle: {
    amp: 0.08,
    speed: 0.25,
    rim: 1.0,
    pulse: 0,
    particleRadius: 1.0,
    particleSpeed: 1.0,
    ringSpeed: 1.0
  },
  listening: {
    amp: 0.16,
    speed: 0.9,
    rim: 1.6,
    pulse: 0.35,
    particleRadius: 1.15,
    particleSpeed: 2.2,
    ringSpeed: 3.0
  },
  thinking: {
    amp: 0.3,
    speed: 1.6,
    rim: 1.3,
    pulse: 0.15,
    particleRadius: 0.62,
    particleSpeed: 3.4,
    ringSpeed: 5.0
  },
  speaking: {
    amp: 0.2,
    speed: 0.7,
    rim: 1.8,
    pulse: 1.0,
    particleRadius: 1.25,
    particleSpeed: 1.6,
    ringSpeed: 2.0
  }
}

export const LERP_RATE = 2.2 // per-second interpolation toward the target state
