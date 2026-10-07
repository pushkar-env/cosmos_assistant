import * as THREE from 'three'

/*
 * Anime cel-shading for the Nova avatar.
 *
 * Every material here is a ShaderMaterial built on three's own skinning /
 * morph chunks, so the GPU does the skeletal + blendshape deformation and the
 * shading stays independent of scene lights: one key-light direction (view
 * space) shared by every material, a hard-ish two-tone ramp, a theme-tinted
 * fresnel rim and an optional emissive term. Shared uniforms are single
 * objects referenced by every material, so one write per frame updates all.
 */

/** how many HUD cards the shaders can cut her out behind (the HUD has seven) */
export const CUT_SLOTS = 8
/** how many tubes draped cloth can be kept out of (two down each thigh) */
export const DRAPE_SLOTS = 4

export const shared = {
  uLightDir: { value: new THREE.Vector3(0.35, 0.55, 0.75).normalize() },
  uRimColor: { value: new THREE.Color('#7df9ff') },
  uAccent: { value: new THREE.Color('#22d3ee') },
  uAccentBright: { value: new THREE.Color('#7df9ff') },
  uTime: { value: 0 },
  /** 0..1 live voice envelope — the glowing trims breathe with her voice */
  uVoice: { value: 0 },
  /** head pivot in world space — drives the face's spherical normals */
  uHeadCenter: { value: new THREE.Vector3(0, 1.4, 0) },
  /** how far the loaded avatar's head (rest pose) sits above Nova's — the
   *  hair shading bands below are tuned in Nova's heights and shift with it */
  uHeadShift: { value: 0 },
  /** 0 = solid … 1 = gone: she dissolves (teleporting) */
  uDissolve: { value: 0 },
  /** 0 = scattered noise, 1 = a seam sweeping up from her feet */
  uDissolveSweep: { value: 0 },
  /** the HUD cards while she's up and about (her canvas is then above the
   *  HUD): each a rounded rect on screen — centre x, y (drawing-buffer px,
   *  from the bottom left), half width, half height — and its angle (rad),
   *  corner radius (px), whether it's on, and the world z of the card's
   *  plane. The cards are on the glass in front of her, so inside one all of
   *  her is cut away (the card is DOM, under the canvas) but her hands where
   *  they are in front of its plane: a hand holding it from behind is hidden
   *  but for the thumb wrapped round its edge onto its face (and a thick
   *  sleeve never pokes through it) */
  uCut: { value: Array.from({ length: CUT_SLOTS }, () => new THREE.Vector4()) },
  uCutShape: { value: Array.from({ length: CUT_SLOTS }, () => new THREE.Vector4()) },
  /** per skin joint (packed 4 to a vec4): 1 for her hands and fingers */
  uHandBones: { value: Array.from({ length: 32 }, () => new THREE.Vector4()) },
  /** the tubes round her thighs that draped cloth (a skirt) is laid over:
   *  each from A to B in world space, its radius there in w (A.w < 0: unused).
   *  Updated every frame from her leg bones (see AvatarConfig.drape) */
  uDrapeA: { value: Array.from({ length: DRAPE_SLOTS }, () => new THREE.Vector4(0, 0, 0, -1)) },
  uDrapeB: { value: Array.from({ length: DRAPE_SLOTS }, () => new THREE.Vector4(0, 0, 0, -1)) }
}

/*
 * Cloth draped over her legs. A skirt hangs from a handful of spring chains,
 * and between two of them the cloth runs straight: when a crouch or a stride
 * brings a thigh up under it, the springs keep the chains (and the straight
 * runs between them) off the thigh, but the round of the thigh still pokes a
 * few millimetres through here and there. So after skinning, a vertex inside
 * one of the leg tubes is moved straight out of it to lie on top, `uDrape`
 * clear (the cloth's thickness over the trousers), its normal turning toward
 * the tube's as it does — the cloth shades like the leg it lies on. Off (and
 * the cloth exactly as skinned) wherever it hangs clear of her legs: all of
 * it while she stands.
 */
