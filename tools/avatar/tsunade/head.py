"""Head base mesh — a mature anime woman's skull (longer, slimmer jaw, small
defined nose) built from front/side profile tables, with the profile sculpted
in (nose, brow, lips, chin, jawline) and ears grown out of its sides. Features
(eyes, lashes, brows, lips, the forehead mark) are thin meshes laid onto this
surface.
"""

import math

from mathutils import Vector

from kit.common import lerp, material, mesh_object, pchip, smoothstep, srgb

# head pivot (roughly the centre of the cranium), world space
HEAD_C = Vector((0.0, 0.0, 1.535))

# head-local landmark heights (metres relative to HEAD_C)
TOP_Z = 0.112
CHIN_Z = -0.118  # a short, softly pointed chin under a wide, full mouth
EYE_Z = -0.019
EYE_X = 0.0355
# measured on the reference (eye line → chin): the nose tip sits a little over
# half way down, the mouth close under it — a mature face, not a child's
NOSE_Z = -0.0645
MOUTH_Z = -0.0810
MARK_Z = 0.027  # the diamond seal on her forehead

SKIN = "#f6dccd"


HALF_W = 0.0845  # cranium half-width
FRONT = 0.088  # forehead depth in front of the pivot
BACK = 0.100  # skull depth behind the pivot

# lower-face profiles over head-local Z (front view half-width, side-view
# front/back extents), drawn for a chin at -0.128 and compressed onto CHIN_Z.
# The back extent swings forward under the jaw so the underside rises from the
# chin to the nape instead of sagging. A slim oval: the cheeks taper early.
_TABLE_CHIN = -0.128
_W = pchip(
    [(-0.128, 0.0), (-0.1255, 0.009), (-0.120, 0.018), (-0.110, 0.030), (-0.097, 0.043),
     (-0.080, 0.055), (-0.062, 0.066), (-0.042, 0.0750), (-0.020, 0.0815), (0.0, HALF_W)]
)
_F = pchip(
    [(-0.128, 0.068), (-0.118, 0.0775), (-0.100, 0.0825), (-0.080, 0.0855),
     (-0.055, 0.0875), (-0.030, 0.0878), (0.0, FRONT)]
)
# the back extent swings forward under the jaw: in profile the jawline climbs
# from the chin toward the angle of the jaw below the ear at ~25°, then turns
# up into the nape (which the neck and the hair hide)
_B = pchip(
    [(-0.128, -0.064), (-0.1265, -0.052), (-0.123, -0.040), (-0.118, -0.026), (-0.110, -0.006),
     (-0.100, 0.016), (-0.090, 0.034), (-0.080, 0.052), (-0.066, 0.072), (-0.048, 0.087),
     (-0.022, 0.096), (0.0, BACK)]
)

