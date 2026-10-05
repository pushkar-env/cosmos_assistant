"""Shared helpers for the Nova avatar generator (runs inside Blender).

Conventions
-----------
* Blender units are metres, Z is up and the character faces -Y, so her LEFT
  side is +X (Blender's ".L" convention). The glTF exporter converts this to
  three.js' Y-up / +Z-forward space.
* Everything is generated from code, so the .glb can be rebuilt from scratch
  with ``tools/avatar/build.py`` — nothing is hand-edited in the .blend.
"""

import math

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

COLL = "Avatar"


# ── maths ────────────────────────────────────────────────────────────────


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0)) if e1 != e0 else (1.0 if x >= e1 else 0.0)
    return t * t * (3 - 2 * t)


def pchip(table):
    """Monotone cubic (Fritsch–Carlson) interpolator over ``[(x, y), ...]``.

    Smooth like a spline but never overshoots, so profile tables can't grow
    bumps between their control points. Returns ``f(x)``; clamps outside.
    """
    xs = [p[0] for p in table]
    ys = [p[1] for p in table]
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0.0
        else:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])

    def f(x):
        if x <= xs[0]:
            return ys[0]
        if x >= xs[-1]:
            return ys[-1]
        lo, hi = 0, n - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if xs[mid] <= x:
                lo = mid
            else:
                hi = mid
        t = (x - xs[lo]) / h[lo]
        t2, t3 = t * t, t * t * t
        return (
            (2 * t3 - 3 * t2 + 1) * ys[lo]
            + (t3 - 2 * t2 + t) * h[lo] * m[lo]
            + (-2 * t3 + 3 * t2) * ys[lo + 1]
            + (t3 - t2) * h[lo] * m[lo + 1]
        )

    return f


def catmull_rom(points, samples_per_seg=8, closed=False):
    """Sample a Catmull–Rom spline through ``points`` (Vectors)."""
    pts = list(points)
    if closed:
        ext = [pts[-1]] + pts + [pts[0], pts[1]]
    else:
        ext = [pts[0] + (pts[0] - pts[1])] + pts + [pts[-1] + (pts[-1] - pts[-2])]
    out = []
    segs = len(pts) if closed else len(pts) - 1
    for i in range(segs):
        p0, p1, p2, p3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
        for s in range(samples_per_seg):
            t = s / samples_per_seg
            t2, t3 = t * t, t * t * t
            out.append(
                0.5
                * (
                    (2 * p1)
                    + (-p0 + p2) * t
                    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
                )
            )
    if not closed:
        out.append(pts[-1].copy())
    return out


def resample(poly, n):
    """Resample a polyline to ``n`` points evenly spaced by arc length."""
    lens = [0.0]
    for i in range(1, len(poly)):
        lens.append(lens[-1] + (poly[i] - poly[i - 1]).length)
    total = lens[-1]
    out = []
    j = 0
    for k in range(n):
        target = total * k / (n - 1)
        while j < len(lens) - 2 and lens[j + 1] < target:
            j += 1
        seg = lens[j + 1] - lens[j]
        t = 0.0 if seg == 0 else (target - lens[j]) / seg
        out.append(poly[j].lerp(poly[j + 1], t))
    return out


def frames_along(poly, up_hint=Vector((0, 0, 1))):
    """Parallel-transport frames (tangent, normal, binormal) along a polyline."""
    n = len(poly)
    tans = []
    for i in range(n):
        a = poly[max(i - 1, 0)]
        b = poly[min(i + 1, n - 1)]
        tans.append((b - a).normalized())
    normal = up_hint.cross(tans[0])
    if normal.length < 1e-6:
        normal = Vector((1, 0, 0)).cross(tans[0])
    normal.normalize()
    frames = []
    for i in range(n):
        if i > 0:
            axis = tans[i - 1].cross(tans[i])
            if axis.length > 1e-8:
                ang = tans[i - 1].angle(tans[i])
                normal = Matrix.Rotation(ang, 3, axis.normalized()) @ normal
        binormal = tans[i].cross(normal).normalized()
        normal = binormal.cross(tans[i]).normalized()
        frames.append((tans[i].copy(), normal.copy(), binormal.copy()))
    return frames


# ── scene ────────────────────────────────────────────────────────────────


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.armatures,
        bpy.data.actions,
        bpy.data.curves,
        bpy.data.images,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.node_groups,
    ):
        for d in list(coll):
            coll.remove(d)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)


def collection(name=COLL):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


def link(ob, coll_name=COLL):
    collection(coll_name).objects.link(ob)
    return ob


def mesh_object(name, verts, faces, mat=None, smooth=True, uvs=None, coll_name=COLL):
    """Create a mesh object from python lists. ``uvs`` is per-loop or per-vertex."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.validate(clean_customdata=False)
    if uvs is not None:
        uvl = me.uv_layers.new(name="UVMap")
        if len(uvs) == len(verts):
            for loop in me.loops:
                uvl.data[loop.index].uv = uvs[loop.vertex_index]
        else:
            for i, uv in enumerate(uvs):
                uvl.data[i].uv = uv
    me.polygons.foreach_set("use_smooth", [smooth] * len(me.polygons))
    me.update()
    ob = bpy.data.objects.new(name, me)
    link(ob, coll_name)
    if mat is not None:
        me.materials.append(mat)
    return ob


def grid_faces(cols, rows, offset=0, wrap_cols=False):
    """Quad indices for a (cols+1) x (rows+1) vertex grid stored row-major."""
    faces = []
    w = cols if wrap_cols else cols + 1
    for r in range(rows):
        for c in range(cols):
            a = offset + r * w + c
            b = offset + r * w + ((c + 1) % w if wrap_cols else c + 1)
            cc = offset + (r + 1) * w + ((c + 1) % w if wrap_cols else c + 1)
            d = offset + (r + 1) * w + c
            faces.append((a, b, cc, d))
    return faces


def bvh_of(ob):
    """BVH of an object's evaluated mesh in world space."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    mw = ob.matrix_world
    verts = [mw @ v.co for v in me.vertices]
    polys = [tuple(p.vertices) for p in me.polygons]
    ev.to_mesh_clear()
    return BVHTree.FromPolygons(verts, polys)


def shape_key(ob, name, positions):
    """Add a shape key holding absolute vertex ``positions``."""
    if ob.data.shape_keys is None:
        ob.shape_key_add(name="Basis", from_mix=False)
    kb = ob.shape_key_add(name=name, from_mix=False)
    for i, p in enumerate(positions):
        kb.data[i].co = p
    kb.value = 0.0  # Blender 5 creates new keys at full strength
    return kb


# ── materials ────────────────────────────────────────────────────────────


def material(name, color, roughness=0.6, emission=None, emission_strength=0.0, alpha=1.0, metallic=0.0):
    """Principled material. The app re-shades everything with its own toon
    shaders (keyed by material NAME), so this only needs to carry the base
    colour + a sensible Blender preview look."""
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (*color[:3], 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission[:3], 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
    mat.diffuse_color = (*color[:3], 1.0)
    return mat


def srgb(hexstr):
    """'#rrggbb' → linear RGB tuple (Blender colour inputs are linear)."""
    h = hexstr.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i : i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def set_parent_keep(child, parent):
    mw = child.matrix_world.copy()
    child.parent = parent
    child.matrix_world = mw


def apply_modifiers(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)
    return ob


def bm_from(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    return bm
