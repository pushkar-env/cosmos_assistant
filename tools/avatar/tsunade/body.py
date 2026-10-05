"""Body — an adult anime woman (~6.9 heads, top of head ≈ 1.65 m in heels).

Only skin that can be seen is built: neck and the V of the chest, forearms
below the haori sleeves, hands, calves below the capri pants, and feet in
heeled sandals (arched, toes on the sole). Nails are painted red. A few ink
lines drawn on the skin (cleavage, collarbones) carry the anatomy the toon
shading alone would flatten.

Joint positions live in ``JOINTS`` so the rig builds bones exactly where the
geometry bends.
"""

import math

from mathutils import Matrix, Vector

import bpy

from kit.common import bvh_of, catmull_rom, lerp, material, pchip, smoothstep, srgb
from kit.geom import MeshBuilder, loft, open_loft, polyline, superellipse_ring, tube

from .head import SKIN

ARM_ANGLE = math.radians(42)  # A-pose: arms this far below horizontal
UPPER_ARM, FOREARM = 0.285, 0.248


def arm_dir(side):
    return Vector((side * math.cos(ARM_ANGLE), 0.0, -math.sin(ARM_ANGLE)))


def _joints():
    j = {
        "hips": Vector((0, 0.0, 1.000)),
        "spine": Vector((0, 0.0, 1.085)),
        "chest": Vector((0, 0.0, 1.170)),
        "upperChest": Vector((0, 0.0, 1.265)),
        "neck": Vector((0, 0.004, 1.385)),
        "head": Vector((0, 0.006, 1.455)),
        "headTop": Vector((0, 0.0, 1.66)),
    }
    for side, s in ((1, "left"), (-1, "right")):
        d = arm_dir(side)
        sh = Vector((side * 0.176, 0.006, 1.333))
        j[s + "Shoulder"] = Vector((side * 0.034, 0.0, 1.362))
        j[s + "UpperArm"] = sh
        j[s + "LowerArm"] = sh + d * UPPER_ARM
        j[s + "Hand"] = sh + d * (UPPER_ARM + FOREARM)
        j[s + "UpperLeg"] = Vector((side * 0.092, 0.0, 0.955))
        j[s + "LowerLeg"] = Vector((side * 0.083, -0.005, 0.528))
        j[s + "Foot"] = Vector((side * 0.075, 0.016, 0.118))
        j[s + "Toes"] = Vector((side * 0.079, -0.090, 0.020))
        j[s + "ToeTip"] = Vector((side * 0.081, -0.146, 0.014))
    return j


JOINTS = _joints()


# ── torso ───────────────────────────────────────────────────────────────

# z → (half-width, front depth, back depth)
_TORSO = [
    (0.860, 0.060, 0.050, 0.055), (0.890, 0.125, 0.070, 0.085), (0.940, 0.165, 0.078, 0.098),
    (0.980, 0.168, 0.077, 0.096), (1.020, 0.150, 0.072, 0.082), (1.060, 0.128, 0.066, 0.070),
    (1.100, 0.112, 0.064, 0.066), (1.140, 0.120, 0.070, 0.068), (1.180, 0.136, 0.082, 0.072),
    (1.215, 0.150, 0.090, 0.074), (1.250, 0.159, 0.088, 0.078), (1.285, 0.160, 0.080, 0.080),
    (1.320, 0.152, 0.068, 0.078), (1.345, 0.140, 0.058, 0.072), (1.360, 0.112, 0.050, 0.064),
    (1.375, 0.075, 0.042, 0.052), (1.390, 0.045, 0.034, 0.040), (1.405, 0.0345, 0.031, 0.034),
    (1.450, 0.0315, 0.030, 0.032), (1.490, 0.030, 0.029, 0.031),
]
TORSO_HW = pchip([(z, w) for z, w, _f, _b in _TORSO])
TORSO_F = pchip([(z, f) for z, _w, f, _b in _TORSO])
TORSO_B = pchip([(z, b) for z, _w, _f, b in _TORSO])

# the bust: two full forms on the chest wall (her reference is very busty).
# Centres also anchor the breast spring bones and their weights.
BUST_Z = 1.232
BUST_X = 0.080
BUST_DEPTH = 0.106
BUST_SPREAD = 0.064
BUST_CENTER = {1: Vector((BUST_X, -0.104, BUST_Z)), -1: Vector((-BUST_X, -0.104, BUST_Z))}


