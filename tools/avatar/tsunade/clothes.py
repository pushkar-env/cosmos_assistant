"""Outfit — grey kimono-style top with a V crossover collar and dark piping,
a navy obi, navy capri pants, a long open green haori with dark trim and wide
3/4 sleeves, and black heeled sandals.

The haori's skirt is cloth: six spring chains hang around the body (front,
side, back on each side) and the coat is panel-weighted to them, so it swings
and settles in the app. Material names are the contract with the app:
  Kimono  Piping  Obi  ObiCord  Pants  Coat  CoatTrim  Sandal
"""

import math

import bpy
from mathutils import Matrix, Vector

from kit.common import bvh_of, frames_along, lerp, material, pchip, smoothstep, srgb
from kit.geom import MeshBuilder, loft, open_loft, polyline, superellipse_ring

from .body import BUST_X, BUST_Z, JOINTS, LEG_RX, LEG_RY, TORSO_B, TORSO_F, TORSO_HW, _FOOT, arm_dir, arm_path, leg_path, torso_point

D = math.degrees
R = math.radians


def mats():
    return {
        "kimono": material("Kimono", srgb("#c4bcb6"), roughness=0.75),
        "piping": material("Piping", srgb("#221e1f"), roughness=0.7),
        "obi": material("Obi", srgb("#28344c"), roughness=0.7),
        "cord": material("ObiCord", srgb("#151b29"), roughness=0.6),
        "pants": material("Pants", srgb("#323849"), roughness=0.75),
        "coat": material("Coat", srgb("#5a7a60"), roughness=0.75),
        "trim": material("CoatTrim", srgb("#2b3129"), roughness=0.7),
        "sandal": material("Sandal", srgb("#1b1517"), roughness=0.45),
        "bust_shadow": material("KimonoShadow", srgb("#8e8581"), roughness=0.8),
        "bust_fold": material("KimonoFold", srgb("#4a4240"), roughness=0.8),
    }


# ── kimono top ──────────────────────────────────────────────────────────

V_POINT = 1.160  # bottom of the V neckline — deep, as in the reference
NECK_TOP = 1.405
# half-width (m) of the V up the chest: narrow, so only the cleavage shows,
# opening to the sides of the neck, where the collar wraps round the back
_V_HW = pchip([(V_POINT, 0.0), (1.20, 0.012), (1.25, 0.027), (1.30, 0.041), (1.34, 0.050),
               (1.37, 0.054), (1.39, 0.050), (NECK_TOP, 0.044)])


def v_edge(z):
    """Half-angle (degrees) of the open V at height z (0 below the V point)."""
    if z <= V_POINT:
        return 0.0
    target, lo, hi = _V_HW(z), 0.0, 90.0
    for _ in range(28):
        mid = (lo + hi) * 0.5
        if kimono_point(z, mid).x < target:
            lo = mid
        else:
            hi = mid
    return max(1.5, lo)


def az_along(z, az0, dist, inflate=0.0085):
    """Azimuth reached walking ``dist`` metres round the kimono surface from
    ``az0`` (toward the back) at height z — offsets measured on the cloth, so
    the collar band keeps its width over the curve of the bust."""
    az, walked, prev = az0, 0.0, kimono_point(z, az0, inflate)
    while walked < dist and az < 179.0:
        az += 0.25
        cur = kimono_point(z, az, inflate)
        walked += (cur - prev).length
        prev = cur
    return az


def kimono_point(z, az, inflate=0.0065):
    return torso_point(z, R(az), inflate + 0.004 * smoothstep(1.18, 1.26, z) * (1 - smoothstep(1.28, 1.34, z)))


KIMONO_SIDE = 84.0  # the upper kimono only reaches this far round from the front…
KIMONO_BAND = 1.350  # …below this height (the collar above is a full ring)
TUNIC_HEM = 0.785
TUNIC_FLARE = 0.032  # A-line: it stands away from the hips toward the hem


