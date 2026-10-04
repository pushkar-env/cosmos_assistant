"""Body — lofted torso/neck, arms, hands and legs in a relaxed A-pose.

Proportions are a petite ~6.3-heads-tall anime girl (top of head ≈ 1.52 m).
The body is mostly covered by clothes, so pieces may overlap where a garment
hides the join (shoulders, hips); the visible skin — neck, hands, thighs —
is built to read cleanly under toon shading.

Joint positions live in ``JOINTS`` so the rig step builds bones exactly where
the geometry bends.
"""

import math

from mathutils import Matrix, Vector

from .common import frames_along, lerp, material, mesh_object, pchip, srgb
from .head import SKIN

ARM_ANGLE = math.radians(42)  # A-pose: arms this far below horizontal


def _arm_dir(side):
    return Vector((side * math.cos(ARM_ANGLE), 0.0, -math.sin(ARM_ANGLE)))


def _joints():
    j = {
        "hips": Vector((0, 0.0, 0.900)),
        "spine": Vector((0, 0.0, 0.985)),
        "chest": Vector((0, 0.0, 1.060)),
        "upperChest": Vector((0, 0.0, 1.140)),
        "neck": Vector((0, 0.004, 1.236)),
        "head": Vector((0, 0.006, 1.315)),
        "headTop": Vector((0, 0.0, 1.52)),
    }
    for side, s in ((1, "left"), (-1, "right")):
        d = _arm_dir(side)
        sh = Vector((side * 0.150, 0.005, 1.172))
        j[s + "Shoulder"] = Vector((side * 0.030, 0.0, 1.205))
        j[s + "UpperArm"] = sh
        j[s + "LowerArm"] = sh + d * 0.245
        j[s + "Hand"] = sh + d * (0.245 + 0.215)
        j[s + "UpperLeg"] = Vector((side * 0.082, 0.0, 0.845))
        j[s + "LowerLeg"] = Vector((side * 0.074, -0.004, 0.462))
        j[s + "Foot"] = Vector((side * 0.066, 0.010, 0.078))
        j[s + "Toes"] = Vector((side * 0.070, -0.075, 0.022))
    return j


JOINTS = _joints()


# ── generic lofting ─────────────────────────────────────────────────────


def superellipse_ring(center, ax, ay, rx, ry, n=2.0, segs=32, start=0.0):
    pts = []
    for k in range(segs):
        t = start + 2 * math.pi * k / segs
        c, s = math.cos(t), math.sin(t)
        x = rx * math.copysign(abs(c) ** (2.0 / n), c)
        y = ry * math.copysign(abs(s) ** (2.0 / n), s)
        pts.append(center + ax * x + ay * y)
    return pts


def loft(rings, cap_start=True, cap_end=True, v_coords=None):
    """Quad-strip a list of equal-length closed rings; optional fan caps.

    Returns verts, faces, uvs (u around, v along)."""
    segs = len(rings[0])
    verts, faces, uvs = [], [], []
    nr = len(rings)
    for i, ring in enumerate(rings):
        v = v_coords[i] if v_coords else i / (nr - 1)
        for k, p in enumerate(ring):
            verts.append(p)
            uvs.append((k / segs, v))
    for i in range(nr - 1):
        for k in range(segs):
            a = i * segs + k
            b = i * segs + (k + 1) % segs
            faces.append((a, b, b + segs, a + segs))
    if cap_start:
        c = sum(rings[0], Vector()) / segs
        ci = len(verts)
        verts.append(c)
        uvs.append((0.5, 0.0))
        for k in range(segs):
            faces.append((ci, (k + 1) % segs, k))
    if cap_end:
        c = sum(rings[-1], Vector()) / segs
        ci = len(verts)
        verts.append(c)
        uvs.append((0.5, 1.0))
        o = (nr - 1) * segs
        for k in range(segs):
            faces.append((ci, o + k, o + (k + 1) % segs))
    return verts, faces, uvs