const DRAPE_PARS = /* glsl */ `
  #ifdef DRAPE
    uniform vec4 uDrapeA[${DRAPE_SLOTS}];
    uniform vec4 uDrapeB[${DRAPE_SLOTS}];
    uniform float uDrape;
    // pos and nrm in the mesh's space; modelMatrix is rigid (her root)
    void drape(inout vec3 pos, inout vec3 nrm) {
      vec3 wp = (modelMatrix * vec4(pos, 1.0)).xyz;
      vec3 move = vec3(0.0);
      vec3 away = vec3(0.0);
      float bend = 0.0;
      for (int i = 0; i < ${DRAPE_SLOTS}; i++) {
        vec4 a = uDrapeA[i];
        if (a.w < 0.0) continue;
        vec4 b = uDrapeB[i];
        vec3 ab = b.xyz - a.xyz;
        float len = max(length(ab), 1e-5);
        vec3 p = wp + move;
        float s = dot(p - a.xyz, ab) / len;
        float t = clamp(s / len, 0.0, 1.0);
        vec3 d = p - (a.xyz + ab * t);
        float dist = length(d);
        // open at A: above her hip joint the skirt narrows to her waist
        float depth = (mix(a.w, b.w, t) + uDrape - dist) * smoothstep(-0.03, 0.0, s);
        if (depth > 0.0 && dist > 1e-5) {
          vec3 dir = d / dist;
          move += dir * depth;
          float k = smoothstep(0.0, 0.006, depth);
          if (k > bend) {
            bend = k;
            away = dir;
          }
        }
      }
      mat3 back = transpose(mat3(modelMatrix));
      pos += back * move;
      if (bend > 0.0) nrm = normalize(mix(nrm, back * away, bend));
    }
  #endif
`

const drapeUniforms = (clearance: number | undefined): Record<string, THREE.IUniform> =>
  clearance === undefined
    ? {}
    : { uDrape: { value: clearance }, uDrapeA: shared.uDrapeA, uDrapeB: shared.uDrapeB }

const drapeDefines = (clearance: number | undefined): Record<string, string> =>
  clearance === undefined ? {} : { DRAPE: '' }

/** the card cut-outs (see shared.uCut) — for any fragment shader */
export const STAGE_CUT = /* glsl */ `
  uniform vec4 uCut[${CUT_SLOTS}];
  uniform vec4 uCutShape[${CUT_SLOTS}];
  float cutBox(vec4 c, vec4 sh) {
    if (sh.z < 0.5) return 0.0;
    vec2 d = gl_FragCoord.xy - c.xy;
    float ca = cos(sh.x);
    float sa = sin(sh.x);
    d = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y);
    vec2 q = abs(d) - c.zw + sh.y;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - sh.y < 0.0 ? 1.0 : 0.0;
  }
  // inside any card (the backdrop: all of it is behind the cards)
  float inCut() {
    float k = 0.0;
    for (int i = 0; i < ${CUT_SLOTS}; i++) k = max(k, cutBox(uCut[i], uCutShape[i]));
    return k;
  }
  // inside a card whose plane is in front of world depth z
  float cutBehind(float z) {
    float k = 0.0;
    for (int i = 0; i < ${CUT_SLOTS}; i++) {
      if (z < uCutShape[i].w) k = max(k, cutBox(uCut[i], uCutShape[i]));
    }
    return k;
  }
`

export const cutUniforms = (): Record<string, THREE.IUniform> => ({
  uCut: shared.uCut,
  uCutShape: shared.uCutShape
})

/*
 * The teleport dissolve, shared by every material: fragments vanish by a
 * noise threshold on the REST position (so the pattern sticks to her body as
 * she moves), with a glowing seam along the edge.
 */