def bust_bulge(x, z):
    """Forward push (m) of the chest surface at (x, z) from both breasts."""
    total = 0.0
    for bx in (BUST_X, -BUST_X):
        dz = z - BUST_Z
        sz = 0.092 if dz > 0 else 0.052  # long slope above, a firmer, rounded underside
        total += math.exp(-(((x - bx) / BUST_SPREAD) ** 2) - (dz / sz) ** 2)
    return BUST_DEPTH * total


def torso_point(z, th, inflate=0.0, n=None):
    """Point on the torso surface at height z, azimuth th (0 = front)."""
    hw, f, b = TORSO_HW(z) + inflate, TORSO_F(z) + inflate, TORSO_B(z) + inflate
    if n is None:
        n = lerp(2.45, 2.0, smoothstep(1.36, 1.40, z))
    neck_y = 0.004 * smoothstep(1.37, 1.43, z)
    yc = (b - f) * 0.5 + neck_y
    d = (f + b) * 0.5
    s, c = math.sin(th), math.cos(th)
    x = hw * math.copysign(abs(s) ** (2.0 / n), s)
    y = yc - d * math.copysign(abs(c) ** (2.0 / n), c)
    if c > 0:
        y -= bust_bulge(x, z) * c**0.6
        # the valley between them
        valley = smoothstep(1.16, 1.21, z) * (1.0 - smoothstep(1.27, 1.33, z))
        y += 0.012 * valley * math.exp(-((x / 0.017) ** 2)) * c
    return Vector((x, y, z))


def torso_ring(z, inflate=0.0, segs=56):
    return [torso_point(z, 2 * math.pi * k / segs, inflate) for k in range(segs)]


def build_torso(mb, z0=1.14, z1=1.49, rows=34):
    """The neck and the V of the chest — everything below sits under the
    kimono and obi."""
    zs = [lerp(z0, z1, i / rows) for i in range(rows + 1)]
    mb.add(loft([torso_ring(z) for z in zs]), "torso")


# ── arms & hands ────────────────────────────────────────────────────────


def arm_path(side, t0=0.0):
    d = arm_dir(side)
    sh = JOINTS[("left" if side > 0 else "right") + "UpperArm"]
    pts = [sh - d * 0.05, sh, sh + d * UPPER_ARM, sh + d * (UPPER_ARM + FOREARM)]
    path = polyline(pts, 10)
    i0 = int(t0 * (len(path) - 1))
    return path[i0:]


# forearm cross-section along the arm path: _ARM_R is the depth (along the
# palm normal), _ARM_RY the width across the palm — a wrist is wider than it
# is deep, and the palm grows straight out of it
_ARM_R = pchip([(0.0, 0.040), (0.10, 0.046), (0.30, 0.040), (0.50, 0.032), (0.56, 0.0310),
                (0.65, 0.0300), (0.75, 0.0285), (0.88, 0.0215), (1.0, 0.0165)])
_ARM_RY = pchip([(0.0, 0.040), (0.10, 0.046), (0.30, 0.040), (0.50, 0.032), (0.56, 0.0315),
                 (0.65, 0.0330), (0.75, 0.0315), (0.88, 0.0255), (1.0, 0.0232)])


def palm_frame(side):
    """(along, across→thumb side, palm-normal) unit axes of the hand."""
    d = arm_dir(side)
    palm_n = Vector((-math.sin(ARM_ANGLE) * side, 0.0, -math.cos(ARM_ANGLE)))  # palm faces down
    thumb = Vector((0.0, -1.0, 0.0))  # palms down → thumbs point forward
    return d, thumb, palm_n


KNUCKLE = 0.092
FINGERS = [
    # name, across offset (toward thumb +), length, radius, splay (rad),
    # knuckle set-back (the knuckles run in an arc: the middle one furthest out)
    # (a gentle natural fan: the fingertips sit a little further apart than
    # the knuckles, which also keeps them separate surfaces when fused)
    ("Index", 0.0262, 0.075, 0.0074, -0.09, 0.003),
    ("Middle", 0.0086, 0.081, 0.0076, -0.01, 0.0),
    ("Ring", -0.0090, 0.077, 0.0072, 0.07, 0.004),
    ("Little", -0.0262, 0.062, 0.0063, 0.14, 0.012),
]


