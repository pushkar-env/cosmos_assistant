"""Outfit — an oversized white techwear jacket with a funnel collar and
"moe" sleeves, a ribbon bow, a pleated skirt, thigh-highs, sneakers and a
cat-ear headset. Glowing trims use the ``Accent`` material, which the app
tints with the active COSMOS theme colour.

Material names are the contract with the app's toon shader set:
  Cloth_White  Cloth_Dark  Accent  Ribbon  Sock  Shoe  Sole  Headset  Headset_Dark
"""

import math

from mathutils import Matrix, Vector

from kit.common import bvh_of, catmull_rom, frames_along, lerp, material, pchip, resample, smoothstep, srgb
from kit.geom import MeshBuilder, flat_strip, loft, polyline, superellipse_ring, tube
from kit.strands import Shell

from .body import JOINTS, LEG_RX, LEG_RY, arm_dir, leg_path
from .head import HEAD_C

WHITE = "#f3f5fb"
DARK = "#1d2340"
ACCENT = "#22d3ee"
RIBBON = "#ff7aa8"


def mats():
    return {
        "white": material("Cloth_White", srgb(WHITE), roughness=0.7),
        "dark": material("Cloth_Dark", srgb(DARK), roughness=0.7),
        "accent": material("Accent", srgb(ACCENT), roughness=0.3, emission=srgb(ACCENT), emission_strength=4.0),
        "ribbon": material("Ribbon", srgb(RIBBON), roughness=0.5),
        "sock": material("Sock", srgb("#1a1c2a"), roughness=0.8),
        "shoe": material("Shoe", srgb("#f5f6fa"), roughness=0.5),
        "sole": material("Sole", srgb("#2b3458"), roughness=0.6),
        "headset": material("Headset", srgb("#f5f7fc"), roughness=0.35),
        "headset_dark": material("Headset_Dark", srgb("#222842"), roughness=0.4),
    }


# ── jacket ──────────────────────────────────────────────────────────────

# z → (half-width, front, back): loose, drapes straight down from the bust
_JK = [
    (0.900, 0.140, 0.085, 0.083), (0.950, 0.134, 0.087, 0.079), (1.000, 0.130, 0.089, 0.078),
    (1.050, 0.131, 0.093, 0.080), (1.095, 0.135, 0.095, 0.082), (1.130, 0.143, 0.089, 0.085),
    (1.160, 0.150, 0.083, 0.087), (1.185, 0.148, 0.073, 0.084), (1.205, 0.126, 0.065, 0.076),
    (1.222, 0.094, 0.055, 0.064), (1.238, 0.062, 0.045, 0.053), (1.250, 0.049, 0.041, 0.047),
    (1.265, 0.045, 0.040, 0.045), (1.300, 0.046, 0.042, 0.048),
]
JK_HW = pchip([(z, w) for z, w, _f, _b in _JK])
JK_F = pchip([(z, f) for z, _w, f, _b in _JK])
JK_B = pchip([(z, b) for z, _w, _f, b in _JK])


def jacket_point(z, th, inflate=0.0):
    hw, f, b = JK_HW(z) + inflate, JK_F(z) + inflate, JK_B(z) + inflate
    n = lerp(2.6, 2.0, smoothstep(1.20, 1.25, z))
    yc, d = (b - f) * 0.5, (f + b) * 0.5
    s, c = math.sin(th), math.cos(th)
    return Vector((hw * math.copysign(abs(s) ** (2 / n), s), yc - d * math.copysign(abs(c) ** (2 / n), c), z))


def jacket_ring(z, inflate=0.0, segs=56, top_tilt=0.0):
    pts = []
    for k in range(segs):
        th = 2 * math.pi * k / segs
        zz = z + top_tilt * (1 - math.cos(th)) * 0.5  # back of the collar rides higher
        pts.append(jacket_point(zz, th, inflate))
    return pts


def build_jacket(m):
    mb = MeshBuilder()
    rings = []
    # hem lip (inside → outside) for visible fabric thickness
    rings.append(jacket_ring(0.915, -0.005))
    rings.append(jacket_ring(0.900, -0.004))
    for i in range(36):
        z = lerp(0.900, 1.262, i / 35)
        rings.append(jacket_ring(z))
    rings.append(jacket_ring(1.276, 0.001, top_tilt=0.016))
    # rolled collar rim, then the inner wall back down toward the neck
    rings.append(jacket_ring(1.283, -0.002, top_tilt=0.018))
    rings.append(jacket_ring(1.279, -0.006, top_tilt=0.018))
    rings.append(jacket_ring(1.255, -0.008, top_tilt=0.010))
    mb.add(loft(rings, cap_start=False, cap_end=False))
    ob = mb.build("Jacket", m["white"])
    ob["double_sided"] = True
    return ob