const DISSOLVE = /* glsl */ `
  uniform float uDissolve;
  uniform float uDissolveSweep;
  varying float vCutZ;
  varying float vHand;
  ${STAGE_CUT}
  float dHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float dNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(dHash(i), dHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(dHash(i + vec3(0.0, 1.0, 0.0)), dHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(dHash(i + vec3(0.0, 0.0, 1.0)), dHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(dHash(i + vec3(0.0, 1.0, 1.0)), dHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
      f.z);
  }
  // discards what has dissolved (or lies behind one of the HUD's cards);
  // returns the glowing seam (0..1)
  float dissolveSeam(vec3 p) {
    if ((vHand < 0.5 && inCut() > 0.5) || cutBehind(vCutZ) > 0.5) discard;
    if (uDissolve <= 0.0) return 0.0;
    float n = dNoise(p * 34.0) * 0.62 + dNoise(p * 97.0) * 0.38;
    // re-forming: the seam rises from her feet, ragged by the noise
    float h = 1.0 - clamp(p.y / 1.75, 0.0, 1.0);
    float v = mix(n, h * 0.82 + n * 0.18, uDissolveSweep);
    float d = v - (uDissolve * 1.1 - 0.05);
    if (d < 0.0) discard;
    return 1.0 - smoothstep(0.0, 0.06, d);
  }
`

const dissolveUniforms = (): Record<string, THREE.IUniform> => ({
  uDissolve: shared.uDissolve,
  uDissolveSweep: shared.uDissolveSweep,
  uAccentBright: shared.uAccentBright,
  uHandBones: shared.uHandBones,
  ...cutUniforms()
})

/** the head-pivot height the hair bands in the shaders were tuned for */
export const HAIR_BAND_HEAD_Y = 1.4

/** how much of a vertex rides on her hand/finger bones (vHand) */
const HAND_PARS = /* glsl */ `
  uniform vec4 uHandBones[32];
  varying float vHand;
  float handOf(float idx) {
    int i = int(idx + 0.5);
    return uHandBones[i / 4][i - (i / 4) * 4];
  }
`
const HAND_VERT = /* glsl */ `
  #ifdef USE_SKINNING
    vHand = dot(skinWeight, vec4(handOf(skinIndex.x), handOf(skinIndex.y), handOf(skinIndex.z), handOf(skinIndex.w)));
  #else
    vHand = 0.0;
  #endif
`

const VERT_COMMON = /* glsl */ `
  #include <common>
  #include <morphtarget_pars_vertex>
  #include <skinning_pars_vertex>
  ${HAND_PARS}
  ${DRAPE_PARS}
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;
  varying vec3 vObjPos;
  varying vec2 vUv2;
  varying float vCutZ;
`

const VERT_BODY = /* glsl */ `
  vUv2 = uv;
  ${HAND_VERT}
  #include <morphinstance_vertex>
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  vObjPos = transformed;
  #include <skinning_vertex>
  #ifdef DRAPE
    drape(transformed, objectNormal);
    transformedNormal = normalMatrix * objectNormal;
    #ifdef FLIP_SIDED
      transformedNormal = -transformedNormal;
    #endif
  #endif
  #include <project_vertex>
  vNormalV = normalize(transformedNormal);
  vViewPos = -mvPosition.xyz;
  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vCutZ = vWorldPos.z;
`

const TOON_VERT = /* glsl */ `
  ${VERT_COMMON}
  void main() {
    ${VERT_BODY}
  }
`

