import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { AvatarConfig, MaterialSpec } from './avatars'
import {
  HAIR_BAND_HEAD_Y,
  blushMaterial,
  eyeMaterial,
  flatMaterial,
  glowMaterial,
  mouthMaterial,
  outlineMaterial,
  shared,
  softMaterial,
  toonMaterial
} from './toonMaterials'

/*
 * Loads an avatar GLB (built by tools/avatar) once per session and dresses
 * every mesh in the app's anime shaders. Materials are matched by the NAME the
 * generator gave them (see avatars.ts), so a model can be rebuilt freely
 * without touching this file as long as the names stay.
 */

const cache = new Map<string, Promise<GLTF>>()

export function loadAvatar(cfg: AvatarConfig): Promise<GLTF> {
  let p = cache.get(cfg.url)
  if (!p) {
    p = new GLTFLoader().loadAsync(cfg.url).catch((err) => {
      cache.delete(cfg.url) // allow a retry on the next mount
      throw err
    })
    cache.set(cfg.url, p)
  }
  return p
}

export interface AvatarRig {
  config: AvatarConfig
  root: THREE.Object3D
  bones: Map<string, THREE.Bone>
  /** every mesh that carries blendshapes */
  morphMeshes: THREE.Mesh[]
  materials: {
    eyeL: THREE.ShaderMaterial
    eyeR: THREE.ShaderMaterial
    mouth: THREE.ShaderMaterial
    blush: THREE.ShaderMaterial
  }
  clips: THREE.AnimationClip[]
  dispose: () => void
}

const KEEP_POSITION = new Set(['hips'])

/** drop the tracks the app drives itself (spring chains, scale, stray translations) */
function trimClip(clip: THREE.AnimationClip): THREE.AnimationClip {
  const tracks = clip.tracks.filter((t) => {
    const [node, prop] = t.name.split('.')
    if (node.startsWith('hair_') || node.startsWith('cloth_') || node.startsWith('bust_')) return false
    if (prop === 'scale') return false
    if (prop === 'position') return KEEP_POSITION.has(node)
    return true
  })
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

export function prepareAvatar(gltf: GLTF, cfg: AvatarConfig): AvatarRig {
  // each mount gets its own skeleton/material instances
  const root = cloneSkinned(gltf.scene)
  const bones = new Map<string, THREE.Bone>()
  const morphMeshes: THREE.Mesh[] = []
  const created: THREE.Material[] = []
  const outlines: THREE.Mesh[] = []
  const found: Partial<AvatarRig['materials']> = {}

  const iris =
    cfg.eyes.iris === 'theme'
      ? null
      : ([new THREE.Color(cfg.eyes.iris.base), new THREE.Color(cfg.eyes.iris.bright)] as [THREE.Color, THREE.Color])
  const irisR = new THREE.Vector2(...cfg.eyes.irisRadius)

  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone)
  })

  // the hair shading bands follow this avatar's head height (rest pose)
  const head = bones.get('head')
  if (head) {
    root.updateMatrixWorld(true)
    const pivot = new THREE.Vector3(...cfg.headPivot).applyMatrix4(head.matrixWorld)
    shared.uHeadShift.value = pivot.y - HAIR_BAND_HEAD_Y
  }

  const meshes: THREE.SkinnedMesh[] = []
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.SkinnedMesh)
  })

  // which skin joints are her hands: inside a HUD card only they can show,
  // where they're in front of it (see shared.uCut)
  const skinned = meshes.find((m) => m.isSkinnedMesh)
  if (skinned) {
    const flags = shared.uHandBones.value
    flags.forEach((v) => v.set(0, 0, 0, 0))
    skinned.skeleton.bones.forEach((b, i) => {
      if (i < flags.length * 4 && /(Hand|Thumb|Index|Middle|Ring|Little)/.test(b.name)) flags[i >> 2].setComponent(i & 3, 1)
    })
  }

  for (const mesh of meshes) {
    const old = mesh.material as THREE.Material
    // `Material:Mesh` overrides a plain material entry (e.g. face vs body skin)
    const spec: MaterialSpec = cfg.materials[`${old.name}:${mesh.name}`] ??
      cfg.materials[old.name] ?? { kind: 'toon', color: '#ffffff', shade: '#c0c0d0' }
    let mat: THREE.ShaderMaterial
    switch (spec.kind) {
      case 'toon':
        mat = toonMaterial({
          color: spec.color,
          shade: spec.shade,
          sphere: spec.sphere,
          rim: spec.rim,
          doubleSided: spec.double,
          step: spec.step,
          drape: spec.drape
        })
        break
      case 'hair':
        mat = toonMaterial({
          color: spec.color,
          shade: spec.shade,
          step: 0.48,
          rim: 0.14,
          hair: true,
          tipMix: spec.tipMix,
          sphere: 0.6,
          doubleSided: true
        })
        break
      case 'flat':
        mat = flatMaterial(spec.color, spec.opacity ?? 1, spec.overHair, spec.facing, spec.drape)
        break
      case 'soft':
        mat = softMaterial(spec.color, spec.opacity ?? 1, spec.feather ?? [0.3, 0.3, 0.3, 0.3], spec.facing)
        break
      case 'eyeL':
        mat = found.eyeL = eyeMaterial(new THREE.Vector2(...cfg.eyes.centerL), 0.3, irisR.clone(), iris)
        break
      case 'eyeR':
        mat = found.eyeR = eyeMaterial(new THREE.Vector2(...cfg.eyes.centerR), 1.7, irisR.clone(), iris)
        break
      case 'mouth':
        mat = found.mouth = mouthMaterial(spec.line)
        break
      case 'blush':
        mat = found.blush = blushMaterial()
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
    // soft shading lies under the see-through ink lines (crease, lower lash)
    if (spec.kind === 'soft') mesh.renderOrder = -0.5
    if (spec.kind === 'blush') mesh.renderOrder = 3
    if (mesh.morphTargetDictionary && Object.keys(mesh.morphTargetDictionary).length) morphMeshes.push(mesh)

    const outline = spec.kind === 'hair' || spec.kind === 'toon' ? spec.outline : undefined
    if (outline && mesh.isSkinnedMesh) {
      const hair = spec.kind === 'hair'
      const fringe = hair && spec.fringeFade !== false ? 1 : 0
      const crease = spec.kind === 'toon' ? (spec.crease ?? 0) : 0
      const drape = spec.kind === 'toon' ? spec.drape : undefined
      const o = new THREE.SkinnedMesh(mesh.geometry, outlineMaterial(outline[0], outline[1], hair ? 1 : 0, fringe, crease, drape))
      o.name = mesh.name + '_outline'
      // the line follows the mesh's blendshapes (a mouth opening, cloth
      // pressed under a hand): one weights array for both
      if (mesh.morphTargetInfluences) o.morphTargetInfluences = mesh.morphTargetInfluences
      o.bind(mesh.skeleton, mesh.bindMatrix)
      o.frustumCulled = false
      o.renderOrder = -1
      created.push(o.material as THREE.Material)
      mesh.parent!.add(o)
      outlines.push(o)
    }
  }

  if (!found.eyeL || !found.eyeR || !found.mouth || !found.blush) {
    throw new Error(`avatar "${cfg.id}" is missing face materials (Eye_L/Eye_R/Mouth/Blush)`)
  }

  return {
    config: cfg,
    root,
    bones,
    morphMeshes,
    materials: found as AvatarRig['materials'],
    clips: gltf.animations.map(trimClip),
    dispose: () => {
      created.forEach((m) => m.dispose())
      outlines.forEach((o) => o.removeFromParent())
    }
  }
}