def build_jacket_trims(m, jacket_ob):
    """Glowing collar line, zipper, hem band, chest emblem."""
    out = []
    # hem band (navy) with a thin glowing line along its top edge
    mb = MeshBuilder()
    mb.add(loft([jacket_ring(0.902, 0.0016), jacket_ring(0.934, 0.0016)], cap_start=False, cap_end=False))
    out.append(mb.build("JacketHem", m["dark"]))
    mb = MeshBuilder()
    mb.add(loft([jacket_ring(0.936, 0.0019), jacket_ring(0.941, 0.0019)], cap_start=False, cap_end=False))
    mb.add(loft([jacket_ring(1.2765, 0.0022, top_tilt=0.016), jacket_ring(1.2805, 0.0005, top_tilt=0.0175)], cap_start=False, cap_end=False))
    # front zipper line from the collar down to the hem band
    zs = [lerp(0.941, 1.270, i / 30) for i in range(31)]
    left = [jacket_point(z, 0.0, 0.0018) + Vector((0.0016, 0, 0)) for z in zs]
    right = [jacket_point(z, 0.0, 0.0018) + Vector((-0.0016, 0, 0)) for z in zs]
    verts, faces, uvs = [], [], []
    for i, (a, b) in enumerate(zip(left, right)):
        verts += [a, b]
        uvs += [(0, i / 30), (1, i / 30)]
    for i in range(30):
        faces.append((2 * i + 1, 2 * i, 2 * i + 2, 2 * i + 3))
    mb.add((verts, faces, uvs))
    # chest emblem: a little four-point star over her heart
    bvh = bvh_of(jacket_ob)
    cx, cz = 0.062, 1.128
    star = []
    for k in range(8):
        ang = math.pi / 2 + k * math.pi / 4
        r = 0.0115 if k % 2 == 0 else 0.0038
        star.append((cx + math.cos(ang) * r, cz + math.sin(ang) * r))
    sv = []
    hit, nrm, _i, _d = bvh.ray_cast(Vector((cx, -1, cz)), Vector((0, 1, 0)))
    centre = hit - Vector((0, 0.0018, 0))
    sv.append(centre)
    for x, z in star:
        h, _n, _i, _d = bvh.ray_cast(Vector((x, -1, z)), Vector((0, 1, 0)))
        sv.append(h - Vector((0, 0.0018, 0)))
    sf = [(0, k + 1, (k + 1) % 8 + 1) for k in range(8)]
    mb.add((sv, sf, [(0.5, 0.5)] * len(sv)))
    out.append(mb.build("JacketGlow", m["accent"]))
    return out


# ── sleeves ─────────────────────────────────────────────────────────────

SLEEVE_R = pchip([(0.0, 0.038), (0.13, 0.053), (0.40, 0.050), (0.55, 0.047), (0.80, 0.050), (1.0, 0.057)])


