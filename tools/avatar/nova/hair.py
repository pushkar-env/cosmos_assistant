"""Hair — a volume cap plus layered, pointed anime clumps.

Each clump is a swept crescent cross-section that tapers to a point. UV.y
runs root (0) → tip (1) so the app's hair shader can fade the silver base
into the theme-coloured tips; UV.x runs across the strand for the jagged
"angel ring" highlight.

Clumps are tagged with a ``hair_group`` (custom property, also stored as a
vertex group name) so the rig step can bind them to the right spring chain.
"""

import math
import random

import bmesh
import bpy
from mathutils import Vector

from .common import (
    bvh_of,
    catmull_rom,
    lerp,
    material,
    mesh_object,
    pchip,
    resample,
    smoothstep,
    srgb,
)
from .head import HEAD_C

HAIR_BASE = "#e9e6f7"


class Shell:
    """Points at a given offset above the head surface, by direction."""

    def __init__(self, head_ob):
        self.bvh = bvh_of(head_ob)

    def radius(self, d):
        # cast from outside back toward the pivot — robust for a closed mesh
        d = d.normalized()
        hit, _n, _i, _dist = self.bvh.ray_cast(HEAD_C + d * 0.5, -d)
        if hit is None:
            return 0.1
        return (hit - HEAD_C).length

    @staticmethod
    def direction(az, el):
        a, e = math.radians(az), math.radians(el)
        return Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))

    def at(self, az, el, offset):
        """az: degrees around (0 = front, +90 = her left); el: degrees up."""
        d = self.direction(az, el)
        return HEAD_C + d * (self.radius(d) + offset)

    def path(self, stops, per_seg=4):
        """Points that hug the shell between (az, el, offset) stops.

        Directions are slerped, so a path over the top of the skull follows
        the surface instead of cutting through the head like a straight
        spline between far-apart control points would."""
        out = []
        for i in range(len(stops) - 1):
            a0, e0, o0 = stops[i]
            a1, e1, o1 = stops[i + 1]
            d0, d1 = self.direction(a0, e0), self.direction(a1, e1)
            for k in range(per_seg):
                t = k / per_seg
                d = d0.slerp(d1, t) if d0.angle(d1) > 1e-4 else d0
                out.append(HEAD_C + d * (self.radius(d) + lerp(o0, o1, t)))
        a, e, o = stops[-1]
        out.append(self.at(a, e, o))
        return out


# The back curtain below the skull: per height, an ellipse (rx, ry) centred at
# cy behind the body axis; ``pull`` swings side clumps behind the shoulders.
CURTAIN_TOP = HEAD_C.z - 0.115
_CURTAIN = [
    # z, rx, ry, cy, pull
    (HEAD_C.z - 0.560, 0.128, 0.076, 0.034, 0.32),
    (HEAD_C.z - 0.330, 0.132, 0.080, 0.030, 0.30),
    (HEAD_C.z - 0.200, 0.120, 0.086, 0.026, 0.22),
    (HEAD_C.z - 0.115, 0.100, 0.095, 0.025, 0.00),
]
_C_RX = pchip([(c[0], c[1]) for c in _CURTAIN])
_C_RY = pchip([(c[0], c[2]) for c in _CURTAIN])
_C_CY = pchip([(c[0], c[3]) for c in _CURTAIN])
_C_PULL = pchip([(c[0], c[4]) for c in _CURTAIN])


def curtain_point(theta, z, r_extra=0.0):
    th = math.radians(math.copysign(180 - (180 - abs(theta)) * (1 - _C_PULL(z)), theta))
    return Vector((math.sin(th) * (_C_RX(z) + r_extra), _C_CY(z) - math.cos(th) * (_C_RY(z) + r_extra), z))


def back_group(theta):
    if abs(abs(theta) - 180) < 30:
        return "back_C"
    return "back_L" if theta > 0 else "back_R"


# spring-bone chains (joint positions, root first). The rig builds bones
# along these and binds the matching hair group to them.
def chain_joints():
    out = {}
    zs = [CURTAIN_TOP + 0.005, HEAD_C.z - 0.215, HEAD_C.z - 0.33, HEAD_C.z - 0.445, HEAD_C.z - 0.545]
    for name, theta in (("back_C", 180.0), ("back_L", 142.0), ("back_R", -142.0)):
        out[name] = [curtain_point(theta, z, 0.0045) for z in zs]
    for side, sfx in ((1, "L"), (-1, "R")):
        out["side_" + sfx] = [
            HEAD_C + Vector((side * 0.090, -0.040, -0.100)),
            HEAD_C + Vector((side * 0.097, -0.036, -0.180)),
            HEAD_C + Vector((side * 0.088, -0.046, -0.268)),
        ]
    out["ahoge"] = list(AHOGE_JOINTS)
    return out


AHOGE_JOINTS = []


