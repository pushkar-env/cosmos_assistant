import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { AvatarRig } from '../avatarAsset'
import { shared } from '../toonMaterials'
import type { StageFx } from './actor'
import { stageClock } from './bridge'

/*
 * The stage's effects in the 3D scene:
 *  · the teleport — she dissolves into a drift of light motes (every one
 *    sampled off her body as it is) and re-forms at home from a converging
 *    swirl, a glowing seam sweeping up her body as it rebuilds;
 *  · a holographic ripple on the floor wherever a foot lands;
 *  · a soft contact shadow that goes where she goes.
 */

const COUNT = 1600

const MOTE_VERT = /* glsl */ `
  attribute vec3 aFrom;
  attribute vec3 aTo;
  attribute float aSeed;
  uniform float uT;
  uniform float uIn;
  uniform vec2 uAxis;
  varying float vAlpha;
  void main() {
    float s = aSeed;
    // each mote keeps its own pace
    float t = clamp((uT - s * 0.25) / 0.75, 0.0, 1.0);
    float e = uIn > 0.5 ? (t * t * (3.0 - 2.0 * t)) : 1.0 - pow(1.0 - t, 2.2);
    vec3 p = mix(aFrom, aTo, e);
    // a swirl round her: unwinding as they leave, winding in as they land
    float ang = (uIn > 0.5 ? (1.0 - e) * 2.4 : e * -1.1) * (0.5 + s);
    vec2 c = p.xz - uAxis;
    p.xz = uAxis + vec2(c.x * cos(ang) - c.y * sin(ang), c.x * sin(ang) + c.y * cos(ang));
    vAlpha = uIn > 0.5 ? smoothstep(0.0, 0.25, t) * (1.0 - smoothstep(0.82, 1.0, t)) : (1.0 - t) * smoothstep(0.0, 0.06, t + 0.06);
    vAlpha *= 0.55 + 0.45 * sin(s * 40.0 + uT * 30.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (2.2 + s * 3.2) * (3.2 / -mv.z) * (uIn > 0.5 ? 1.0 : 1.0 + 0.8 * t);
    gl_Position = projectionMatrix * mv;
  }
`
const MOTE_FRAG = /* glsl */ `
  uniform vec3 uAccentBright;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    gl_FragColor = vec4(mix(uAccentBright, vec3(1.0), 0.35 * smoothstep(0.25, 0.0, d)), a);
    #include <colorspace_fragment>
  }
`

const RING_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const RING_FRAG = /* glsl */ `
  uniform vec3 uAccentBright;
  uniform float uT;
  uniform float uHard;
  varying vec2 vUv;
  void main() {
    float r = length((vUv - 0.5) * 2.0);
    float front = 0.25 + 0.75 * uT;
    float ring = exp(-pow((r - front) * 18.0, 2.0)) + 0.35 * exp(-pow((r - front * 0.6) * 26.0, 2.0));
    float a = ring * (1.0 - uT) * (1.0 - uT) * (0.35 + 0.4 * uHard) * smoothstep(1.0, 0.92, r);
    gl_FragColor = vec4(uAccentBright, a);
    #include <colorspace_fragment>
  }
`

const SHADOW_FRAG = /* glsl */ `
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * vec2(2.0, 3.2);
    float a = (1.0 - smoothstep(0.0, 1.0, length(p))) * 0.55 * uAlpha;
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
  }
`

/** sample `n` points off the rig's skinned meshes, as posed now (world) */
function sampleBody(rig: AvatarRig, n: number, out: Float32Array): void {
  const meshes: THREE.SkinnedMesh[] = []
  rig.root.traverse((o) => {
    const m = o as THREE.SkinnedMesh
    if (m.isSkinnedMesh && m.visible && !m.name.endsWith('_outline') && m.geometry.attributes.position.count > 200) meshes.push(m)
  })
  if (!meshes.length) return
  const counts = meshes.map((m) => m.geometry.attributes.position.count)
  const total = counts.reduce((a, b) => a + b, 0)
  rig.root.updateWorldMatrix(true, true)
  const v = new THREE.Vector3()
  for (let i = 0; i < n; i++) {
    let r = Math.random() * total
    let k = 0
    while (k < meshes.length - 1 && r >= counts[k]) r -= counts[k++]
    const mesh = meshes[k]
    const idx = Math.floor(Math.random() * counts[k])
    mesh.getVertexPosition(idx, v)
    mesh.localToWorld(v)
    out[i * 3] = v.x
    out[i * 3 + 1] = v.y
    out[i * 3 + 2] = v.z
  }
}

interface Run {
  out: boolean
  t: number
  dur: number
  resolve: () => void
}

/**
 * Mount once in the avatar's Canvas; fills in `fx` for the actor. `getRig`
 * returns the live rig (null until loaded).
 */