def build_kimono(m):
    out = []
    mb = MeshBuilder()
    # upper body: rows run around the BACK from the left V edge to the right
    rows = []
    zs = [lerp(1.105, NECK_TOP, i / 28) for i in range(29)]
    for z in zs:
        e = v_edge(z)
        rows.append([kimono_point(z, lerp(e, 360 - e, k / 56)) for k in range(57)])
    verts, faces, uvs = open_loft(rows)
    # under the coat's flanks and back none of it shows — and there a raised
    # arm pinches the layers (linear skinning) until the kimono pokes through
    # the coat. Keep the front panels and the collar ring round the neck.
    keep = []
    for f in faces:
        i, k = divmod(f[0], 57)
        e = v_edge((zs[i] + zs[i + 1]) * 0.5)
        az = lerp(e, 360 - e, (k + 0.5) / 56)
        if zs[i + 1] > KIMONO_BAND or KIMONO_SIDE > az or az > 360 - KIMONO_SIDE:
            keep.append(f)
    mb.add((verts, keep, uvs))
    # tunic skirt below the obi: hangs from the hips, flares slightly
    rings = []
    for i in range(13):
        t = i / 12
        z = lerp(1.035, TUNIC_HEM, t)
        zz = max(z, 0.965)
        infl = 0.010 + TUNIC_FLARE * t ** 1.2
        rings.append([torso_point(zz, R(360 * k / 56), infl) + Vector((0, 0, z - zz)) for k in range(56)])
    rings.reverse()  # hem → waist keeps the normals outward
    mb.add(loft(rings, cap_start=False, cap_end=False))
    ob = mb.build("Kimono", m["kimono"])
    out.append(ob)

    # collar band + piping: two dark lines along each V edge and round the
    # back of the neck, with a grey band between them
    pipe = MeshBuilder()
    band_w = 0.013
    for side in (1, -1):
        for off, w in ((0.0, 0.0016), (band_w, 0.0036)):
            pts_a, pts_b = [], []
            for z in [lerp(V_POINT - 0.004, NECK_TOP, i / 30) for i in range(31)]:
                e = v_edge(z)
                a0 = az_along(z, e, off) if off else e
                a1 = az_along(z, a0, w)
                for lst, az in ((pts_a, a0), (pts_b, a1)):
                    lst.append(kimono_point(z, side * az, 0.0085))
            # second row steps back toward the opening → outward normals
            pipe.add(open_loft([pts_b, pts_a]) if side > 0 else open_loft([pts_a, pts_b]))
    # the line across the back of the collar
    top_a = [kimono_point(NECK_TOP, lerp(v_edge(NECK_TOP), 360 - v_edge(NECK_TOP), k / 30), 0.0085) for k in range(31)]
    top_b = [p + Vector((0, 0, -0.003)) for p in top_a]
    pipe.add(open_loft([top_b, top_a]))
    # the overlap edge running down the tunic skirt
    edge_a, edge_b = [], []
    for i in range(14):
        z = lerp(1.025, TUNIC_HEM + 0.002, i / 13)
        zz = max(z, 0.965)
        t = (1.035 - z) / (1.035 - TUNIC_HEM)
        infl = 0.0115 + TUNIC_FLARE * t ** 1.2
        drift = 7.0 + 12.0 * t ** 1.3  # left over right: the edge falls toward her right
        for lst, az in ((edge_a, -drift - 1.6), (edge_b, -drift)):
            lst.append(torso_point(zz, R(az), infl) + Vector((0, 0, z - zz)))
    pipe.add(open_loft([edge_a, edge_b]))
    out.append(pipe.build("KimonoPiping", m["piping"]))
    return out


# ── shading cues on the kimono ──────────────────────────────────────────