def finger_chain(side, name):
    """Three joint positions + tip for a finger (used by the rig too)."""
    d, thumb, palm_n = palm_frame(side)
    wrist = JOINTS[("left" if side > 0 else "right") + "Hand"]
    if name == "Thumb":
        root = wrist + d * 0.020 + thumb * 0.023 + palm_n * 0.009
        dirn = (d * 0.62 + thumb * 0.62 + palm_n * 0.30).normalized()
        segs = (0.027, 0.023, 0.021)
        bend = Matrix.Rotation(-0.18 * side, 3, d)
        pts = [root]
        cur = dirn
        for L in segs:
            pts.append(pts[-1] + cur * L)
            cur = (bend @ cur).normalized()
        return pts
    _n, across, length, _r, splay, setback = next(f for f in FINGERS if f[0] == name)
    knuckle = wrist + d * (KNUCKLE - setback) + thumb * across - palm_n * 0.002
    # splay > 0 fans a finger away from the thumb (index −, little +); about
    # palm_n a positive turn heads toward the thumb, hence the minus
    dirn = (Matrix.Rotation(-splay * side, 3, palm_n) @ d).normalized()
    axis = dirn.cross(palm_n).normalized()
    segs = (length * 0.42, length * 0.31, length * 0.27)
    pts = [knuckle]
    cur = dirn
    for i, L in enumerate(segs):
        cur = (Matrix.Rotation(-(0.10, 0.16, 0.12)[i], 3, axis) @ cur).normalized()
        pts.append(pts[-1] + cur * L)
    return pts


def _nail(tip, along, back, r, length):
    """A small domed nail lying on the back of a fingertip / toe."""
    side = along.cross(back).normalized()
    c0 = tip - along * (length + r * 0.35) + back * r * 0.72
    rings = []
    for t, w in ((0.0, 0.55), (0.25, 0.95), (0.7, 1.0), (1.0, 0.75)):
        c = c0 + along * (length * t)
        rings.append(superellipse_ring(c, side, back, r * 0.72 * w, 0.0011, 2.2, 10))
    return loft(rings)


# ── the hand ──
# along the hand from the wrist: (u, half-width, back-of-hand height, palm depth)
_PALM = [
    (-0.020, 0.0190, 0.0130, 0.0130), (-0.008, 0.0212, 0.0146, 0.0148), (0.000, 0.0226, 0.0153, 0.0157),
    (0.012, 0.0258, 0.0150, 0.0166), (0.026, 0.0296, 0.0141, 0.0165), (0.042, 0.0328, 0.0130, 0.0152),
    (0.058, 0.0350, 0.0120, 0.0138), (0.072, 0.0362, 0.0112, 0.0127), (0.084, 0.0366, 0.0106, 0.0118),
    (0.094, 0.0358, 0.0099, 0.0106), (0.101, 0.0334, 0.0086, 0.0090), (0.106, 0.0292, 0.0068, 0.0070),
]
_PW = pchip([(u, w) for u, w, _b, _p in _PALM])
_PB = pchip([(u, b) for u, _w, b, _p in _PALM])
_PP = pchip([(u, p) for u, _w, _b, p in _PALM])


def _forearm_t(u):
    """Arm-path parameter at ``u`` m from the wrist along the hand axis."""
    return min(1.0, 1.0 + u / FOREARM * (1.0 / 3.0))