const TOON_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uShade;
  uniform float uStep;
  uniform float uSoft;
  uniform vec3 uLightDir;
  uniform vec3 uRimColor;
  uniform float uRim;
  uniform vec3 uEmissive;
  uniform float uOpacity;
  uniform float uSphere;
  uniform vec3 uHeadCenter;
  uniform float uHair;
  uniform vec3 uAccent;
  uniform vec3 uAccentBright;
  uniform float uTipMix;
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;
  varying vec3 vObjPos;
  varying vec2 vUv2;
  ${DISSOLVE}

  void main() {
    float seam = dissolveSeam(vObjPos);
    vec3 n = normalize(vNormalV);
    if (!gl_FrontFacing) n = -n;
    // anime faces: bend normals toward a sphere around the head so the face
    // shades as one soft volume instead of picking up every bump
    // (hair uses it too, but only over the skull — the long locks keep
    // their own strand normals)
    float sphereK = uSphere;
    // height on Nova's scale, measured from her head as it is now — the bands
    // ride along when she bows or crouches
    float hy = vWorldPos.y - (uHeadCenter.y - ${HAIR_BAND_HEAD_Y.toFixed(2)});
    if (uHair > 0.0) sphereK *= smoothstep(1.22, 1.33, hy);
    if (sphereK > 0.0) {
      vec3 sn = normalize((viewMatrix * vec4(normalize(vWorldPos - uHeadCenter), 0.0)).xyz);
      n = normalize(mix(n, sn, sphereK));
    }
    vec3 v = normalize(vViewPos);
    float ndl = dot(n, uLightDir) * 0.5 + 0.5;
    float lit = smoothstep(uStep - uSoft, uStep + uSoft, ndl);
    vec3 base = uColor;
    vec3 shade = uShade;

    if (uHair > 0.0) {
      // silver → theme-coloured ends on the long locks (uv.y: root 0 → tip 1);
      // the fringe and crown stay silver
      float tip = smoothstep(0.45, 1.0, vUv2.y) * smoothstep(1.32, 1.12, hy) * uTipMix;
      base = mix(base, mix(base, uAccentBright, 0.75), tip);
      shade = mix(shade, uAccent * 0.75, tip);
    }

    vec3 col = mix(shade, base, lit);
    // a whisper of the shade colour in the light too keeps it soft, not flat
    col = mix(col, shade, 0.08 * (1.0 - ndl));

    if (uHair > 0.0) {
      // angel ring: a jagged band of specular where the view grazes the crown
      vec3 h = normalize(uLightDir + v);
      float spec = dot(n, h);
      float jag = 0.06 * sin(vUv2.x * 6.2831 * 3.0 + vWorldPos.y * 40.0);
      float ring = smoothstep(0.86 + jag, 0.9 + jag, spec) * (1.0 - smoothstep(0.94, 0.975, spec));
      ring *= smoothstep(1.34, 1.44, hy);
      col += vec3(1.0, 0.98, 1.0) * ring * 0.35 * uHair;
    }

    // fresnel rim — the holographic COSMOS edge light
    float fres = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
    col += uRimColor * fres * uRim * (0.45 + 0.55 * lit);
    col += uEmissive;
    col = mix(col, uAccentBright * 1.6 + 0.25, seam);
    gl_FragColor = vec4(col, uOpacity);
    #include <colorspace_fragment>
  }
`

export interface ToonOptions {
  color: string
  shade: string
  step?: number
  soft?: number
  rim?: number
  emissive?: string
  opacity?: number
  sphere?: number
  hair?: boolean
  /** hair only: 0..1 how strongly strand ends take the theme colour */
  tipMix?: number
  doubleSided?: boolean
  transparent?: boolean
  /** cloth draped over her legs: how far (m) it's kept outside them */
  drape?: number
}

export function toonMaterial(o: ToonOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: TOON_FRAG,
    defines: drapeDefines(o.drape),
    uniforms: {
      ...drapeUniforms(o.drape),
      uColor: { value: new THREE.Color(o.color) },
      uShade: { value: new THREE.Color(o.shade) },
      uStep: { value: o.step ?? 0.5 },
      uSoft: { value: o.soft ?? 0.035 },
      uRim: { value: o.rim ?? 0.35 },
      uEmissive: { value: new THREE.Color(o.emissive ?? '#000000') },
      uOpacity: { value: o.opacity ?? 1 },
      uSphere: { value: o.sphere ?? 0 },
      uHair: { value: o.hair ? 1 : 0 },
      uTipMix: { value: o.hair ? (o.tipMix ?? 1) : 0 },
      uLightDir: shared.uLightDir,
      uRimColor: shared.uRimColor,
      uHeadCenter: shared.uHeadCenter,
      uAccent: shared.uAccent,
      ...dissolveUniforms()
    },
    side: o.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    transparent: o.transparent ?? false
  })
}

/* ── flat unlit detail (lashes, brows, creases) ─────────────────────── */

/** decals drawn on a surface that faces sideways (a line on the side of the
 *  nose) can fade out as it turns away from the camera: fully drawn when the
 *  surface faces it more than uFacing.y, gone below uFacing.x (off: 0, 0) */
const FACING = /* glsl */ `
  uniform vec2 uFacing;
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  float facingFade() {
    if (uFacing.y <= 0.0) return 1.0;
    float f = abs(dot(normalize(vNormalV), normalize(vViewPos)));
    return smoothstep(uFacing.x, uFacing.y, f);
  }