# The profile, measured against real proportions (scaled to her face, ~0.85
# of a real one): head-local z → forward relief (m) over the base shape at the
# midline, and the relief's half-width there.
#
# The nose: a soft dip at its root between the eyes, a straight bridge, a
# tip ~16 mm proud, and its underside running back nearly level to meet the
# upper lip (as in the reference's profile; a real nose's columella).
_NOSE_P = pchip(sorted(
    [(EYE_Z + 0.020, 0.0), (EYE_Z + 0.004, 0.0003), (EYE_Z - 0.006, 0.0019), (EYE_Z - 0.016, 0.0050),
     (EYE_Z - 0.026, 0.0081), (EYE_Z - 0.036, 0.0112), (NOSE_Z + 0.0045, 0.0131), (NOSE_Z + 0.0020, 0.0149),
     (NOSE_Z + 0.0005, 0.0161), (NOSE_Z - 0.0010, 0.0153), (NOSE_Z - 0.0022, 0.0138), (NOSE_Z - 0.0034, 0.0110),
     (NOSE_Z - 0.0045, 0.0074), (NOSE_Z - 0.0056, 0.0040), (NOSE_Z - 0.0066, 0.0014), (NOSE_Z - 0.0076, 0.0)]
))
_NOSE_W = pchip(sorted(
    [(EYE_Z + 0.018, 0.0050), (EYE_Z, 0.0040), (NOSE_Z + 0.010, 0.0048), (NOSE_Z, 0.0058),
     (NOSE_Z - 0.004, 0.0068), (NOSE_Z - 0.0076, 0.0071)]
))
# The mouth and chin: the skin under the nose sloping forward to the upper
# lip's border, the upper lip rounding over it, the notch of the mouth line,
# the fuller lower lip, the crease under it, and the chin standing out again
# below — all in the same terms (the lip paint lies exactly over the lips:
# the upper lip's border ~2.5 mm above the mouth line, the lower lip ~6 mm tall)
_LIPS_P = pchip(sorted(
    [(MOUTH_Z + 0.0095, 0.0), (MOUTH_Z + 0.0088, 0.0004), (MOUTH_Z + 0.0075, 0.0026), (MOUTH_Z + 0.0060, 0.0039),
     (MOUTH_Z + 0.0045, 0.0046), (MOUTH_Z + 0.0032, 0.0054), (MOUTH_Z + 0.0023, 0.0061), (MOUTH_Z + 0.0015, 0.0063),
     (MOUTH_Z + 0.0007, 0.0055), (MOUTH_Z, 0.0039), (MOUTH_Z - 0.0006, 0.0052), (MOUTH_Z - 0.0016, 0.0065),
     (MOUTH_Z - 0.0028, 0.0071), (MOUTH_Z - 0.0042, 0.0067), (MOUTH_Z - 0.0056, 0.0054), (MOUTH_Z - 0.0072, 0.0031),
     (MOUTH_Z - 0.0095, 0.0008), (MOUTH_Z - 0.0125, -0.0002), (MOUTH_Z - 0.0160, 0.0012), (MOUTH_Z - 0.0195, 0.0030),
     (MOUTH_Z - 0.0235, 0.0039), (MOUTH_Z - 0.0275, 0.0033), (MOUTH_Z - 0.0315, 0.0020), (MOUTH_Z - 0.0350, 0.0008),
     (CHIN_Z, 0.0)]
))
_LIPS_W = pchip(sorted(
    [(MOUTH_Z + 0.0095, 0.0120), (MOUTH_Z + 0.0040, 0.0140), (MOUTH_Z, 0.0145), (MOUTH_Z - 0.0060, 0.0140),
     (MOUTH_Z - 0.0110, 0.0160), (CHIN_Z, 0.0170)]
))

def _superellipse(c, n):
    return math.copysign(abs(c) ** (2.0 / n), c)


def head_point(x, y, z):
    """Map a unit-sphere point (front = -Y) to the anime head surface.

    Every horizontal slice is a superellipse described by its half-width and
    its front/back extents, so the cranium and the jaw share one formula and
    meet without a crease."""
    r = math.hypot(x, y)
    th = math.atan2(x, -y) if r > 1e-9 else 0.0  # 0 = straight ahead
    if z >= 0:
        # cranium: ellipsoidal slices, slightly fuller at the back (cute big skull)
        Z = z * TOP_Z
        k = math.sqrt(max(0.0, 1.0 - z * z))
        W = HALF_W * k
        F = FRONT * k
        B = BACK * k + 0.006 * math.sin(math.pi * z)
        n_front = lerp(2.25, 2.0, smoothstep(0.0, 0.6, z))
    else:
        Z = z * (-CHIN_Z)
        T = z * (-_TABLE_CHIN)
        W, F, B = _W(T), _F(T), _B(T)
        n_front = 2.25
    yc = (B - F) * 0.5
    d = (F + B) * 0.5
    s, c = math.sin(th), math.cos(th)
    # flatter, fuller cheeks in front; plain ellipse round the back
    n = n_front if c > 0 else 2.0
    p = Vector((W * _superellipse(s, n), yc - d * _superellipse(c, n), Z))

    X, Z = p.x, p.z
    if p.y < 0:
        front = smoothstep(0.0, -0.05, p.y)
        p.y -= _relief(X, Z) * front
    return p