def build_bust_shading(m, kimono_ob):
    """What makes a clothed bust read from the front in anime: a cel shadow
    under each breast and a fold line along its lower curve. Both are
    projected onto the kimono (front-most surface along +Y) and weighted like
    it, so they ride every pose and the breast springs."""
    bvh = bvh_of(kimono_ob)

    def on_kimono(x, z, lift):
        hit, nrm, _i, _d = bvh.ray_cast(Vector((x, -1.0, z)), Vector((0, 1, 0)))
        # through the V opening a ray would reach the kimono's back panel
        if hit is None or hit.y > -0.05:
            return None
        if nrm.y > 0:
            nrm = -nrm
        return hit + nrm * lift

    shadow, fold = MeshBuilder(), MeshBuilder()
    n = 26

    def arc(side, a0, a1):
        """Lower contour of one breast from angle a0 to a1 (degrees; 270 is
        straight down, 360 the outer flank), ordered left → right so both
        sides' strips wind the same way. Yields (x, z, t) with t running
        from a0 to a1."""
        bx = side * BUST_X
        pts = []
        for i in range(n + 1):
            t = i / n
            a = math.radians(lerp(a0, a1, t))
            pts.append((bx + side * 0.068 * math.cos(a), BUST_Z - 0.008 + 0.060 * math.sin(a), t))
        return pts if side > 0 else pts[::-1]

    for side in (1, -1):
        # the cel shadow: under the breast, deepest below its outer half; it
        # stops short of the V so the two sides never join up
        top_s, bot_s = [], []
        for x, z, t in arc(side, 228, 352):
            depth = 0.017 * math.sin(math.pi * t) ** 0.7
            p_top, p_bot = on_kimono(x, z, 0.0012), on_kimono(x, z - depth - 0.0004, 0.0012)
            if None not in (p_top, p_bot):
                top_s.append(p_top)
                bot_s.append(p_bot)
        shadow.add(open_loft([bot_s, top_s]))
        # the ink line: along the bottom and up the outer flank only
        top_f, bot_f = [], []
        for x, z, t in arc(side, 250, 360):
            wf = 0.0004 + 0.0016 * math.sin(math.pi * t) ** 0.6
            f_top, f_bot = on_kimono(x, z + wf, 0.0018), on_kimono(x, z - wf, 0.0018)
            if None not in (f_top, f_bot):
                top_f.append(f_top)
                bot_f.append(f_bot)
        fold.add(open_loft([bot_f, top_f]))
        # two tension folds running from under the breast in toward the waist
        for (x0, z0), (x1, z1), (x2, z2), w in (((0.112, 1.174), (0.090, 1.152), (0.062, 1.136), 0.0012),
                                                  ((0.136, 1.196), (0.124, 1.166), (0.104, 1.140), 0.0010)):
            ta, tb = [], []
            for i in range(9):
                t = i / 8
                x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * x1 + t * t * x2
                z = (1 - t) ** 2 * z0 + 2 * (1 - t) * t * z1 + t * t * z2
                wf = w * math.sin(math.pi * min(max(t, 0.06), 0.94)) ** 0.7
                pa, pb = on_kimono(side * x, z + wf, 0.0018), on_kimono(side * x, z - wf, 0.0018)
                if None not in (pa, pb):
                    ta.append(pa)
                    tb.append(pb)
            if len(ta) > 2:
                if side > 0:  # left → right, like the arcs, so both sides wind the same way
                    ta.reverse()
                    tb.reverse()
                fold.add(open_loft([tb, ta]))
    sh = shadow.build("BustShadow", m["bust_shadow"])
    fo = fold.build("BustFold", m["bust_fold"])
    return [sh, fo]


# ── obi ─────────────────────────────────────────────────────────────────