`

const FLAT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform vec3 uAccentBright;
  varying vec3 vObjPos;
  ${DISSOLVE}
  ${FACING}
  void main() {
    float seam = dissolveSeam(vObjPos);
    gl_FragColor = vec4(mix(uColor, uAccentBright * 1.6 + 0.25, seam), uOpacity * facingFade());
    #include <colorspace_fragment>
  }
`

export function flatMaterial(
  color: string,
  opacity = 1,
  overHair = false,
  facing?: [number, number],
  drape?: number
): THREE.ShaderMaterial {
  const fades = opacity < 1 || !!facing
  const m = new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: FLAT_FRAG,
    defines: drapeDefines(drape),
    uniforms: {
      ...drapeUniforms(drape),
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uFacing: { value: new THREE.Vector2(...(facing ?? [0, 0])) },
      ...dissolveUniforms()
    },
    transparent: fades,
    depthWrite: !fades
  })
  if (overHair) {
    // brows are drawn over the fringe — an anime convention — by testing
    // against a depth biased toward the camera
    m.polygonOffset = true
    m.polygonOffsetFactor = -40
    m.polygonOffsetUnits = -400
  }
  return m
}

/* ── soft painted shading (lid shadow, nose shading, lip gloss) ────── */

const SOFT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform vec4 uFeather; // uv.x 0 / 1 edge, uv.y 0 / 1 edge (as generated)
  uniform vec3 uAccentBright;
  varying vec2 vUv2;
  varying vec3 vObjPos;
  ${DISSOLVE}
  ${FACING}
  void main() {
    float seam = dissolveSeam(vObjPos);
    vec4 f = max(uFeather, vec4(1e-4));
    vec2 uv = vec2(vUv2.x, 1.0 - vUv2.y); // glTF stores v flipped
    float a = uOpacity * facingFade()
      * smoothstep(0.0, f.x, uv.x) * smoothstep(0.0, f.y, 1.0 - uv.x)
      * smoothstep(0.0, f.z, uv.y) * smoothstep(0.0, f.w, 1.0 - uv.y);
    gl_FragColor = vec4(mix(uColor, uAccentBright * 1.6 + 0.25, seam), a);
    #include <colorspace_fragment>
  }
`

/** an unlit decal whose edges fade out over its UV square (each feather is
 *  the share of the square, from that edge, over which it fades in) */
export function softMaterial(
  color: string,
  opacity: number,
  feather: [number, number, number, number],
  facing?: [number, number]
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: SOFT_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uFeather: { value: new THREE.Vector4(...feather) },
      uFacing: { value: new THREE.Vector2(...(facing ?? [0, 0])) },
      ...dissolveUniforms()
    },
    transparent: true,
    depthWrite: false
  })
}

/* ── glowing trims ─────────────────────────────────────────────────── */

const GLOW_FRAG = /* glsl */ `
  uniform vec3 uAccent;
  uniform vec3 uAccentBright;
  uniform float uTime;
  uniform float uVoice;
  varying vec3 vWorldPos;
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  varying vec3 vObjPos;
  ${DISSOLVE}
  void main() {
    float seam = dissolveSeam(vObjPos);
    // a slow energy pulse travelling down the outfit, lifted by her voice
    float wave = 0.5 + 0.5 * sin(vWorldPos.y * 14.0 - uTime * 2.2);
    float k = 0.65 + 0.25 * wave + 0.6 * uVoice;
    vec3 col = mix(uAccent, uAccentBright, 0.35 + 0.35 * wave) * k;
    col = mix(col, uAccentBright * 1.6 + 0.25, seam);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

export function glowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: {
      uAccent: shared.uAccent,
      uTime: shared.uTime,
      uVoice: shared.uVoice,
      ...dissolveUniforms()
    },
    side: THREE.DoubleSide
  })
}

/* ── eyes ──────────────────────────────────────────────────────────── */

