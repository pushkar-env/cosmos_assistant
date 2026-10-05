"""Facial features — eyes, lashes, brows, mouth and blush — with blendshapes.

Every feature is a thin mesh laid onto the head surface (projected along +Y
and lifted a fraction of a millimetre off the skin). Expressions are shape
keys that *re-project* the feature's 2D outline, so a morphed eye or mouth
still hugs the face exactly.

Eye trick: the eye mesh is just the visible white of the eye. The app's eye
shader paints the iris at a position computed from the MORPHED vertex
position, so when the lids close (the mesh outline shrinks) the iris is
covered like a real eyelid instead of being squashed. UV.y stores how far a
vertex sits from the lower lid (0) to the upper lid (1), which the shader uses
for the soft lash shadow across the top of the eye.

This character's variant (proportions measured on the reference): almond cat
eyes — inner corners dipping toward the nose, high blunt outer corners — with
hazel irises; detailed lids (bold lash line with flicks, the double-eyelid
crease, a soft lid/socket shadow, the pink inner corner, a lower lash line);
thin brows climbing from the nose; a long nose drawn in soft shading; a wide
mouth with full lips (pink lower lip with a gloss and the shadow under it, an
upper lip with a cupid's bow) that follow every mouth shape; and the
blue-violet diamond seal on her forehead.

Soft-edged decals (lid shade, nose shading, upper lip, lip gloss and shadow)
carry UVs the app feathers them by: x along the feature, y across it.

Shape-key contract (read by src/renderer/src/features/avatar):
  eyes + lashes : E_Blink_L/R E_Happy_L/R E_Wide_L/R E_Relax_L/R E_Sad_L/R E_Angry_L/R
  brows         : B_Up_L/R B_Angry_L/R B_Sad_L/R
  mouth (+head) : V_A V_I V_U V_E V_O M_Smile M_Frown M_Joy M_Grin M_Pout M_Small
"""

import math

from mathutils import Vector

from kit.common import (
    bvh_of,
    catmull_rom,
    lerp,
    material,
    mesh_object,
    pchip,
    shape_key,
    smoothstep,
    srgb,
)
from .head import EYE_X, EYE_Z, HEAD_C, MARK_Z, MOUTH_Z, NOSE_Z

# ── projection onto the skin ────────────────────────────────────────────


class Surface:
    """Projects face-plane points (x, z) onto the head surface."""

    def __init__(self, head_ob):
        self.bvh = bvh_of(head_ob)

    def at(self, x, z, lift):
        origin = Vector((x, -1.0, z))
        hit, normal, _i, _d = self.bvh.ray_cast(origin, Vector((0, 1, 0)))
        if hit is None:
            raise RuntimeError(f"face projection missed at x={x:.4f} z={z:.4f}")
        if normal.y > 0:
            normal = -normal
        return hit + normal * lift


def _sinp(a, p=1.0):
    return math.sin(math.pi * min(max(a, 0.0), 1.0)) ** p


def _outward(verts, faces):
    """Wind every face toward the viewer (−Y) — the features are thin decals
    on the face and the app culls back faces."""
    a, b, c = (verts[i] for i in faces[0][:3])
    if (b - a).cross(c - a).y > 0:
        return [tuple(reversed(f)) for f in faces]
    return faces


def _grid(cols, rows):
    """Quads for a (cols+1) × (rows+1) vertex grid stored row-major."""
    out = []
    for r in range(rows):
        for c in range(cols):
            i = r * (cols + 1) + c
            out.append((i, i + 1, i + cols + 2, i + cols + 1))
    return out


# ── eyes ────────────────────────────────────────────────────────────────

U_IN, U_OUT = -0.0190, 0.0200  # eye-local horizontal extent (outward +)

# her cat eye, measured on the reference: the inner corner dips toward the
# nose, the upper lid climbs steeply out of it and then runs nearly flat to a
# high, blunt outer corner; a shallow lower lid sweeps up to meet it
_top = pchip(
    [(0.0, -0.0006), (0.08, 0.0036), (0.20, 0.0074), (0.38, 0.0098), (0.58, 0.0108),
     (0.78, 0.0110), (0.92, 0.0104), (1.0, 0.0088)]
)
_bot = pchip(
    [(0.0, -0.0006), (0.10, -0.0034), (0.30, -0.0056), (0.50, -0.0060), (0.70, -0.0046),
     (0.84, -0.0024), (0.93, 0.0006), (1.0, 0.0088)]
)


