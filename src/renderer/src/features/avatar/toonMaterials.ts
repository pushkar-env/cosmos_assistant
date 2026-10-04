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

export const shared = {
  uLightDir: { value: new THREE.Vector3(0.35, 0.55, 0.75).normalize() },
  uRimColor: { value: new THREE.Color('#7df9ff') },
  uAccent: { value: new THREE.Color('#22d3ee') },
  uAccentBright: { value: new THREE.Color('#7df9ff') },
  uTime: { value: 0 },
  /** 0..1 live voice envelope — the glowing trims breathe with her voice */
  uVoice: { value: 0 },
  /** head pivot in world space — drives the face's spherical normals */
  uHeadCenter: { value: new THREE.Vector3(0, 1.4, 0) }
}

const VERT_COMMON = /* glsl */ `
  #include <common>
  #include <morphtarget_pars_vertex>
  #include <skinning_pars_vertex>
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;
  varying vec3 vObjPos;
  varying vec2 vUv2;
`

const VERT_BODY = /* glsl */ `
  vUv2 = uv;
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
  #include <project_vertex>
  vNormalV = normalize(transformedNormal);
  vViewPos = -mvPosition.xyz;
  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
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

  void main() {
    vec3 n = normalize(vNormalV);
    if (!gl_FrontFacing) n = -n;
    // anime faces: bend normals toward a sphere around the head so the face
    // shades as one soft volume instead of picking up every bump
    // (hair uses it too, but only over the skull — the long locks keep
    // their own strand normals)
    float sphereK = uSphere;
    if (uHair > 0.0) sphereK *= smoothstep(1.22, 1.33, vWorldPos.y);
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
      float tip = smoothstep(0.45, 1.0, vUv2.y) * smoothstep(1.32, 1.12, vWorldPos.y) * uTipMix;
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
      ring *= smoothstep(1.34, 1.44, vWorldPos.y);
      col += vec3(1.0, 0.98, 1.0) * ring * 0.35 * uHair;
    }

    // fresnel rim — the holographic COSMOS edge light
    float fres = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
    col += uRimColor * fres * uRim * (0.45 + 0.55 * lit);
    col += uEmissive;
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
  doubleSided?: boolean
  transparent?: boolean
}

export function toonMaterial(o: ToonOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: TOON_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(o.color) },
      uShade: { value: new THREE.Color(o.shade) },
      uStep: { value: o.step ?? 0.5 },
      uSoft: { value: o.soft ?? 0.035 },
      uRim: { value: o.rim ?? 0.35 },
      uEmissive: { value: new THREE.Color(o.emissive ?? '#000000') },
      uOpacity: { value: o.opacity ?? 1 },
      uSphere: { value: o.sphere ?? 0 },
      uHair: { value: o.hair ? 1 : 0 },
      uTipMix: { value: o.hair ? 1 : 0 },
      uLightDir: shared.uLightDir,
      uRimColor: shared.uRimColor,
      uHeadCenter: shared.uHeadCenter,
      uAccent: shared.uAccent,
      uAccentBright: shared.uAccentBright
    },
    side: o.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    transparent: o.transparent ?? false
  })
}

/* ── flat unlit detail (lashes, brows, creases) ─────────────────────── */

const FLAT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() {
    gl_FragColor = vec4(uColor, uOpacity);
    #include <colorspace_fragment>
  }
`

export function flatMaterial(color: string, opacity = 1, overHair = false): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: FLAT_FRAG,
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
    transparent: opacity < 1,
    depthWrite: opacity >= 1
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

/* ── glowing trims ─────────────────────────────────────────────────── */

