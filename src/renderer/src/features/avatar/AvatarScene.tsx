import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { subscribeAssistantEvents, useAssistantStore } from '@/core/stores/useAssistantStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { voiceSignal } from '@/core/voice/voiceSignal'
import { THEMES } from '@/core/theme/themes'
import { FrameDriver } from '@/shared/three/FrameDriver'
import { loadNova, prepareNova, type NovaRig } from './avatarAsset'
import { AvatarController } from './AvatarController'
import { readReplySentence, readUserMessage, SentenceSplitter } from './emotion'
import { shared } from './toonMaterials'

/** the avatar is cheap, but there is no reason to draw it faster than this */
const AVATAR_FPS = 60

/**
 * Mutable bridge between DOM events and the frame loop (no React renders on
 * the hot path). Exported so the dev Avatar Lab can poke the controller.
 */
export const avatarBridge = {
  ctrl: null as AvatarController | null,
  pointer: new THREE.Vector2(),
  inside: false,
  click: null as THREE.Vector2 | null,
  /** render one frame at the given time (seconds) — dev/testing aid */
  advance: null as ((t: number) => void) | null,
  /** smoothed CPU cost of the avatar's per-frame update, in ms */
  updateMs: 0
}

if (import.meta.env.DEV) (window as unknown as { __nova: typeof avatarBridge }).__nova = avatarBridge

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()

function NovaModel({ onFail }: { onFail: (err: unknown) => void }): React.JSX.Element | null {
  const [rig, setRig] = useState<NovaRig | null>(null)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)

  useEffect(() => {
    let alive = true
    let prepared: NovaRig | null = null
    loadNova()
      .then((gltf) => {
        if (!alive) return
        prepared = prepareNova(gltf)
        setRig(prepared)
      })
      .catch((err) => {
        console.error('[avatar] failed to load Nova:', err)
        if (alive) onFail(err)
      })
    return () => {
      alive = false
      prepared?.dispose()
    }
  }, [onFail])

  const ctrl = useMemo(() => (rig ? new AvatarController(rig) : null), [rig])

  useEffect(() => {
    if (!ctrl) return
    avatarBridge.ctrl = ctrl
    // say hello once she has materialised
    const hi = setTimeout(() => ctrl.feel({ emotion: 'happy', intensity: 0.9, gesture: 'Wave' }), 900)
    return () => {
      clearTimeout(hi)
      ctrl.dispose()
      if (avatarBridge.ctrl === ctrl) avatarBridge.ctrl = null
    }
  }, [ctrl])

  // theme → accent-coloured eyes, hair tips, glow and rim light
  const theme = useSettingsStore((s) => s.settings.theme)
  useEffect(() => {
    const t = THEMES[theme].tokens
    shared.uAccent.value.set(t.accent)
    shared.uAccentBright.value.set(t.accentBright)
    shared.uRimColor.value.set(t.accentBright)
  }, [theme])

  // the conversation drives her feelings: your message, then her reply
  // sentence by sentence as it streams
  useEffect(() => {
    if (!ctrl) return
    const splitter = new SentenceSplitter()
    let first = true
    const offEvents = subscribeAssistantEvents((e) => {
      if (e.type === 'delta') {
        for (const sentence of splitter.push(e.text)) {
          ctrl.feel(readReplySentence(sentence, first))
          first = false
        }
        return
      }
      const rest = splitter.flush()
      if (rest && e.type === 'done') ctrl.feel(readReplySentence(rest, first))
      if (e.type === 'error' && useAssistantStore.getState().messages.at(-1)?.error) {
        ctrl.feel({ emotion: 'sad', intensity: 0.8 })
      }
      first = true
    })
    let seen = useAssistantStore.getState().messages.length
    const offStore = useAssistantStore.subscribe((s) => {
      const msgs = s.messages
      for (let i = seen; i < msgs.length; i++) {
        const m = msgs[i]
        if (m.role === 'user' && m.content) ctrl.feel(readUserMessage(m.content))
      }
      seen = msgs.length
    })
    return () => {
      offEvents()
      offStore()
    }
  }, [ctrl])

  useFrame((_state, delta) => {
    if (!ctrl) return
    ctrl.state = useAssistantStore.getState().state
    ctrl.speaking = voiceSignal.speaking
    ctrl.pointer = avatarBridge.inside ? avatarBridge.pointer : null
    const voice = voiceSignal.speaking ? voiceSignal.level : 0
    shared.uVoice.value += (voice - shared.uVoice.value) * Math.min(1, delta * 10)

    // clicks: a cheap screen-space hit test instead of raycasting a skinned mesh
    const click = avatarBridge.click
    if (click) {
      avatarBridge.click = null
      // project to pixels: a circle round her head, a box round her body
      const px = (ndc: THREE.Vector3 | THREE.Vector2): [number, number] => [
        ((ndc.x + 1) / 2) * size.width,
        ((1 - ndc.y) / 2) * size.height
      ]
      const [cx, cy] = px(click)
      const head = ctrl.bonePosition('head', _v).add(_w.set(0, 0.09, 0))
      const [hx, hy] = px(head.clone().project(camera))
      const [ex] = px(head.clone().add(_w.set(0.13, 0, 0)).project(camera))
      const headR = Math.abs(ex - hx)
      if (Math.hypot(cx - hx, cy - hy) < headR) {
        ctrl.poke(head)
      } else {
        const [nx, ny] = px(ctrl.bonePosition('neck', _v).project(camera))
        const [, hipY] = px(ctrl.bonePosition('hips', _v).add(_w.set(0, -0.15, 0)).project(camera))
        if (cy > ny && cy < hipY && Math.abs(cx - nx) < headR * 1.6) ctrl.poke(new THREE.Vector3(0, 1.1, 0))
      }
    }
    const t0 = performance.now()
    ctrl.update(delta)
    avatarBridge.updateMs += (performance.now() - t0 - avatarBridge.updateMs) * 0.05
  })

  return rig ? <primitive object={rig.root} /> : null
}