def _closed(a):
    # a relaxed downward arc — the classic anime closed eye
    return lerp(-0.0006, 0.0088, a) - 0.0058 * _sinp(a, 0.85)


def _happy(a):
    # ^ ^ — an upward arc, sitting a little low
    return lerp(-0.0035, 0.0030, a) + 0.0060 * _sinp(a, 0.8) - 0.001


def eye_lids(key, a):
    """(top, bottom) lid heights for an eye-local column ``a`` in [0, 1]."""
    t, b = _top(a), _bot(a)
    if key == "E_Blink":
        c = _closed(a)
        return c, c
    if key == "E_Happy":
        h = _happy(a)
        return h, h
    if key == "E_Wide":
        return t + 0.0030 * _sinp(a, 0.5), b - 0.0012 * _sinp(a)
    if key == "E_Relax":
        return t - 0.40 * (t - b), b + 0.10 * (t - b)
    if key == "E_Sad":
        return t - (t - b) * (0.08 + 0.30 * a ** 1.3), b + 0.04 * (t - b)
    if key == "E_Angry":
        return t - (t - b) * (0.08 + 0.36 * (1 - a) ** 1.2), b + 0.12 * (t - b)
    return t, b


EYE_KEYS = ["E_Blink", "E_Happy", "E_Wide", "E_Relax", "E_Sad", "E_Angry"]

IRIS_RX, IRIS_RZ = 0.0104, 0.0110


def _preview_iris(mat, cx, cz):
    """Blender-only stand-in for the app's eye shader so renders show an iris
    (the glTF exporter ignores this node graph; the app re-shades the eye)."""
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    bsdf = nodes["Principled BSDF"]
    tc = nodes.new("ShaderNodeTexCoord")
    sep = nodes.new("ShaderNodeSeparateXYZ")
    links.new(tc.outputs["Object"], sep.inputs[0])

    def math_node(op, a, b):
        n = nodes.new("ShaderNodeMath")
        n.operation = op
        for i, v in enumerate((a, b)):
            if isinstance(v, float):
                n.inputs[i].default_value = v
            else:
                links.new(v, n.inputs[i])
        return n.outputs[0]

    dx = math_node("DIVIDE", math_node("SUBTRACT", sep.outputs["X"], cx), IRIS_RX)
    dz = math_node("DIVIDE", math_node("SUBTRACT", sep.outputs["Z"], cz), IRIS_RZ)
    d = math_node("SQRT", math_node("ADD", math_node("MULTIPLY", dx, dx), math_node("MULTIPLY", dz, dz)), 0.0)
    ramp = nodes.new("ShaderNodeValToRGB")
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, (0.01, 0.03, 0.06, 1)
    els[1].position, els[1].color = 1.0, (0.95, 0.96, 1.0, 1)
    for pos, col in ((0.30, (0.04, 0.02, 0.01, 1)), (0.36, (0.30, 0.15, 0.04, 1)), (0.80, (0.55, 0.32, 0.10, 1)),
                     (0.93, (0.10, 0.05, 0.02, 1)), (0.985, (0.10, 0.05, 0.02, 1))):
        e = els.new(pos)
        e.color = col
    links.new(d, ramp.inputs[0])
    links.new(ramp.outputs[0], bsdf.inputs["Base Color"])


def _eye_xz(side, u, v):
    return side * (EYE_X + u), HEAD_C.z + EYE_Z + v


def build_eye(surf, side, cols=22, rows=10):
    suffix = "L" if side > 0 else "R"

    def positions(key):
        pts = []
        for r in range(rows + 1):
            b = r / rows
            for c in range(cols + 1):
                a = c / cols
                top, bot = eye_lids(key, a)
                x, z = _eye_xz(side, lerp(U_IN, U_OUT, a), lerp(bot, top, b))
                pts.append(surf.at(x, z, 0.0004))
        return pts

    faces = []
    for r in range(rows):
        for c in range(cols):
            i = r * (cols + 1) + c
            q = (i, i + 1, i + cols + 2, i + cols + 1)
            faces.append(q if side > 0 else tuple(reversed(q)))
    uvs = [(c / cols, r / rows) for r in range(rows + 1) for c in range(cols + 1)]
    mat = material(f"Eye_{suffix}", srgb("#f6f8ff"), roughness=0.2)
    _preview_iris(mat, *_eye_xz(side, 0.0008, 0.0028))
    ob = mesh_object(f"Eye_{suffix}", positions(None), faces, mat, uvs=uvs)
    for k in EYE_KEYS:
        shape_key(ob, f"{k}_{suffix}", positions(k))
    return ob