def _relief(x, z):
    """Forward relief (m) of the face over the head's base shape — what her
    profile is drawn from. (The face shades through sphere normals, so from
    the front the features stay painted, anime-style; from the side they read
    like a real person's.) The nose, a soft brow ridge over the eyes, gentle
    cheekbones, and the lips and chin (``_lips``)."""
    out = 0.0
    # the nose: root → bridge → tip → underside, narrow up top. (No sculpted
    # nostril wings: as separate forms they sat low and wide beside the nose
    # and broke the face's shape from the front — an anime nose keeps one
    # clean silhouette; a fine line drawn on its side reads as the nostril in
    # profile, see face.build_nose_lines.)
    w = _NOSE_W(z)
    out += _NOSE_P(z) * math.exp(-((x / w) ** 2))
    # a soft brow ridge: the eyes sit a touch deeper than the brows above them
    out += 0.0014 * math.exp(-(((z - EYE_Z - 0.019) / 0.0085) ** 2) - (x / 0.040) ** 4)
    # gentle cheekbones
    for sx in (-1, 1):
        out += 0.0012 * math.exp(-(((x - sx * 0.052) / 0.02) ** 2) - ((z + 0.045) / 0.018) ** 2)
    return out + _lips(x, z)


def _lips(x, z):
    """Forward relief (m) of the mouth and chin (``_LIPS_P``), tapering out
    to the corners of the mouth — the lips turn back into the face there, as
    a real mouth's do."""
    return _LIPS_P(z) * math.exp(-((x / _LIPS_W(z)) ** 2))


def _azimuth(s, k=0.5):
    """Head ring azimuth for s in [0, 1): back → front (0) → back, with the
    vertices k× as far apart over the face as round the back of the head (the
    lips and nose need ~2 mm; the back is under the hair)."""
    t = 2.0 * s - 1.0
    return math.pi * t * (k + (1.0 - k) * t * t)


def _polar(s):
    """Ring polar angle for s in [0, 1] (top → bottom pole): rings crowd
    over the face below the eyes (~1.5 mm apart over the nose and lips,
    whose profile is all detail) and spread out over the crown under the
    hair."""
    return math.pi * pchip([(0.0, 0.0), (0.25, 0.30), (0.40, 0.52), (0.85, 0.88), (1.0, 1.0)])(s)


def build_head(rings=200, segs=160):
    verts = []
    faces = []
    # top pole
    verts.append(HEAD_C + head_point(0, 0, 1))
    for i in range(1, rings):
        phi = _polar(i / rings)
        for j in range(segs):
            th = _azimuth(j / segs, 0.42)
            x = math.sin(phi) * math.sin(th)
            y = -math.sin(phi) * math.cos(th)
            z = math.cos(phi)
            verts.append(HEAD_C + head_point(x, y, z))
    verts.append(HEAD_C + head_point(0, 0, -1))
    bottom = len(verts) - 1

    def vi(i, j):
        return 1 + (i - 1) * segs + (j % segs)

    # rings run top → bottom while j winds counter-clockwise seen from above,
    # so each quad is listed j+1 → j to keep the normals pointing outward
    # (the app's outline shell and back-face culling depend on it)
    for j in range(segs):
        faces.append((0, vi(1, j), vi(1, j + 1)))
    for i in range(1, rings - 1):
        for j in range(segs):
            faces.append((vi(i, j + 1), vi(i, j), vi(i + 1, j), vi(i + 1, j + 1)))
    for j in range(segs):
        faces.append((vi(rings - 1, j + 1), vi(rings - 1, j), bottom))

    mat = material("Skin", srgb(SKIN), roughness=0.55)
    ob = mesh_object("Head", verts, faces, mat)
    return ob


# ── ears ────────────────────────────────────────────────────────────────

# head-local heights of the top of the ear and its lobe: from just above the
# eye line down to the level of the nose's wings, as in the reference profile
EAR_TOP, EAR_BOT = -0.007, -0.058
# how far the ear reaches back from where it grows out of the head, top → lobe
_EAR_W = pchip([(0.0, 0.015), (0.08, 0.0195), (0.20, 0.0225), (0.35, 0.0235), (0.50, 0.0228),
                (0.68, 0.0200), (0.82, 0.0168), (0.93, 0.0140), (1.0, 0.0110)])