def tube(path, radius_x, radius_y, up_hint, segs=20, n=2.0, cap_start=True, cap_end=True, tip=None):
    """Loft round/elliptical sections along ``path``.

    radius_x/radius_y: callables over t in [0, 1]. ``up_hint`` orients the
    first frame (ry runs along it). ``tip`` adds a rounded end point."""
    frames = frames_along(path, up_hint)
    rings = []
    n_pts = len(path)
    for i, (p, (tan, nrm, bin_)) in enumerate(zip(path, frames)):
        t = i / (n_pts - 1)
        # ring runs nrm → bin, which winds counter-clockwise about the
        # tangent so the quads face outward (bin follows the up hint)
        rings.append(superellipse_ring(p, nrm, bin_, radius_x(t), radius_y(t), n, segs))
    verts, faces, uvs = loft(rings, cap_start=cap_start, cap_end=cap_end and tip is None)
    if tip is not None:
        ci = len(verts)
        verts.append(tip)
        uvs.append((0.5, 1.0))
        o = (n_pts - 1) * segs
        for k in range(segs):
            faces.append((ci, o + k, o + (k + 1) % segs))
    return verts, faces, uvs


class MeshBuilder:
    """Accumulates pieces into one mesh. Pieces can carry a ``tag`` that is
    stored as a ``piece_<tag>`` vertex group, which the rig step uses to pick
    the bones each piece may be weighted to."""

    def __init__(self):
        self.verts, self.faces, self.uvs, self.tags = [], [], [], []

    def add(self, data, tag=None):
        v, f, uv = data
        o = len(self.verts)
        self.verts += list(v)
        self.faces += [tuple(i + o for i in face) for face in f]
        self.uvs += list(uv)
        self.tags += [tag] * len(v)

    def build(self, name, mat):
        ob = mesh_object(name, self.verts, self.faces, mat)
        uvl = ob.data.uv_layers.new(name="UVMap")
        for loop in ob.data.loops:
            uvl.data[loop.index].uv = self.uvs[loop.vertex_index]
        for tag in sorted({t for t in self.tags if t}):
            vg = ob.vertex_groups.new(name="piece_" + tag)
            vg.add([i for i, t in enumerate(self.tags) if t == tag], 1.0, "REPLACE")
        return ob


def polyline(points, per_seg=6):
    out = []
    for i in range(len(points) - 1):
        for k in range(per_seg):
            out.append(points[i].lerp(points[i + 1], k / per_seg))
    out.append(points[-1].copy())
    return out


# ── torso ───────────────────────────────────────────────────────────────

# z → (half-width, front depth, back depth)
_TORSO = [
    (0.765, 0.055, 0.045, 0.050), (0.790, 0.110, 0.062, 0.075), (0.830, 0.132, 0.068, 0.084),
    (0.870, 0.136, 0.068, 0.082), (0.910, 0.122, 0.063, 0.070), (0.950, 0.104, 0.058, 0.060),
    (0.985, 0.097, 0.057, 0.058), (1.020, 0.104, 0.061, 0.062), (1.060, 0.115, 0.071, 0.066),
    (1.095, 0.121, 0.079, 0.068), (1.125, 0.127, 0.075, 0.070), (1.155, 0.133, 0.068, 0.072),
    (1.185, 0.130, 0.058, 0.070), (1.205, 0.108, 0.050, 0.062), (1.222, 0.075, 0.040, 0.050),
    (1.238, 0.042, 0.031, 0.036), (1.252, 0.0295, 0.0275, 0.0300), (1.300, 0.0265, 0.0265, 0.0290),
    (1.345, 0.0260, 0.0260, 0.0280),
]
TORSO_HW = pchip([(z, w) for z, w, _f, _b in _TORSO])
TORSO_F = pchip([(z, f) for z, _w, f, _b in _TORSO])
TORSO_B = pchip([(z, b) for z, _w, _f, b in _TORSO])