const EYE_FRAG = /* glsl */ `
  uniform vec2 uCenter;
  uniform vec2 uGaze;
  uniform vec2 uIrisR;
  uniform vec3 uIris;
  uniform vec3 uIrisBright;
  uniform float uTime;
  uniform float uPupil;
  uniform float uSparkle;
  uniform float uSeed;
  uniform vec3 uAccentBright;
  varying vec3 vObjPos;
  varying vec2 vUv2;
  ${DISSOLVE}

  float star(vec2 p, float r) {
    // a soft four-point twinkle
    p = abs(p) / r;
    float d = pow(p.x, 0.5) + pow(p.y, 0.5);
    return 1.0 - smoothstep(0.85, 1.0, d);
  }

  void main() {
    float seam = dissolveSeam(vObjPos);
    // iris placement uses the MORPHED (pre-skin) position: closing lids
    // shrink the mesh and simply cover the iris, like a real eyelid
    vec2 q = vObjPos.xy;
    vec2 p = (q - (uCenter + uGaze)) / uIrisR;
    float d = length(p);
    // the generator's uv.y runs lower lid 0 → upper lid 1; glTF stores v
    // flipped, so it arrives as 1 − that
    float vy = 1.0 - vUv2.y;
    float lid = smoothstep(0.52, 1.0, vy);       // under the upper lid
    float lower = smoothstep(0.18, 0.0, vy);     // along the lower lid

    vec3 sclera = vec3(0.975, 0.98, 1.0);
    sclera = mix(sclera, vec3(0.72, 0.76, 0.90), lid * 0.85);
    sclera = mix(sclera, vec3(0.90, 0.88, 0.95), lower * 0.4);
    vec3 col = sclera;

    vec3 deep = uIris * 0.22 + vec3(0.02, 0.02, 0.06);
    vec3 mid = uIris * 0.85;
    vec3 light = mix(uIrisBright, vec3(1.0), 0.15);
    // iris: deep at the top, bright toward the bottom, radial fibres
    float g = clamp(p.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 iris = mix(light, mid, smoothstep(0.05, 0.55, g));
    iris = mix(iris, deep, smoothstep(0.55, 1.0, g));
    float ang = atan(p.y, p.x);
    float fib = 0.5 + 0.5 * sin(ang * 26.0 + sin(ang * 5.0 + uSeed) * 2.5);
    iris *= 0.88 + 0.16 * fib * smoothstep(0.3, 0.9, d);
    // the glowing crescent along the bottom of the iris
    iris += uIrisBright * 0.55 * smoothstep(0.35, 0.95, d) * smoothstep(-0.05, -0.75, p.y);
    // limbal ring
    iris = mix(iris, deep * 0.6, smoothstep(0.80, 0.97, d));
    // pupil — a soft vertical oval
    float pd = length((p - vec2(0.0, 0.08)) * vec2(1.25, 0.95)) / (0.34 * uPupil);
    iris = mix(iris, deep * 0.45, 1.0 - smoothstep(0.82, 1.0, pd));
    iris *= 1.0 - 0.5 * lid;
    col = mix(col, iris, 1.0 - smoothstep(0.965, 1.0, d));

    // highlights: one big soft catch-light, one small, ride with the iris
    vec2 hq = (q - (uCenter + uGaze * 0.85)) / uIrisR;
    float h1 = 1.0 - smoothstep(0.20, 0.27, length((hq - vec2(-0.36, 0.40)) * vec2(1.0, 0.85)));
    float h2 = 1.0 - smoothstep(0.08, 0.12, length(hq - vec2(0.36, -0.36)));
    float tw = 0.85 + 0.15 * sin(uTime * 2.6 + uSeed * 3.0);
    col = mix(col, vec3(1.0), clamp(h1 * 0.95 + h2 * 0.85 * tw, 0.0, 1.0) * (1.0 - lid * 0.6));

    // excited eyes: twinkling stars in the iris
    if (uSparkle > 0.01) {
      float s1 = star(hq - vec2(0.12, 0.05), 0.62 * (0.85 + 0.15 * sin(uTime * 7.0)));
      float s2 = star(hq - vec2(-0.40, -0.42), 0.26 * (0.85 + 0.15 * sin(uTime * 9.0 + 1.3)));
      col = mix(col, vec3(1.0), clamp(s1 + s2, 0.0, 1.0) * uSparkle * step(d, 1.0));
    }
    col = mix(col, uAccentBright * 1.6 + 0.25, seam);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

/**
 * Procedural anime eye. ``iris`` null → the iris follows the COSMOS theme
 * accent; otherwise a fixed [base, bright] colour pair.
 */
export function eyeMaterial(
  center: THREE.Vector2,
  seed: number,
  irisRadius: THREE.Vector2,
  iris: [THREE.Color, THREE.Color] | null
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: EYE_FRAG,
    uniforms: {
      uCenter: { value: center },
      uGaze: { value: new THREE.Vector2() },
      uIrisR: { value: irisRadius },
      uIris: iris ? { value: iris[0] } : shared.uAccent,
      uIrisBright: iris ? { value: iris[1] } : shared.uAccentBright,
      uTime: shared.uTime,
      uPupil: { value: 1 },
      uSparkle: { value: 0 },
      uSeed: { value: seed },
      ...dissolveUniforms()
    }
  })
}

/* ── mouth ─────────────────────────────────────────────────────────── */

const MOUTH_FRAG = /* glsl */ `
  uniform float uOpen;
  uniform float uTeeth;
  uniform vec3 uLine;
  uniform vec3 uAccentBright;
  varying vec2 vUv2;
  varying vec3 vObjPos;
  ${DISSOLVE}
  void main() {
    float seam = dissolveSeam(vObjPos);
    vec3 line = uLine;
    vec3 deep = vec3(0.20, 0.04, 0.08);
    // uv.y: bottom 0 → top 1 as generated (glTF stores v flipped)
    float vy = 1.0 - vUv2.y;
    vec3 inner = mix(deep, vec3(0.42, 0.10, 0.15), smoothstep(0.0, 0.7, vy));
    // tongue rests low and centred
    float t = length(vec2((vUv2.x - 0.5) * 1.5, (vy + 0.05) * 1.7));
    inner = mix(inner, vec3(0.93, 0.47, 0.52), (1.0 - smoothstep(0.42, 0.55, t)) * 0.9);
    // upper teeth: a soft white band under the top lip
    float teeth = smoothstep(0.74, 0.86, vy) * smoothstep(0.10, 0.24, vUv2.x) * smoothstep(0.90, 0.76, vUv2.x);
    inner = mix(inner, vec3(1.0, 0.985, 0.98), teeth * uTeeth);
    vec3 col = mix(line, inner, smoothstep(0.02, 0.25, uOpen));
    col = mix(col, uAccentBright * 1.6 + 0.25, seam);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

/** the mouth; `line` is the colour of the closed mouth's line (sRGB hex) */
export function mouthMaterial(line?: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: MOUTH_FRAG,
    uniforms: {
      uOpen: { value: 0 },
      uTeeth: { value: 0 },
      uLine: { value: line ? new THREE.Color(line) : new THREE.Color(0.47, 0.2, 0.24) },
      ...dissolveUniforms()
    }
  })
}