def build_obi(m):
    mb = MeshBuilder()
    rings = []
    # the sash sits at the waist, below the bust (which rests just above it)
    for z, infl in ((1.018, 0.010), (1.022, 0.018), (1.124, 0.018), (1.128, 0.010)):
        rings.append([torso_point(z, R(360 * k / 56), infl) for k in range(56)])
    mb.add(loft(rings, cap_start=False, cap_end=False))
    obi = mb.build("Obi", m["obi"])
    cord = MeshBuilder()
    for z0 in (1.056, 1.091):
        cord.add(loft([[torso_point(z, R(360 * k / 56), 0.0192) for k in range(56)] for z in (z0, z0 + 0.0032)], cap_start=False, cap_end=False))
    return [obi, cord.build("ObiCord", m["cord"])]


# ── pants ───────────────────────────────────────────────────────────────


def build_pants(m):
    out = []
    for side in (1, -1):
        # start inside the tunic (it covers the hips), end at mid-calf
        full = leg_path(side)
        n = len(full)
        first = next(i for i, p in enumerate(full) if p.z <= 0.925)
        path = full[first:]
        bottom_z = 0.345
        cut = next(i for i, p in enumerate(path) if p.z <= bottom_z)
        sub = path[: cut + 1]
        sub[-1] = path[cut - 1].lerp(path[cut], (path[cut - 1].z - bottom_z) / max(1e-6, path[cut - 1].z - path[cut].z))
        frames = frames_along(sub, Vector((0, -1, 0)))
        rings = []
        for i, (p, (_tan, nrm, bn)) in enumerate(zip(sub, frames)):
            t = (i + first) / (n - 1)
            rings.append(superellipse_ring(p, nrm, bn, LEG_RX(t) + 0.007, LEG_RY(t) + 0.007, 2.0, 28))
        tan, nrm, bn = frames[-1]
        tb = (len(sub) - 1 + first) / (n - 1)
        rx, ry = LEG_RX(tb) + 0.007, LEG_RY(tb) + 0.007
        # rolled cuff: outer edge → inner lip
        rings.append(superellipse_ring(sub[-1] + tan * 0.002, nrm, bn, rx - 0.004, ry - 0.004, 2.0, 28))
        rings.append(superellipse_ring(sub[-1] - tan * 0.025, nrm, bn, rx - 0.006, ry - 0.006, 2.0, 28))
        mb = MeshBuilder()
        mb.add(loft(rings, cap_start=True, cap_end=False))
        out.append(mb.build("Pants_" + ("L" if side > 0 else "R"), m["pants"]))
    return out


# ── haori (the long open coat) ──────────────────────────────────────────

COAT_HEM = 0.430
COAT_TOP = 1.400
# below the bust the coat hangs instead of hugging: z → (half-width, front,
# back), flaring toward the hem like the reference
_HANG = [(0.40, 0.292, 0.170, 0.196), (0.55, 0.276, 0.158, 0.184), (0.70, 0.258, 0.148, 0.170),
         (0.90, 0.236, 0.130, 0.154), (1.00, 0.220, 0.124, 0.138), (1.10, 0.202, 0.150, 0.116),
         (1.17, 0.194, 0.194, 0.106), (1.235, 0.188, 0.204, 0.102)]
_HW = pchip([(z, w) for z, w, _f, _b in _HANG])
_HF = pchip([(z, f) for z, _w, f, _b in _HANG])
_HB = pchip([(z, b) for z, _w, _f, b in _HANG])


def coat_edge(z):
    """Half-angle of the coat's front opening (degrees)."""
    # open wide across the chest so the coat frames the bust from the sides
    return pchip([(0.43, 36), (0.70, 32), (1.00, 30), (1.12, 34), (1.22, 40), (1.29, 37), (1.34, 32),
                  (1.37, 40), (COAT_TOP, 66)])(z)


