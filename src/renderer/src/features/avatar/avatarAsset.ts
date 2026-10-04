import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import novaUrl from '@/assets/avatar/nova.glb?url'
import {
  blushMaterial,
  eyeMaterial,
  flatMaterial,
  glowMaterial,
  mouthMaterial,
  outlineMaterial,
  toonMaterial
} from './toonMaterials'

/*
 * Loads Nova (built by tools/avatar from Blender) once per session and dresses
 * every mesh in the app's anime shaders. Materials are matched by the NAME the
 * generator gave them, so the .glb can be rebuilt freely without touching this
 * file as long as the names stay.
 */

// eye centres (rest pose, metres) — mirror of tools/avatar/nova/head.py
const EYE_CENTER_L = new THREE.Vector2(0.0403, 1.3752)
const EYE_CENTER_R = new THREE.Vector2(-0.0403, 1.3752)

let cached: Promise<GLTF> | null = null

export function loadNova(): Promise<GLTF> {
  cached ??= new GLTFLoader().loadAsync(novaUrl).catch((err) => {
    cached = null // allow a retry on the next mount
    throw err
  })
  return cached
}

export interface NovaRig {
  root: THREE.Object3D
  bones: Map<string, THREE.Bone>
  /** every mesh that carries blendshapes */
  morphMeshes: THREE.Mesh[]
  materials: {
    eyeL: THREE.ShaderMaterial
    eyeR: THREE.ShaderMaterial
    mouth: THREE.ShaderMaterial
    blush: THREE.ShaderMaterial
    hair: THREE.ShaderMaterial
  }
  clips: THREE.AnimationClip[]
  dispose: () => void
}

type Spec =
  | { kind: 'toon'; color: string; shade: string; outline?: [string, number]; sphere?: number; rim?: number; double?: boolean; step?: number }
  | { kind: 'hair' }
  | { kind: 'flat'; color: string; opacity?: number; overHair?: boolean }
  | { kind: 'eyeL' | 'eyeR' | 'mouth' | 'blush' | 'glow' }

function specFor(materialName: string, meshName: string): Spec {
  switch (materialName) {
    case 'Skin':
      return meshName === 'Head'
        ? { kind: 'toon', color: '#fff0e8', shade: '#f4bfb2', sphere: 0.85, rim: 0.22, step: 0.42, outline: ['#b97b70', 0.55] }
        : { kind: 'toon', color: '#fff0e8', shade: '#efb6a8', rim: 0.25, step: 0.45, outline: ['#b97b70', 0.7] }
    case 'Hair':
      return { kind: 'hair' }
    case 'Eye_L':
      return { kind: 'eyeL' }
    case 'Eye_R':
      return { kind: 'eyeR' }
    case 'Mouth':
      return { kind: 'mouth' }
    case 'Blush':
      return { kind: 'blush' }
    case 'Accent':
      return { kind: 'glow' }
    case 'Lash':
      return { kind: 'flat', color: '#2a1a26' }
    case 'LashLower':
      return { kind: 'flat', color: '#7a4c5c', opacity: 0.85 }
    case 'Crease':
      return { kind: 'flat', color: '#c99088', opacity: 0.6 }
    case 'Brow':
      return { kind: 'flat', color: '#8c7ea6', overHair: true }
    case 'Cloth_White':
      return { kind: 'toon', color: '#f1f3fa', shade: '#aeb8d6', double: true, rim: 0.22, outline: ['#5d678c', 0.8] }
    case 'Cloth_Dark':
      return { kind: 'toon', color: '#2b3254', shade: '#171b33', double: true, rim: 0.4, outline: ['#0a0c18', 0.8] }
    case 'Ribbon':
      return { kind: 'toon', color: '#ff86b0', shade: '#d9507f', double: true, rim: 0.3, outline: ['#8c2a50', 0.6] }
    case 'Sock':
      return { kind: 'toon', color: '#262838', shade: '#14151f', rim: 0.45, outline: ['#07080d', 0.8] }
    case 'Shoe':
      return { kind: 'toon', color: '#f6f7fb', shade: '#bcc4dc', outline: ['#5d678c', 0.8] }
    case 'Sole':
      return { kind: 'toon', color: '#33406b', shade: '#1e2647', outline: ['#0a0c18', 0.8] }
    case 'Headset':
      return { kind: 'toon', color: '#f8f9fd', shade: '#b6c0dc', rim: 0.4, outline: ['#5d678c', 0.7] }
    case 'Headset_Dark':
      return { kind: 'toon', color: '#2a3150', shade: '#161a2e', rim: 0.4, outline: ['#0a0c18', 0.6] }
    default:
      return { kind: 'toon', color: '#ffffff', shade: '#c0c0d0' }
  }
}

const KEEP_POSITION = new Set(['hips'])