/* ── blush ─────────────────────────────────────────────────────────── */

const BLUSH_FRAG = /* glsl */ `
  uniform float uAmount;
  uniform float uLines;
  uniform vec3 uAccentBright;
  varying vec2 vUv2;
  varying vec3 vObjPos;
  ${DISSOLVE}
  void main() {
    float seam = dissolveSeam(vObjPos);
    vec2 c = (vUv2 - 0.5) * 2.0;
    float r = length(c);
    float a = (1.0 - smoothstep(0.15, 1.0, r)) * uAmount * 0.6;
    vec3 col = vec3(1.0, 0.52, 0.62);
    // the bashful hatch lines ///
    float stripe = abs(fract((c.x * 0.9 + c.y * 0.55) * 2.2) - 0.5);
    float lines = (1.0 - smoothstep(0.05, 0.11, stripe)) * (1.0 - smoothstep(0.45, 0.62, r)) * uLines;
    col = mix(col, vec3(0.93, 0.33, 0.45), lines);
    a = max(a, lines * 0.85);
    gl_FragColor = vec4(col, a * (1.0 - seam));
    #include <colorspace_fragment>
  }
`

export function blushMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: BLUSH_FRAG,
    uniforms: { uAmount: { value: 0.15 }, uLines: { value: 0 }, ...dissolveUniforms() },
    transparent: true,
    depthWrite: false
  })
}