/** SkeletonUtils.clone, inlined: clone a skinned hierarchy with rebound bones.
 *  Meshes sharing a skeleton (the loader makes one per skin) share its clone
 *  too — SkeletonUtils would give each mesh its own copy, i.e. one bone update
 *  and one bone texture upload per mesh every frame instead of one */
function cloneSkinned(source: THREE.Object3D): THREE.Object3D {
  const sourceLookup = new Map<THREE.Object3D, THREE.Object3D>()
  const cloneLookup = new Map<THREE.Object3D, THREE.Object3D>()
  const clone = source.clone()
  parallelTraverse(source, clone, (a, b) => {
    sourceLookup.set(b, a)
    cloneLookup.set(a, b)
  })
  const skeletons = new Map<THREE.Skeleton, THREE.Skeleton>()
  clone.traverse((node) => {
    const sm = node as THREE.SkinnedMesh
    if (!sm.isSkinnedMesh) return
    const src = (sourceLookup.get(node) as THREE.SkinnedMesh).skeleton
    let skeleton = skeletons.get(src)
    if (!skeleton) {
      skeleton = new THREE.Skeleton(
        src.bones.map((b) => cloneLookup.get(b) as THREE.Bone),
        src.boneInverses
      )
      skeletons.set(src, skeleton)
    }
    sm.bind(skeleton, sm.bindMatrix)
  })
  return clone
}

function parallelTraverse(a: THREE.Object3D, b: THREE.Object3D, cb: (a: THREE.Object3D, b: THREE.Object3D) => void): void {
  cb(a, b)
  for (let i = 0; i < a.children.length; i++) parallelTraverse(a.children[i], b.children[i], cb)
}