/** drop the tracks the app drives itself (hair springs, scale, stray translations) */
function trimClip(clip: THREE.AnimationClip): THREE.AnimationClip {
  const tracks = clip.tracks.filter((t) => {
    const [node, prop] = t.name.split('.')
    if (node.startsWith('hair_')) return false
    if (prop === 'scale') return false
    if (prop === 'position') return KEEP_POSITION.has(node)
    return true
  })
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

export function prepareNova(gltf: GLTF): NovaRig {
  // each mount gets its own skeleton/material instances
  const root = cloneSkinned(gltf.scene)
  const bones = new Map<string, THREE.Bone>()
  const morphMeshes: THREE.Mesh[] = []
  const created: THREE.Material[] = []
  let eyeL!: THREE.ShaderMaterial
  let eyeR!: THREE.ShaderMaterial
  let mouth!: THREE.ShaderMaterial
  let blush!: THREE.ShaderMaterial
  let hair!: THREE.ShaderMaterial
  const outlines: THREE.Mesh[] = []

  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone)
  })

  const meshes: THREE.SkinnedMesh[] = []
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh || (o as THREE.Mesh).isMesh) meshes.push(o as THREE.SkinnedMesh)
  })

  for (const mesh of meshes) {
    const old = mesh.material as THREE.Material
    const spec = specFor(old.name, mesh.name)
    let mat: THREE.ShaderMaterial
    switch (spec.kind) {
      case 'toon':
        mat = toonMaterial({ color: spec.color, shade: spec.shade, sphere: spec.sphere, rim: spec.rim, doubleSided: spec.double, step: spec.step })
        break
      case 'hair':
        mat = hair = toonMaterial({ color: '#e6e3f4', shade: '#a9a1cc', step: 0.48, rim: 0.14, hair: true, sphere: 0.6, doubleSided: true })
        break
      case 'flat':
        mat = flatMaterial(spec.color, spec.opacity ?? 1, spec.overHair)
        break
      case 'eyeL':
        mat = eyeL = eyeMaterial(EYE_CENTER_L.clone(), 0.3)
        break
      case 'eyeR':
        mat = eyeR = eyeMaterial(EYE_CENTER_R.clone(), 1.7)
        break
      case 'mouth':
        mat = mouth = mouthMaterial()
        break
      case 'blush':
        mat = blush = blushMaterial()
        break
      case 'glow':
        mat = glowMaterial()
        break
    }
    old.dispose()
    mesh.material = mat
    created.push(mat)
    mesh.frustumCulled = false // skinned bounds don't follow gestures
    if (spec.kind === 'flat' && spec.overHair) mesh.renderOrder = 2
    if (spec.kind === 'blush') mesh.renderOrder = 3
    if (mesh.morphTargetDictionary && Object.keys(mesh.morphTargetDictionary).length) morphMeshes.push(mesh)

    const outline = spec.kind === 'hair' ? (['#8279a8', 0.85] as [string, number]) : spec.kind === 'toon' ? spec.outline : undefined
    if (outline && mesh.isSkinnedMesh) {
      const o = new THREE.SkinnedMesh(mesh.geometry, outlineMaterial(outline[0], outline[1], spec.kind === 'hair' ? 1 : 0))
      o.name = mesh.name + '_outline'
      o.bind(mesh.skeleton, mesh.bindMatrix)
      o.frustumCulled = false
      o.renderOrder = -1
      created.push(o.material as THREE.Material)
      mesh.parent!.add(o)
      outlines.push(o)
    }
  }

  return {
    root,
    bones,
    morphMeshes,
    materials: { eyeL, eyeR, mouth, blush, hair },
    clips: gltf.animations.map(trimClip),
    dispose: () => {
      created.forEach((m) => m.dispose())
      outlines.forEach((o) => o.removeFromParent())
    }
  }
}

/** SkeletonUtils.clone, inlined: clone a skinned hierarchy with rebound bones */
function cloneSkinned(source: THREE.Object3D): THREE.Object3D {
  const sourceLookup = new Map<THREE.Object3D, THREE.Object3D>()
  const cloneLookup = new Map<THREE.Object3D, THREE.Object3D>()
  const clone = source.clone()
  parallelTraverse(source, clone, (a, b) => {
    sourceLookup.set(b, a)
    cloneLookup.set(a, b)
  })
  clone.traverse((node) => {
    const sm = node as THREE.SkinnedMesh
    if (!sm.isSkinnedMesh) return
    const src = sourceLookup.get(node) as THREE.SkinnedMesh
    const bones = src.skeleton.bones.map((b) => cloneLookup.get(b) as THREE.Bone)
    sm.bind(new THREE.Skeleton(bones, src.skeleton.boneInverses), sm.bindMatrix)
  })
  return clone
}

function parallelTraverse(a: THREE.Object3D, b: THREE.Object3D, cb: (a: THREE.Object3D, b: THREE.Object3D) => void): void {
  cb(a, b)
  for (let i = 0; i < a.children.length; i++) parallelTraverse(a.children[i], b.children[i], cb)
}