def coat_point(z, az, extra=0.0):
    th = R(az)
    # hugging the torso above the bust, hanging below it
    # it hangs from the bust (draping in front of it) and hugs above it
    k = smoothstep(1.235, 1.29, z)
    # extra room round the armpits: a raised arm pinches the layers there
    # (linear skinning) and the kimono would push through
    a = abs(((az + 180) % 360) - 180)
    pit = 0.014 * smoothstep(40, 70, a) * (1 - smoothstep(110, 140, a)) * smoothstep(1.18, 1.24, z) * (1 - smoothstep(1.32, 1.38, z))
    hug = torso_point(min(max(z, 1.17), 1.40), th, 0.020 + 0.004 * (1 - k) + pit + extra)
    hug.z = z
    hw, f, b = _HW(z) + extra, _HF(z) + extra, _HB(z) + extra
    n = 2.3
    yc, d = (b - f) * 0.5, (f + b) * 0.5
    s, c = math.sin(th), math.cos(th)
    hang = Vector((hw * math.copysign(abs(s) ** (2 / n), s), yc - d * math.copysign(abs(c) ** (2 / n), c), z))
    p = hang.lerp(hug, k)
    # a gentle drape: the hem dips a little at the back
    p.z -= 0.014 * smoothstep(0.55, COAT_HEM, z) * (1 - c) * 0.5
    return p


def graded(a, b, base, spans):
    """Samples from a to b about ``base`` apart, closer inside each
    ``(lo, hi, step)`` span (easing between the two spacings)."""

    def step_at(x):
        s = base
        for lo, hi, st in spans:
            w = smoothstep(lo - 2 * base, lo, x) * (1 - smoothstep(hi, hi + 2 * base, x))
            s = min(s, base + (st - base) * w)
        return s

    xs = [a]
    while xs[-1] < b:
        xs.append(xs[-1] + step_at(xs[-1]))
    k = (b - a) / (xs[-1] - a)
    return [a + (x - a) * k for x in xs]


# Where her left hand rests on the haori (her hip, from the front edge round
# toward her side), the coat is meshed ~4x finer: the HipPress morph lays it
# flat under the hand vertex by vertex, and at the base spacing (~2 cm) its
# faces bridged the gaps between the fingers and cut through them.
COAT_ROWS = graded(COAT_HEM, COAT_TOP, 0.022, [(0.87, 1.13, 0.006)])
# columns run from the left front edge (0) round the back to the right (1)
COAT_COLS = graded(0.0, 1.0, 1 / 64, [(0.0, 0.17, 1 / 220)])
# across the trim band, edge → inner side
TRIM_COLS = (0.0, 0.33, 0.67, 1.0)


def build_coat(m):
    out = []
    mb = MeshBuilder()
    rows = []
    for z in COAT_ROWS:
        e = coat_edge(z)
        rows.append([coat_point(z, lerp(e, 360 - e, u)) for u in COAT_COLS])
    mb.add(open_loft(rows))
    coat = mb.build("Coat", m["coat"])
    out.append(coat)

    # dark trim: down each front edge and round the back of the neck
    trim = MeshBuilder()
    for side in (1, -1):
        cols = [[] for _ in TRIM_COLS]
        for z in [COAT_HEM - 0.002] + COAT_ROWS[1:]:
            e = coat_edge(z)
            r = max(_HW(z) if z < 1.2 else TORSO_HW(min(z, 1.38)) + 0.02, 0.05)
            w = D(0.036 / r)
            for col, t in zip(cols, TRIM_COLS):
                col.append(coat_point(z, side * (e + w * t), 0.0042))
        # (rows ordered inner side → edge on the left, edge → inner on the right)
        trim.add(open_loft(cols[::-1]) if side > 0 else open_loft(cols))
    # round the back of the neck the trim lies flat along the coat's top edge
    rows = []
    for z in (COAT_TOP - 0.034, COAT_TOP + 0.001):
        e = coat_edge(z)
        rows.append([coat_point(z, lerp(e, 360 - e, k / 40), 0.0042) for k in range(41)])
    trim.add(open_loft(rows))
    out.append(trim.build("CoatTrim", m["trim"]))

    # wide 3/4 sleeves, draping below the arm
    for side in (1, -1):
        d = arm_dir(side)
        sh = JOINTS[("left" if side > 0 else "right") + "UpperArm"]
        start, end = sh - d * 0.09, sh + d * 0.42
        path = polyline([start, sh, end], 12)
        frames = frames_along(path, Vector((0, 1, 0)))
        prof = pchip([(0.0, 0.040), (0.2, 0.050), (0.6, 0.060), (1.0, 0.074)])
        rings = []
        down = Vector((0, 0, -1))
        for i, (p, (tan, nrm, bn)) in enumerate(zip(path, frames)):
            t = i / (len(path) - 1)
            r = prof(t)
            sag = (down - tan * down.dot(tan)).normalized() * (0.020 * smoothstep(0.1, 1.0, t) ** 1.4)
            rings.append(superellipse_ring(p + sag, nrm, bn, r, r * 1.12, 2.2, 28))
        tan, nrm, bn = frames[-1]
        r_end = prof(1.0)
        c = path[-1] + (down - tan * down.dot(tan)).normalized() * 0.020
        rings.append(superellipse_ring(c + tan * 0.002, nrm, bn, r_end - 0.005, (r_end - 0.005) * 1.1, 2.2, 28))
        rings.append(superellipse_ring(c - tan * 0.04, nrm, bn, r_end - 0.008, (r_end - 0.008) * 1.1, 2.2, 28))
        smb = MeshBuilder()
        smb.add(loft(rings, cap_start=True, cap_end=False))
        out.append(smb.build("CoatSleeve_" + ("L" if side > 0 else "R"), m["coat"]))
    return out