def build_sleeves(m):
    out = []
    for side in (1, -1):
        d = arm_dir(side)
        sh = JOINTS[("left" if side > 0 else "right") + "UpperArm"]
        start, end = sh - d * 0.070, sh + d * 0.505  # past the wrist: covers the palm
        path = polyline([start, sh, sh + d * 0.245, end], 10)
        n = len(path)
        frames = frames_along(path, Vector((0, 1, 0)))
        rings = []
        for i, (p, (tan, nrm, bn)) in enumerate(zip(path, frames)):
            t = i / (n - 1)
            r = SLEEVE_R(t)
            rings.append(superellipse_ring(p, nrm, bn, r, r * 0.96, 2.0, 28))
        tan, nrm, bn = frames[-1]
        r_end = SLEEVE_R(1.0)
        # rolled cuff: outer edge → inner lip → inside wall
        rings.append(superellipse_ring(path[-1] + tan * 0.002, nrm, bn, r_end - 0.004, (r_end - 0.004) * 0.96, 2.0, 28))
        rings.append(superellipse_ring(path[-1] - tan * 0.03, nrm, bn, r_end - 0.007, (r_end - 0.007) * 0.96, 2.0, 28))
        mb = MeshBuilder()
        mb.add(loft(rings, cap_start=True, cap_end=False))
        sl = mb.build("Sleeve_" + ("L" if side > 0 else "R"), m["white"])
        sl["double_sided"] = True
        out.append(sl)

        # cuff: navy band + glowing line
        mb = MeshBuilder()
        r0 = SLEEVE_R(0.93)
        rings = [
            superellipse_ring(path[-1] - tan * 0.034, nrm, bn, SLEEVE_R(0.92) + 0.0016, (SLEEVE_R(0.92) + 0.0016) * 0.96, 2.0, 28),
            superellipse_ring(path[-1] - tan * 0.001, nrm, bn, r_end + 0.0016, (r_end + 0.0016) * 0.96, 2.0, 28),
        ]
        mb.add(loft(rings, cap_start=False, cap_end=False))
        out.append(mb.build("Cuff_" + ("L" if side > 0 else "R"), m["dark"]))
        mb = MeshBuilder()
        rings = [
            superellipse_ring(path[-1] - tan * 0.040, nrm, bn, r0 + 0.0019, (r0 + 0.0019) * 0.96, 2.0, 28),
            superellipse_ring(path[-1] - tan * 0.036, nrm, bn, r0 + 0.0019, (r0 + 0.0019) * 0.96, 2.0, 28),
        ]
        mb.add(loft(rings, cap_start=False, cap_end=False))
        out.append(mb.build("CuffGlow_" + ("L" if side > 0 else "R"), m["accent"]))
    return out


# ── ribbon bow ──────────────────────────────────────────────────────────


def build_bow(m):
    mb = MeshBuilder()
    knot = Vector((0.0, -0.058, 1.236))
    forward = lambda p: Vector((0, -1, 0))  # noqa: E731
    for side in (1, -1):
        # each wing: a puffy, pinched lobe lofted outward from the knot
        rings = []
        for dx, hz, hy, lift in ((0.003, 0.0045, 0.0030, 0.000), (0.010, 0.0085, 0.0042, 0.0015),
                                  (0.020, 0.0125, 0.0052, 0.0035), (0.030, 0.0140, 0.0055, 0.0045),
                                  (0.037, 0.0128, 0.0050, 0.0045), (0.0415, 0.0090, 0.0040, 0.0040),
                                  (0.0435, 0.0040, 0.0025, 0.0035)):
            c = knot + Vector((side * dx, -0.001 - 0.002 * dx / 0.04, lift))
            rings.append(superellipse_ring(c, Vector((0, 0, 1)) * side, Vector((0, -1, 0)), hz, hy, 2.4, 20))
        mb.add(loft(rings))
        # tails drape over the chest, following the jacket front
        tail = []
        for i in range(9):
            t = i / 8
            z = lerp(1.230, 1.150, t)
            th = side * lerp(0.05, 0.20, t)
            p = jacket_point(z, th, 0.006)
            tail.append(p)
        tail[0] = knot + Vector((side * 0.004, -0.001, -0.004))
        tw = pchip([(0, 0.004), (0.2, 0.0075), (1, 0.0095)])
        mb.add(flat_strip(tail, tw, lambda t: 0.0018, lambda p: Vector((p.x * 0.3, p.y, 0.0))))
    # the knot
    mb.add(flat_strip([knot + Vector((0, 0, 0.007)), knot + Vector((0, -0.002, 0)), knot + Vector((0, 0, -0.007))],
                       lambda t: 0.0065, lambda t: 0.0042, forward))
    bow = mb.build("Bow", m["ribbon"])
    bow["double_sided"] = True
    return bow


# ── skirt ───────────────────────────────────────────────────────────────

PLEATS = 26


def _pleat(th):
    # knife pleats: a sharp sawtooth gives the crisp folded edges
    x = (th / (2 * math.pi)) * PLEATS
    f = x - math.floor(x)
    return 1.0 - abs(2.0 * f - 1.0) ** 0.8


def skirt_ring(t, segs=PLEATS * 6, extra=0.0):
    from .body import TORSO_B, TORSO_F, TORSO_HW  # noqa: PLC0415

    z = lerp(0.968, 0.680, t)
    zz = max(z, 0.865)  # below the hips the skirt hangs, it doesn't follow the body
    flare = 0.010 + 0.062 * t ** 1.25 + extra
    hw, f, b = TORSO_HW(zz) + flare, TORSO_F(zz) + flare * 0.85, TORSO_B(zz) + flare * 1.05
    amp = 0.011 * smoothstep(0.05, 0.9, t)
    yc, d = (b - f) * 0.5, (f + b) * 0.5
    pts = []
    for k in range(segs):
        th = 2 * math.pi * k / segs
        s, c = math.sin(th), math.cos(th)
        r = 1.0 + amp * _pleat(th) / max(hw, 0.05)
        pts.append(Vector((hw * s * r, yc - d * c * r, z - 0.006 * t * (1 - c) * 0.5)))
    return pts