def _outward(p):
    """Outward direction used to orient strand cross-sections."""
    c_head = HEAD_C
    c_body = Vector((0.0, 0.03, p.z))
    k = smoothstep(HEAD_C.z - 0.03, HEAD_C.z - 0.12, p.z)  # 0 near head → 1 below
    c = c_head.lerp(c_body, k)
    v = p - c
    if v.length < 1e-6:
        v = Vector((0, 1, 0))
    return v.normalized()


def clump(ctrl, width, thick, n_len=18, n_sec=10, crescent=0.35, edge=0.75, flat_out=None):
    """Sweep a tapered crescent along a Catmull-Rom path.

    width/thick: callables over t in [0, 1] (half-width, outer half-thickness).
    Returns (verts, faces, uvs) with a single tip vertex.
    """
    path = resample(catmull_rom([Vector(p) for p in ctrl], 12), n_len + 1)
    verts, faces, uvs = [], [], []
    for i in range(n_len):
        t = i / n_len
        p = path[i]
        tan = (path[min(i + 1, n_len)] - path[max(i - 1, 0)]).normalized()
        out = flat_out(p) if flat_out else _outward(p)
        out = (out - tan * out.dot(tan)).normalized()
        side = tan.cross(out).normalized()
        w, h = width(t), thick(t)
        for k in range(n_sec):
            ph = 2 * math.pi * k / n_sec
            c, s = math.cos(ph), math.sin(ph)
            x = w * math.copysign(abs(c) ** edge, c)
            y = h * s if s > 0 else h * crescent * s
            verts.append(p + side * x + out * y)
            uvs.append((k / n_sec, t))
    tip = len(verts)
    verts.append(path[-1])
    uvs.append((0.5, 1.0))
    for i in range(n_len - 1):
        for k in range(n_sec):
            a = i * n_sec + k
            b = i * n_sec + (k + 1) % n_sec
            faces.append((a, b, b + n_sec, a + n_sec))
    last = (n_len - 1) * n_sec
    for k in range(n_sec):
        faces.append((last + k, last + (k + 1) % n_sec, tip))
    # root cap (buried in the hair cap, closes the tube for clean outlines)
    faces.append(tuple(reversed(range(n_sec))))
    return verts, faces, uvs


class HairBuilder:
    def __init__(self):
        self.verts, self.faces, self.uvs, self.groups = [], [], [], []

    def add(self, data, group):
        v, f, uv = data
        o = len(self.verts)
        self.verts += v
        self.faces += [tuple(i + o for i in face) for face in f]
        self.uvs += uv
        self.groups += [group] * len(v)

    def build(self, name, mat):
        # per-loop UVs because tip/root fans share vertices
        me_uvs = []
        ob = mesh_object(name, self.verts, self.faces, mat)
        uvl = ob.data.uv_layers.new(name="UVMap")
        for loop in ob.data.loops:
            uvl.data[loop.index].uv = self.uvs[loop.vertex_index]
        del me_uvs
        for g in sorted(set(self.groups)):
            vg = ob.vertex_groups.new(name="hair_" + g)
            idx = [i for i, gg in enumerate(self.groups) if gg == g]
            vg.add(idx, 1.0, "REPLACE")
        return ob


def taper(w0, w_mid, peak=0.35, tip_pow=1.0):
    """Width profile: swells from the root to ``peak`` then narrows to a point."""

    def f(t):
        if t < peak:
            return lerp(w0, w_mid, smoothstep(0.0, peak, t))
        return w_mid * (1.0 - ((t - peak) / (1.0 - peak))) ** tip_pow

    return f