def _palm(side, wrist, d, across, palm_n, rows=24, segs=32):
    """Palm and back of the hand, one smooth loft that takes over from the
    forearm (same cross-section, a hair outside it) just above the wrist and
    turns into the hand: it widens out of the wrist, carries the thumb's pad
    (thenar) and web, the smaller pad under the little finger, the knuckles
    ride on its back, and its end follows their arc."""
    rings = []
    for i in range(rows):
        u = lerp(-WRIST_TAKEOVER - 0.004, 0.106, i / (rows - 1))
        blend = smoothstep(-0.012, 0.010, u)  # forearm → hand
        ft = _forearm_t(u)
        # just inside the forearm where it starts, a hair outside it by the time
        # the forearm ends — the two surfaces cross without a rim
        off = lerp(-0.0003, 0.0003, smoothstep(-WRIST_TAKEOVER - 0.004, -WRIST_TAKEOVER + 0.002, u))
        fw, fd = _ARM_RY(ft) + off, _ARM_R(ft) + off
        w, hb, hp = lerp(fw, _PW(u), blend), lerp(fd, _PB(u), blend), lerp(fd, _PP(u), blend)
        n = lerp(2.0, 2.5, smoothstep(-0.005, 0.03, u))
        thenar = math.exp(-(((u - 0.026) / 0.022) ** 2))
        web = math.exp(-(((u - 0.036) / 0.020) ** 2))
        hypo = math.exp(-(((u - 0.040) / 0.030) ** 2))
        end = smoothstep(0.080, 0.106, u)
        ring = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            c, s = math.cos(a), math.sin(a)
            xn = math.copysign(abs(c) ** (2 / n), c)
            yn = math.copysign(abs(s) ** (2 / n), s)  # + = palm side
            x = w * xn
            y = (hp if s > 0 else hb) * yn
            th = xn * side  # + toward the thumb
            x += side * (0.0040 * thenar * max(th, 0.0) ** 2 + 0.0100 * web * max(th, 0.0) ** 1.5)
            if s > 0:
                y += 0.0085 * thenar * max(th, 0.0) ** 1.5 * yn
                y += 0.0030 * hypo * max(-th, 0.0) ** 1.5 * yn
            else:
                for _f, f_across, _l, _r, _s, back in FINGERS:
                    bump = math.exp(-(((x - f_across * side) / 0.0065) ** 2) - (((u - (KNUCKLE - back - 0.004)) / 0.009) ** 2))
                    y += 0.0022 * bump * yn
            uu = u - 0.009 * end * xn * xn
            ring.append(wrist + d * uu + across * x + palm_n * (y - 0.001 * blend))
        rings.append(ring)
    return loft(rings, cap_start=True, cap_end=True)


def _digit(pts, r, dorsal, back_len, prof, flat=0.86, segs=16, pad=0.07):
    """A finger or thumb: a tapered, slightly flattened tube from inside the
    palm through its joints (a touch fuller at each), ending in a rounded
    fingertip whose pad sits toward the palm side. Returns the mesh and the
    fingertip frame for its nail."""
    root_dir = (pts[1] - pts[0]).normalized()
    path = [pts[0] - root_dir * back_len] + polyline(pts, 6)
    acc = [0.0]
    for a, b in zip(path, path[1:]):
        acc.append(acc[-1] + (b - a).length)
    ts = [a / acc[-1] for a in acc]
    tj = [ts[1], ts[7], ts[13], ts[19]]  # knuckle and the three joints along the path
    keys = [(0.0, prof[0]), (tj[0], prof[1]), ((tj[0] + tj[1]) / 2, prof[2]), (tj[1], prof[3]),
            ((tj[1] + tj[2]) / 2, prof[4]), (tj[2], prof[5]), ((tj[2] + 1) / 2, prof[6]), (1.0, prof[7])]
    m = pchip(keys)
    rings = []
    frames = []
    for i, p in enumerate(path):
        tan = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        dors = (dorsal - tan * dorsal.dot(tan)).normalized()
        vol = -dors
        acr = vol.cross(tan).normalized()
        R = r * m(ts[i])
        c = p + vol * (pad * r * smoothstep(0.78, 1.0, ts[i]))
        rings.append(superellipse_ring(c, acr, vol, R, R * flat, 2.1, segs))
        frames.append((c, tan, dors, acr, R))
    # the rounded fingertip
    c, tan, dors, acr, R = frames[-1]
    for deg in (24, 46, 64, 78):
        q = math.radians(deg)
        rings.append(superellipse_ring(c + tan * (R * 0.95 * math.sin(q)), acr, -dors, R * math.cos(q), R * flat * math.cos(q), 2.1, segs))
    verts, faces, uvs = loft(rings, cap_start=True, cap_end=False)
    tip = len(verts)
    verts.append(c + tan * R * 0.95)
    uvs.append((0.5, 1.0))
    o = (len(rings) - 1) * segs
    for k in range(segs):
        faces.append((tip, o + k, o + (k + 1) % segs))
    return (verts, faces, uvs), frames


_NAIL_SPAN = pchip([(0.0, 0.78), (0.22, 1.0), (0.65, 0.97), (0.88, 0.74), (1.0, 0.34)])


