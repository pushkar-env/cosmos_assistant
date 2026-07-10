/** GLSL for the AI core. Simplex noise: Ashima Arts (MIT). */

/** shared 3D simplex noise — prepended to any shader stage that needs it */
const SIMPLEX = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// fractal brownian motion — layered noise for turbulent plasma
float fbm(vec3 p){
  float f = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { f += a * snoise(p); p *= 2.02; a *= 0.5; }
  return f;
}
`

// ── outer holographic membrane (the displaced icosahedron shell) ────────────

export const CORE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uSpeed;
uniform float uPulse;

varying vec3 vNormal;
varying vec3 vViewDir;
varying float vDisp;
${SIMPLEX}
void main() {
  float t = uTime * uSpeed;
  float n = snoise(position * 1.8 + vec3(t * 0.4, t * 0.3, t * 0.2));
  // voice pulse: layered LFO that reads as speech cadence
  float voice = uPulse * (0.5 + 0.5 * sin(uTime * 9.0) * sin(uTime * 4.7 + 1.3));
  float disp = n * uAmp * (1.0 + voice * 0.9);
  vec3 displaced = position + normal * disp;

  vDisp = disp;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`

export const CORE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColorBright;
uniform float uRim;
uniform float uTime;

varying vec3 vNormal;
varying vec3 vViewDir;
varying float vDisp;

void main() {
  float fresnel = pow(1.0 - max(dot(vNormal, vViewDir), 0.0), 2.2);
  float ridge = smoothstep(0.0, 0.22, abs(vDisp)) * 0.9;
  // energy flowing along the displacement ridges
  float bands = 0.5 + 0.5 * sin(vDisp * 34.0 - uTime * 3.2);
  float shimmer = 0.06 * sin(uTime * 2.0 + vDisp * 40.0);

  vec3 base = uColor * 0.10;                         // faint translucent body
  vec3 rim = uColorBright * fresnel * uRim;          // holographic edge
  vec3 hot = uColorBright * pow(fresnel, 3.5) * 0.7; // hot inner-rim glow
  vec3 energy = mix(uColor, uColorBright, ridge) * ridge * (0.55 + bands * 0.5);

  vec3 color = base + rim + hot + energy + shimmer * uColorBright;
  // keep the front glassy so the glowing nucleus + lattice read through it
  float alpha = clamp(0.07 + fresnel * 0.72 + ridge * 0.42, 0.0, 1.0);
  gl_FragColor = vec4(color, alpha);
}
`

// ── glowing plasma nucleus (the hot core at the centre) ─────────────────────

export const NUCLEUS_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uPulse;

varying vec3 vPos;
varying vec3 vNormal;
varying vec3 vViewDir;
varying float vTurb;
${SIMPLEX}
void main() {
  float t = uTime * 0.6;
  float turb = fbm(position * 2.6 + vec3(t, t * 0.7, -t * 0.5));
  float voice = uPulse * (0.5 + 0.5 * sin(uTime * 8.0));
  float disp = turb * (0.05 + uAmp * 0.5 + voice * 0.18);
  vec3 displaced = position + normal * disp;

  vTurb = turb;
  vPos = position;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`

export const NUCLEUS_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColorBright;
uniform float uTime;
uniform float uPulse;
uniform float uGlow;

varying vec3 vPos;
varying vec3 vNormal;
varying vec3 vViewDir;
varying float vTurb;
${SIMPLEX}
void main() {
  float facing = max(dot(vNormal, vViewDir), 0.0);
  // churning plasma veins on the surface
  float plasma = 0.5 + 0.5 * fbm(vPos * 3.4 + vec3(uTime * 0.6, 0.0, uTime * 0.4));
  float veins = pow(plasma, 2.0);

  // white-hot centre fading to the theme colour toward the edges
  vec3 hot = mix(uColor, uColorBright, plasma);
  float core = pow(facing, 1.6);
  vec3 color = mix(hot, vec3(1.0), core * 0.7);
  color *= 0.55 + veins * 1.1;

  float pulse = 1.0 + uPulse * 0.45 * sin(uTime * 7.0);
  float alpha = (0.30 + core * 0.7) * (0.7 + veins * 0.6) * pulse * uGlow;
  gl_FragColor = vec4(color * pulse, clamp(alpha, 0.0, 1.0));
}
`

// ── orbiting particle field ─────────────────────────────────────────────────

export const PARTICLE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uRadiusScale;
uniform float uSpeed;
uniform float uSize;

attribute float aSeed;
attribute float aShell;

varying float vTwinkle;

void main() {
  // each particle orbits on its own tilted circle
  float angle = uTime * uSpeed * (0.15 + aSeed * 0.25) + aSeed * 6.28318;
  float tilt = aSeed * 3.14159;
  float radius = aShell * uRadiusScale;

  vec3 p = vec3(
    cos(angle) * radius,
    sin(angle) * radius * sin(tilt),
    sin(angle) * radius * cos(tilt)
  );
  // slight breathing
  p *= 1.0 + 0.04 * sin(uTime * 0.8 + aSeed * 10.0);

  vTwinkle = 0.55 + 0.45 * sin(uTime * (2.0 + aSeed * 3.0) + aSeed * 20.0);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * (0.6 + aSeed * 0.8) * (30.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`

export const PARTICLE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vTwinkle;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  float core = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(uColor * vTwinkle, core * core * vTwinkle);
}
`