def build_skirt(m):
    mb = MeshBuilder()
    rows = 16
    rings = [skirt_ring(1.0 - i / rows) for i in range(rows + 1)]  # hem → waist
    # hem lip (inside wall first, so the outer skirt keeps outward normals)
    inner = [p.lerp(Vector((0, 0, p.z)), 0.03) + Vector((0, 0, 0.008)) for p in rings[0]]
    rings.insert(0, inner)
    mb.add(loft(rings, cap_start=False, cap_end=False))
    sk = mb.build("Skirt", m["dark"])
    sk["double_sided"] = True
    mb = MeshBuilder()
    mb.add(loft([skirt_ring(0.915, extra=0.0015), skirt_ring(0.885, extra=0.0015)], cap_start=False, cap_end=False))
    stripe = mb.build("SkirtStripe", m["accent"])
    stripe["double_sided"] = True
    return [sk, stripe]


# ── legs: thigh-highs + sneakers ────────────────────────────────────────


def build_socks(m):
    out = []
    for side in (1, -1):
        path = leg_path(side)
        n = len(path)
        # keep the part of the leg below the sock top
        top_z = 0.615
        idx = [i for i, p in enumerate(path) if p.z <= top_z]
        i0 = max(idx[0] - 1, 0)
        sub = path[i0:]
        t0 = i0 / (n - 1)
        sub[0] = path[i0].lerp(path[i0 + 1], (path[i0].z - top_z) / max(1e-6, path[i0].z - path[i0 + 1].z))
        tt = lambda t: t0 + (1 - t0) * t  # noqa: E731
        mb = MeshBuilder()
        mb.add(tube(sub, lambda t: LEG_RX(tt(t)) + 0.0028, lambda t: LEG_RY(tt(t)) + 0.0028, Vector((0, -1, 0)), segs=28, cap_end=True))
        out.append(mb.build("Sock_" + ("L" if side > 0 else "R"), m["sock"]))
        # glowing band around the sock top
        mb = MeshBuilder()
        axis = (sub[1] - sub[0]).normalized()
        band = [sub[0] + axis * 0.002, sub[0] + axis * 0.010, sub[0] + axis * 0.016]
        r0x, r0y = LEG_RX(tt(0.0)) + 0.0040, LEG_RY(tt(0.0)) + 0.0040
        mb.add(tube(band, lambda t: r0x, lambda t: r0y, Vector((0, -1, 0)), segs=28, cap_start=False, cap_end=False))
        out.append(mb.build("SockBand_" + ("L" if side > 0 else "R"), m["accent"]))
    return out


def build_shoes(m):
    out = []
    # (y, half-width, bottom z, top z)
    secs = [(0.050, 0.026, 0.004, 0.070), (0.038, 0.036, 0.0, 0.094), (0.010, 0.041, 0.0, 0.104),
            (-0.025, 0.043, 0.0, 0.086), (-0.065, 0.045, 0.0, 0.064), (-0.098, 0.043, 0.0, 0.052),
            (-0.122, 0.035, 0.0, 0.043), (-0.136, 0.020, 0.004, 0.032)]
    for side in (1, -1):
        x = side * 0.068
        rings = []
        for y, hw, zb, zt in secs:
            c = Vector((x, y, (zb + zt) * 0.5 + 0.012))
            rings.append(superellipse_ring(c, Vector((1, 0, 0)), Vector((0, 0, 1)), hw, (zt - zb) * 0.5, 3.0, 28))
        mb = MeshBuilder()
        mb.add(loft(rings))
        out.append(mb.build("Shoe_" + ("L" if side > 0 else "R"), m["shoe"]))
        sole = []
        for y, hw, zb, zt in secs:
            c = Vector((x, y, 0.010))
            sole.append(superellipse_ring(c, Vector((1, 0, 0)), Vector((0, 0, 1)), hw + 0.003, 0.010, 4.0, 28))
        mb = MeshBuilder()
        mb.add(loft(sole))
        out.append(mb.build("Sole_" + ("L" if side > 0 else "R"), m["sole"]))
    return out