/* ── inverted-hull outline ─────────────────────────────────────────── */

const OUTLINE_VERT = /* glsl */ `
  #include <common>
  #include <morphtarget_pars_vertex>
  #include <skinning_pars_vertex>
  uniform float uWidth;
  uniform float uTipTaper;
  uniform float uFringe;
  uniform float uHeadShift;
  uniform float uCrease;
  varying vec3 vRest;
  varying float vCutZ;
  ${HAND_PARS}
  ${DRAPE_PARS}
  void main() {
    ${HAND_VERT}
    #include <morphinstance_vertex>
    #include <beginnormal_vertex>
    #include <morphnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <morphtarget_vertex>
    vec3 restPos = transformed;
    vRest = restPos;
    #include <skinning_vertex>
    #ifdef DRAPE
      // the line wraps the cloth where it lies over a leg
      drape(transformed, objectNormal);
    #endif
    #include <project_vertex>
    vCutZ = (modelMatrix * vec4(transformed, 1.0)).z;
    // push the back faces out along the view-space normal, scaled with depth
    // so the line keeps a steady on-screen weight as the camera moves.
    // (normalMatrix by hand: defaultnormal_vertex would flip it for BackSide)
    vec3 nv = normalize(normalMatrix * objectNormal);
    // hair strands thin their line toward the pointed tips (uv.y → 1), or
    // the hull pokes out of every tip like a dark drip
    float taper = 1.0 - uTipTaper * smoothstep(0.5, 0.95, uv.y);
    // ...and fade out entirely where the fringe lies over the face (rest
    // pose: in front of the forehead, below the hairline), where the hull
    // would show between strand and skin
    float fringe = smoothstep(0.035, 0.065, restPos.z) * (1.0 - smoothstep(1.40, 1.445, restPos.y - uHeadShift));
    taper *= 1.0 - uFringe * fringe;
    float push = uWidth * taper * (-mvPosition.z) * 0.0016;
    mvPosition.xyz += nv * push;
    // the face's creases — under the nose, between the lips, over the chin:
    // a hull folding out of one draws over her own skin (from the usual
    // camera, below her face, the hull of the up-facing upper lip shows in
    // the pocket under the nose as a dark band — a "moustache"). Pushed back
    // along the view ray it hides behind the skin; on a profile there is only
    // background behind it, so the line stays. (Head-local rest space: the
    // nose and mouth, a little in front of the face's sides.)
    if (uCrease > 0.0) {
      vec3 hp = restPos - vec3(0.0, ${HAIR_BAND_HEAD_Y.toFixed(2)} + uHeadShift, 0.0);
      float m = (1.0 - smoothstep(0.026, 0.04, abs(hp.x)))
        * smoothstep(-0.118, -0.104, hp.y) * (1.0 - smoothstep(-0.058, -0.048, hp.y))
        * smoothstep(0.03, 0.05, hp.z);
      mvPosition.z -= push * uCrease * m;
    }
    gl_Position = projectionMatrix * mvPosition;
  }
`

const OUTLINE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uAccentBright;
  varying vec3 vRest;
  ${DISSOLVE}
  void main() {
    float seam = dissolveSeam(vRest);
    gl_FragColor = vec4(mix(uColor, uAccentBright * 1.4, seam), 1.0);
    #include <colorspace_fragment>
  }
`

/** ``fringe``: fade the line where bangs lie over the face (see the shader);
 *  ``drape``: the line of cloth draped over her legs (see toonMaterial) */
export function outlineMaterial(
  color: string,
  width: number,
  tipTaper = 0,
  fringe = tipTaper,
  crease = 0,
  drape?: number
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    defines: drapeDefines(drape),
    uniforms: {
      ...drapeUniforms(drape),
      uColor: { value: new THREE.Color(color) },
      uWidth: { value: width },
      uTipTaper: { value: tipTaper },
      uFringe: { value: fringe },
      uCrease: { value: crease },
      uHeadShift: shared.uHeadShift,
      ...dissolveUniforms()
    },
    side: THREE.BackSide
  })
}