def _frame_at(frames, a):
    """The finger's cross-section frame ``a`` m from its last ring (a < 0:
    back along the finger; a > 0: straight on past it, over the fingertip)."""
    c, tan, dors, acr, R = frames[-1]
    if a >= 0:
        return c + tan * a, tan, dors, acr, R
    back = -a
    for i in range(len(frames) - 1, 0, -1):
        f1, f0 = frames[i], frames[i - 1]
        seg = (f1[0] - f0[0]).length
        if back <= seg or i == 1:
            t = 1.0 - min(back / seg, 1.0)
            return (f0[0].lerp(f1[0], t), f0[1].lerp(f1[1], t).normalized(), f0[2].lerp(f1[2], t).normalized(),
                    f0[3].lerp(f1[3], t).normalized(), lerp(f0[4], f1[4], t))
        back -= seg
    return frames[0]


def _nail_shell(frames, flat, back_on, over, span_deg=58.0, rows=10, cols=9, n=2.1):
    """An almond nail: a thin plate on the back of the fingertip that follows
    the finger's own cross-section (so it never sinks into the skin), from its
    cuticle ``back_on`` m behind the last joint to a free edge ``over`` m past
    the tip, drooping a hair as it leaves the finger."""
    R_end = frames[-1][4]
    a0, a1 = -back_on, R_end * 0.95 + over
    e = 2.0 / n

    def grid(lift):
        g = []
        for i in range(rows):
            s = i / (rows - 1)
            c, tan, dors, acr, R = _frame_at(frames, lerp(a0, a1, s))
            c = c - dors * (0.0011 * s ** 2.2)
            span = math.radians(span_deg) * _NAIL_SPAN(s)
            row = []
            for j in range(cols):
                q = span * lerp(-1.0, 1.0, j / (cols - 1))
                sq, cq = math.sin(q), math.cos(q)
                row.append(c + dors * ((R * flat + lift) * abs(cq) ** e) + acr * ((R + lift) * math.copysign(abs(sq) ** e, sq)))
            g.append(row)
        return g

    top, bot = grid(0.0010), grid(0.0004)
    verts = [p for row in top for p in row] + [p for row in bot for p in row]
    T = lambda i, j: i * cols + j  # noqa: E731
    B = lambda i, j: rows * cols + i * cols + j  # noqa: E731
    faces = []
    for i in range(rows - 1):
        for j in range(cols - 1):
            faces.append((T(i, j), T(i, j + 1), T(i + 1, j + 1), T(i + 1, j)))  # out of the finger
            faces.append((B(i, j), B(i + 1, j), B(i + 1, j + 1), B(i, j + 1)))  # into it
        faces.append((T(i, 0), T(i + 1, 0), B(i + 1, 0), B(i, 0)))
        faces.append((T(i, cols - 1), B(i, cols - 1), B(i + 1, cols - 1), T(i + 1, cols - 1)))
    for j in range(cols - 1):
        faces.append((T(0, j), B(0, j), B(0, j + 1), T(0, j + 1)))
        faces.append((T(rows - 1, j), T(rows - 1, j + 1), B(rows - 1, j + 1), B(rows - 1, j)))
    return verts, faces, [(0.5, 0.5)] * len(verts)


WRIST_TAKEOVER = 0.032  # the hand's loft takes over from the forearm this far above the wrist


def build_arm(mb, hb, nails, side):
    """Forearm, palm, fingers and thumb into the hand builder ``hb``: they are
    fused into one surface later (see _fuse_hand), so the only join with the
    body is up inside the sleeve."""
    sfx = "L" if side > 0 else "R"
    # forearm skin from just above the elbow (the sleeve hides the rest) to
    # just above the wrist, where the hand's loft takes over
    full = arm_path(side, t0=0.40)
    t_end = _forearm_t(-WRIST_TAKEOVER)
    path = [p for p, t in zip(full, (0.40 + 0.60 * i / (len(full) - 1) for i in range(len(full)))) if t < t_end - 1e-6]
    path.append(full[-1] - arm_dir(side) * WRIST_TAKEOVER)
    span = t_end - 0.40
    prof_x = lambda t: _ARM_R(0.40 + span * t)  # noqa: E731
    prof_y = lambda t: _ARM_RY(0.40 + span * t)  # noqa: E731
    hb.add(tube(path, prof_x, prof_y, Vector((0, 1, 0)), segs=32, cap_start=True, cap_end=True), "arm_" + sfx)

    d, thumb, palm_n = palm_frame(side)
    wrist = JOINTS[("left" if side > 0 else "right") + "Hand"]
    hb.add(_palm(side, wrist, d, thumb * side, palm_n), "palm_" + sfx)

    for name in ("Thumb", "Index", "Middle", "Ring", "Little"):
        pts = finger_chain(side, name)
        tag = f"finger{name}_{sfx}"
        if name == "Thumb":
            # the thumb's nail faces out to the side and up, not to the back of the hand
            dorsal = (thumb * 0.75 - palm_n * 0.66).normalized()
            mesh, frames = _digit(pts, 0.0092, dorsal, 0.018, (1.25, 1.12, 1.03, 1.0, 0.93, 0.95, 0.92, 0.87), flat=0.84)
            seg = (pts[3] - pts[2]).length
            nails.add(_nail_shell(frames, 0.84, 0.52 * seg, 0.0018, span_deg=52.0), tag)
        else:
            _n, _a, _l, r, _s, _b = next(f for f in FINGERS if f[0] == name)
            mesh, frames = _digit(pts, r, -palm_n, 0.011, (0.96, 1.0, 0.95, 0.99, 0.90, 0.91, 0.89, 0.84))
            seg = (pts[3] - pts[2]).length
            nails.add(_nail_shell(frames, 0.86, 0.56 * seg, 0.0024, span_deg=50.0), tag)
        hb.add(mesh, tag)