# spring chains for the coat skirt: (name, azimuth)
COAT_CHAINS = [("cloth_coat_FL", 40), ("cloth_coat_SL", 102), ("cloth_coat_BL", 158),
               ("cloth_coat_BR", -158), ("cloth_coat_SR", -102), ("cloth_coat_FR", -40)]
COAT_CHAIN_Z = [1.10, 0.93, 0.77, 0.60, 0.44]


def coat_chain_joints():
    return {name: [coat_point(z, az, -0.006) for z in COAT_CHAIN_Z] for name, az in COAT_CHAINS}


# ── sandals ─────────────────────────────────────────────────────────────


def build_sandals(m):
    out = []
    for side in (1, -1):
        sfx = "L" if side > 0 else "R"
        x = JOINTS[("left" if side > 0 else "right") + "Foot"].x + side * 0.003
        mb = MeshBuilder()
        # sole following the arched underside of the foot, out past the toes
        # to a rounded toe that sweeps toward the big toe (y, z bottom,
        # half-width, shift toward the big toe)
        secs = [(y, zb, hw, 0.0) for y, zb, _zt, hw in _FOOT if y >= -0.080]
        secs += [(-0.092, 0.0095, 0.0345, 0.0), (-0.104, 0.0090, 0.0355, 0.001), (-0.117, 0.0085, 0.0340, 0.003),
                 (-0.129, 0.0082, 0.0310, 0.006), (-0.139, 0.0082, 0.0262, 0.0085), (-0.146, 0.0082, 0.0195, 0.010),
                 (-0.150, 0.0082, 0.0110, 0.011), (-0.1515, 0.0082, 0.0040, 0.011)]
        rings = []
        for y, zb, hw, shift in secs:
            c = Vector((x - side * shift, y, zb - 0.005))
            rings.append(superellipse_ring(c, Vector((1, 0, 0)), Vector((0, 0, 1)), hw + 0.005, 0.0045, 3.0, 24))
        mb.add(loft(rings))
        # heel block
        hrings = []
        for z, w, dpt in ((0.0, 0.009, 0.010), (0.012, 0.010, 0.011), (0.066, 0.017, 0.020)):
            hrings.append(superellipse_ring(Vector((x, 0.034, z)), Vector((1, 0, 0)), Vector((0, 1, 0)), w, dpt, 2.6, 16))
        mb.add(loft(hrings))
        # ankle strap
        ankle = JOINTS[("left" if side > 0 else "right") + "Foot"]
        ar = [superellipse_ring(Vector((ankle.x, ankle.y + 0.004, z)), Vector((1, 0, 0)), Vector((0, 1, 0)), 0.033, 0.035, 2.0, 24)
              for z in (0.118, 0.130)]
        mb.add(loft(ar, cap_start=False, cap_end=False))
        # toe strap across the base of the toes, snug over the foot
        fzb = pchip([(y, zb) for y, zb, _zt, _hw in reversed(_FOOT)])
        fzt = pchip([(y, zt) for y, _zb, zt, _hw in reversed(_FOOT)])
        fhw = pchip([(y, hw) for y, _zb, _zt, hw in reversed(_FOOT)])
        tr = []
        for y in (-0.074, -0.088):
            zb, zt, hw = fzb(y), fzt(y), fhw(y)
            tr.append(superellipse_ring(Vector((x, y, (zb + zt) * 0.5)), Vector((1, 0, 0)), Vector((0, 0, 1)),
                                        hw + 0.0035, (zt - zb) * 0.5 + 0.0025, 2.8, 32))
        mb.add(loft(tr, cap_start=False, cap_end=False))
        out.append(mb.build("Sandal_" + sfx, m["sandal"]))
    return out


