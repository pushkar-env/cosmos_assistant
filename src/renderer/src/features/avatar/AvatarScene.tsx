import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { subscribeAssistantEvents, useAssistantStore } from '@/core/stores/useAssistantStore'
import { useSettingsStore } from '@/core/stores/useSettingsStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { voiceSignal } from '@/core/voice/voiceSignal'
import { THEMES } from '@/core/theme/themes'
import { FrameDriver } from '@/shared/three/FrameDriver'
import { loadAvatar, prepareAvatar, type AvatarRig } from './avatarAsset'
import { AvatarController } from './AvatarController'
import { resolveAvatar, type AvatarConfig } from './avatars'
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
  updateMs: 0,
  /** dev/testing aid: orbit the camera around her (radians, 0 = front) */
  orbit: 0,
  /** dev/testing aid: a close-up instead of the full-body framing */
  focus: null as { x?: number; y: number; z?: number; dist: number } | null
}

if (import.meta.env.DEV) (window as unknown as { __nova: typeof avatarBridge }).__nova = avatarBridge

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()

function AvatarModel({ cfg, onFail }: { cfg: AvatarConfig; onFail: (err: unknown) => void }): React.JSX.Element | null {
  const [rig, setRig] = useState<AvatarRig | null>(null)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)

  useEffect(() => {
    let alive = true
    let prepared: AvatarRig | null = null
    loadAvatar(cfg)
      .then((gltf) => {
        if (!alive) return
        prepared = prepareAvatar(gltf, cfg)
        setRig(prepared)
      })
      .catch((err) => {
        console.error(`[avatar] failed to load ${cfg.label}:`, err)
        if (alive) onFail(err)
      })
    return () => {
      alive = false
      prepared?.dispose()
    }
  }, [cfg, onFail])

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
function CameraRig({ cfg }: { cfg: AvatarConfig }): null {
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
    // full body: from just under the soles to just over her hair, with a
    // little air. While she talks the camera leans in a touch — never enough
    // to crop her feet or a raised hand.
    const top = cfg.frame.top + 0.04
    const bottom = -0.05
    const span = (top - bottom) * (st === 'speaking' && !avatarBridge.ctrl?.gesturing ? 1.03 : 1.07)
    let dist = span / 2 / Math.tan(half)
    // keep ~1.2 m of width so an arm or the coat never clips on narrow windows
    dist = Math.max(dist, 0.6 / (Math.tan(half) * aspect))
    const t = state.clock.elapsedTime
    const px = avatarBridge.inside ? avatarBridge.pointer.x : 0
    const py = avatarBridge.inside ? avatarBridge.pointer.y : 0
    const lookY = (top + bottom) / 2
    goalLook.set(px * 0.03, lookY + py * 0.015, 0)
    // camera a little above the middle of her, looking very slightly down
    goalPos.set(px * 0.08 + Math.sin(t * 0.13) * 0.03, lookY + 0.12 + Math.sin(t * 0.21) * 0.015, dist)
    const f = avatarBridge.focus
    if (f) {
      goalLook.set(f.x ?? 0, f.y, f.z ?? 0)
      goalPos.set(f.x ?? 0, f.y, (f.z ?? 0) + f.dist)
    }
    const k = f ? 1 : Math.min(1, delta * 1.6)
    pos.current.lerp(goalPos, k)
    look.current.lerp(goalLook, k)
    camera.position.copy(pos.current)
    if (avatarBridge.orbit) camera.position.applyAxisAngle(THREE.Object3D.DEFAULT_UP, avatarBridge.orbit)
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
    <mesh position={[0, 1.18, -0.5]} material={mat} renderOrder={-10}>
      <planeGeometry args={[2.0, 2.0]} />
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
    p.y = 0.05 + mod(p.y + t, 1.95);
    p.x += sin(t * 2.0 + aSeed * 6.0) * 0.03;
    vAlpha = smoothstep(0.05, 0.35, p.y) * smoothstep(2.0, 1.7, p.y) * (0.4 + 0.6 * aSeed);
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
      pos[i * 3 + 1] = Math.random() * 1.95
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

/* ── the floor she stands on ───────────────────────────────────────── */

const FLOOR_FRAG = /* glsl */ `
  uniform vec3 uAccent;
  uniform vec3 uAccentBright;
  uniform float uTime;
  uniform float uVoice;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    float ang = atan(p.y, p.x);
    // a holographic pad: two rings, rotating segments, a soft inner glow
    float ring1 = exp(-pow((r - 0.62) * 60.0, 2.0)) * 0.6;
    float segs = step(0.45, fract((ang / 6.2831) * 12.0 - uTime * 0.05));
    float ring2 = exp(-pow((r - 0.80) * 90.0, 2.0)) * 0.45 * segs;
    float glow = exp(-r * r * 3.5) * (0.10 + 0.12 * uVoice);
    float a = clamp(ring1 + ring2 + glow, 0.0, 1.0) * smoothstep(1.0, 0.9, r);
    vec3 col = uAccent * glow + uAccentBright * (ring1 + ring2);
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }
`
const SHADOW_FRAG = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * vec2(2.0, 3.2);
    float a = (1.0 - smoothstep(0.0, 1.0, length(p))) * 0.55;
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
  }
`

function Floor(): React.JSX.Element {
  const [pad, shadow] = useMemo(
    () => [
      new THREE.ShaderMaterial({
        vertexShader: HALO_VERT,
        fragmentShader: FLOOR_FRAG,
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
      new THREE.ShaderMaterial({ vertexShader: HALO_VERT, fragmentShader: SHADOW_FRAG, transparent: true, depthWrite: false })
    ],
    []
  )
  useEffect(
    () => () => {
      pad.dispose()
      shadow.dispose()
    },
    [pad, shadow]
  )
  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <mesh position={[0, 0, 0.002]} material={pad} renderOrder={-9}>
        <planeGeometry args={[1.1, 1.1]} />
      </mesh>
      <mesh position={[0, 0.01, 0.004]} material={shadow} renderOrder={-8}>
        <planeGeometry args={[0.55, 0.55]} />
      </mesh>
    </group>
  )
}

/** The 3D anime avatar at the heart of the main view. */
export function AvatarScene({ onFail }: { onFail: (err: unknown) => void }): React.JSX.Element {
  const visible = useUIStore((s) => s.windowVisible)
  const avatarId = useSettingsStore((s) => s.settings.avatarId)
  const cfg = resolveAvatar(avatarId)
  useEffect(() => {
    if (!cfg) onFail(new Error('no avatar model is bundled'))
  }, [cfg, onFail])
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
      {cfg && <CameraRig cfg={cfg} />}
      <Halo />
      <Floor />
      <Motes />
      {cfg && <AvatarModel key={cfg.id} cfg={cfg} onFail={onFail} />}
    </Canvas>
  )
}