# ── legs & feet ─────────────────────────────────────────────────────────

LEG_RX = pchip([(0.0, 0.066), (0.10, 0.074), (0.40, 0.065), (0.62, 0.045), (0.68, 0.041),
                (0.76, 0.041), (0.90, 0.028), (1.0, 0.0225)])
LEG_RY = pchip([(0.0, 0.068), (0.10, 0.076), (0.40, 0.068), (0.62, 0.049), (0.68, 0.046),
                (0.76, 0.048), (0.90, 0.031), (1.0, 0.0255)])


def leg_path(side):
    s = "left" if side > 0 else "right"
    hip, knee, ankle = JOINTS[s + "UpperLeg"], JOINTS[s + "LowerLeg"], JOINTS[s + "Foot"]
    top = hip + Vector((-side * 0.004, 0.0, 0.035))
    return polyline([top, hip, knee, ankle], 10)


# (y, z bottom, z top, half-width): an arched foot, heel raised on the sandal
_FOOT = [
    (0.048, 0.074, 0.110, 0.017), (0.032, 0.066, 0.128, 0.023), (0.006, 0.058, 0.124, 0.025),
    (-0.030, 0.040, 0.094, 0.027), (-0.064, 0.020, 0.060, 0.031), (-0.088, 0.011, 0.042, 0.034),
    (-0.104, 0.009, 0.031, 0.033),
]
# toes: (across from the foot centre toward the big-toe side, length, radius)
_TOES = [(0.018, 0.044, 0.0082), (0.0055, 0.040, 0.0059), (-0.0055, 0.036, 0.0055),
         (-0.0155, 0.032, 0.0051), (-0.0245, 0.027, 0.0047)]


def build_foot(mb, nails, side):
    sfx = "L" if side > 0 else "R"
    x = JOINTS[("left" if side > 0 else "right") + "Foot"].x + side * 0.003
    rings = []
    for y, zb, zt, hw in _FOOT:
        c = Vector((x, y, (zb + zt) * 0.5))
        rings.append(superellipse_ring(c, Vector((1, 0, 0)), Vector((0, 0, 1)), hw, (zt - zb) * 0.5, 2.8, 24))
    mb.add(loft(rings), "foot_" + sfx)
    for across, length, r in _TOES:
        tx = x - side * across  # the big toe sits on the inner side
        root = Vector((tx, -0.098, 0.018))
        end = Vector((tx - side * across * 0.15, -0.098 - length, 0.0135))
        path = polyline([root, end], 5)
        prof = pchip([(0.0, r), (0.6, r * 0.95), (1.0, r * 0.82)])
        tip = end + (end - root).normalized() * r * 0.7
        mb.add(tube(path, prof, lambda t, p=prof: p(t) * 0.85, Vector((0, 0, 1)), segs=10, cap_start=True, tip=tip), "foot_" + sfx)
        along = (end - root).normalized()
        nails.add(_nail(tip, along, Vector((0, 0, 1)), r * 0.85, 0.0065 if r > 0.008 else 0.0042), "foot_" + sfx)


def build_leg(mb, side):
    mb.add(tube(leg_path(side), LEG_RX, LEG_RY, Vector((0, -1, 0)), segs=28, cap_start=True, cap_end=True),
           "leg_" + ("L" if side > 0 else "R"))


# ── ink lines on the skin ───────────────────────────────────────────────