function ExposeAdvance(): null {
  const advance = useThree((s) => s.advance)
  useEffect(() => {
    avatarBridge.advance = (t) => advance(t)
    return () => {
      avatarBridge.advance = null
    }
  }, [advance])
  return null
}

/** Framing: head to hips (VTuber-style), easing closer while she talks to you. */
function CameraRig(): null {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  const pos = useRef(new THREE.Vector3(0, 1.2, 3))
  const look = useRef(new THREE.Vector3(0, 1.15, 0))
  const goalPos = useMemo(() => new THREE.Vector3(), [])
  const goalLook = useMemo(() => new THREE.Vector3(), [])

  useFrame((state, delta) => {
    const st = useAssistantStore.getState().state
    const aspect = size.width / Math.max(1, size.height)
    const half = THREE.MathUtils.degToRad(camera.fov / 2)
    // vertical span to fit (metres) — tighter while she's speaking
    const span = st === 'speaking' ? 0.88 : st === 'listening' ? 0.94 : 1.02
    let dist = span / 2 / Math.tan(half)
    // keep ~0.9 m of width so gestures never clip on narrow windows
    dist = Math.max(dist, 0.45 / (Math.tan(half) * aspect))
    const t = state.clock.elapsedTime
    const px = avatarBridge.inside ? avatarBridge.pointer.x : 0
    const py = avatarBridge.inside ? avatarBridge.pointer.y : 0
    // keep the top of her head (≈1.52 m, ears ≈1.58) just inside the frame
    const lookY = 1.645 - span / 2
    goalLook.set(px * 0.02, lookY + py * 0.01, 0)
    goalPos.set(px * 0.06 + Math.sin(t * 0.13) * 0.025, lookY + 0.04 + Math.sin(t * 0.21) * 0.012, dist)
    const k = Math.min(1, delta * 1.6)
    pos.current.lerp(goalPos, k)
    look.current.lerp(goalLook, k)
    camera.position.copy(pos.current)
    camera.lookAt(look.current)
  })
  return null
}

/* ── holographic backdrop ───────────────────────────────────────────── */