# ── lashes / eyelid crease ──────────────────────────────────────────────

# upper lash thickness along the lid (thin at the tear duct, bold outside)
_lash_th = pchip([(-0.04, 0.0006), (0.0, 0.0012), (0.3, 0.0026), (0.7, 0.0036), (1.0, 0.0044)])

_SHUT = ("E_Blink", "E_Happy")


def _band(surf, side, rows_uv, lift, flip):
    """Quad strip from a list of columns, each a list of (u, v) points."""
    verts = []
    cols = len(rows_uv)
    nr = len(rows_uv[0])
    for r in range(nr):
        for c in range(cols):
            u, v = rows_uv[c][r]
            x, z = _eye_xz(side, u, v)
            verts.append(surf.at(x, z, lift))
    faces = []
    for r in range(nr - 1):
        for c in range(cols - 1):
            i = r * cols + c
            q = (i, i + 1, i + cols + 1, i + cols)
            faces.append(q if (side > 0) != flip else tuple(reversed(q)))
    return verts, faces


def _strips(surf, side, strips, lift):
    """Several column-strips (see ``_band``) as one mesh."""
    verts, faces = [], []
    for cols in strips:
        v, f = _band(surf, side, cols, lift, False)
        o = len(verts)
        verts += v
        faces += [tuple(i + o for i in q) for q in f]
    return verts, faces


def _upper_lash_columns(key, n=30):
    cols = []
    for k in range(n + 1):
        a = lerp(-0.035, 1.0, k / n)
        top, _ = eye_lids(key, max(a, 0.0))
        if a < 0:
            top += a * 0.05  # tuck the inner end down toward the tear duct
        u = lerp(U_IN, U_OUT, a)
        th = _lash_th(a)
        if key in _SHUT:
            th *= 0.72
        base = top - 0.00055
        cols.append([(u, base), (u, base + th * 0.55), (u, base + th)])
    # the outer end runs on past the corner, level, and tapers off (her
    # corner is already high — a lifted wing would read as a cat-eye liner)
    top1, _ = eye_lids(key, 1.0)
    th1 = _lash_th(1.0) * (0.72 if key in _SHUT else 1.0)
    for du, dv, f in ((0.0026, 0.0002, 0.80), (0.0048, 0.0001, 0.50), (0.0068, -0.0002, 0.0)):
        base = top1 - 0.00055 + dv
        cols.append([(U_OUT + du, base), (U_OUT + du, base + th1 * 0.55 * f + 0.0001), (U_OUT + du, base + th1 * f + 0.0002)])
    return cols


# lash flicks rising off the outer part of the upper lash: (lid column a,
# along-lid offset of the tip, height of the tip, base width)
_FLICKS = ((0.80, 0.0018, 0.0021, 0.0011), (0.93, 0.0027, 0.0024, 0.0012), (1.04, 0.0034, 0.0019, 0.0010))


def _flick_columns(key):
    out = []
    shut = key in _SHUT
    for a, du, dv, w in _FLICKS:
        top, _ = eye_lids(key, min(a, 1.0))
        u0 = lerp(U_IN, U_OUT, a)
        base = top - 0.00055 + _lash_th(min(a, 1.0)) * (0.72 if shut else 1.0) * 0.8
        if a > 1.0:  # past the corner: on the run-off
            base = eye_lids(key, 1.0)[0] - 0.00055 + 0.0016
        k = 0.45 if shut else 1.0  # closed, the flicks fold down along the lid
        cols = []
        for t in (0.0, 0.5, 1.0):
            # a little curl: out first, then up
            u = u0 + du * k * t ** 0.8
            v = base + dv * k * t ** 1.3
            half = w * 0.5 * (1.0 - t) + 0.00004
            # columns climb the flick, so its rows run outer → inner to wind
            # like the lash strip (whose columns run along the lid)
            cols.append([(u + half, v), (u - half, v)])
        out.append(cols)
    return out


def _lower_lash_columns(key, n=18):
    cols = []
    for k in range(n + 1):
        a = lerp(0.14, 1.0, k / n)
        _, bot = eye_lids(key, a)
        # a hairline at the inner end, firming up over the outer third
        th = 0.00022 + 0.00070 * smoothstep(0.35, 0.85, a)
        u = lerp(U_IN, U_OUT, a)
        cols.append([(u, bot - th), (u, bot + 0.0003)])
    return cols


def _openness(key, a):
    """How open the lids are at column a, relative to rest (0 shut → 1)."""
    top, bot = eye_lids(key, a)
    return max(0.0, top - bot) / max(1e-6, _top(a) - _bot(a))