def build_hair(head_ob):
    rnd = random.Random(7)
    shell = Shell(head_ob)
    mat = material("Hair", srgb(HAIR_BASE), roughness=0.45)
    hb = HairBuilder()

    # ── bangs: a front layer of wide, blunt-ended clumps over a back layer ──
    # (azimuth, tip height relative to the top of the eyes, half-width, curl)
    front = [
        (-58, -0.050, 0.0165, -9), (-42, -0.018, 0.0190, -6), (-27, 0.004, 0.0200, -3),
        (-13, 0.000, 0.0190, -1), (0, -0.013, 0.0175, 0), (13, 0.006, 0.0190, 1),
        (27, 0.002, 0.0200, 3), (42, -0.020, 0.0190, 6), (58, -0.052, 0.0165, 9),
    ]
    back = [(az, 0.014, 0.0175, c) for az, c in ((-50, -5), (-35, -3), (-20, -1), (-6, 0), (7, 0), (21, 1), (36, 3), (50, 5))]
    for layer, specs in ((0, back), (1, front)):
        off = 0.0085 + 0.0025 * layer
        for az, tip_dz, w, curl in specs:
            tip_z = HEAD_C.z - 0.004 + tip_dz
            tip_el = math.degrees(math.asin(max(-0.95, min(0.95, (tip_z - HEAD_C.z) / 0.095))))
            pts = shell.path(
                [(az * 0.45, 66, off), (az * 0.85, 38, off + 0.002), (az + curl * 0.4, 16, off + 0.0015), (az + curl, tip_el, off)],
                per_seg=3,
            )
            hb.add(clump(pts, taper(w * 0.85, w, 0.45, 1.6), taper(0.0042, 0.0052, 0.4, 0.9), n_len=18), "head")

    # ── side locks framing the face ──
    for side in (1, -1):
        for j, (az, w, dz, dy) in enumerate(((72, 0.0165, 0.0, 0.0), (83, 0.0195, 0.035, 0.014))):
            a = az * side
            pts = shell.path([(a * 0.75, 52, 0.011), (a, 18, 0.012), (a + side * 4, -12, 0.014)], per_seg=2) + [
                HEAD_C + Vector((side * 0.090, -0.044 + dy, -0.105)),
                HEAD_C + Vector((side * 0.097, -0.040 + dy, -0.180 + dz)),
                HEAD_C + Vector((side * 0.088, -0.050 + dy, -0.262 + dz)),
            ]
            hb.add(
                clump(pts, taper(w * 0.8, w, 0.4, 1.4), taper(0.0045, 0.006, 0.35, 0.8), n_len=22),
                "side_L" if side > 0 else "side_R",
            )

    # ── long back hair: a layered curtain down to the waist ──
    def back_clump(theta, length, w, layer):
        r_extra = 0.009 * layer
        root_az = theta * 0.35 + math.copysign(180, theta) * 0.65
        pts = shell.path([(root_az, 60, 0.011 + r_extra), (theta, 22, 0.013 + r_extra), (theta, -12, 0.015 + r_extra)], per_seg=2)
        end_z = HEAD_C.z - 0.10 - length
        z = CURTAIN_TOP
        while z > end_z + 0.05:
            pts.append(curtain_point(theta, z, r_extra))
            z -= 0.09
        pts.append(curtain_point(theta, end_z, r_extra))
        hb.add(clump(pts, taper(w * 0.75, w, 0.3, 1.25), taper(0.0055, 0.0085, 0.3, 0.8), n_len=26), back_group(theta))

    # inner layer (fills gaps), outer layer (the visible curtain)
    for th in range(114, 247, 14):
        theta = th if th <= 180 else th - 360
        length = 0.36 + 0.06 * math.cos(math.radians(th - 180)) + rnd.uniform(-0.03, 0.02)
        back_clump(theta, length, 0.030, 0)
    for th in range(120, 241, 15):
        theta = th if th <= 180 else th - 360
        length = 0.40 + 0.08 * math.cos(math.radians(th - 180)) + rnd.uniform(-0.04, 0.03)
        back_clump(theta, length, 0.036, 1)

    # ── ahoge: the single rebellious strand on top ──
    base = shell.at(6, 80, 0.008)
    ahoge = [
        base,
        base + Vector((0.001, -0.006, 0.026)),
        base + Vector((0.003, -0.024, 0.048)),
        base + Vector((0.005, -0.046, 0.044)),
        base + Vector((0.006, -0.054, 0.030)),
    ]
    hb.add(clump(ahoge, taper(0.004, 0.0075, 0.35, 1.1), taper(0.002, 0.0026, 0.3, 0.8), n_len=14), "ahoge")
    AHOGE_JOINTS[:] = [ahoge[0] + Vector((0, 0, 0.004)), ahoge[2], ahoge[4]]

    strands = hb.build("HairStrands", mat)
    cap = build_cap(head_ob, mat)
    return [cap.name, strands.name]


def build_cap(head_ob, mat):
    """Hair volume over the skull: the head mesh above the hairline, inflated."""
    me = head_ob.data.copy()
    me.name = "HairCap"
    ob = bpy.data.objects.new("HairCap", me)
    head_ob.users_collection[0].objects.link(ob)
    if ob.data.shape_keys:
        ob.shape_key_clear()
    bm = bmesh.new()
    bm.from_mesh(me)
    hairline = pchip([(0, 0.038), (40, 0.034), (70, 0.010), (95, -0.045), (130, -0.070), (180, -0.080)])
    kill = []
    for v in bm.verts:
        rel = v.co - HEAD_C
        az = abs(math.degrees(math.atan2(rel.x, -rel.y)))
        if rel.z < hairline(az):
            kill.append(v)
    bmesh.ops.delete(bm, geom=kill, context="VERTS")
    for v in bm.verts:
        rel = v.co - HEAD_C
        d = rel.normalized()
        # extra volume on top and at the back, thin at the hairline
        az = abs(math.degrees(math.atan2(rel.x, -rel.y)))
        vol = 0.007 + 0.010 * smoothstep(-0.02, 0.10, rel.z) + 0.004 * smoothstep(0.0, 0.08, rel.y)
        # taper the volume to nothing at the hairline so the cap meets the skin
        vol *= smoothstep(0.0, 0.022, rel.z - hairline(az))
        v.co = v.co + d * (vol + 0.0006)
    bm.to_mesh(me)
    bm.free()
    me.materials.clear()
    me.materials.append(mat)
    uvl = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        uvl.data[loop.index].uv = (0.5, 0.0)
    vg = ob.vertex_groups.new(name="hair_head")
    vg.add(list(range(len(me.vertices))), 1.0, "REPLACE")
    return ob
