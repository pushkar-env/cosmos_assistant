import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useVoiceStore } from '@/features/voice/useVoiceStore'
import { voiceSignal } from '@/core/voice/voiceSignal'
import { THEMES } from '@/core/theme/themes'
import { LERP_RATE, ORB_STATES, type OrbParams } from './orbConfig'
import {
  CORE_FRAGMENT,
  CORE_VERTEX,
  NUCLEUS_FRAGMENT,
  NUCLEUS_VERTEX,
  PARTICLE_FRAGMENT,
  PARTICLE_VERTEX
} from './shaders'

const PARTICLE_COUNT = 2400

/** true while the cursor is over the orb canvas (gates the hover reaction) */
const pointerSignal = { inside: false }

function OrbRig(): React.JSX.Element {
  const coreMat = useRef<THREE.ShaderMaterial>(null)
  const nucleusMat = useRef<THREE.ShaderMaterial>(null)
  const nucleusMesh = useRef<THREE.Mesh>(null)
  const lattice = useRef<THREE.LineSegments>(null)
  const particleMat = useRef<THREE.ShaderMaterial>(null)
  const coreMesh = useRef<THREE.Mesh>(null)
  const ringA = useRef<THREE.Mesh>(null)
  const ringB = useRef<THREE.Mesh>(null)

  // live params lerped toward the current assistant state each frame
  const current = useRef<OrbParams>({ ...ORB_STATES.idle })
  /** 0..1 hover intensity — the orb leans toward and brightens near the cursor */
  const hover = useRef(0)
  /** smoothed voice envelope — quick attack, gentle release, so the orb
   *  breathes with speech instead of jittering frame-to-frame */
  const smoothLevel = useRef(0)
  /** smoothed voice pitch/brightness — drives the hue shimmer + rim, so the
   *  orb shifts colour with pitch, not just size with volume */
  const smoothPitch = useRef(0)
  /** time-integrated animation phases. Accumulating phase at the current speed
   *  (rather than multiplying elapsed time by a changing speed in the shader)
   *  keeps motion continuous when the speed changes — no teleport/jitter. */
  const flowPhase = useRef(0)
  const spinPhase = useRef(0)
  const ringPhase = useRef(0)

  const theme = useSettingsStore((s) => s.settings.theme)
  const { accent, accentBright } = useMemo(() => {
    const t = THEMES[theme].tokens
    return {
      accent: new THREE.Color(t.accent),
      accentBright: new THREE.Color(t.accentBright)
    }
  }, [theme])
  // scratch colour reused each frame for the pitch-driven hue shimmer (no
  // per-frame allocation)
  const voiceColor = useMemo(() => new THREE.Color(), [])

  const coreUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAmp: { value: ORB_STATES.idle.amp },
      uFlow: { value: 0 },
      uPulse: { value: 0 },
      uRim: { value: 1 },
      uColor: { value: new THREE.Color() },
      uColorBright: { value: new THREE.Color() }
    }),
    []
  )

  const nucleusUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAmp: { value: ORB_STATES.idle.amp },
      uPulse: { value: 0 },
      uGlow: { value: 0.8 },
      uColor: { value: new THREE.Color() },
      uColorBright: { value: new THREE.Color() }
    }),
    []
  )

  // a geometric energy lattice suspended between the nucleus and the shell
  const latticeGeometry = useMemo(
    () => new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.82, 1)),
    []
  )

  const particleUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uRadiusScale: { value: 1 },
      uSpin: { value: 0 },
      uSize: { value: 9 },
      uColor: { value: new THREE.Color() }
    }),
    []
  )

  const particleGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const positions = new Float32Array(PARTICLE_COUNT * 3) // computed in shader
    const seeds = new Float32Array(PARTICLE_COUNT)
    const shells = new Float32Array(PARTICLE_COUNT)
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      seeds[i] = Math.random()
      shells[i] = 1.7 + Math.random() * 1.6
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    geo.setAttribute('aShell', new THREE.BufferAttribute(shells, 1))
    // positions are shader-generated; give the GPU an infinite-ish bound
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10)
    return geo
  }, [])

  useFrame((state, delta) => {
    const st = useAssistantStore.getState().state
    const target = ORB_STATES[st]
    const c = current.current
    const k = Math.min(delta * LERP_RATE, 1)

    c.amp += (target.amp - c.amp) * k
    c.speed += (target.speed - c.speed) * k
    c.rim += (target.rim - c.rim) * k
    c.pulse += (target.pulse - c.pulse) * k
    c.particleRadius += (target.particleRadius - c.particleRadius) * k
    c.particleSpeed += (target.particleSpeed - c.particleSpeed) * k
    c.ringSpeed += (target.ringSpeed - c.ringSpeed) * k

    const t = state.clock.elapsedTime

    // real audio envelope (mic while listening, TTS while speaking), smoothed
    // like a VU meter: rises quickly, falls gently — reads as calm breathing
    // rather than a twitchy reaction to every syllable.
    const raw = voiceSignal.level
    const sl = smoothLevel.current
    smoothLevel.current += (raw - sl) * Math.min(delta * (raw > sl ? 11 : 3.5), 1)
    // the voice is the star. Apply the strong listening reaction whenever the
    // mic is actively capturing — that includes HANDS-FREE passive listening,
    // where the assistant state is still 'idle' while it waits for the wake
    // word, so the orb clearly reacts to "Cosmos…". Lift the envelope with a
    // perceptual curve (pow < 1) so even QUIET speech is visible, then a strong
    // gain. Speaking (its own reply) reacts too, a touch softer.
    const micLive = useVoiceStore.getState().micMode !== 'off'
    const activelyListening = st === 'listening' || (micLive && st === 'idle')
    let env = smoothLevel.current
    let voiceGain = 1.0
    if (st === 'speaking') {
      voiceGain = 1.4
    } else if (activelyListening) {
      env = Math.pow(env, 0.5) // quiet speech → much more visible
      voiceGain = 2.15
    }
    const level = Math.min(1.5, env * voiceGain)

    // smoothed pitch (spectral brightness), gated by how live the voice is so it
    // only tints while actually speaking/listening — snappier attack than the
    // volume envelope so pitch changes read instantly.
    const rawPitch = voiceSignal.pitch
    const sp = smoothPitch.current
    smoothPitch.current += (rawPitch - sp) * Math.min(delta * (rawPitch > sp ? 14 : 6), 1)
    const voicePitch = smoothPitch.current * Math.min(1, level * 2.2)

    // Advance the integrated animation phases at the current speeds. Clamp the
    // step so a stalled/backgrounded frame (large delta) can't jump the phase.
    // The particle field quickens a little with the voice (louder + higher →
    // livelier), but because we integrate the RATE the transition is seamless.
    const dt = Math.min(delta, 0.05)
    flowPhase.current += dt * c.speed
    const particleSpeed = c.particleSpeed * (1 + level * 0.28 + voicePitch * 0.18)
    spinPhase.current += dt * particleSpeed
    ringPhase.current += dt * c.ringSpeed

    // pointer proximity to the orb (screen centre) → premium hover reaction
    const px = state.pointer.x
    const py = state.pointer.y
    // only react while the cursor is actually over the canvas (pointer
    // defaults to centre before any move — this avoids a false boost)
    const proximity = pointerSignal.inside
      ? Math.max(0, 1 - Math.hypot(px, py) / 0.6)
      : 0
    // ease in/out gently so the reaction feels calm, not twitchy
    hover.current += (proximity - hover.current) * Math.min(delta * 2, 1)
    const hv = hover.current

    // pitch shimmer: lean the core hue toward the bright accent as the voice
    // rises in pitch, so timbre — not just loudness — moves the orb
    voiceColor.copy(accent).lerp(accentBright, Math.min(0.7, voicePitch * 0.7))

    if (coreMat.current) {
      const u = coreMat.current.uniforms
      u.uTime.value = t
      // the voice drives LIGHT (rim glow) most, plus a lively wave — the orb
      // visibly lights up and ripples to the audio, pitch adding extra rim
      u.uAmp.value = c.amp * (1 + level * 0.6)
      u.uFlow.value = flowPhase.current
      u.uPulse.value = c.pulse * 0.3 + level * 1.05
      u.uRim.value = c.rim + level * 1.1 + voicePitch * 0.5 + hv * 0.28
      ;(u.uColor.value as THREE.Color).copy(voiceColor)
      ;(u.uColorBright.value as THREE.Color).copy(accentBright)
    }
    if (nucleusMat.current) {
      const u = nucleusMat.current.uniforms
      u.uTime.value = t
      u.uAmp.value = c.amp
      // the hot core flares with the voice — the most eye-catching reaction
      u.uPulse.value = c.pulse + level * 0.7
      u.uGlow.value = 0.72 + level * 1.1 + c.pulse * 0.2 + hv * 0.15
      ;(u.uColor.value as THREE.Color).copy(voiceColor)
      ;(u.uColorBright.value as THREE.Color).copy(accentBright)
    }
    if (nucleusMesh.current) {
      // slow tumble; a swell on the voice, kept controlled so it reads premium
      nucleusMesh.current.rotation.y = t * 0.18
      nucleusMesh.current.rotation.x = t * 0.1
      nucleusMesh.current.scale.setScalar(1 + c.pulse * 0.02 + level * 0.08)
    }
    if (lattice.current) {
      // the lattice counter-rotates against the core for a gyroscopic feel
      lattice.current.rotation.y = -t * 0.22 + px * 0.1 * hv
      lattice.current.rotation.x = t * 0.14 - py * 0.1 * hv
      lattice.current.rotation.z = t * 0.06
    }
    if (particleMat.current) {
      const u = particleMat.current.uniforms
      u.uTime.value = t
      u.uRadiusScale.value = c.particleRadius
      // orbital motion comes from the integrated spin phase (see above); size
      // brightens a little with volume for a responsive shimmer
      u.uSpin.value = spinPhase.current
      u.uSize.value = 9 * (1 + level * 0.18)
      ;(u.uColor.value as THREE.Color).copy(voiceColor)
    }
    if (coreMesh.current) {
      // gentle parallax lean toward the cursor — small and smooth
      coreMesh.current.rotation.y = t * 0.12 + px * 0.12 * hv
      coreMesh.current.rotation.x = -py * 0.12 * hv
      coreMesh.current.scale.setScalar(1 + hv * 0.02)
    }
    if (ringA.current) {
      // spin from the integrated ring phase so a state change in ringSpeed
      // eases in instead of jumping (same reason as the particle spin)
      ringA.current.rotation.z = ringPhase.current * 0.4
      ringA.current.rotation.x = Math.PI / 2.6 + Math.sin(t * 0.3) * 0.15
    }
    if (ringB.current) {
      ringB.current.rotation.z = -ringPhase.current * 0.28
      ringB.current.rotation.x = -Math.PI / 3.2 + Math.cos(t * 0.25) * 0.12
    }
  })

  return (
    <>
      {/* glowing plasma nucleus — the hot heart of the core */}
      <mesh ref={nucleusMesh}>
        <sphereGeometry args={[0.55, 32, 32]} />
        <shaderMaterial
          ref={nucleusMat}
          vertexShader={NUCLEUS_VERTEX}
          fragmentShader={NUCLEUS_FRAGMENT}
          uniforms={nucleusUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* geometric energy lattice around the nucleus */}
      <lineSegments ref={lattice} geometry={latticeGeometry}>
        <lineBasicMaterial
          color={accentBright}
          transparent
          opacity={0.32}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>

      {/* the outer holographic membrane */}
      <mesh ref={coreMesh}>
        <icosahedronGeometry args={[1.15, 24]} />
        <shaderMaterial
          ref={coreMat}
          vertexShader={CORE_VERTEX}
          fragmentShader={CORE_FRAGMENT}
          uniforms={coreUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* orbiting particle field */}
      <points geometry={particleGeometry}>
        <shaderMaterial
          ref={particleMat}
          vertexShader={PARTICLE_VERTEX}
          fragmentShader={PARTICLE_FRAGMENT}
          uniforms={particleUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {/* gyroscope rings */}
      <mesh ref={ringA}>
        <torusGeometry args={[1.75, 0.012, 8, 128]} />
        <meshBasicMaterial color={accent} transparent opacity={0.55} />
      </mesh>
      <mesh ref={ringB}>
        <torusGeometry args={[2.05, 0.008, 8, 128]} />
        <meshBasicMaterial color={accentBright} transparent opacity={0.3} />
      </mesh>
    </>
  )
}

/** The AI Core canvas — mounted once, always animating. */
export function OrbScene(): React.JSX.Element {
  return (
    <Canvas
      camera={{ position: [0, 0, 6], fov: 42 }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      style={{ background: 'transparent' }}
      onPointerMove={() => {
        pointerSignal.inside = true
      }}
      onPointerLeave={() => {
        pointerSignal.inside = false
      }}
    >
      <OrbRig />
    </Canvas>
  )
}
