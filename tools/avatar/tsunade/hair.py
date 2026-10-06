"""Hair — pale blonde, parted in the middle: curtains that sweep from the part
over the forehead corners and fall past the cheeks to the collarbones (framing
the face as in the reference); the hair over the ears swept back behind them;
and two full pigtails tied low behind the ears, with a curtain of hair between
them over the nape, falling down her back to the waist.

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

# the pigtail ties sit low at the back of the head, behind the ears — high
# enough that, in profile, the hair falls in one mass from behind the ear
# down her back (as in the reference)
TIE = {1: HEAD_C + Vector((0.050, 0.086, -0.084)), -1: HEAD_C + Vector((-0.050, 0.086, -0.084))}


def tail_path(side):
    """Centre line of a pigtail: from the tie, down behind the shoulder to
    the waist, drifting outward a little and settling on the back."""
    t = TIE[side]
    return [
        t,
        t + Vector((side * 0.012, 0.024, -0.070)),
        t + Vector((side * 0.022, 0.046, -0.170)),
        t + Vector((side * 0.026, 0.054, -0.290)),
        t + Vector((side * 0.022, 0.052, -0.410)),
        t + Vector((side * 0.016, 0.046, -0.520)),
    ]


def curtain_path(side, x0):
    """The hair between the pigtails below its root on the back of the head:
    straight down over the nape (hiding the neck from behind) onto her upper
    back."""
    return [
        HEAD_C + Vector((side * x0 * 1.06, 0.088, -0.108)),
        HEAD_C + Vector((side * x0 * 1.16, 0.100, -0.170)),
        HEAD_C + Vector((side * x0 * 1.26, 0.124, -0.262)),
        HEAD_C + Vector((side * x0 * 1.32, 0.138, -0.360)),
        HEAD_C + Vector((side * x0 * 1.34, 0.144, -0.430)),
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
            # the hair over the ear is swept back above it and down behind
            # it (the ear shows in profile, as in the reference)
            over_ear = 84 < az1 < 112
            if over_ear:
                el1 = max(el1, 4.0)
            mid_az = side * az1 * 0.55
            mid_el = lerp(el0, el1, 0.45) + 8
            pts = shell.path([(side * 2, el0, 0.010), (mid_az, mid_el, 0.0135), (side * az1, el1, 0.012)], per_seg=3)
            if over_ear:
                pts += shell.path([(side * az1, el1, 0.012), (side * 121, -12, 0.011)], per_seg=3)[1:]
            if az1 > 84:
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
        for j in range(9):
            ang = 2 * math.pi * j / 9 + rnd.uniform(-0.2, 0.2)
            spread = 0.020 + 0.005 * rnd.random()
            pts = []
            for i, c in enumerate(centre):
                # a full bundle that swells below the tie then gathers toward
                # the end (from the side it reads as the mass of hair falling
                # down her back, as in the reference)
                k = (0.3, 1.0, 1.32, 1.3, 1.1, 0.7)[i]
                off = Vector((math.cos(ang) * spread * k * 1.3, math.sin(ang) * spread * k * 1.15, 0))
                pts.append(c + off)
            length_cut = rnd.uniform(0.0, 0.06)
            pts[-1] = pts[-1] + Vector((0, 0, length_cut))
            w = 0.019 + 0.006 * rnd.random()
            hb.add(clump(pts, taper(w * 0.5, w, 0.3, 1.1), taper(0.0065, 0.0105, 0.3, 0.8), _out, n_len=26), "hair_tail_" + sfx)
        # the hair between the two tails, falling from the back of the head
        # over the nape (each half rides its own side's tail)
        for x0 in (0.007, 0.021, 0.035):
            az0 = 180.0 - math.degrees(math.atan2(x0, 0.075))
            root = shell.path([(side * az0, -26, 0.004), (side * az0, -40, 0.007)], per_seg=2)
            pts = root + curtain_path(side, x0)
            pts[-1] = pts[-1] + Vector((0, 0, rnd.uniform(0.0, 0.05)))
            w = 0.017 + 0.004 * rnd.random()
            hb.add(clump(pts, taper(w * 0.8, w, 0.3, 1.0), taper(0.0045, 0.0075, 0.3, 0.8), _out, n_len=24, crescent=0.3),
                   "hair_tail_" + sfx)

    strands = hb.build("HairStrands", mat)

    def hairline(az):
        # high at the front: the curtain locks form the hairline there, meeting
        # in a peak at the part; it arches over the ear (az ≈ 90–110°) and
        # drops steeply right behind it to below the lobe, so the hair covers
        # the back of the head down to the nape
        return pchip([(0, 0.066), (25, 0.058), (45, 0.040), (62, 0.016), (76, 0.004), (88, -0.001), (110, -0.002),
                      (114, -0.034), (118, -0.062), (126, -0.076), (150, -0.086), (180, -0.090)])(az)

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