const HALO_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const HALO_FRAG = /* glsl */ `
  uniform vec3 uAccent;
  uniform vec3 uAccentBright;
  uniform float uTime;
  uniform float uVoice;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    float ang = atan(p.y, p.x);
    // soft core glow
    float glow = exp(-r * r * 4.0) * (0.22 + 0.25 * uVoice);
    // two thin rings, with rotating arc segments on the outer one
    float ring1 = exp(-pow((r - 0.62) * 70.0, 2.0)) * 0.35;
    float arcs = step(0.55, fract((ang / 6.2831) * 6.0 + uTime * 0.04));
    float ring2 = exp(-pow((r - 0.78) * 90.0, 2.0)) * 0.45 * arcs;
    float ticks = step(0.92, fract((ang / 6.2831) * 72.0)) * exp(-pow((r - 0.86) * 60.0, 2.0)) * 0.35;
    vec3 col = uAccent * glow + uAccentBright * (ring1 + ring2 + ticks);
    float a = clamp(glow + ring1 + ring2 + ticks, 0.0, 1.0) * smoothstep(1.0, 0.85, r);
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }
`

function Halo(): React.JSX.Element {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: HALO_VERT,
        fragmentShader: HALO_FRAG,
        uniforms: {
          uAccent: shared.uAccent,
          uAccentBright: shared.uAccentBright,
          uTime: shared.uTime,
          uVoice: shared.uVoice
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      }),
    []
  )
  useEffect(() => () => mat.dispose(), [mat])
  return (
    <mesh position={[0, 1.26, -0.45]} material={mat} renderOrder={-10}>
      <planeGeometry args={[1.5, 1.5]} />
    </mesh>
  )
}

const MOTE_VERT = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    float t = uTime * (0.03 + aSeed * 0.04) + aSeed * 10.0;
    p.y = 0.5 + mod(p.y + t, 1.6);
    p.x += sin(t * 2.0 + aSeed * 6.0) * 0.03;
    vAlpha = smoothstep(0.5, 0.8, p.y) * smoothstep(2.1, 1.8, p.y) * (0.4 + 0.6 * aSeed);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (2.0 + aSeed * 3.0) * (2.5 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`
const MOTE_FRAG = /* glsl */ `
  uniform vec3 uAccentBright;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    gl_FragColor = vec4(uAccentBright, a);
    #include <colorspace_fragment>
  }
`

function Motes({ count = 140 }: { count?: number }): React.JSX.Element {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const pos = new Float32Array(count * 3)
    const seed = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const r = 0.35 + Math.random() * 0.55
      pos[i * 3] = Math.cos(a) * r
      pos[i * 3 + 1] = Math.random() * 1.6
      pos[i * 3 + 2] = Math.sin(a) * r * 0.6 - 0.25
      seed[i] = Math.random()
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.2, 0), 3)
    return g
  }, [count])
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: MOTE_VERT,
        fragmentShader: MOTE_FRAG,
        uniforms: { uTime: shared.uTime, uAccentBright: shared.uAccentBright },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      }),
    []
  )
  useEffect(
    () => () => {
      geo.dispose()
      mat.dispose()
    },
    [geo, mat]
  )
  return <points geometry={geo} material={mat} />
}

/** Nova — the 3D anime avatar at the heart of the main view. */
export function AvatarScene({ onFail }: { onFail: (err: unknown) => void }): React.JSX.Element {
  const visible = useUIStore((s) => s.windowVisible)
  const toNdc = (e: React.PointerEvent | React.MouseEvent, out: THREE.Vector2): THREE.Vector2 => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return out.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
  }
  return (
    <Canvas
      frameloop="never"
      flat
      camera={{ position: [0, 1.2, 3], fov: 30, near: 0.05, far: 30 }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      style={{ background: 'transparent' }}
      onPointerMove={(e) => {
        toNdc(e, avatarBridge.pointer)
        avatarBridge.inside = true
      }}
      onPointerLeave={() => {
        avatarBridge.inside = false
      }}
      onClick={(e) => {
        avatarBridge.click = toNdc(e, new THREE.Vector2())
      }}
    >
      <FrameDriver fps={visible ? AVATAR_FPS : null} />
      <ExposeAdvance />
      <CameraRig />
      <Halo />
      <Motes />
      <NovaModel onFail={onFail} />
    </Canvas>
  )
}