def _crease_gap(key, a):
    # the double-eyelid fold: ~2.6 mm above the lash line at the inner end,
    # 3.8 mm toward the outer end; it flattens onto the lid as the eye closes
    return (0.0026 + 0.0012 * a) * (0.35 + 0.65 * _openness(key, a))


def _crease_columns(key, n=22):
    cols = []
    for k in range(n + 1):
        a = lerp(0.10, 1.06, k / n)
        ac = min(a, 1.0)
        top, _ = eye_lids(key, ac)
        if a > 1.0:  # runs a touch past the corner, level
            top = eye_lids(key, 1.0)[0] + (a - 1.0) * 0.004
        gap = _crease_gap(key, ac)
        th = 0.00075 * _sinp((a - 0.10) / 0.96, 0.55)
        u = lerp(U_IN, U_OUT, a)
        cols.append([(u, top + gap), (u, top + gap + th + 0.00005)])
    return cols


def build_lid_lines(surf, side):
    suffix = "L" if side > 0 else "R"
    out = []
    specs = (
        ("Lash", lambda k: [_upper_lash_columns(k)] + _flick_columns(k), 0.0009, "#2b1b24"),
        ("LashLower", lambda k: [_lower_lash_columns(k)], 0.0008, "#6b3d45"),
        ("Crease", lambda k: [_crease_columns(k)], 0.0006, "#a06e5c"),
    )
    for name, fn, lift, col in specs:
        verts, faces = _strips(surf, side, fn(None), lift)
        mat = material(f"{name}", srgb(col), roughness=0.8)
        ob = mesh_object(f"{name}_{suffix}", verts, faces, mat)
        for k in EYE_KEYS:
            kv, _ = _strips(surf, side, fn(k), lift)
            shape_key(ob, f"{k}_{suffix}", kv)
        out.append(ob)
    out.append(build_lid_shade(surf, side))
    out.append(build_caruncle(surf, side))
    return out


def build_lid_shade(surf, side, cols=30, rows=6):
    """The shadow on the upper lid: from the lash line up past the crease,
    deepening into the eye socket beside the nose (as drawn in the reference).
    Soft-edged in the app: UV.y runs lid (0) → top edge (1), UV.x inner →
    outer."""
    suffix = "L" if side > 0 else "R"

    def positions(key):
        pts = []
        for r in range(rows + 1):
            b = r / rows
            for c in range(cols + 1):
                a = lerp(-0.16, 1.02, c / cols)
                ac = min(max(a, 0.0), 1.0)
                top, _ = eye_lids(key, ac)
                if a < 0:  # on toward the nose, level with the inner corner
                    top = eye_lids(key, 0.0)[0] + 0.0010 * a
                lo = top - 0.0002
                # tall in the socket by the nose, down to the fold outside
                h = _crease_gap(key, ac) + 0.0018 + 0.0040 * (1.0 - smoothstep(-0.10, 0.40, a))
                pts.append(surf.at(*_eye_xz(side, lerp(U_IN, U_OUT, a), lo + h * b), 0.0003))
        return pts

    faces = _grid(cols, rows)
    uvs = [(c / cols, r / rows) for r in range(rows + 1) for c in range(cols + 1)]
    base = positions(None)
    ob = mesh_object(f"LidShade_{suffix}", base, _outward(base, faces), material("LidShade", srgb("#d49a8a"), roughness=0.8), uvs=uvs)
    for k in EYE_KEYS:
        shape_key(ob, f"{k}_{suffix}", positions(k))
    return ob


def build_caruncle(surf, side, n=6):
    """The pink inner corner of the eye (a little notch of flesh where the
    lids meet by the nose). It closes with the lids."""
    suffix = "L" if side > 0 else "R"

    def positions(key):
        pts = [surf.at(*_eye_xz(side, U_IN + 0.0003, eye_lids(key, 0.0)[0]), 0.0006)]
        for k in range(n + 1):
            t = k / n
            a = 0.095
            top, bot = eye_lids(key, a)
            mid = (top + bot) * 0.5
            # fills most of the narrow corner, so it reads as part of it
            half = 0.36 * max(0.0, top - bot)
            # a rounded back edge (a lens, pointed at the corner)
            u = U_IN + 0.0003 + (lerp(U_IN, U_OUT, a) - U_IN) * (1.0 - 0.35 * (2 * t - 1) ** 2)
            pts.append(surf.at(*_eye_xz(side, u, mid + half * (2 * t - 1)), 0.0006))
        return pts

    base = positions(None)
    faces = _outward(base, [(0, k + 1, k + 2) for k in range(n)])
    ob = mesh_object(f"Caruncle_{suffix}", base, faces, material("Caruncle", srgb("#eba7a4"), roughness=0.6))
    for k in EYE_KEYS:
        shape_key(ob, f"{k}_{suffix}", positions(k))
    return ob