def _stroke(bvh, pts, widths, lift=0.0006):
    """A tapered ribbon along face-plane points (x, z), projected onto the
    body from the front."""
    curve = catmull_rom([Vector((x, 0.0, z)) for x, z in pts], 5)
    wf = pchip([(i / (len(widths) - 1), w) for i, w in enumerate(widths)])
    a_row, b_row = [], []
    n = len(curve)
    for i, p in enumerate(curve):
        t = curve[min(i + 1, n - 1)] - curve[max(i - 1, 0)]
        side = Vector((-t.z, 0.0, t.x)).normalized() * (wf(i / (n - 1)) * 0.5)
        for row, q in ((a_row, p - side), (b_row, p + side)):
            hit, nrm, _i, _d = bvh.ray_cast(Vector((q.x, -1.0, q.z)), Vector((0, 1, 0)))
            if nrm.y > 0:
                nrm = -nrm
            row.append(hit + nrm * lift)
    return open_loft([a_row, b_row])


def build_skin_lines(body_ob):
    """The cleavage (a line up from the V, opening into the inner curves of
    the breasts) and the collarbones."""
    bvh = bvh_of(body_ob)
    mb = MeshBuilder()
    mb.add(_stroke(bvh, [(0.0, 1.166), (0.0004, 1.186), (0.0, 1.206), (-0.0006, 1.222)], [0.0004, 0.0016, 0.0013, 0.0003]), "torso")
    for side in (1, -1):
        # the inner contour of each breast: an arc round its centre
        arc = []
        for a in (186, 172, 158, 144, 130):
            r = math.radians(a)
            arc.append((side * (BUST_X + 0.074 * math.cos(r)), BUST_Z - 0.004 + 0.070 * math.sin(r)))
        mb.add(_stroke(bvh, arc, [0.0003, 0.0011, 0.0011, 0.0008, 0.0002]), "torso")
        mb.add(_stroke(bvh, [(side * 0.019, 1.357), (side * 0.031, 1.360), (side * 0.044, 1.364), (side * 0.057, 1.368)],
                       [0.0002, 0.0011, 0.0009, 0.0001]), "torso")
    ob = mb.build("SkinLines", material("SkinLine", srgb("#c4887a"), roughness=0.6))
    # the strips must face the camera (out of the skin) for the app's culling
    if ob.data.polygons and ob.data.polygons[0].normal.y > 0:
        ob.data.flip_normals()

    # soft shade: down the cleavage, and where the kimono's edges overhang
    # the skin of the V
    from .clothes import _V_HW, V_POINT  # noqa: PLC0415 — the V is defined with the kimono

    sh = MeshBuilder()
    sh.add(_stroke(bvh, [(0.0, 1.168), (0.0, 1.190), (0.0, 1.212), (0.0, 1.232)], [0.0010, 0.0060, 0.0055, 0.0010], 0.0004), "torso")
    for side in (1, -1):
        pts, ws = [], []
        for i in range(9):
            z = lerp(V_POINT + 0.006, 1.385, i / 8)
            pts.append((side * (_V_HW(z) - 0.0035), z))
            ws.append(0.0055 if 0 < i < 8 else 0.002)
        sh.add(_stroke(bvh, pts, ws, 0.0004), "torso")
    shade = sh.build("SkinShade", material("SkinShade", srgb("#e9bba9"), roughness=0.6))
    if shade.data.polygons and shade.data.polygons[0].normal.y > 0:
        shade.data.flip_normals()
    return [ob, shade]


