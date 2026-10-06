import type { AvatarId } from '@shared/types'

// Whichever avatar models are present in assets/avatar are bundled; a config
// whose .glb is missing simply isn't offered. (A model can be kept out of a
// public repo — e.g. fan art of someone else's character — and the app still
// builds and falls back to the ones that ship.)
const GLB_URLS = import.meta.glob('../../assets/avatar/*.glb', {
  query: '?url',
  import: 'default',
  eager: true
}) as Record<string, string>

function glb(file: string): string | undefined {
  return Object.entries(GLB_URLS).find(([path]) => path.endsWith('/' + file))?.[1]
}

/*
 * Avatar registry. Each GLB comes from tools/avatar (one package per
 * character); this is everything the runtime needs to dress and drive it.
 * Coordinates are three.js space (Y up, +Z toward the camera), in metres.
 */

/** how a material (matched by its name in the GLB) is shaded */
export type MaterialSpec =
  | {
      kind: 'toon'
      color: string
      shade: string
      outline?: [color: string, width: number]
      /** a face with a sculpted profile: its outline is kept off the creases
       *  of the nose and mouth where they'd draw over her own skin (how far
       *  the line is pushed back, × its width) — see OUTLINE_VERT */
      crease?: number
      sphere?: number
      rim?: number
      double?: boolean
      step?: number
    }
  | {
      kind: 'hair'
      color: string
      shade: string
      outline: [string, number]
      tipMix: number
      /** fade the outline where bangs lie over the face (default true) — off
       *  for curtains framing the face, which want their ink edge */
      fringeFade?: boolean
    }
  /** `facing` (both decal kinds): drawn only where the surface faces the
   *  camera — fully above facing[1] (|n·v|), gone below facing[0] — for a
   *  mark on a surface that faces sideways, like the side of the nose */
  | { kind: 'flat'; color: string; opacity?: number; overHair?: boolean; facing?: [number, number] }
  /** painted shading with soft edges: it fades in over `feather` of its UV
   *  square from each edge (uv.x 0, uv.x 1, uv.y 0, uv.y 1) */
  | { kind: 'soft'; color: string; opacity?: number; feather?: [number, number, number, number]; facing?: [number, number] }
  /** `line`: the closed mouth's line colour (default a soft pink) */
  | { kind: 'mouth'; line?: string }
  | { kind: 'eyeL' | 'eyeR' | 'blush' | 'glow' }

export interface SpringChainSpec {
  /** chain bones are named `${prefix}_1`, `${prefix}_2`, … */
  prefix: string
  stiffness: number
  drag: number
  gravity: number
  /** collision radius around the chain */
  radius: number
  /** how much the ambient breeze moves it (0 = not at all) */
  wind?: number
  /** collider group — only colliders listing this group (or none) touch it */
  group?: string
  /** cloth hanging round her: may swing out freely, but never more than this
   *  (m) nearer her body than it hangs at rest (see SpringSettings.inward) */
  inward?: number
  /** …and per joint, root first, never more than this further out (joints
   *  past the list swing out freely — see SpringSettings.outward) */
  outward?: number[]
}

export interface ColliderSpec {
  bone: string
  /** rest-pose world position of the sphere centre */
  at: [number, number, number]
  radius: number
  /** spring groups this collider affects; omitted = all of them */
  groups?: string[]
}