const GLOW_FRAG = /* glsl */ `
  uniform vec3 uAccent;
  uniform vec3 uAccentBright;
  uniform float uTime;
  uniform float uVoice;
  varying vec3 vWorldPos;
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  void main() {
    // a slow energy pulse travelling down the outfit, lifted by her voice
    float wave = 0.5 + 0.5 * sin(vWorldPos.y * 14.0 - uTime * 2.2);
    float k = 0.65 + 0.25 * wave + 0.6 * uVoice;
    vec3 col = mix(uAccent, uAccentBright, 0.35 + 0.35 * wave) * k;
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
      uAccentBright: shared.uAccentBright,
      uTime: shared.uTime,
      uVoice: shared.uVoice
    },
    side: THREE.DoubleSide
  })
}

/* ── eyes ──────────────────────────────────────────────────────────── */

const EYE_FRAG = /* glsl */ `
  uniform vec2 uCenter;
  uniform vec2 uGaze;
  uniform vec2 uIrisR;
  uniform vec3 uAccent;
  uniform vec3 uAccentBright;
  uniform float uTime;
  uniform float uPupil;
  uniform float uSparkle;
  uniform float uSeed;
  varying vec3 vObjPos;
  varying vec2 vUv2;

  float star(vec2 p, float r) {
    // a soft four-point twinkle
    p = abs(p) / r;
    float d = pow(p.x, 0.5) + pow(p.y, 0.5);
    return 1.0 - smoothstep(0.85, 1.0, d);
  }

  void main() {
    // iris placement uses the MORPHED (pre-skin) position: closing lids
    // shrink the mesh and simply cover the iris, like a real eyelid
    vec2 q = vObjPos.xy;
    vec2 p = (q - (uCenter + uGaze)) / uIrisR;
    float d = length(p);
    float lid = smoothstep(0.52, 1.0, vUv2.y);       // under the upper lid
    float lower = smoothstep(0.18, 0.0, vUv2.y);     // along the lower lid

    vec3 sclera = vec3(0.975, 0.98, 1.0);
    sclera = mix(sclera, vec3(0.72, 0.76, 0.90), lid * 0.85);
    sclera = mix(sclera, vec3(0.90, 0.88, 0.95), lower * 0.4);
    vec3 col = sclera;

    vec3 deep = uAccent * 0.22 + vec3(0.02, 0.02, 0.06);
    vec3 mid = uAccent * 0.85;
    vec3 light = mix(uAccentBright, vec3(1.0), 0.15);
    // iris: deep at the top, bright toward the bottom, radial fibres
    float g = clamp(p.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 iris = mix(light, mid, smoothstep(0.05, 0.55, g));
    iris = mix(iris, deep, smoothstep(0.55, 1.0, g));
    float ang = atan(p.y, p.x);
    float fib = 0.5 + 0.5 * sin(ang * 26.0 + sin(ang * 5.0 + uSeed) * 2.5);
    iris *= 0.88 + 0.16 * fib * smoothstep(0.3, 0.9, d);
    // the glowing crescent along the bottom of the iris
    iris += uAccentBright * 0.55 * smoothstep(0.35, 0.95, d) * smoothstep(-0.05, -0.75, p.y);
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
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

export function eyeMaterial(center: THREE.Vector2, seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: EYE_FRAG,
    uniforms: {
      uCenter: { value: center },
      uGaze: { value: new THREE.Vector2() },
      uIrisR: { value: new THREE.Vector2(0.0128, 0.017) },
      uAccent: shared.uAccent,
      uAccentBright: shared.uAccentBright,
      uTime: shared.uTime,
      uPupil: { value: 1 },
      uSparkle: { value: 0 },
      uSeed: { value: seed }
    }
  })
}

/* ── mouth ─────────────────────────────────────────────────────────── */

const MOUTH_FRAG = /* glsl */ `
  uniform float uOpen;
  uniform float uTeeth;
  varying vec2 vUv2;
  void main() {
    vec3 line = vec3(0.47, 0.20, 0.24);
    vec3 deep = vec3(0.20, 0.04, 0.08);
    vec3 inner = mix(deep, vec3(0.42, 0.10, 0.15), smoothstep(0.0, 0.7, vUv2.y));
    // tongue rests low and centred
    float t = length(vec2((vUv2.x - 0.5) * 1.5, (vUv2.y + 0.05) * 1.7));
    inner = mix(inner, vec3(0.93, 0.47, 0.52), (1.0 - smoothstep(0.42, 0.55, t)) * 0.9);
    // upper teeth: a soft white band under the top lip
    float teeth = smoothstep(0.74, 0.86, vUv2.y) * smoothstep(0.10, 0.24, vUv2.x) * smoothstep(0.90, 0.76, vUv2.x);
    inner = mix(inner, vec3(1.0, 0.985, 0.98), teeth * uTeeth);
    vec3 col = mix(line, inner, smoothstep(0.02, 0.25, uOpen));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

export function mouthMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: MOUTH_FRAG,
    uniforms: { uOpen: { value: 0 }, uTeeth: { value: 0 } }
  })
}

/* ── blush ─────────────────────────────────────────────────────────── */

const BLUSH_FRAG = /* glsl */ `
  uniform float uAmount;
  uniform float uLines;
  varying vec2 vUv2;
  void main() {
    vec2 c = (vUv2 - 0.5) * 2.0;
    float r = length(c);
    float a = (1.0 - smoothstep(0.15, 1.0, r)) * uAmount * 0.6;
    vec3 col = vec3(1.0, 0.52, 0.62);
    // the bashful hatch lines ///
    float stripe = abs(fract((c.x * 0.9 + c.y * 0.55) * 2.2) - 0.5);
    float lines = (1.0 - smoothstep(0.05, 0.11, stripe)) * (1.0 - smoothstep(0.45, 0.62, r)) * uLines;
    col = mix(col, vec3(0.93, 0.33, 0.45), lines);
    a = max(a, lines * 0.85);
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }
`

export function blushMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: TOON_VERT,
    fragmentShader: BLUSH_FRAG,
    uniforms: { uAmount: { value: 0.15 }, uLines: { value: 0 } },
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
  void main() {
    #include <morphinstance_vertex>
    #include <beginnormal_vertex>
    #include <morphnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <morphtarget_vertex>
    vec3 restPos = transformed;
    #include <skinning_vertex>
    #include <project_vertex>
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
    float fringe = smoothstep(0.035, 0.065, restPos.z) * (1.0 - smoothstep(1.40, 1.445, restPos.y));
    taper *= 1.0 - uTipTaper * fringe;
    mvPosition.xyz += nv * uWidth * taper * (-mvPosition.z) * 0.0016;
    gl_Position = projectionMatrix * mvPosition;
  }
`

const OUTLINE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  void main() {
    gl_FragColor = vec4(uColor, 1.0);
    #include <colorspace_fragment>
  }
`

export function outlineMaterial(color: string, width: number, tipTaper = 0): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uWidth: { value: width },
      uTipTaper: { value: tipTaper }
    },
    side: THREE.BackSide
  })
}