# ── brows ───────────────────────────────────────────────────────────────

# thin brows, measured on the reference: a blunt inner end low by the nose
# (level with the top of the eye), climbing steeply, then running out nearly
# flat above the outer corner — her composed, confident look
_BROW = [(-0.0225, 0.0118), (-0.0140, 0.0170), (-0.0040, 0.0209), (0.0075, 0.0232), (0.0185, 0.0236)]
_BROW_TH = [0.0024, 0.0023, 0.0019, 0.0013, 0.0003]
BROW_KEYS = ["B_Up", "B_Angry", "B_Sad"]


def _brow_points(key):
    pts = []
    for i, (u, v) in enumerate(_BROW):
        f_in = 1.0 - i / (len(_BROW) - 1)  # 1 at the inner end
        du = dv = 0.0
        if key == "B_Up":
            dv = 0.0045 + 0.0015 * f_in
        elif key == "B_Angry":
            dv = -0.0060 * f_in ** 1.3 + 0.0012 * (1 - f_in)
            du = 0.0020 * f_in
        elif key == "B_Sad":
            dv = 0.0055 * f_in ** 1.5 - 0.0015 * (1 - f_in)
            du = 0.0008 * f_in
        pts.append((u + du, v + dv))
    return pts


def build_brow(surf, side):
    suffix = "L" if side > 0 else "R"

    def verts_for(key):
        ctrl = [Vector((u, v, 0)) for u, v in _brow_points(key)]
        curve = catmull_rom(ctrl, 6)
        th = pchip([(i / (len(_BROW_TH) - 1), t) for i, t in enumerate(_BROW_TH)])
        n = len(curve)
        cols = []
        for i, p in enumerate(curve):
            a = i / (n - 1)
            nxt = curve[min(i + 1, n - 1)] - curve[max(i - 1, 0)]
            nrm = Vector((-nxt.y, nxt.x, 0)).normalized()
            if nrm.y < 0:
                nrm = -nrm
            t = th(a)
            cols.append([(p.x - nrm.x * t * 0.5, p.y - nrm.y * t * 0.5), (p.x + nrm.x * t * 0.5, p.y + nrm.y * t * 0.5)])
        return _band(surf, side, cols, 0.0008, False)

    verts, faces = verts_for(None)
    mat = material("Brow", srgb("#a8804c"), roughness=0.8)
    ob = mesh_object(f"Brow_{suffix}", verts, faces, mat)
    for k in BROW_KEYS:
        kv, _ = verts_for(k)
        shape_key(ob, f"{k}_{suffix}", kv)
    return ob


# ── mouth ───────────────────────────────────────────────────────────────

MOUTH_KEYS = ["V_A", "V_I", "V_U", "V_E", "V_O", "M_Smile", "M_Frown", "M_Joy", "M_Grin", "M_Pout", "M_Small"]