export function StageEffects({ fx, getRig }: { fx: { current: StageFx | null }; getRig: () => AvatarRig | null }): React.JSX.Element {
  const motes = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3))
    g.setAttribute('aFrom', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3))
    g.setAttribute('aTo', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3))
    const seed = new Float32Array(COUNT)
    for (let i = 0; i < COUNT; i++) seed[i] = Math.random()
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 10)
    const m = new THREE.ShaderMaterial({
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      uniforms: { uT: { value: 0 }, uIn: { value: 0 }, uAxis: { value: new THREE.Vector2() }, uAccentBright: shared.uAccentBright },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    return { g, m }
  }, [])
  const points = useRef<THREE.Points>(null)
  const run = useRef<Run | null>(null)

  const rings = useMemo(
    () =>
      Array.from({ length: 8 }, () => {
        const m = new THREE.ShaderMaterial({
          vertexShader: RING_VERT,
          fragmentShader: RING_FRAG,
          uniforms: { uT: { value: 1 }, uHard: { value: 1 }, uAccentBright: shared.uAccentBright },
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending
        })
        return { m, t: 1, mesh: null as THREE.Mesh | null }
      }),
    []
  )
  const nextRing = useRef(0)
  const ringGeo = useMemo(() => new THREE.PlaneGeometry(0.42, 0.42).rotateX(-Math.PI / 2), [])

  const shadowMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: SHADOW_FRAG,
        uniforms: { uAlpha: { value: 1 } },
        transparent: true,
        depthWrite: false
      }),
    []
  )
  const shadow = useRef<THREE.Mesh>(null)
  const hipsPos = useMemo(() => new THREE.Vector3(), [])

  useEffect(() => {
    fx.current = {
      footstep: (at, hard) => {
        const r = rings[nextRing.current++ % rings.length]
        r.t = 0
        r.m.uniforms.uHard.value = hard
        if (r.mesh) r.mesh.position.set(at.x, 0.003, at.z)
      },
      dissolve: (out, dur) =>
        new Promise<void>((resolve) => {
          const rig = getRig()
          if (!rig) {
            shared.uDissolve.value = 0
            resolve()
            return
          }
          // the motes: off her body as she is (out), or onto it (in)
          const from = motes.g.attributes.aFrom as THREE.BufferAttribute
          const to = motes.g.attributes.aTo as THREE.BufferAttribute
          const body = new Float32Array(COUNT * 3)
          sampleBody(rig, COUNT, body)
          const a = (out ? from : to).array as Float32Array
          const b = (out ? to : from).array as Float32Array
          a.set(body)
          for (let i = 0; i < COUNT; i++) {
            const x = body[i * 3]
            const y = body[i * 3 + 1]
            const z = body[i * 3 + 2]
            // scattered: out from her axis, drifting up
            const cx = x - rig.root.position.x
            const cz = z - rig.root.position.z
            const len = Math.hypot(cx, cz) || 1
            const push = 0.15 + Math.random() * 0.55
            b[i * 3] = x + (cx / len) * push + (Math.random() - 0.5) * 0.3
            b[i * 3 + 1] = y + (out ? 0.15 + Math.random() * 0.75 : (Math.random() - 0.3) * 0.6)
            b[i * 3 + 2] = z + (cz / len) * push + (Math.random() - 0.5) * 0.3
          }
          from.needsUpdate = true
          to.needsUpdate = true
          motes.m.uniforms.uIn.value = out ? 0 : 1
          motes.m.uniforms.uT.value = 0
          ;(motes.m.uniforms.uAxis.value as THREE.Vector2).set(rig.root.position.x, rig.root.position.z)
          shared.uDissolveSweep.value = out ? 0 : 1
          run.current?.resolve()
          run.current = { out, t: 0, dur, resolve }
        })
    }
    return () => {
      fx.current = null
      run.current?.resolve()
      run.current = null
      shared.uDissolve.value = 0
    }
  }, [fx, getRig, motes, rings])

  useEffect(
    () => () => {
      motes.g.dispose()
      motes.m.dispose()
      ringGeo.dispose()
      shadowMat.dispose()
      rings.forEach((r) => r.m.dispose())
    },
    [motes, ringGeo, shadowMat, rings]
  )

  useFrame((_s, frameDelta) => {
    const delta = frameDelta * stageClock.scale
    const r = run.current
    if (r) {
      r.t += delta
      const u = Math.min(1, r.t / r.dur)
      motes.m.uniforms.uT.value = u
      // out: she thins away over the first 85%; in: she re-forms as the motes land
      shared.uDissolve.value = r.out ? Math.min(1, u / 0.85) : 1 - THREE.MathUtils.smoothstep(u, 0.12, 1)
      if (u >= 1) {
        run.current = null
        if (!r.out) {
          shared.uDissolve.value = 0
          shared.uDissolveSweep.value = 0
        }
        r.resolve()
      }
    }
    if (points.current) points.current.visible = !!run.current
    for (const ring of rings) {
      if (ring.t >= 1) {
        if (ring.mesh) ring.mesh.visible = false
        continue
      }
      ring.t = Math.min(1, ring.t + delta / 0.9)
      ring.m.uniforms.uT.value = ring.t
      if (ring.mesh) ring.mesh.visible = true
    }
    // the shadow follows her hips, fading as she dissolves
    const rig = getRig()
    const hips = rig?.bones.get('hips')
    if (shadow.current && hips) {
      hips.getWorldPosition(hipsPos)
      shadow.current.position.set(hipsPos.x, 0.01, hipsPos.z + 0.01)
      shadowMat.uniforms.uAlpha.value = 1 - shared.uDissolve.value
    }
  })

  return (
    <>
      <points ref={points} geometry={motes.g} material={motes.m} frustumCulled={false} renderOrder={20} visible={false} />
      {rings.map((r, i) => (
        <mesh
          key={i}
          ref={(m) => {
            r.mesh = m
          }}
          geometry={ringGeo}
          material={r.m}
          renderOrder={-7}
          visible={false}
        />
      ))}
      <mesh ref={shadow} material={shadowMat} renderOrder={-8} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.55, 0.55]} />
      </mesh>
    </>
  )
}