# ── the haori pressed under her hand ────────────────────────────────────


def add_hand_press(arm_ob, hand="Hand_L", clip="Idle", frame=0, names=("Coat", "CoatTrim"),
                   under=("Kimono", "Obi"), gap=0.003, floor=0.0015, soft=0.045, margin=0.002):
    """A shape key, "HipPress", that lays the haori flat under the hand
    resting on her hip — the hand presses the panel to her, as in the
    reference, instead of the cloth cutting through it. Worked out in the
    posed clip (where the hand rests): every coat point the hand covers (a
    ray out from inside her body meets the hand) is pulled in to ``gap``
    under the hand, never into the tunic beneath; the dent eases out into the
    cloth round it, and any face still within ``margin`` of the hand has its
    corners sunk further. Displacements are carried back to the rest pose through each
    vertex's skinning, so the key is a plain morph the app can fade in and
    out with the hand (see ``handPress`` in avatars.ts)."""
    from mathutils.bvhtree import BVHTree
    from mathutils.kdtree import KDTree

    from kit import anims
    from kit.common import shape_key

    anims.preview_pose(arm_ob, clip, frame)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    hand_bvh = BVHTree.FromObject(bpy.data.objects[hand], dg)
    # the arm below its sleeve (the hand mesh runs up to the shoulder, which
    # sits inside the coat by design) — what the cloth must not cut — grown
    # by ``margin``, so the cloth keeps clear of it as the clips sway
    side = "left" if hand.endswith("_L") else "right"
    hob = bpy.data.objects[hand]
    ev = hob.evaluated_get(dg)
    me = ev.to_mesh()
    hv = [hob.matrix_world @ (v.co + v.normal * margin) for v in me.vertices]
    hp = [tuple(p.vertices) for p in me.polygons]
    ev.to_mesh_clear()
    lower = arm_ob.pose.bones[side + "LowerArm"]
    elbow, axis = lower.head, (lower.tail - lower.head).normalized()
    reach = anims._sleeve_reach(arm_ob, side)
    hand_free = BVHTree.FromPolygons(hv, [p for p in hp if (hv[p[0]] - elbow).dot(axis) > reach])
    unders = [BVHTree.FromObject(bpy.data.objects[n], dg) for n in under if n in bpy.data.objects]
    pose_mats = {pb.name: pb.matrix @ arm_ob.data.bones[pb.name].matrix_local.inverted() for pb in arm_ob.pose.bones}
    report = {}
    for name in names:
        ob = bpy.data.objects.get(name)
        if ob is None:
            continue
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        posed = [ob.matrix_world @ v.co for v in me.vertices]
        ev.to_mesh_clear()
        radial = [Vector((p.x, p.y, 0.0)).normalized() for p in posed]

        def floor_at(i):
            """radial depth of the tunic/obi surface under coat point i"""
            p, r = posed[i], radial[i]
            best = None
            for t in unders:
                hit, _n, _x, _d = t.ray_cast(p + r * 0.06, -r, 0.2)
                if hit is not None:
                    best = max(best, hit.dot(r)) if best is not None else hit.dot(r)
            return best

        target = {}
        for i, p in enumerate(posed):
            r = radial[i]
            start = p - r * 0.08  # well inside her body
            hit, _n, _x, _d = hand_bvh.ray_cast(start, r, 0.16)
            if hit is None:
                continue
            depth = hit.dot(r) - gap  # just under the hand's inner surface
            fl = floor_at(i)
            if fl is not None:
                depth = max(depth, fl + floor)
            if p.dot(r) > depth:
                target[i] = depth - p.dot(r)  # (negative: inward)
        # ease the dent out into the cloth around it
        kd = KDTree(len(target))
        for i in target:
            kd.insert(posed[i], i)
        kd.balance()
        disp = {}
        for i, p in enumerate(posed):
            if i in target:
                disp[i] = target[i]
                continue
            pull = 0.0
            for _co, j, dist in kd.find_range(p, soft * 2.2):
                pull = min(pull, target[j] * math.exp(-((dist / soft) ** 2)))
            if pull < -1e-5:
                fl = floor_at(i)
                if fl is not None:
                    pull = max(pull, min(0.0, fl + floor - p.dot(radial[i])))
                disp[i] = pull
        # the hand is only sampled at the cloth's vertices, so a face bridging
        # a pressed vertex and a free one beside a finger can still cut it:
        # sink the corners of every face that cuts the hand a little further
        # (never into the tunic) until none does
        faces = [tuple(p.vertices) for p in ob.data.polygons]
        cutting = 0
        for _ in range(12):
            now = [p + radial[i] * disp.get(i, 0.0) for i, p in enumerate(posed)]
            cut = BVHTree.FromPolygons(now, faces).overlap(hand_free)
            cutting = len(cut)
            if not cut:
                break
            for i in {i for f, _h in cut for i in faces[f]}:
                d = disp.get(i, 0.0) - 0.0015
                fl = floor_at(i)
                if fl is not None:
                    d = max(d, min(disp.get(i, 0.0), fl + floor - posed[i].dot(radial[i])))
                disp[i] = d
        # posed displacement → rest pose, through each vertex's blended skinning
        gnames = {g.index: g.name for g in ob.vertex_groups}
        inv_obj = ob.matrix_world.inverted().to_3x3()
        rest = [v.co.copy() for v in ob.data.vertices]
        keyed = [c.copy() for c in rest]
        for i, d in disp.items():
            M = Matrix(((0.0,) * 3,) * 3)
            tot = 0.0
            for g in ob.data.vertices[i].groups:
                bone = gnames.get(g.group)
                if bone in pose_mats and g.weight > 0:
                    M += pose_mats[bone].to_3x3() * g.weight
                    tot += g.weight
            if tot < 1e-6:
                continue
            M = M * (1.0 / tot)
            keyed[i] = rest[i] + inv_obj @ (M.inverted() @ (radial[i] * d))
        shape_key(ob, "HipPress", keyed)
        report[name] = {"covered": len(target), "moved": len(disp), "still_cutting": cutting,
                        "deepest_mm": round(-min(disp.values(), default=0.0) * 1000, 1)}
    arm_ob.animation_data.action = None
    return report


def build_clothes(head_ob):
    m = mats()
    out = []
    kimono = build_kimono(m)
    out += kimono
    out += build_bust_shading(m, kimono[0])
    out += build_obi(m)
    out += build_pants(m)
    out += build_coat(m)
    out += build_sandals(m)
    return [o.name for o in out]
