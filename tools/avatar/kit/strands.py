"""Anime hair building blocks: a shell over the skull, swept crescent clumps,
and a volume cap cut from the head mesh.

Each clump is a swept crescent cross-section that tapers to a point. UV.y runs
root (0) → tip (1) so the app's hair shader can grade colour along strands;
UV.x runs across the strand for the jagged "angel ring" highlight. Clumps are
grouped (``hair_<chain>`` vertex groups) so the rig binds them to the right
spring chain.
"""

import math

import bmesh
import bpy
from mathutils import Vector

from .common import bvh_of, catmull_rom, lerp, mesh_object, resample, smoothstep


class Shell:
    """Points at a given offset above the head surface, by direction."""

    def __init__(self, head_ob, center):
        self.bvh = bvh_of(head_ob)
        self.center = Vector(center)

    def radius(self, d):
        # cast from outside back toward the pivot — robust for a closed mesh
        d = d.normalized()
        hit, _n, _i, _dist = self.bvh.ray_cast(self.center + d * 0.5, -d)
        if hit is None:
            return 0.1
        return (hit - self.center).length

    @staticmethod
    def direction(az, el):
        a, e = math.radians(az), math.radians(el)
        return Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))

    def at(self, az, el, offset):
        """az: degrees around (0 = front, +90 = her left); el: degrees up."""
        d = self.direction(az, el)
        return self.center + d * (self.radius(d) + offset)

    def path(self, stops, per_seg=4):
        """Points that hug the shell between (az, el, offset) stops.

        Directions are slerped, so a path over the top of the skull follows
        the surface instead of cutting through the head like a straight
        spline between far-apart control points would."""
        out = []
        for i in range(len(stops) - 1):
            a0, e0, o0 = stops[i]
            a1, e1, o1 = stops[i + 1]
            d0, d1 = self.direction(a0, e0), self.direction(a1, e1)
            for k in range(per_seg):
                t = k / per_seg
                d = d0.slerp(d1, t) if d0.angle(d1) > 1e-4 else d0
                out.append(self.center + d * (self.radius(d) + lerp(o0, o1, t)))
        a, e, o = stops[-1]
        out.append(self.at(a, e, o))
        return out


def outward_from(head_center, body_y=0.03, near=0.03, far=0.12):
    """Outward direction for strand cross-sections: away from the skull up
    top, away from the body axis below the head."""
    hc = Vector(head_center)

    def f(p):
        c_body = Vector((0.0, body_y, p.z))
        k = smoothstep(hc.z - near, hc.z - far, p.z)  # 0 near head → 1 below
        v = p - hc.lerp(c_body, k)
        if v.length < 1e-6:
            v = Vector((0, 1, 0))
        return v.normalized()

    return f


def clump(ctrl, width, thick, outward, n_len=18, n_sec=10, crescent=0.35, edge=0.75):
    """Sweep a tapered crescent along a Catmull-Rom path.

    width/thick: callables over t in [0, 1] (half-width, outer half-thickness).
    Returns (verts, faces, uvs) with a single tip vertex.
    """
    path = resample(catmull_rom([Vector(p) for p in ctrl], 12), n_len + 1)
    verts, faces, uvs = [], [], []
    for i in range(n_len):
        t = i / n_len
        p = path[i]
        tan = (path[min(i + 1, n_len)] - path[max(i - 1, 0)]).normalized()
        out = outward(p)
        out = (out - tan * out.dot(tan)).normalized()
        side = tan.cross(out).normalized()
        w, h = width(t), thick(t)
        for k in range(n_sec):
            ph = 2 * math.pi * k / n_sec
            c, s = math.cos(ph), math.sin(ph)
            x = w * math.copysign(abs(c) ** edge, c)
            y = h * s if s > 0 else h * crescent * s
            verts.append(p + side * x + out * y)
            uvs.append((k / n_sec, t))
    tip = len(verts)
    verts.append(path[-1])
    uvs.append((0.5, 1.0))
    for i in range(n_len - 1):
        for k in range(n_sec):
            a = i * n_sec + k
            b = i * n_sec + (k + 1) % n_sec
            faces.append((a, b, b + n_sec, a + n_sec))
    last = (n_len - 1) * n_sec
    for k in range(n_sec):
        faces.append((last + k, last + (k + 1) % n_sec, tip))
    # root cap (buried in the hair cap, closes the tube for clean outlines)
    faces.append(tuple(reversed(range(n_sec))))
    return verts, faces, uvs