def ear_point(side, u, v, bvh, inner=0.0):
    """A point on one ear: u runs from where it grows out of the head (0) to
    the rim (1), v from its top (0) to the lobe (1). ``inner`` shifts toward
    the head (the shell's back face)."""
    # the outline: the helix arcs over the top and down the back, the lobe
    # rounds off the bottom
    top = EAR_TOP - (0.011 * ((u - 0.32) / 0.68) ** 2 if u > 0.32 else 0.003 * ((0.32 - u) / 0.32) ** 2)
    bot = EAR_BOT + 0.008 * ((u - 0.40) / 0.60) ** 2
    z = HEAD_C.z + lerp(top, bot, v)
    # the ear leans back: its root slants down and forward
    y0 = HEAD_C.y + 0.0060 - 0.0055 * v
    y = y0 + _EAR_W(v) * u
    hit, _n, _i, _d = bvh.ray_cast(Vector((side * 0.3, y, z)), Vector((-side, 0.0, 0.0)))
    base = abs(hit.x) if hit is not None else HALF_W
    # an anime ear lies close to the head: it stands out a little behind its
    # root — most at mid-height, least at the lobe
    flare = 0.0092 * u ** 1.4 * (0.6 + 0.4 * math.sin(math.pi * min(1.0, v * 1.08)))
    # the shallow bowl of the concha, and the rolled rim of the helix
    bowl = -0.0011 * math.exp(-(((u - 0.50) / 0.22) ** 2) - ((v - 0.56) / 0.20) ** 2)
    rim = 0.0011 * smoothstep(0.75, 0.92, u) - 0.0016 * smoothstep(0.94, 1.0, u)
    # (only the root edge sinks into the skin; the rest sits on it)
    x = base + lerp(-0.0014, 0.0011, smoothstep(0.0, 0.12, u)) + flare + bowl + rim - inner
    return Vector((side * x, y - 0.0015 * smoothstep(0.9, 1.0, u), z))