def mouth_shape(key):
    """(half_width, centre-line(a), top(a), bottom(a)) — offsets from the line.

    Her mouth is wide (measured on the reference: ~0.55× the distance between
    her pupils), a long line thickest in the middle that tapers to fine
    corners."""
    hw = 0.0168
    line = lambda a: 0.0010 * (2 * a - 1) ** 2  # noqa: E731 — a composed, faint smile
    top = lambda a: 0.00048 * _sinp(a, 0.6)  # noqa: E731
    bot = lambda a: -0.00048 * _sinp(a, 0.6)  # noqa: E731
    if key == "V_A":
        hw = 0.0152
        top = lambda a: 0.0016 * _sinp(a, 0.45)  # noqa: E731
        bot = lambda a: -0.0125 * _sinp(a, 0.75)  # noqa: E731
    elif key == "V_I":
        hw = 0.0200
        line = lambda a: 0.0022 * (2 * a - 1) ** 2  # noqa: E731
        top = lambda a: 0.0014 * _sinp(a, 0.35)  # noqa: E731
        bot = lambda a: -0.0030 * _sinp(a, 0.45)  # noqa: E731
    elif key == "V_U":
        hw = 0.0066
        line = lambda a: 0.0  # noqa: E731
        top = lambda a: 0.0030 * _sinp(a, 0.75)  # noqa: E731
        bot = lambda a: -0.0036 * _sinp(a, 0.75)  # noqa: E731
    elif key == "V_E":
        hw = 0.0176
        top = lambda a: 0.0018 * _sinp(a, 0.45)  # noqa: E731
        bot = lambda a: -0.0068 * _sinp(a, 0.65)  # noqa: E731
    elif key == "V_O":
        hw = 0.0094
        line = lambda a: 0.0  # noqa: E731
        top = lambda a: 0.0042 * _sinp(a, 0.65)  # noqa: E731
        bot = lambda a: -0.0080 * _sinp(a, 0.7)  # noqa: E731
    elif key == "M_Smile":
        hw = 0.0192
        line = lambda a: 0.0054 * (2 * a - 1) ** 2 - 0.0008  # noqa: E731
    elif key == "M_Frown":
        hw = 0.0142
        line = lambda a: -0.0032 * (2 * a - 1) ** 2  # noqa: E731
    elif key == "M_Joy":
        # open "D" laugh: flat-topped smile line, deep round bottom
        hw = 0.0186
        line = lambda a: 0.0046 * (2 * a - 1) ** 2 - 0.0006  # noqa: E731
        top = lambda a: 0.0006 * _sinp(a, 0.4)  # noqa: E731
        bot = lambda a: -0.0118 * _sinp(a, 0.8)  # noqa: E731
    elif key == "M_Grin":
        hw = 0.0200
        line = lambda a: 0.0048 * (2 * a - 1) ** 2 - 0.0006  # noqa: E731
        top = lambda a: 0.0012 * _sinp(a, 0.35)  # noqa: E731
        bot = lambda a: -0.0040 * _sinp(a, 0.5)  # noqa: E731
    elif key == "M_Pout":
        hw = 0.0072
        line = lambda a: -0.0004  # noqa: E731
        top = lambda a: 0.0006 * _sinp(a, 0.6)  # noqa: E731
        bot = lambda a: -0.0006 * _sinp(a, 0.6)  # noqa: E731
    elif key == "M_Small":
        # the little surprised "o"
        hw = 0.0048
        line = lambda a: 0.0  # noqa: E731
        top = lambda a: 0.0032 * _sinp(a, 0.7)  # noqa: E731
        bot = lambda a: -0.0042 * _sinp(a, 0.7)  # noqa: E731
    return hw, line, top, bot


def build_mouth(surf, cols=24, rows=8):
    def positions(key):
        hw, line, top, bot = mouth_shape(key)
        pts = []
        for r in range(rows + 1):
            b = r / rows
            for c in range(cols + 1):
                a = c / cols
                u = lerp(-hw, hw, a)
                v = line(a) + lerp(bot(a), top(a), b)
                pts.append(surf.at(u, HEAD_C.z + MOUTH_Z + v, 0.00045))
        return pts

    faces = []
    for r in range(rows):
        for c in range(cols):
            i = r * (cols + 1) + c
            faces.append((i, i + 1, i + cols + 2, i + cols + 1))
    uvs = [(c / cols, r / rows) for r in range(rows + 1) for c in range(cols + 1)]
    mat = material("Mouth", srgb("#7a2633"), roughness=0.6)
    ob = mesh_object("Mouth", positions(None), faces, mat, uvs=uvs)
    for k in MOUTH_KEYS:
        shape_key(ob, k, positions(k))
    return ob


# ── blush ───────────────────────────────────────────────────────────────


def build_blush(surf):
    verts, faces, uvs = [], [], []
    segs, rings = 20, 5
    for side in (1, -1):
        base = len(verts)
        cx, cz = side * 0.052, HEAD_C.z - 0.050
        verts.append(surf.at(cx, cz, 0.00025))
        uvs.append((0.5, 0.5))
        for r in range(1, rings + 1):
            f = r / rings
            for s in range(segs):
                t = 2 * math.pi * s / segs
                x = cx + math.cos(t) * 0.0165 * f
                z = cz + math.sin(t) * 0.0080 * f
                verts.append(surf.at(x, z, 0.00025))
                uvs.append((0.5 + 0.5 * f * math.cos(t), 0.5 + 0.5 * f * math.sin(t)))
        # the ellipse is not mirrored per side, so both share one winding
        for s in range(segs):
            faces.append((base, base + 1 + s, base + 1 + (s + 1) % segs))
        for r in range(1, rings):
            o0 = base + 1 + (r - 1) * segs
            o1 = base + 1 + r * segs
            for s in range(segs):
                faces.append((o0 + s, o1 + s, o1 + (s + 1) % segs, o0 + (s + 1) % segs))
    mat = material("Blush", srgb("#ff8fa3"), roughness=0.9, alpha=0.5)
    return mesh_object("Blush", verts, faces, mat, uvs=uvs)


