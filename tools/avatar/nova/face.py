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

Shape-key contract (read by src/renderer/src/features/avatar):
  eyes + lashes : E_Blink_L/R E_Happy_L/R E_Wide_L/R E_Relax_L/R E_Sad_L/R E_Angry_L/R
  brows         : B_Up_L/R B_Angry_L/R B_Sad_L/R
  mouth (+head) : V_A V_I V_U V_E V_O M_Smile M_Frown M_Joy M_Grin M_Pout M_Small
"""

import math

from mathutils import Vector

from .common import (
    bvh_of,
    lerp,
    material,
    mesh_object,
    pchip,
    shape_key,
    smoothstep,
    srgb,
)
from .head import EYE_X, EYE_Z, HEAD_C, MOUTH_Z

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


# ── eyes ────────────────────────────────────────────────────────────────

U_IN, U_OUT = -0.0195, 0.0215  # eye-local horizontal extent (outward +)

_top = pchip(
    [(0.0, -0.0010), (0.07, 0.0085), (0.18, 0.0158), (0.36, 0.0199), (0.55, 0.0207),
     (0.74, 0.0184), (0.88, 0.0130), (1.0, 0.0042)]
)
_bot = pchip(
    [(0.0, -0.0010), (0.10, -0.0074), (0.28, -0.0124), (0.48, -0.0141), (0.68, -0.0132),
     (0.86, -0.0088), (1.0, 0.0042)]
)


def _closed(a):
    # a relaxed downward arc — the classic anime closed eye
    return lerp(-0.0010, 0.0042, a) - 0.0072 * _sinp(a, 0.85)


def _happy(a):
    # ^ ^ — an upward arc, sitting a little low
    return lerp(-0.0045, -0.0005, a) + 0.0072 * _sinp(a, 0.8) - 0.001


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
        return t + 0.0028 * _sinp(a, 0.5), b - 0.0013 * _sinp(a)
    if key == "E_Relax":
        return t - 0.40 * (t - b), b + 0.10 * (t - b)
    if key == "E_Sad":
        return t - (t - b) * (0.08 + 0.30 * a ** 1.3), b + 0.04 * (t - b)
    if key == "E_Angry":
        return t - (t - b) * (0.08 + 0.36 * (1 - a) ** 1.2), b + 0.12 * (t - b)
    return t, b


EYE_KEYS = ["E_Blink", "E_Happy", "E_Wide", "E_Relax", "E_Sad", "E_Angry"]

IRIS_RX, IRIS_RZ = 0.0128, 0.0170


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
    for pos, col in ((0.30, (0.01, 0.04, 0.08, 1)), (0.36, (0.02, 0.35, 0.45, 1)), (0.80, (0.05, 0.6, 0.7, 1)),
                     (0.93, (0.01, 0.08, 0.14, 1)), (0.985, (0.01, 0.08, 0.14, 1))):
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
    _preview_iris(mat, *_eye_xz(side, 0.0008, 0.0012))
    ob = mesh_object(f"Eye_{suffix}", positions(None), faces, mat, uvs=uvs)
    for k in EYE_KEYS:
        shape_key(ob, f"{k}_{suffix}", positions(k))
    return ob


# ── lashes / eyelid crease ──────────────────────────────────────────────

# upper lash thickness along the lid (thin at the tear duct, bold outside)
_lash_th = pchip([(-0.04, 0.0008), (0.0, 0.0015), (0.3, 0.0029), (0.7, 0.0042), (1.0, 0.0052)])


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


def _upper_lash_columns(key, n=26):
    cols = []
    for k in range(n + 1):
        a = lerp(-0.035, 1.0, k / n)
        top, _ = eye_lids(key, max(a, 0.0))
        if a < 0:
            top += a * 0.05  # tuck the inner end down toward the tear duct
        u = lerp(U_IN, U_OUT, a)
        th = _lash_th(a)
        if key in ("E_Blink", "E_Happy"):
            th *= 0.72
        base = top - 0.00055
        cols.append([(u, base), (u, base + th * 0.55), (u, base + th)])
    # the outer wing: a little flick past the outer corner
    top1, _ = eye_lids(key, 1.0)
    th1 = _lash_th(1.0) * (0.72 if key in ("E_Blink", "E_Happy") else 1.0)
    for du, dv, f in ((0.0034, 0.0014, 0.78), (0.0064, 0.0034, 0.45), (0.0090, 0.0058, 0.0)):
        base = top1 - 0.00055 + dv
        cols.append([(U_OUT + du, base), (U_OUT + du, base + th1 * 0.55 * f + 0.0001), (U_OUT + du, base + th1 * f + 0.0002)])
    return cols


def _lower_lash_columns(key, n=12):
    cols = []
    for k in range(n + 1):
        a = lerp(0.42, 1.0, k / n)
        _, bot = eye_lids(key, a)
        th = 0.00085 * smoothstep(0.42, 0.7, a) + 0.0001
        u = lerp(U_IN, U_OUT, a)
        cols.append([(u, bot - th), (u, bot + 0.0003)])
    return cols


def _crease_columns(key, n=14):
    cols = []
    for k in range(n + 1):
        a = lerp(0.22, 0.95, k / n)
        top, bot = eye_lids(key, a)
        rest_top, _ = eye_lids(None, a)
        # the crease rides above the lid but flattens as the lid closes
        gap = 0.0042 * (0.35 + 0.65 * max(0.0, (top - bot)) / max(1e-6, rest_top - _bot(a)))
        th = 0.00055 * _sinp((a - 0.22) / 0.73, 0.6)
        u = lerp(U_IN, U_OUT, a)
        cols.append([(u, top + gap), (u, top + gap + th + 0.00005)])
    return cols


def build_lid_lines(surf, side):
    suffix = "L" if side > 0 else "R"
    out = []
    specs = (
        ("Lash", _upper_lash_columns, 0.0009, "#2b1b24"),
        ("LashLower", _lower_lash_columns, 0.0008, "#6b3d45"),
        ("Crease", _crease_columns, 0.0006, "#c98f86"),
    )
    for name, fn, lift, col in specs:
        verts, faces = _band(surf, side, fn(None), lift, False)
        mat = material(f"{name}", srgb(col), roughness=0.8)
        ob = mesh_object(f"{name}_{suffix}", verts, faces, mat)
        for k in EYE_KEYS:
            kv, _ = _band(surf, side, fn(k), lift, False)
            shape_key(ob, f"{k}_{suffix}", kv)
        out.append(ob)
    return out


# ── brows ───────────────────────────────────────────────────────────────

_BROW = [(-0.0175, 0.0335), (-0.009, 0.0382), (0.003, 0.0402), (0.015, 0.0392), (0.0265, 0.0345)]
_BROW_TH = [0.0033, 0.0031, 0.0025, 0.0016, 0.0003]
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
        from .common import catmull_rom

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
    mat = material("Brow", srgb("#5a3b52"), roughness=0.8)
    ob = mesh_object(f"Brow_{suffix}", verts, faces, mat)
    for k in BROW_KEYS:
        kv, _ = verts_for(k)
        shape_key(ob, f"{k}_{suffix}", kv)
    return ob


# ── mouth ───────────────────────────────────────────────────────────────

MOUTH_KEYS = ["V_A", "V_I", "V_U", "V_E", "V_O", "M_Smile", "M_Frown", "M_Joy", "M_Grin", "M_Pout", "M_Small"]


def mouth_shape(key):
    """(half_width, centre-line(a), top(a), bottom(a)) — offsets from the line."""
    hw = 0.0095
    line = lambda a: 0.0010 * (2 * a - 1) ** 2  # noqa: E731 — a soft resting smile
    top = lambda a: 0.00042 * _sinp(a, 0.5)  # noqa: E731
    bot = lambda a: -0.00042 * _sinp(a, 0.5)  # noqa: E731
    if key == "V_A":
        hw = 0.0118
        top = lambda a: 0.0016 * _sinp(a, 0.45)  # noqa: E731
        bot = lambda a: -0.0125 * _sinp(a, 0.75)  # noqa: E731
    elif key == "V_I":
        hw = 0.0150
        line = lambda a: 0.0020 * (2 * a - 1) ** 2  # noqa: E731
        top = lambda a: 0.0014 * _sinp(a, 0.35)  # noqa: E731
        bot = lambda a: -0.0030 * _sinp(a, 0.45)  # noqa: E731
    elif key == "V_U":
        hw = 0.0058
        line = lambda a: 0.0  # noqa: E731
        top = lambda a: 0.0030 * _sinp(a, 0.75)  # noqa: E731
        bot = lambda a: -0.0036 * _sinp(a, 0.75)  # noqa: E731
    elif key == "V_E":
        hw = 0.0128
        top = lambda a: 0.0018 * _sinp(a, 0.45)  # noqa: E731
        bot = lambda a: -0.0068 * _sinp(a, 0.65)  # noqa: E731
    elif key == "V_O":
        hw = 0.0082
        line = lambda a: 0.0  # noqa: E731
        top = lambda a: 0.0042 * _sinp(a, 0.65)  # noqa: E731
        bot = lambda a: -0.0080 * _sinp(a, 0.7)  # noqa: E731
    elif key == "M_Smile":
        hw = 0.0128
        line = lambda a: 0.0046 * (2 * a - 1) ** 2 - 0.0008  # noqa: E731
    elif key == "M_Frown":
        hw = 0.0090
        line = lambda a: -0.0030 * (2 * a - 1) ** 2  # noqa: E731
    elif key == "M_Joy":
        # open "D" laugh: flat-topped smile line, deep round bottom
        hw = 0.0135
        line = lambda a: 0.0040 * (2 * a - 1) ** 2 - 0.0006  # noqa: E731
        top = lambda a: 0.0006 * _sinp(a, 0.4)  # noqa: E731
        bot = lambda a: -0.0118 * _sinp(a, 0.8)  # noqa: E731
    elif key == "M_Grin":
        hw = 0.0145
        line = lambda a: 0.0042 * (2 * a - 1) ** 2 - 0.0006  # noqa: E731
        top = lambda a: 0.0012 * _sinp(a, 0.35)  # noqa: E731
        bot = lambda a: -0.0040 * _sinp(a, 0.5)  # noqa: E731
    elif key == "M_Pout":
        hw = 0.0060
        line = lambda a: -0.0004  # noqa: E731
        top = lambda a: 0.0006 * _sinp(a, 0.6)  # noqa: E731
        bot = lambda a: -0.0006 * _sinp(a, 0.6)  # noqa: E731
    elif key == "M_Small":
        # the little surprised "o"
        hw = 0.0042
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
        cx, cz = side * 0.0545, HEAD_C.z - 0.054
        verts.append(surf.at(cx, cz, 0.00025))
        uvs.append((0.5, 0.5))
        for r in range(1, rings + 1):
            f = r / rings
            for s in range(segs):
                t = 2 * math.pi * s / segs
                x = cx + math.cos(t) * 0.0175 * f
                z = cz + math.sin(t) * 0.0088 * f
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


def build_face(head_ob):
    surf = Surface(head_ob)
    out = []
    for side in (1, -1):
        out.append(build_eye(surf, side))
        out.extend(build_lid_lines(surf, side))
        out.append(build_brow(surf, side))
    out.append(build_mouth(surf))
    out.append(build_blush(surf))
    return [o.name for o in out]