class HairBuilder:
    def __init__(self):
        self.verts, self.faces, self.uvs, self.groups = [], [], [], []

    def add(self, data, group):
        """``group`` is a spring-chain name (``hair_*``) or ``head``."""
        v, f, uv = data
        o = len(self.verts)
        self.verts += v
        self.faces += [tuple(i + o for i in face) for face in f]
        self.uvs += uv
        self.groups += [group] * len(v)

    def build(self, name, mat):
        ob = mesh_object(name, self.verts, self.faces, mat)
        uvl = ob.data.uv_layers.new(name="UVMap")
        # per-loop UVs because tip/root fans share vertices
        for loop in ob.data.loops:
            uvl.data[loop.index].uv = self.uvs[loop.vertex_index]
        for g in sorted(set(self.groups)):
            vg = ob.vertex_groups.new(name="hair_head" if g == "head" else g)
            idx = [i for i, gg in enumerate(self.groups) if gg == g]
            vg.add(idx, 1.0, "REPLACE")
        return ob


def taper(w0, w_mid, peak=0.35, tip_pow=1.0):
    """Width profile: swells from the root to ``peak`` then narrows to a point."""

    def f(t):
        if t < peak:
            return lerp(w0, w_mid, smoothstep(0.0, peak, t))
        return w_mid * (1.0 - ((t - peak) / (1.0 - peak))) ** tip_pow

    return f


def build_cap(head_ob, mat, center, hairline, volume, name="HairCap", snap_edge=False):
    """Hair volume over the skull: the head mesh above ``hairline(az)``,
    pushed out by ``volume(rel)`` and tapered to nothing at the hairline so
    the cap meets the skin. ``snap_edge`` cuts the mesh exactly along the
    hairline curve (otherwise the edge steps along the head mesh's rows)."""
    center = Vector(center)
    me = head_ob.data.copy()
    me.name = name
    ob = bpy.data.objects.new(name, me)
    head_ob.users_collection[0].objects.link(ob)
    if ob.data.shape_keys:
        ob.shape_key_clear()
    bm = bmesh.new()
    bm.from_mesh(me)

    def above(co):
        rel = co - center
        return rel.z - hairline(abs(math.degrees(math.atan2(rel.x, -rel.y))))

    if snap_edge:
        # a level-set cut: every edge the hairline crosses is split where it
        # crosses, each face is split between its two new vertices, and what
        # lies below goes — the edge runs along the curve itself, however
        # steeply it climbs (snapping the vertices of a row/column staircase
        # onto a steep stretch, behind an ear, folded the faces into teeth)
        f = {v: above(v.co) for v in bm.verts}
        on = set()
        for e in list(bm.edges):
            a, b = e.verts
            fa, fb = f[a], f[b]
            if (fa < 0) == (fb < 0) or abs(fa - fb) < 1e-12:
                continue
            t = fa / (fa - fb)
            if t <= 1e-4 or t >= 1 - 1e-4:
                continue
            pa, pb = a.co.copy(), b.co.copy()
            _e, nv = bmesh.utils.edge_split(e, a, t)
            nv.co = pa.lerp(pb, t)
            # (pulled onto the curve exactly, at its own height)
            rel = nv.co - center
            nv.co.z = center.z + hairline(abs(math.degrees(math.atan2(rel.x, -rel.y))))
            f[nv] = 0.0
            on.add(nv)
        for face in list(bm.faces):
            vs = [v for v in face.verts if v in on]
            if len(vs) != 2:
                continue
            v1, v2 = vs
            if any(v2 in (e.other_vert(v1),) for e in v1.link_edges):
                continue
            try:
                bmesh.utils.face_split(face, v1, v2)
            except ValueError:
                pass
        kill = [v for v in bm.verts if f.get(v, 0.0) < -1e-9]
    else:
        kill = [v for v in bm.verts if above(v.co) < 0]
    bmesh.ops.delete(bm, geom=kill, context="VERTS")

    def edge_distance(rel):
        """how far a cap point lies above the hairline, measured round the
        head and up (a plain height difference overstates it wherever the
        hairline runs steeply — the volume would jump up beside the edge)"""
        r = math.hypot(rel.x, rel.y)
        az0 = abs(math.degrees(math.atan2(rel.x, -rel.y)))
        best = rel.z - hairline(az0)
        if not snap_edge:
            return best
        for k in range(-48, 49, 2):
            az = min(180.0, max(0.0, az0 + k * 0.25))
            dz = rel.z - hairline(az)
            d = math.hypot(math.radians(az - az0) * r, dz)
            if d < abs(best):
                best = d if dz >= 0 else -d
        return best

    for v in bm.verts:
        rel = v.co - center
        vol = volume(rel) * smoothstep(0.0, 0.022, edge_distance(rel))
        v.co = v.co + rel.normalized() * (vol + 0.0006)
    bm.to_mesh(me)
    bm.free()
    me.materials.clear()
    me.materials.append(mat)
    uvl = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        uvl.data[loop.index].uv = (0.5, 0.0)
    vg = ob.vertex_groups.new(name="hair_head")
    vg.add(list(range(len(me.vertices))), 1.0, "REPLACE")
    return ob
