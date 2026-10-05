"""Hair — pale blonde, parted in the middle: curtains that sweep from the part
over the forehead corners and fall past the cheeks to the collarbones (framing
the face as in the reference), and two low pigtails tied at the nape, falling
to the waist.

Spring chains (simulated in the app): ``hair_tail_L/R`` (pigtails) and
``hair_lock_L/R`` (the front locks). Everything else rides the head.
"""

import math
import random

from mathutils import Vector

from kit.common import lerp, material, pchip, smoothstep, srgb
from kit.geom import loft, superellipse_ring
from kit.strands import HairBuilder, Shell, build_cap, clump, outward_from, taper

from .head import HEAD_C

HAIR_BASE = "#ecd3ab"
_out = outward_from(HEAD_C, body_y=0.03, near=0.04, far=0.13)


def _curtain_out(p):
    """Cross-section orientation for the curtains: lying on the skull up
    top, but turned to face forward (a touch outward) once they hang beside
    the face — so they spread across the cheek like a curtain instead of
    showing the camera their edge."""
    k = smoothstep(HEAD_C.z + 0.025, HEAD_C.z - 0.025, p.z)
    fwd = Vector((0.6 * math.copysign(1.0, p.x), -0.8, 0.0))
    return _out(p).lerp(fwd, k).normalized()

# the pigtail ties sit low at the back of the head, just behind the ears
TIE = {1: HEAD_C + Vector((0.036, 0.094, -0.100)), -1: HEAD_C + Vector((-0.036, 0.094, -0.100))}


def tail_path(side):
    """Centre line of a pigtail: from the tie, down behind the shoulder to
    the waist, drifting outward a little and settling on the back."""
    t = TIE[side]
    return [
        t,
        t + Vector((side * 0.018, 0.022, -0.070)),
        t + Vector((side * 0.034, 0.040, -0.170)),
        t + Vector((side * 0.040, 0.046, -0.290)),
        t + Vector((side * 0.036, 0.044, -0.410)),
        t + Vector((side * 0.030, 0.038, -0.520)),
    ]


LOCKS = 4  # curtain locks per side


def lock_path(side, k):
    """Centre line of curtain lock ``k`` (0 = innermost) below the temple: it
    covers the edge of the cheek (the face shows about ±6.5 cm wide, as in
    the reference), tucks in along the jaw, and ends over the collarbone —
    clear of the coat's lapels."""
    ax = 0.078 + 0.0095 * k
    ay = -0.052 + 0.012 * k  # in front of the cheek: its inner edge covers the side of the face
    return [
        HEAD_C + Vector((side * ax, ay, -0.030)),
        HEAD_C + Vector((side * (ax - 0.008), ay + 0.002, -0.080)),
        HEAD_C + Vector((side * (ax - 0.004), ay - 0.008, -0.120)),
        HEAD_C + Vector((side * (ax + 0.004), ay - 0.020, -0.150)),
        HEAD_C + Vector((side * (ax + 0.008), ay - 0.028, -0.168)),
    ]


def chain_joints():
    """{chain name: joints} for the hair spring chains."""
    out = {}
    for side, sfx in ((1, "L"), (-1, "R")):
        p = tail_path(side)
        out["hair_tail_" + sfx] = [p[1], p[2], p[3], p[4], p[5] + (p[5] - p[4]) * 0.3]
        lk = lock_path(side, 1)
        out["hair_lock_" + sfx] = [lk[1], lk[2], lk[3], lk[4] + (lk[4] - lk[3]) * 0.6]
    return out