# ── cat-ear headset ─────────────────────────────────────────────────────


def build_headset(m, shell):
    out = []
    mb_white, mb_dark, mb_glow = MeshBuilder(), MeshBuilder(), MeshBuilder()
    for side in (1, -1):
        ax = Vector((side, 0, 0))
        base = Vector((side * 0.0985, 0.010, 1.370))
        rings = []
        for dx, r in ((0.0, 0.025), (0.003, 0.032), (0.010, 0.0345), (0.018, 0.033), (0.023, 0.027), (0.025, 0.020)):
            rings.append(superellipse_ring(base + ax * dx, Vector((0, side, 0)), Vector((0, 0, 1)), r, r, 2.0, 32))
        mb_white.add(loft(rings))
        # glowing ring + dark disc on the outer face
        face = base + ax * 0.0252
        mb_glow.add(loft([superellipse_ring(face, Vector((0, side, 0)), Vector((0, 0, 1)), 0.0225, 0.0225, 2.0, 32),
                          superellipse_ring(face + ax * 0.0004, Vector((0, side, 0)), Vector((0, 0, 1)), 0.0175, 0.0175, 2.0, 32)],
                         cap_start=False, cap_end=False))
        mb_dark.add(loft([superellipse_ring(face + ax * 0.0002, Vector((0, side, 0)), Vector((0, 0, 1)), 0.0172, 0.0172, 2.0, 32),
                          superellipse_ring(face + ax * 0.0012, Vector((0, side, 0)), Vector((0, 0, 1)), 0.006, 0.006, 2.0, 32)],
                         cap_start=False, cap_end=True))

    # headband: over the crown from cup to cup
    pts = shell.path([(-90, 8, 0.016), (-90, 50, 0.022), (0, 90, 0.024), (90, 50, 0.022), (90, 8, 0.016)], per_seg=6)
    pts = [p + Vector((0, 0.012, 0)) for p in pts]
    band = resample(pts, 60)
    mb_dark.add(flat_strip(band, lambda t: 0.0068, lambda t: 0.0032, lambda p: (p - HEAD_C).normalized()))

    # cat ears riding on the band
    for side in (1, -1):
        root = shell.at(side * 90, 56, 0.026) + Vector((0, 0.010, 0))
        outward = (root - HEAD_C).normalized()
        up = (outward + Vector((0, 0, 0.9))).normalized()
        fwd = Vector((0, -1, 0))
        lateral = up.cross(fwd).normalized() * side
        tip = root + up * 0.052 + lateral * 0.010 + Vector((0, 0.006, 0))
        ear_rings = []
        for t, w, dpt in ((0.0, 0.025, 0.010), (0.3, 0.020, 0.009), (0.6, 0.012, 0.007), (0.85, 0.005, 0.004)):
            c = root.lerp(tip, t)
            ear_rings.append(superellipse_ring(c, fwd, lateral * side, dpt, w, 2.6, 20))
        verts, faces, uvs = loft(ear_rings, cap_start=True, cap_end=False)
        ci = len(verts)
        verts.append(tip)
        uvs.append((0.5, 1.0))
        o = (len(ear_rings) - 1) * 20
        for k in range(20):
            faces.append((ci, o + k, o + (k + 1) % 20))
        mb_white.add((verts, faces, uvs))
        # glowing inner panel on the front face
        inner = []
        for t, w in ((0.12, 0.016), (0.45, 0.011), (0.75, 0.004)):
            c = root.lerp(tip, t) + fwd * (0.0092 - 0.004 * t)
            inner.append((c - lateral * w, c + lateral * w))
        v = [p for pair in inner for p in pair]
        f = [(0, 1, 3, 2), (2, 3, 5, 4)]
        mb_glow.add((v, f, [(0, 0)] * len(v)))

    out.append(mb_white.build("Headset", m["headset"]))
    out.append(mb_dark.build("HeadsetBand", m["headset_dark"]))
    g = mb_glow.build("HeadsetGlow", m["accent"])
    g["double_sided"] = True
    out.append(g)
    return out


def build_clothes(head_ob):
    m = mats()
    out = []
    jacket = build_jacket(m)
    out.append(jacket)
    out += build_jacket_trims(m, jacket)
    out += build_sleeves(m)
    out.append(build_bow(m))
    out += build_skirt(m)
    out += build_socks(m)
    out += build_shoes(m)
    out += build_headset(m, Shell(head_ob, HEAD_C))
    return [o.name for o in out]