export interface AvatarConfig {
  id: AvatarId
  label: string
  url: string
  /** camera framing: the highest point to keep in frame (hair/ears, m) —
   *  the camera shows her head to toe */
  frame: { top: number }
  /** head pivot relative to the head bone (bone space) — face shading sphere */
  headPivot: [number, number, number]
  eyes: {
    centerL: [number, number]
    centerR: [number, number]
    irisRadius: [number, number]
    /** max iris travel (m) for full gaze left/right, up/down */
    gaze: [number, number]
    /** 'theme' follows the COSMOS accent; otherwise fixed colours */
    iris: 'theme' | { base: string; deep: string; bright: string }
  }
  /** resting blush (0..1) */
  blush: number
  materials: Record<string, MaterialSpec>
  springs: SpringChainSpec[]
  colliders: ColliderSpec[]
  /** a tiny breath-synced lift layered on top of the spring sim (degrees) */
  breath?: { bones: string[]; degrees: number; period: number }
  /** living hands: each finger drifts this many degrees on its own slow
   *  rhythm, layered over whatever the clips pose, with an occasional small
   *  hand "moment" (a tap, a flex…) */
  fingerLife?: number
  /** the hand her base pose rests on her body: its fingers only ever lift
   *  (never press into what they lie on) and its wrist stays put — and when
   *  she's up and about (the stage) it comes off and hangs free */
  restingHand?: 'left' | 'right'
  /** a morph that presses her clothes under the resting hand, faded in as
   *  the hand nears its resting spot and out as it leaves */
  handPress?: string
  /** spring bones carrying the cloth under the resting hand: held at rest
   *  as far as the press is in, so the breeze can't swing pressed cloth back
   *  out through her fingers */
  pressHolds?: string[]
  /** how she moves about the stage (walking, crouching to the HUD) */
  stage?: {
    /** deepest crouch, 0..1 of a full squat (a short skirt: keep it shallow) */
    crouchMax?: number
    /** how far her knees open as she crouches (m of pole, at a full squat) */
    kneeOut?: number
    /** what her arms keep out of when the stage moves them: spheres riding
     *  on her bones (rest-pose world centre, radius) — the elbow swings
     *  round, the shoulder comes forward, a hand moves out of it */
    keepOut?: { bone: string; at: [number, number, number]; radius: number }[]
    /** her arms' thickness for that (m: upper arm, forearm, hand — sleeves
     *  included, as far as they keep her arms off her body) */
    armRadius?: [number, number, number]
  }
}

const SKIN_FACE = (color: string, shade: string, outline: string, width = 0.55, crease?: number): MaterialSpec => ({
  kind: 'toon',
  color,
  shade,
  sphere: 0.85,
  rim: 0.22,
  step: 0.42,
  outline: [outline, width],
  crease
})