def build_hair(head_ob):
    rnd = random.Random(11)
    shell = Shell(head_ob, HEAD_C)
    mat = material("Hair", srgb(HAIR_BASE), roughness=0.45)
    hb = HairBuilder()

    # ── strands flowing from the centre part, out to the sides ──
    # The part runs from the front hairline (el ≈ 48°) back over the crown.
    # Each strand leaves the part and sweeps sideways (never forward), so the
    # forehead stays open; the front-most ones frame its corners.
    for side in (1, -1):
        for i in range(10):
            el0 = lerp(50, 88, i / 9)  # where it leaves the part
            az1 = lerp(48, 150, i / 9)  # where it lands on the side/back
            el1 = lerp(8, -14, i / 9)
            mid_az = side * az1 * 0.55
            mid_el = lerp(el0, el1, 0.45) + 8
            pts = shell.path([(side * 2, el0, 0.010), (mid_az, mid_el, 0.0135), (side * az1, el1, 0.012)], per_seg=3)
            if az1 > 110:
                # the back strands gather into the pigtail ties
                pts.append(TIE[side] + Vector((0, -0.004, 0.012)))
            w = 0.020 + 0.004 * rnd.random()
            hb.add(clump(pts, taper(w * 0.8, w, 0.45, 0.9), taper(0.0042, 0.0050, 0.4, 0.8), _out, n_len=18, crescent=0.25), "head")

    # ── curtains: from the part, over the forehead corner, down the face ──
    # (the innermost lock's edge sits just outside the outer eye corner; the
    # forehead shows as an arch under the part, as in the reference)
    # each lock: (half-width, thickness, its stops on the skull: leaving the
    # part, crossing the forehead corner, over the temple)
    curtain = (
        (0.0175, 0.0085, ((0.6, 61, 0.013), (18, 41, 0.016), (34, 21, 0.016), (51, -5, 0.014))),
        (0.0195, 0.0090, ((3, 63, 0.013), (28, 42, 0.018), (44, 20, 0.018), (57, -5, 0.016))),
        (0.0195, 0.0090, ((5, 67, 0.013), (38, 44, 0.019), (54, 20, 0.019), (63, -3, 0.017))),
        (0.0180, 0.0082, ((7, 71, 0.013), (48, 46, 0.019), (64, 20, 0.019), (70, -1, 0.017))),
    )
    for side, sfx in ((1, "L"), (-1, "R")):
        for k, (w, th, stops) in enumerate(curtain):
            root = shell.path([(side * az, el, off) for az, el, off in stops], per_seg=3)
            pts = root + lock_path(side, k)
            hb.add(clump(pts, taper(w * 0.85, w, 0.25, 0.7), taper(th * 0.8, th, 0.35, 0.8), _curtain_out, n_len=32), "hair_lock_" + sfx)
    # the little tuft at the part — the "M" of her hairline
    tuft = shell.path([(0, 67, 0.012), (0, 54, 0.014), (0, 45, 0.011)], per_seg=3)
    hb.add(clump(tuft, taper(0.004, 0.0075, 0.35, 1.0), taper(0.0028, 0.0040, 0.35, 0.8), _out, n_len=12, crescent=0.25), "head")

    # ── two low pigtails ──
    for side, sfx in ((1, "L"), (-1, "R")):
        centre = tail_path(side)
        for j in range(7):
            ang = 2 * math.pi * j / 7 + rnd.uniform(-0.2, 0.2)
            spread = 0.015 + 0.004 * rnd.random()
            pts = []
            for i, c in enumerate(centre):
                # a bundle that swells below the tie then gathers to the end
                k = (0.25, 0.9, 1.25, 1.2, 0.9, 0.5)[i]
                off = Vector((math.cos(ang) * spread * k * 1.4, math.sin(ang) * spread * k, 0))
                pts.append(c + off)
            length_cut = rnd.uniform(0.0, 0.06)
            pts[-1] = pts[-1] + Vector((0, 0, length_cut))
            w = 0.017 + 0.005 * rnd.random()
            hb.add(clump(pts, taper(w * 0.5, w, 0.3, 1.1), taper(0.0060, 0.0095, 0.3, 0.8), _out, n_len=26), "hair_tail_" + sfx)

    strands = hb.build("HairStrands", mat)

    def hairline(az):
        # high at the front: the curtain locks form the hairline there, meeting
        # in a peak at the part
        return pchip([(0, 0.066), (25, 0.058), (45, 0.040), (70, 0.012), (95, -0.040), (130, -0.075), (180, -0.090)])(az)

    def volume(rel):
        return 0.008 + 0.010 * smoothstep(-0.02, 0.10, rel.z) + 0.004 * smoothstep(0.0, 0.08, rel.y)

    cap = build_cap(head_ob, mat, HEAD_C, hairline, volume, snap_edge=True)
    ties = build_ties()
    return [cap.name, strands.name, ties.name]


def build_ties():
    """Small dark hair ties where the pigtails are gathered."""
    from kit.geom import MeshBuilder

    mb = MeshBuilder()
    for side in (1, -1):
        p = tail_path(side)
        axis = (p[1] - p[0]).normalized()
        a1 = axis.cross(Vector((1, 0, 0))).normalized()
        a2 = axis.cross(a1).normalized()
        rings = [superellipse_ring(p[0] + axis * (0.004 + 0.009 * t), a1, a2, 0.0105, 0.0095, 2.0, 16) for t in (0.0, 0.5, 1.0)]
        mb.add(loft(rings))
    return mb.build("HairTies", material("HairTie", srgb("#3a2a22"), roughness=0.6))
