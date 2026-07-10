import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useAssistantStore } from '@/core/stores/useAssistantStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
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

  const theme = useSettingsStore((s) => s.settings.theme)
  const { accent, accentBright } = useMemo(() => {
    const t = THEMES[theme].tokens
    return {
      accent: new THREE.Color(t.accent),
      accentBright: new THREE.Color(t.accentBright)
    }
  }, [theme])

  const coreUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAmp: { value: ORB_STATES.idle.amp },
      uSpeed: { value: ORB_STATES.idle.speed },
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
      uSpeed: { value: 1 },
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
    const target = ORB_STATES[useAssistantStore.getState().state]
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

    // real audio envelope (mic while listening, TTS while speaking)
    const level = voiceSignal.level

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

    if (coreMat.current) {
      const u = coreMat.current.uniforms
      u.uTime.value = t
      // subtle hover: a soft warm glow on the rim only — no turbulence spike
      u.uAmp.value = c.amp * (1 + level * 0.9)
      u.uSpeed.value = c.speed
      u.uPulse.value = c.pulse * 0.35 + level * 1.1
      u.uRim.value = c.rim + level * 0.5 + hv * 0.28
      ;(u.uColor.value as THREE.Color).copy(accent)
      ;(u.uColorBright.value as THREE.Color).copy(accentBright)
    }
    if (nucleusMat.current) {
      const u = nucleusMat.current.uniforms
      u.uTime.value = t
      u.uAmp.value = c.amp
      // the core burns hotter while it speaks/listens, and flares with the voice
      u.uPulse.value = c.pulse + level * 0.7
      u.uGlow.value = 0.7 + level * 0.7 + c.pulse * 0.35 + hv * 0.15
      ;(u.uColor.value as THREE.Color).copy(accent)
      ;(u.uColorBright.value as THREE.Color).copy(accentBright)
    }
    if (nucleusMesh.current) {
      // slow tumble, slightly swelling as it pulses
      nucleusMesh.current.rotation.y = t * 0.18
      nucleusMesh.current.rotation.x = t * 0.1
      nucleusMesh.current.scale.setScalar(1 + c.pulse * 0.06 + level * 0.08)
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
      u.uSpeed.value = c.particleSpeed
      ;(u.uColor.value as THREE.Color).copy(accent)
    }
    if (coreMesh.current) {
      // gentle parallax lean toward the cursor — small and smooth
      coreMesh.current.rotation.y = t * 0.12 + px * 0.12 * hv
      coreMesh.current.rotation.x = -py * 0.12 * hv
      coreMesh.current.scale.setScalar(1 + hv * 0.02)
    }
    if (ringA.current) {
      ringA.current.rotation.z = t * 0.4 * c.ringSpeed
      ringA.current.rotation.x = Math.PI / 2.6 + Math.sin(t * 0.3) * 0.15
    }
    if (ringB.current) {
      ringB.current.rotation.z = -t * 0.28 * c.ringSpeed
      ringB.current.rotation.x = -Math.PI / 3.2 + Math.cos(t * 0.25) * 0.12
    }
  })

  return (
    <>
      {/* glowing plasma nucleus — the hot heart of the core */}
      <mesh ref={nucleusMesh}>
        <sphereGeometry args={[0.55, 48, 48]} />
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
        <icosahedronGeometry args={[1.15, 48]} />
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
      dpr={[1, 2]}
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
