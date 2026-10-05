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
    the cap meets the skin. ``snap_edge`` moves the cut's boundary onto the
    hairline curve itself (otherwise it steps along the head mesh's rows)."""
    center = Vector(center)
    me = head_ob.data.copy()
    me.name = name
    ob = bpy.data.objects.new(name, me)
    head_ob.users_collection[0].objects.link(ob)
    if ob.data.shape_keys:
        ob.shape_key_clear()
    bm = bmesh.new()
    bm.from_mesh(me)
    kill = []
    for v in bm.verts:
        rel = v.co - center
        az = abs(math.degrees(math.atan2(rel.x, -rel.y)))
        if rel.z < hairline(az):
            kill.append(v)
    bmesh.ops.delete(bm, geom=kill, context="VERTS")
    if snap_edge:
        for v in [v for v in bm.verts if any(e.is_boundary for e in v.link_edges)]:
            rel = v.co - center
            v.co.z = center.z + hairline(abs(math.degrees(math.atan2(rel.x, -rel.y))))
    for v in bm.verts:
        rel = v.co - center
        az = abs(math.degrees(math.atan2(rel.x, -rel.y)))
        vol = volume(rel) * smoothstep(0.0, 0.022, rel.z - hairline(az))
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