const LIBRARY: Record<AvatarId, Omit<AvatarConfig, 'url'> & { url: string | undefined }> = {
  nova: {
    id: 'nova',
    label: 'Nova',
    url: glb('nova.glb'),
    frame: { top: 1.645 },
    headPivot: [0, 0.085, 0.006],
    eyes: {
      centerL: [0.0403, 1.3752],
      centerR: [-0.0403, 1.3752],
      irisRadius: [0.0128, 0.017],
      gaze: [0.0072, 0.0045],
      iris: 'theme'
    },
    blush: 0.14,
    materials: {
      Skin: SKIN_FACE('#fff0e8', '#f4bfb2', '#b97b70'),
      'Skin:Body': { kind: 'toon', color: '#fff0e8', shade: '#efb6a8', rim: 0.25, step: 0.45, outline: ['#b97b70', 0.7] },
      Hair: { kind: 'hair', color: '#e6e3f4', shade: '#a9a1cc', outline: ['#8279a8', 0.85], tipMix: 1 },
      Eye_L: { kind: 'eyeL' },
      Eye_R: { kind: 'eyeR' },
      Mouth: { kind: 'mouth' },
      Blush: { kind: 'blush' },
      Accent: { kind: 'glow' },
      Lash: { kind: 'flat', color: '#2a1a26' },
      LashLower: { kind: 'flat', color: '#7a4c5c', opacity: 0.85 },
      Crease: { kind: 'flat', color: '#c99088', opacity: 0.6 },
      Brow: { kind: 'flat', color: '#8c7ea6', overHair: true },
      Cloth_White: { kind: 'toon', color: '#f1f3fa', shade: '#aeb8d6', double: true, rim: 0.22, outline: ['#5d678c', 0.8] },
      Cloth_Dark: { kind: 'toon', color: '#2b3254', shade: '#171b33', double: true, rim: 0.4, outline: ['#0a0c18', 0.8] },
      Ribbon: { kind: 'toon', color: '#ff86b0', shade: '#d9507f', double: true, rim: 0.3, outline: ['#8c2a50', 0.6] },
      Sock: { kind: 'toon', color: '#262838', shade: '#14151f', rim: 0.45, outline: ['#07080d', 0.8] },
      Shoe: { kind: 'toon', color: '#f6f7fb', shade: '#bcc4dc', outline: ['#5d678c', 0.8] },
      Sole: { kind: 'toon', color: '#33406b', shade: '#1e2647', outline: ['#0a0c18', 0.8] },
      Headset: { kind: 'toon', color: '#f8f9fd', shade: '#b6c0dc', rim: 0.4, outline: ['#5d678c', 0.7] },
      Headset_Dark: { kind: 'toon', color: '#2a3150', shade: '#161a2e', rim: 0.4, outline: ['#0a0c18', 0.6] }
    },
    springs: [
      { prefix: 'hair_back_C', stiffness: 0.85, drag: 0.32, gravity: 0.25, radius: 0.016, wind: 0.6 },
      { prefix: 'hair_back_L', stiffness: 0.85, drag: 0.32, gravity: 0.25, radius: 0.016, wind: 0.6 },
      { prefix: 'hair_back_R', stiffness: 0.85, drag: 0.32, gravity: 0.25, radius: 0.016, wind: 0.6 },
      { prefix: 'hair_side_L', stiffness: 1.1, drag: 0.38, gravity: 0.2, radius: 0.008, wind: 0.4 },
      { prefix: 'hair_side_R', stiffness: 1.1, drag: 0.38, gravity: 0.2, radius: 0.008, wind: 0.4 },
      { prefix: 'hair_ahoge', stiffness: 3.2, drag: 0.22, gravity: 0, radius: 0 }
    ],
    // a short skirt: crouch shallow, knees together, and lean for the rest
    stage: { crouchMax: 0.5, kneeOut: 0.02 },
    colliders: [
      { bone: 'head', at: [0, 1.405, -0.004], radius: 0.1 },
      { bone: 'neck', at: [0, 1.27, 0], radius: 0.038 },
      { bone: 'upperChest', at: [0, 1.15, -0.005], radius: 0.088 },
      { bone: 'chest', at: [0, 1.05, 0], radius: 0.088 },
      { bone: 'spine', at: [0, 0.96, 0], radius: 0.09 },
      { bone: 'hips', at: [0, 0.86, -0.005], radius: 0.11 },
      { bone: 'leftUpperArm', at: [0.15, 1.16, 0], radius: 0.055 },
      { bone: 'rightUpperArm', at: [-0.15, 1.16, 0], radius: 0.055 }
    ]
  },

  tsunade: {
    id: 'tsunade',
    label: 'Tsunade',
    url: glb('tsunade.glb'),
    frame: { top: 1.715 },
    headPivot: [0, 0.08, 0.006],
    eyes: {
      centerL: [0.0363, 1.5188],
      centerR: [-0.0363, 1.5188],
      irisRadius: [0.0104, 0.011],
      gaze: [0.0056, 0.0026],
      // hazel-brown, sampled from the reference
      iris: { base: '#93735a', deep: '#45301f', bright: '#cfab84' }
    },
    blush: 0.06,
    materials: {
      // the palette is sampled from the reference: warm peach skin, pale
      // beige-blonde hair, muted forest green, slate navy
      // the face, with the bolder ink jawline of the reference
      // (her sculpted profile's creases keep their ink off her face — see crease)
      Skin: SKIN_FACE('#f8dfd1', '#e0a993', '#8a5444', 0.75, 3),
      // a higher shading step than the face: the cleavage and the curves of
      // the chest pick up a soft shadow instead of reading flat
      'Skin:Body': { kind: 'toon', color: '#f8dfd1', shade: '#d9a08a', rim: 0.22, step: 0.56, outline: ['#9c6656', 0.7] },
      SkinLine: { kind: 'flat', color: '#c98c7c' },
      // the ink of the ear's folds and the nostril wings' creases (the
      // jawline's colour)
      EarLine: { kind: 'flat', color: '#8a5444', opacity: 0.85 },
      // the ears shade by their own shape (the face's sphere normals would
      // flatten them into the cheek): the bowl dips into shade, the rim stays lit
      'Skin:Ears': { kind: 'toon', color: '#f8dfd1', shade: '#dba08c', sphere: 0.25, rim: 0.18, step: 0.5, outline: ['#8a5444', 0.75] },
      // the soft shade in the bowl of each ear
      EarShade: { kind: 'soft', color: '#dfa592', opacity: 0.6, feather: [0.45, 0.45, 0.45, 0.45] },
      // the soft shade down the cleavage and under the kimono's edges
      SkinShade: { kind: 'flat', color: '#ecc2b1' },
      // the head's cel shadow on the neck (matches the body's shade colour)
      NeckShade: { kind: 'flat', color: '#dba38c' },
      // a soft shade under each collarbone
      CollarShade: { kind: 'soft', color: '#e2ab97', opacity: 0.55, feather: [0.35, 0.35, 0.5, 0.5] },
      Hair: { kind: 'hair', color: '#f0d8ae', shade: '#a9865c', outline: ['#6a5034', 0.85], tipMix: 0, fringeFade: false },
      Eye_L: { kind: 'eyeL' },
      Eye_R: { kind: 'eyeR' },
      // a firm brownish line, as the reference draws her closed mouth
      Mouth: { kind: 'mouth', line: '#93605a' },
      Blush: { kind: 'blush' },
      Lash: { kind: 'flat', color: '#1f130d' },
      LashLower: { kind: 'flat', color: '#6b4630', opacity: 0.85 },
      // the double-eyelid fold, the lid's shadow deepening into the socket by
      // the nose (uv.x inner → outer, uv.y lid → up), the pink inner corner
      Crease: { kind: 'flat', color: '#9c6a58', opacity: 0.8 },
      LidShade: { kind: 'soft', color: '#d29886', opacity: 0.55, feather: [0.3, 0.2, 0.02, 0.75] },
      Caruncle: { kind: 'flat', color: '#e9a6a3' },
      Brow: { kind: 'flat', color: '#9a7558', overHair: true },
      // full lips: the lower lip, the upper lip's soft bow over the line, a
      // gloss, and the soft shadow under the lower lip
      // (as the reference: from a few metres her mouth reads as the line over
      // a soft lower lip — the lips stay light, the upper one faint)
      Lips: { kind: 'flat', color: '#dd9b91' },
      LipUpper: { kind: 'soft', color: '#c97c7b', opacity: 0.55, feather: [0.22, 0.22, 0.02, 0.55] },
      LipLight: { kind: 'soft', color: '#f8d8d1', opacity: 0.7, feather: [0.45, 0.45, 0.45, 0.45] },
      LipShade: { kind: 'soft', color: '#c98d80', opacity: 0.45, feather: [0.35, 0.35, 0.75, 0.1] },
      Mark: { kind: 'flat', color: '#5f6cb4' },
      // the nose: a soft shadow down the bridge (fading in from the brows,
      // uv.x top → tip), its underside and a highlight on the tip
      NoseShadow: { kind: 'soft', color: '#cfae9d', opacity: 0.92, feather: [0.45, 0.25, 0.36, 0.36] },
      NoseUnder: { kind: 'soft', color: '#d6b2a0', opacity: 0.8, feather: [0.5, 0.5, 0.5, 0.5] },
      Nostril: { kind: 'soft', color: '#a88370', opacity: 0.75, feather: [0.45, 0.45, 0.45, 0.45] },
      // the nostril, as the reference draws it in profile: a short soft shade
      // on the side of the nose, gone as she turns to face you
      NoseLine: { kind: 'soft', color: '#b9796a', opacity: 0.85, feather: [0.3, 0.45, 0.5, 0.5], facing: [0.42, 0.72] },
      NoseLight: { kind: 'soft', color: '#fff6ef', opacity: 0.8, feather: [0.5, 0.5, 0.5, 0.5] },
      Nail: { kind: 'flat', color: '#d02a40' },
      // shaded on the underside and outer flanks of the bust (light comes from
      // above-right), which is what makes the figure read from the front
      Kimono: { kind: 'toon', color: '#c6beb8', shade: '#8a817d', double: true, rim: 0.2, step: 0.66, outline: ['#3a3434', 0.8] },
      Piping: { kind: 'flat', color: '#221e1f' },
      // the cel shadow under each breast + the ink line along its curve
      KimonoShadow: { kind: 'flat', color: '#8a817d' },
      KimonoFold: { kind: 'flat', color: '#463e3c' },
      Obi: { kind: 'toon', color: '#2b3750', shade: '#171d2c', rim: 0.3, outline: ['#0a0d14', 0.75] },
      ObiCord: { kind: 'flat', color: '#151b29' },
      Pants: { kind: 'toon', color: '#353b4e', shade: '#1d202b', double: true, rim: 0.3, outline: ['#0a0b10', 0.8] },
      Coat: { kind: 'toon', color: '#5c7c62', shade: '#36513e', double: true, rim: 0.22, outline: ['#1a281e', 0.85] },
      CoatTrim: { kind: 'toon', color: '#2c3229', shade: '#171a16', double: true, rim: 0.2, outline: ['#0a0c09', 0.6] },
      Sandal: { kind: 'toon', color: '#2c2428', shade: '#120e10', rim: 0.35, outline: ['#000000', 0.7] },
      HairTie: { kind: 'toon', color: '#9a7038', shade: '#6a4a22', outline: ['#3a2812', 0.5] }
    },
    springs: [
      { prefix: 'hair_tail_L', stiffness: 0.8, drag: 0.32, gravity: 0.3, radius: 0.03, wind: 0.6, group: 'hair' },
      { prefix: 'hair_tail_R', stiffness: 0.8, drag: 0.32, gravity: 0.3, radius: 0.03, wind: 0.6, group: 'hair' },
      { prefix: 'hair_lock_L', stiffness: 1.0, drag: 0.36, gravity: 0.25, radius: 0.012, wind: 0.35, group: 'hair' },
      { prefix: 'hair_lock_R', stiffness: 1.0, drag: 0.36, gravity: 0.25, radius: 0.012, wind: 0.35, group: 'hair' },
      // the haori's skirt swings round her, but never in through her tunic (it
      // hangs only ~3 cm off it at the hips), nor far out at hand height —
      // it swept through her hanging hand; the hem below swings out freely
      ...['FL', 'SL', 'BL', 'BR', 'SR', 'FR'].map((p) => ({
        prefix: `cloth_coat_${p}`,
        stiffness: 1.9,
        drag: 0.3,
        gravity: 0.18,
        radius: 0.015,
        wind: 1,
        group: 'cloth',
        inward: 0.01,
        outward: [0.012, 0.016, 0.02]
      })),
      // the tunic's skirt hangs from under the obi and her legs push it about:
      // it drapes over a striding thigh, and over both when she crouches
      ...['F_L', 'S_L', 'K_L', 'B_L', 'B_R', 'K_R', 'S_R', 'F_R'].map((p) => ({
        prefix: `cloth_tunic_${p}`,
        stiffness: 1.3,
        drag: 0.34,
        gravity: 0.22,
        radius: 0.012,
        wind: 0.4,
        group: 'tunic',
        inward: 0.006
      })),
      // gentle secondary motion: ~7° of sway on a hop or a quick gesture,
      // settling in under a second (tuned live in the app at 60 fps)
      { prefix: 'bust_L', stiffness: 0.5, drag: 0.1, gravity: 0, radius: 0, group: 'bust' },
      { prefix: 'bust_R', stiffness: 0.5, drag: 0.1, gravity: 0, radius: 0, group: 'bust' }
    ],
    breath: { bones: ['bust_L_1', 'bust_R_1'], degrees: 0.9, period: 4 },
    fingerLife: 4,
    restingHand: 'left',
    handPress: 'HipPress',
    pressHolds: ['cloth_coat_FL_1', 'cloth_coat_SL_1'],
    // her arms reach round her bust (fitted to the kimono over it: a sphere
    // each, swaying with it); the wide haori sleeves make her arms thick
    stage: {
      keepOut: [
        { bone: 'bust_L_1', at: [0.072, 1.236, 0.068], radius: 0.078 },
        { bone: 'bust_R_1', at: [-0.072, 1.236, 0.068], radius: 0.078 }
      ],
      armRadius: [0.045, 0.05, 0.035]
    },
    colliders: [
      { bone: 'head', at: [0, 1.54, 0], radius: 0.098 },
      { bone: 'neck', at: [0, 1.42, 0], radius: 0.045 },
      // the hair rests on the COAT, not the body: these follow its back,
      // shoulders, wide sleeves and the bust it drapes over
      { bone: 'upperChest', at: [0, 1.33, 0], radius: 0.108, groups: ['hair'] },
      { bone: 'chest', at: [0, 1.21, -0.005], radius: 0.108, groups: ['hair'] },
      { bone: 'chest', at: [0.08, 1.22, 0.088], radius: 0.086, groups: ['hair'] },
      { bone: 'chest', at: [-0.08, 1.22, 0.088], radius: 0.086, groups: ['hair'] },
      { bone: 'spine', at: [0, 1.1, 0], radius: 0.118, groups: ['hair'] },
      { bone: 'hips', at: [0, 0.97, -0.01], radius: 0.142, groups: ['hair'] },
      { bone: 'leftShoulder', at: [0.12, 1.37, -0.01], radius: 0.06, groups: ['hair'] },
      { bone: 'rightShoulder', at: [-0.12, 1.37, -0.01], radius: 0.06, groups: ['hair'] },
      { bone: 'leftUpperArm', at: [0.21, 1.3, 0], radius: 0.07, groups: ['hair'] },
      { bone: 'rightUpperArm', at: [-0.21, 1.3, 0], radius: 0.07, groups: ['hair'] },
      { bone: 'leftUpperArm', at: [0.29, 1.23, 0], radius: 0.075, groups: ['hair'] },
      { bone: 'rightUpperArm', at: [-0.29, 1.23, 0], radius: 0.075, groups: ['hair'] },
      // the coat's skirt swings around the hips and legs — and never through
      // the tunic under it (these hug the tunic, clear of the coat at rest)
      { bone: 'hips', at: [0.08, 0.96, 0], radius: 0.11, groups: ['cloth'] },
      { bone: 'hips', at: [-0.08, 0.96, 0], radius: 0.11, groups: ['cloth'] },
      { bone: 'hips', at: [0.09, 0.98, 0.04], radius: 0.05, groups: ['cloth'] },
      { bone: 'hips', at: [-0.09, 0.98, 0.04], radius: 0.05, groups: ['cloth'] },
      { bone: 'hips', at: [0.09, 0.86, 0.04], radius: 0.05, groups: ['cloth'] },
      { bone: 'hips', at: [-0.09, 0.86, 0.04], radius: 0.05, groups: ['cloth'] },
      { bone: 'leftUpperLeg', at: [0.09, 0.8, 0], radius: 0.085, groups: ['cloth'] },
      { bone: 'rightUpperLeg', at: [-0.09, 0.8, 0], radius: 0.085, groups: ['cloth'] },
      { bone: 'leftUpperLeg', at: [0.088, 0.62, 0], radius: 0.075, groups: ['cloth'] },
      { bone: 'rightUpperLeg', at: [-0.088, 0.62, 0], radius: 0.075, groups: ['cloth'] },
      { bone: 'leftLowerLeg', at: [0.083, 0.5, 0], radius: 0.065, groups: ['cloth'] },
      { bone: 'rightLowerLeg', at: [-0.083, 0.5, 0], radius: 0.065, groups: ['cloth'] },
      { bone: 'leftLowerLeg', at: [0.08, 0.34, 0], radius: 0.055, groups: ['cloth'] },
      { bone: 'rightLowerLeg', at: [-0.08, 0.34, 0], radius: 0.055, groups: ['cloth'] },
      // the tunic's skirt rests on her thighs (and knees, when she crouches):
      // clear of it while she stands, pushing it once a leg swings forward
      ...([1, -1] as const).flatMap((s) => {
        const bone = s > 0 ? 'leftUpperLeg' : 'rightUpperLeg'
        return [
          { bone, at: [s * 0.09, 0.84, 0] as [number, number, number], radius: 0.078, groups: ['tunic'] },
          { bone, at: [s * 0.088, 0.73, 0] as [number, number, number], radius: 0.072, groups: ['tunic'] },
          { bone, at: [s * 0.086, 0.63, 0] as [number, number, number], radius: 0.064, groups: ['tunic'] },
          { bone: s > 0 ? 'leftLowerLeg' : 'rightLowerLeg', at: [s * 0.084, 0.535, 0.01] as [number, number, number], radius: 0.058, groups: ['tunic'] }
        ]
      })
    ]
  }
}

/** the avatars whose model is actually bundled */
export const AVATARS: Partial<Record<AvatarId, AvatarConfig>> = Object.fromEntries(
  Object.entries(LIBRARY).filter(([, cfg]) => cfg.url) as [AvatarId, AvatarConfig][]
)

export const AVATAR_IDS = Object.keys(AVATARS) as AvatarId[]

/** the requested avatar, or the first bundled one (null when none ship) */
export function resolveAvatar(id: AvatarId): AvatarConfig | null {
  return AVATARS[id] ?? AVATARS[AVATAR_IDS[0]] ?? null
}
