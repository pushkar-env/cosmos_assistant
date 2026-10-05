"""Hair — a volume cap plus layered, pointed anime clumps.

Each clump is a swept crescent cross-section that tapers to a point. UV.y
runs root (0) → tip (1) so the app's hair shader can fade the silver base
into the theme-coloured tips; UV.x runs across the strand for the jagged
"angel ring" highlight.

Clumps are tagged with their spring chain (a ``hair_*`` vertex group) so the
rig step can bind them to it; the strand tools live in kit.strands.
"""

import math
import random

from mathutils import Vector

from kit.common import material, pchip, smoothstep, srgb
from kit.strands import HairBuilder, Shell, clump, outward_from, taper
from kit.strands import build_cap as strands_cap

from .head import HEAD_C

_out = outward_from(HEAD_C)

HAIR_BASE = "#e9e6f7"


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
        return "hair_back_C"
    return "hair_back_L" if theta > 0 else "hair_back_R"


# spring-bone chains (joint positions, root first). The rig builds bones
# along these and binds the matching hair group to them.
def chain_joints():
    """{chain name: joints} for every hair spring chain."""
    out = {}
    zs = [CURTAIN_TOP + 0.005, HEAD_C.z - 0.215, HEAD_C.z - 0.33, HEAD_C.z - 0.445, HEAD_C.z - 0.545]
    for name, theta in (("hair_back_C", 180.0), ("hair_back_L", 142.0), ("hair_back_R", -142.0)):
        out[name] = [curtain_point(theta, z, 0.0045) for z in zs]
    for side, sfx in ((1, "L"), (-1, "R")):
        out["hair_side_" + sfx] = [
            HEAD_C + Vector((side * 0.090, -0.040, -0.100)),
            HEAD_C + Vector((side * 0.097, -0.036, -0.180)),
            HEAD_C + Vector((side * 0.088, -0.046, -0.268)),
        ]
    out["hair_ahoge"] = list(AHOGE_JOINTS)
    return out


AHOGE_JOINTS = []


def build_hair(head_ob):
    rnd = random.Random(7)
    shell = Shell(head_ob, HEAD_C)
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
            hb.add(clump(pts, taper(w * 0.85, w, 0.45, 1.6), taper(0.0042, 0.0052, 0.4, 0.9), _out, n_len=18), "head")

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
                clump(pts, taper(w * 0.8, w, 0.4, 1.4), taper(0.0045, 0.006, 0.35, 0.8), _out, n_len=22),
                "hair_side_L" if side > 0 else "hair_side_R",
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
        hb.add(clump(pts, taper(w * 0.75, w, 0.3, 1.25), taper(0.0055, 0.0085, 0.3, 0.8), _out, n_len=26), back_group(theta))

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
    hb.add(clump(ahoge, taper(0.004, 0.0075, 0.35, 1.1), taper(0.002, 0.0026, 0.3, 0.8), _out, n_len=14), "hair_ahoge")
    AHOGE_JOINTS[:] = [ahoge[0] + Vector((0, 0, 0.004)), ahoge[2], ahoge[4]]

    strands = hb.build("HairStrands", mat)
    cap = build_cap(head_ob, mat)
    return [cap.name, strands.name]


def build_cap(head_ob, mat):
    """Hair volume over the skull: the head mesh above the hairline, inflated."""
    hairline = pchip([(0, 0.038), (40, 0.034), (70, 0.010), (95, -0.045), (130, -0.070), (180, -0.080)])

    def volume(rel):
        # extra volume on top and at the back, thin at the hairline
        return 0.007 + 0.010 * smoothstep(-0.02, 0.10, rel.z) + 0.004 * smoothstep(0.0, 0.08, rel.y)

    return strands_cap(head_ob, mat, HEAD_C, hairline, volume)