def torso_ring(z, inflate=0.0, segs=48, n=None):
    hw, f, b = TORSO_HW(z) + inflate, TORSO_F(z) + inflate, TORSO_B(z) + inflate
    if n is None:
        n = lerp(2.45, 2.0, max(0.0, min(1.0, (z - 1.20) / 0.05)))
    neck_y = 0.004 * max(0.0, min(1.0, (z - 1.22) / 0.06))
    yc = (b - f) * 0.5 + neck_y
    d = (f + b) * 0.5
    pts = []
    for k in range(segs):
        th = 2 * math.pi * k / segs  # 0 = front, increasing toward her left
        s, c = math.sin(th), math.cos(th)
        x = hw * math.copysign(abs(s) ** (2.0 / n), s)
        y = yc - d * math.copysign(abs(c) ** (2.0 / n), c)
        pts.append(Vector((x, y, z)))
    return pts


def build_torso(mb, z0=1.205, z1=1.345, rows=14):
    """Only the neck and collarbone area: everything below sits under the
    jacket and skirt, and hidden skin would only poke through the cloth when
    the arms move. (The rings come from the full torso profile, so this can
    be extended back down freely.)"""
    zs = [lerp(z0, z1, i / rows) for i in range(rows + 1)]
    rings = [torso_ring(z) for z in zs]
    mb.add(loft(rings), "torso")


# ── arms & hands ────────────────────────────────────────────────────────


def arm_path(side):
    d = _arm_dir(side)
    sh = JOINTS[("left" if side > 0 else "right") + "UpperArm"]
    pts = [sh - d * 0.045, sh, sh + d * 0.245, sh + d * 0.460]
    return polyline(pts, 8)


_ARM_R = pchip([(0.0, 0.034), (0.10, 0.042), (0.30, 0.036), (0.47, 0.029), (0.53, 0.0285),
                (0.62, 0.031), (0.85, 0.025), (1.0, 0.0215)])
_ARM_RY = pchip([(0.0, 0.034), (0.10, 0.042), (0.30, 0.036), (0.47, 0.029), (0.53, 0.0285),
                 (0.62, 0.029), (0.85, 0.021), (1.0, 0.0170)])


def palm_frame(side):
    """(along, across→thumb side, palm-normal) unit axes of the hand."""
    d = _arm_dir(side)
    palm_n = Vector((-math.sin(ARM_ANGLE) * side, 0.0, -math.cos(ARM_ANGLE)))  # palm faces down
    thumb = Vector((0.0, -1.0, 0.0))  # palms down → thumbs point forward
    return d, thumb, palm_n


FINGERS = [
    # name, across offset (toward thumb +), length, radius, splay (rad)
    ("Index", 0.0235, 0.066, 0.0079, -0.06),
    ("Middle", 0.0080, 0.072, 0.0081, 0.0),
    ("Ring", -0.0080, 0.068, 0.0077, 0.05),
    ("Little", -0.0230, 0.054, 0.0068, 0.12),
]


def finger_chain(side, name):
    """Three joint positions + tip for a finger (used by the rig too)."""
    d, thumb, palm_n = palm_frame(side)
    wrist = JOINTS[("left" if side > 0 else "right") + "Hand"]
    if name == "Thumb":
        root = wrist + d * 0.018 + thumb * 0.021 + palm_n * 0.008
        dirn = (d * 0.62 + thumb * 0.62 + palm_n * 0.30).normalized()
        segs = (0.024, 0.021, 0.019)
        bend = Matrix.Rotation(-0.18 * side, 3, d)  # curls slightly toward the palm
        pts = [root]
        cur = dirn
        for L in segs:
            pts.append(pts[-1] + cur * L)
            cur = (bend @ cur).normalized()
        return pts
    spec = next(f for f in FINGERS if f[0] == name)
    _n, across, length, _r, splay = spec
    knuckle = wrist + d * 0.084 + thumb * across - palm_n * 0.002
    dirn = (Matrix.Rotation(splay * side, 3, palm_n) @ d).normalized()
    axis = dirn.cross(palm_n).normalized()
    segs = (length * 0.42, length * 0.31, length * 0.27)
    pts = [knuckle]
    cur = dirn
    for i, L in enumerate(segs):
        # a natural relaxed curl toward the palm
        cur = (Matrix.Rotation(-(0.10, 0.16, 0.12)[i], 3, axis) @ cur).normalized()
        pts.append(pts[-1] + cur * L)
    return pts