# ── lips ────────────────────────────────────────────────────────────────


def _mouth_decal(surf, name, mat, where, cols, rows, lift):
    """A grid laid on the face around the mouth that carries every mouth
    shape key, re-derived from the same outline, so it rides the jaw.
    ``where(key, s, b)`` → face-plane (u, v) from the mouth centre for grid
    column s and row b (both 0..1); UVs are (s, b)."""

    def positions(key):
        return [surf.at(*_mouth_uv(where(key, c / cols, r / rows)), lift) for r in range(rows + 1) for c in range(cols + 1)]

    base = positions(None)
    uvs = [(c / cols, r / rows) for r in range(rows + 1) for c in range(cols + 1)]
    ob = mesh_object(name, base, _outward(base, _grid(cols, rows)), mat, uvs=uvs)
    for k in MOUTH_KEYS:
        shape_key(ob, k, positions(k))
    return ob


def _mouth_uv(uv):
    return uv[0], HEAD_C.z + MOUTH_Z + uv[1]


# the lower lip spans this much of the mouth (measured: ~0.68 of its width)
_LIP_A0, _LIP_A1 = 0.16, 0.84


def _lower_lip(key, a, depth):
    """Point on the lower lip at mouth column a, ``depth`` 0 (under the line)
    → 1 (its full, rounded bottom edge)."""
    hw, line, _top, bot = mouth_shape(key)
    edge = line(a) + bot(a)
    full = 0.0058 * _sinp((a - _LIP_A0) / (_LIP_A1 - _LIP_A0), 0.55)
    return lerp(-hw, hw, a), edge - 0.0001 - lerp(0.0003, 1.0, depth) * full


def build_lips(surf):
    """Her full lips (as drawn in the reference): a pink lower lip ~6 mm tall
    under the mouth line, a thinner upper lip over it with a soft cupid's
    bow, a gloss on the lower lip and the soft shadow it casts on the chin."""
    out = []

    def lower(key, s, b):
        return _lower_lip(key, lerp(_LIP_A0, _LIP_A1, s), b)

    out.append(_mouth_decal(surf, "Lips", material("Lips", srgb("#dc928e"), roughness=0.5), lower, 24, 4, 0.0005))

    def upper(key, s, b):
        hw, line, top, _bot = mouth_shape(key)
        a = lerp(0.09, 0.91, s)
        # fuller either side of the centre: the bow dips in the middle
        h = 0.0027 * _sinp((a - 0.09) / 0.82, 0.75) * (1.0 - 0.32 * math.exp(-(((a - 0.5) / 0.06) ** 2)))
        return lerp(-hw, hw, a), line(a) + top(a) + 0.00005 + h * b

    out.append(_mouth_decal(surf, "LipUpper", material("LipUpper", srgb("#cf8985"), roughness=0.5), upper, 28, 3, 0.00045))

    def gloss(key, s, b):
        a = lerp(0.40, 0.67, s)
        u, v_mid = _lower_lip(key, a, 0.42)
        half = 0.0008 * _sinp(s, 0.6)
        return u, v_mid + half * (2 * b - 1)

    out.append(_mouth_decal(surf, "LipLight", material("LipLight", srgb("#f6d2cb"), roughness=0.4), gloss, 12, 2, 0.00062))

    def shade(key, s, b):
        a = lerp(0.24, 0.76, s)
        u, v_lip = _lower_lip(key, a, 1.0)
        drop = 0.0046 * _sinp(s, 0.7)
        # b = 1 tucks under the lip's edge, b = 0 is the soft lower edge
        return u, v_lip + 0.0007 - (1.0 - b) * drop

    out.append(_mouth_decal(surf, "LipShade", material("LipShade", srgb("#c98d80"), roughness=0.6), shade, 16, 3, 0.0003))
    return out


# ── nose ────────────────────────────────────────────────────────────────