def _fuse_hand(ob, side, voxel=0.0005, smooth=8, keep=0.014, pin_wrist=False):
    """Turn a hand built from overlapping parts (palm loft, finger and thumb
    tubes) into ONE organic surface, the way a sculpted hand is: voxel-remesh
    their union (real webbing between the fingers, knuckles that flow into the
    back of the hand, a thumb that grows out of its pad), relax the voxel
    steps and decimate to a light mesh (``pin_wrist``: when the forearm is a
    separate tube, pin the hand's wrist end onto its cross-section). Each new
    vertex takes the part tag of the nearest original surface, so the rig
    weights it per part (and the spec smooths those weights across the
    joins)."""
    from mathutils.bvhtree import BVHTree

    me = ob.data
    names = {vg.index: vg.name for vg in ob.vertex_groups}
    tag = [None] * len(me.vertices)
    for v in me.vertices:
        for g in v.groups:
            tag[v.index] = names[g.group]
    verts = [ob.matrix_world @ v.co for v in me.vertices]
    parts = {}
    for p in me.polygons:
        parts.setdefault(tag[p.vertices[0]], []).append(tuple(p.vertices))
    trees = {t: BVHTree.FromPolygons(verts, polys) for t, polys in parts.items()}

    rm = ob.modifiers.new("Fuse", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = voxel
    rm.adaptivity = 0.0
    sm = ob.modifiers.new("Relax", "SMOOTH")
    sm.factor = 0.5
    sm.iterations = smooth
    dc = ob.modifiers.new("Light", "DECIMATE")
    dc.ratio = keep
    dg = bpy.context.evaluated_depsgraph_get()
    new = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    ob.modifiers.clear()
    old = ob.data
    ob.data = new
    new.name = old.name
    bpy.data.meshes.remove(old)

    # pin the wrist end onto the forearm's elliptical cross-section, easing
    # into the hand
    d, thumb, palm_n = palm_frame(side)
    across = thumb * side
    wrist = JOINTS[("left" if side > 0 else "right") + "Hand"]
    inv = ob.matrix_world.inverted()
    for v in new.vertices:
        p = ob.matrix_world @ v.co
        rel = p - wrist
        u = rel.dot(d)
        pin = smoothstep(-0.018, -WRIST_TAKEOVER + 0.002, u) if pin_wrist else 0.0
        if pin <= 0.0:
            continue
        ft = _forearm_t(u)
        x, y = rel.dot(across), rel.dot(palm_n)
        r = math.sqrt((x / _ARM_RY(ft)) ** 2 + (y / _ARM_R(ft)) ** 2) or 1.0
        # inside the forearm where it still covers the hand, a hair outside
        # it over the forearm's open edge (so no outline catches that edge)
        k = lerp(0.997, 1.004, smoothstep(-WRIST_TAKEOVER - 0.003, -WRIST_TAKEOVER + 0.001, u)) / r
        on = wrist + d * u + across * (x * k) + palm_n * (y * k)
        v.co = inv @ p.lerp(on, pin)
    new.validate()
    new.polygons.foreach_set("use_smooth", [True] * len(new.polygons))
    new.update()

    for vg in list(ob.vertex_groups):
        ob.vertex_groups.remove(vg)
    groups = {t: ob.vertex_groups.new(name=t) for t in trees}
    for v in new.vertices:
        p = ob.matrix_world @ v.co
        best = min(trees, key=lambda t: trees[t].find_nearest(p)[3])
        groups[best].add([v.index], 1.0, "REPLACE")
    return ob


def _seat_nails(nail_ob, surfaces):
    """Fusing a hand moves its surface by a fraction of a millimetre; move
    each fingernail vertex by however much the skin under it moved, so the
    nails sit on the fused fingertips exactly as they sat on the parts (the
    toenails, far from any hand, stay put)."""
    me = nail_ob.data
    mw = nail_ob.matrix_world
    inv = mw.inverted()
    for v in me.vertices:
        p = mw @ v.co
        for before, after in surfaces:
            q0, n0, _i, d0 = before.find_nearest(p)
            if q0 is None or d0 > 0.004:
                continue
            q1, _n, _j, _d = after.find_nearest(q0)
            if q1 is not None:
                v.co = inv @ (p + n0 * (q1 - q0).dot(n0))
            break
    me.update()


def build_body():
    mb = MeshBuilder()
    nails = MeshBuilder()
    hands = []
    build_torso(mb)
    for side in (1, -1):
        hb = MeshBuilder()
        build_arm(mb, hb, nails, side)
        hands.append((side, hb))
        build_leg(mb, side)
        build_foot(mb, nails, side)
    skin = material("Skin", srgb(SKIN), roughness=0.55)
    body = mb.build("Body", skin)
    hand_obs, surfaces = [], []
    for side, hb in hands:
        ob = hb.build("Hand_" + ("L" if side > 0 else "R"), skin)
        before = bvh_of(ob)
        _fuse_hand(ob, side)
        surfaces.append((before, bvh_of(ob)))
        hand_obs.append(ob)
    nail_ob = nails.build("Nails", material("Nail", srgb("#c8283c"), roughness=0.3))
    _seat_nails(nail_ob, surfaces)
    lines = build_skin_lines(body)
    return [body.name, nail_ob.name] + [o.name for o in hand_obs] + [o.name for o in lines]