def build_ears(head_ob, cols=14, rows=26):
    """Her ears: a thin shell growing out of the side of the head — its
    front edge buried in the skin, the helix flaring out behind it with a
    rolled rim around the bowl of the concha — and the inner fold drawn as an
    ink line, anime-style. They ride the head (no weights of their own)."""
    from kit.common import bvh_of

    bvh = bvh_of(head_ob)
    mat = head_ob.data.materials[0]
    ears, lines = [], []
    thick = 0.0024
    for side, sfx in ((1, "L"), (-1, "R")):
        verts, faces = [], []
        n = (cols + 1) * (rows + 1)
        for inner in (0.0, thick):
            for r in range(rows + 1):
                v = r / rows
                for c in range(cols + 1):
                    u = c / cols
                    # the back face tapers into the front one toward the root
                    verts.append(ear_point(side, u, v, bvh, inner * smoothstep(0.0, 0.5, u)))

        def vi(layer, r, c):
            return layer * n + r * (cols + 1) + c

        outer = []
        for r in range(rows):
            for c in range(cols):
                outer.append((vi(0, r, c), vi(0, r, c + 1), vi(0, r + 1, c + 1), vi(0, r + 1, c)))
        # wind the outer face away from the head
        a, b, cc = (verts[i] for i in outer[len(outer) // 2][:3])
        if (b - a).cross(cc - a).x * side < 0:
            outer = [tuple(reversed(f)) for f in outer]
        back = [tuple(reversed([i + n for i in f])) for f in outer]
        # close the shell round the rim, top and lobe (the root edge is buried)
        rim = []
        for r in range(rows):
            rim.append((vi(0, r, cols), vi(1, r, cols), vi(1, r + 1, cols), vi(0, r + 1, cols)))
        for c in range(cols):
            rim.append((vi(0, 0, c + 1), vi(1, 0, c + 1), vi(1, 0, c), vi(0, 0, c)))
            rim.append((vi(0, rows, c), vi(1, rows, c), vi(1, rows, c + 1), vi(0, rows, c + 1)))
        # (same winding sense as the outer face: check one strip outward)
        mid = rim[rows // 2]
        p0, p1, p2 = (verts[i] for i in mid[:3])
        centre = sum((verts[vi(0, r, cols // 2)] for r in range(rows + 1)), Vector()) / (rows + 1)
        if (p1 - p0).cross(p2 - p0).dot(p0 - centre) < 0:
            rim = [tuple(reversed(f)) for f in rim]
        faces = outer + back + rim
        ears.append(mesh_object("Ear_" + sfx, verts, faces, mat))

        # the ink of the inner fold: along the inside of the helix, curling
        # into the bowl, and the little notch above the lobe
        def stroke(pts, w0, w1):
            """an ink line (half-width w0 → w1 m) through ear (u, v) points"""
            from kit.common import catmull_rom

            curve = catmull_rom([Vector((u, v, 0.0)) for u, v in pts], 6)
            centres = [ear_point(side, q.x, q.y, bvh) for q in curve]
            a_, b_ = [], []
            m = len(curve)
            for i, (q, c) in enumerate(zip(curve, centres)):
                t = i / (m - 1)
                w = lerp(w0, w1, t) * math.sin(math.pi * min(max(t, 0.08), 0.92)) ** 0.5
                tan = (centres[min(i + 1, m - 1)] - centres[max(i - 1, 0)]).normalized()
                du = ear_point(side, q.x + 0.02, q.y, bvh) - ear_point(side, q.x - 0.02, q.y, bvh)
                dv = ear_point(side, q.x, q.y + 0.02, bvh) - ear_point(side, q.x, q.y - 0.02, bvh)
                nrm = du.cross(dv).normalized()
                if nrm.x * side < 0:
                    nrm = -nrm
                off = tan.cross(nrm).normalized() * w
                a_.append(c - off + nrm * 0.0004)
                b_.append(c + off + nrm * 0.0004)
            vs = a_ + b_
            fs = [(i, i + 1, i + m + 1, i + m) for i in range(m - 1)]
            p0, p1, p2 = vs[fs[m // 2][0]], vs[fs[m // 2][1]], vs[fs[m // 2][2]]
            if (p1 - p0).cross(p2 - p0).x * side < 0:
                fs = [tuple(reversed(f)) for f in fs]
            return vs, fs

        for pts, w0, w1 in (
            # the helix's outer edge, over the top, down the back to the lobe
            ([(0.22, 0.015), (0.55, 0.004), (0.86, 0.05), (0.975, 0.24), (0.975, 0.52), (0.93, 0.78), (0.74, 0.97), (0.45, 0.99)],
             0.00060, 0.00045),
            # the inner fold, curling into the bowl; the notch above the lobe
            ([(0.62, 0.10), (0.76, 0.22), (0.80, 0.40), (0.74, 0.58), (0.58, 0.68), (0.46, 0.66)], 0.00050, 0.00035),
            ([(0.16, 0.50), (0.22, 0.60), (0.30, 0.66)], 0.00040, 0.00030),
        ):
            lines.append(stroke(pts, w0, w1))
    # all the ink in one mesh
    lv, lf = [], []
    for vs, fs in lines:
        o = len(lv)
        lv += vs
        lf += [tuple(i + o for i in f) for f in fs]
    ink = mesh_object("EarLines", lv, lf, material("EarLine", srgb("#8a5444"), roughness=0.6))
    # a soft shade in the bowl of each ear (feathered by its UVs in the app),
    # the way an anime ear is drawn — the shell alone is too shallow to shade
    sv, sf, suv = [], [], []
    cols, rows = 8, 10
    for side in (1, -1):
        o = len(sv)
        for r in range(rows + 1):
            for c in range(cols + 1):
                u = lerp(0.16, 0.74, c / cols)
                v = lerp(0.26, 0.84, r / rows)
                sv.append(ear_point(side, u, v, bvh) + Vector((side * 0.00035, 0.0, 0.0)))
                suv.append((c / cols, r / rows))
        quads = [(o + r * (cols + 1) + c, o + r * (cols + 1) + c + 1, o + (r + 1) * (cols + 1) + c + 1, o + (r + 1) * (cols + 1) + c)
                 for r in range(rows) for c in range(cols)]
        a, b, cc = (sv[i] for i in quads[len(quads) // 2][:3])
        if (b - a).cross(cc - a).x * side < 0:
            quads = [tuple(reversed(q)) for q in quads]
        sf += quads
    shade = mesh_object("EarShades", sv, sf, material("EarShade", srgb("#dfa592"), roughness=0.6), uvs=suv)
    return ears + [ink, shade]