def build_arm(mb, side, with_arm=False):
    """Hands (palm + fingers). The arm itself is hidden by the sleeve end to
    end, so it is skipped unless ``with_arm`` — see build_torso."""
    sfx = "L" if side > 0 else "R"
    if with_arm:
        mb.add(tube(arm_path(side), _ARM_R, _ARM_RY, Vector((0, 1, 0)), segs=24, cap_start=True, cap_end=False), "arm_" + sfx)

    d, thumb, palm_n = palm_frame(side)
    wrist = JOINTS[("left" if side > 0 else "right") + "Hand"]
    # palm: a rounded box lofted from the wrist to the knuckles
    rings = []
    for t, w, h in ((-0.012, 0.0215, 0.0170), (0.0, 0.024, 0.0165), (0.03, 0.033, 0.0145),
                    (0.06, 0.036, 0.0125), (0.082, 0.035, 0.0105), (0.092, 0.031, 0.0085)):
        c = wrist + d * t - palm_n * 0.001
        # the right hand's frame is mirrored — flip the start axis to keep
        # the winding (and so the normals) facing outward
        rings.append(superellipse_ring(c, thumb * side, palm_n, w, h, n=2.6, segs=24))
    mb.add(loft(rings), "palm_" + sfx)

    for name in ("Thumb", "Index", "Middle", "Ring", "Little"):
        pts = finger_chain(side, name)
        r = 0.0098 if name == "Thumb" else next(f for f in FINGERS if f[0] == name)[3]
        path = polyline(pts, 4)
        tip_dir = (pts[-1] - pts[-2]).normalized()
        root_back = path[0] - (path[1] - path[0]).normalized() * 0.008
        path = [root_back] + path
        prof = pchip([(0.0, r * 1.05), (0.3, r), (0.85, r * 0.86), (1.0, r * 0.80)])
        mb.add(
            tube(path, prof, lambda t, p=prof: p(t) * 0.88, palm_n, segs=12,
                 cap_start=True, tip=pts[-1] + tip_dir * r * 0.75),
            f"finger{name}_{sfx}",
        )


# ── legs ────────────────────────────────────────────────────────────────


LEG_RX = pchip([(0.0, 0.058), (0.10, 0.066), (0.40, 0.060), (0.62, 0.045), (0.68, 0.043),
                (0.76, 0.048), (0.90, 0.034), (1.0, 0.0275)])
LEG_RY = pchip([(0.0, 0.060), (0.10, 0.068), (0.40, 0.062), (0.62, 0.047), (0.68, 0.046),
                (0.76, 0.051), (0.90, 0.035), (1.0, 0.0285)])


def leg_path(side):
    s = "left" if side > 0 else "right"
    hip, knee, ankle = JOINTS[s + "UpperLeg"], JOINTS[s + "LowerLeg"], JOINTS[s + "Foot"]
    top = hip + Vector((-side * 0.004, 0.0, 0.035))
    return polyline([top, hip, knee, ankle], 10)


def build_leg(mb, side):
    mb.add(tube(leg_path(side), LEG_RX, LEG_RY, Vector((0, -1, 0)), segs=28, cap_start=True, cap_end=True),
           "leg_" + ("L" if side > 0 else "R"))


def build_body():
    mb = MeshBuilder()
    build_torso(mb)
    for side in (1, -1):
        build_arm(mb, side)
        build_leg(mb, side)
    mat = material("Skin", srgb(SKIN), roughness=0.55)
    return mb.build("Body", mat)