def build_nose(surf):
    """Anime noses read through shading, not geometry. As in the reference:
    a long soft shadow down the shaded side of the bridge (her right — the
    key light comes from her left), fading in under the brows and curling
    under the tip; the soft shade on the underside, two small nostrils, and a
    highlight on the tip. UVs carry the soft edges in the app (x along a
    stroke, y across it)."""
    nz = HEAD_C.z + NOSE_Z

    def ribbon(name, col, pts, widths, lift, samples=5):
        curve = catmull_rom([Vector((x, 0.0, z)) for x, z in pts], samples)
        wf = pchip([(i / (len(widths) - 1), w) for i, w in enumerate(widths)])
        rows = ([], [])
        n = len(curve)
        for i, p in enumerate(curve):
            t = curve[min(i + 1, n - 1)] - curve[max(i - 1, 0)]
            off = Vector((-t.z, 0.0, t.x)).normalized() * (wf(i / (n - 1)) * 0.5)
            rows[0].append(surf.at(p.x - off.x, nz + p.z - off.z, lift))
            rows[1].append(surf.at(p.x + off.x, nz + p.z + off.z, lift))
        verts = rows[0] + rows[1]
        faces = [(i, i + 1, i + n + 1, i + n) for i in range(n - 1)]
        uvs = [(i / (n - 1), r) for r in (0.0, 1.0) for i in range(n)]
        return mesh_object(name, verts, _outward(verts, faces), material(name, srgb(col), roughness=0.6), uvs=uvs)

    def blob(name, col, ellipses, lift, cols=8, rows=6):
        """Small soft ellipses (cx, cz, rx, rz, tilt) as UV grids in one mesh
        (the app feathers their edges)."""
        verts, faces, uvs = [], [], []
        for cx, cz, rx, rz, tilt in ellipses:
            ct, st = math.cos(tilt), math.sin(tilt)
            o = len(verts)
            for r in range(rows + 1):
                for c in range(cols + 1):
                    dx, dz = (2 * c / cols - 1) * rx, (2 * r / rows - 1) * rz
                    verts.append(surf.at(cx + dx * ct - dz * st, nz + cz + dx * st + dz * ct, lift))
                    uvs.append((c / cols, r / rows))
            faces += [tuple(i + o for i in q) for q in _grid(cols, rows)]
        return mesh_object(name, verts, _outward(verts, faces), material(name, srgb(col), roughness=0.6), uvs=uvs)

    # down the side of the bridge from under the brows, curling under the tip
    bridge = ribbon(
        "NoseShadow", "#cf9583",
        [(-0.0036, 0.0245), (-0.0041, 0.0170), (-0.0046, 0.0095), (-0.0048, 0.0035), (-0.0040, -0.0006),
         (-0.0022, -0.0026), (0.0004, -0.0031)],
        [0.0004, 0.0010, 0.0013, 0.0015, 0.0013, 0.0010, 0.0003],
        0.0005,
    )
    # the underside of the nose, from wing to wing
    under = blob("NoseUnder", "#d9a291", [(-0.0002, -0.0018, 0.0050, 0.0021, 0.0)], 0.0004)
    nostrils = blob("Nostril", "#b07a6a", [(-0.0034, -0.0004, 0.0011, 0.0005, 0.45), (0.0032, 0.0, 0.0011, 0.0005, -0.40)],
                    0.0006, 6, 4)
    light = blob("NoseLight", "#fff6ef", [(0.0011, 0.0026, 0.0011, 0.0016, -0.25)], 0.0006, 6, 6)
    return [bridge, under, nostrils, light]


# ── forehead seal ───────────────────────────────────────────────────────


def build_mark(surf):
    """The violet diamond seal centred on her forehead."""
    cz = HEAD_C.z + MARK_Z
    ring = [(0.0, 0.0062), (0.0038, 0.0), (0.0, -0.0062), (-0.0038, 0.0)]
    verts = [surf.at(0.0, cz, 0.0004)]
    for k in range(4):
        x0, z0 = ring[k]
        x1, z1 = ring[(k + 1) % 4]
        for t in (0.0, 0.5):
            verts.append(surf.at(lerp(x0, x1, t), cz + lerp(z0, z1, t), 0.0004))
    n = len(verts) - 1
    faces = [(0, 1 + (k + 1) % n, 1 + k) for k in range(n)]
    mat = material("Mark", srgb("#5f6cb4"), roughness=0.5)
    return mesh_object("Mark", verts, faces, mat)


def build_face(head_ob):
    surf = Surface(head_ob)
    out = []
    for side in (1, -1):
        out.append(build_eye(surf, side))
        out.extend(build_lid_lines(surf, side))
        out.append(build_brow(surf, side))
    out.append(build_mouth(surf))
    out.extend(build_lips(surf))
    out.extend(build_nose(surf))
    out.append(build_blush(surf))
    out.append(build_mark(surf))
    return [o.name for o in out]
