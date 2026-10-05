"""Lofting primitives shared by every character's body and clothes."""

import math

from mathutils import Vector

from .common import frames_along, mesh_object


def superellipse_ring(center, ax, ay, rx, ry, n=2.0, segs=32, start=0.0):
    pts = []
    for k in range(segs):
        t = start + 2 * math.pi * k / segs
        c, s = math.cos(t), math.sin(t)
        x = rx * math.copysign(abs(c) ** (2.0 / n), c)
        y = ry * math.copysign(abs(s) ** (2.0 / n), s)
        pts.append(center + ax * x + ay * y)
    return pts


def loft(rings, cap_start=True, cap_end=True, v_coords=None):
    """Quad-strip a list of equal-length closed rings; optional fan caps.

    Returns verts, faces, uvs (u around, v along)."""
    segs = len(rings[0])
    verts, faces, uvs = [], [], []
    nr = len(rings)
    for i, ring in enumerate(rings):
        v = v_coords[i] if v_coords else i / (nr - 1)
        for k, p in enumerate(ring):
            verts.append(p)
            uvs.append((k / segs, v))
    for i in range(nr - 1):
        for k in range(segs):
            a = i * segs + k
            b = i * segs + (k + 1) % segs
            faces.append((a, b, b + segs, a + segs))
    if cap_start:
        c = sum(rings[0], Vector()) / segs
        ci = len(verts)
        verts.append(c)
        uvs.append((0.5, 0.0))
        for k in range(segs):
            faces.append((ci, (k + 1) % segs, k))
    if cap_end:
        c = sum(rings[-1], Vector()) / segs
        ci = len(verts)
        verts.append(c)
        uvs.append((0.5, 1.0))
        o = (nr - 1) * segs
        for k in range(segs):
            faces.append((ci, o + k, o + (k + 1) % segs))
    return verts, faces, uvs


def open_loft(rows, close_ends=False):
    """Quad-strip rows of points that do NOT wrap around (an open sheet, e.g.
    a coat panel or a front-opening garment). Returns verts, faces, uvs."""
    cols = len(rows[0])
    verts, faces, uvs = [], [], []
    nr = len(rows)
    for i, row in enumerate(rows):
        for k, p in enumerate(row):
            verts.append(p)
            uvs.append((k / (cols - 1), i / (nr - 1)))
    for i in range(nr - 1):
        for k in range(cols - 1):
            a = i * cols + k
            faces.append((a, a + 1, a + cols + 1, a + cols))
    return verts, faces, uvs


def tube(path, radius_x, radius_y, up_hint, segs=20, n=2.0, cap_start=True, cap_end=True, tip=None):
    """Loft round/elliptical sections along ``path``.

    radius_x/radius_y: callables over t in [0, 1]. ``up_hint`` orients the
    first frame (ry runs along it). ``tip`` adds a rounded end point."""
    frames = frames_along(path, up_hint)
    rings = []
    n_pts = len(path)
    for i, (p, (tan, nrm, bin_)) in enumerate(zip(path, frames)):
        t = i / (n_pts - 1)
        # ring runs nrm → bin, which winds counter-clockwise about the
        # tangent so the quads face outward (bin follows the up hint)
        rings.append(superellipse_ring(p, nrm, bin_, radius_x(t), radius_y(t), n, segs))
    verts, faces, uvs = loft(rings, cap_start=cap_start, cap_end=cap_end and tip is None)
    if tip is not None:
        ci = len(verts)
        verts.append(tip)
        uvs.append((0.5, 1.0))
        o = (n_pts - 1) * segs
        for k in range(segs):
            faces.append((ci, o + k, o + (k + 1) % segs))
    return verts, faces, uvs


class MeshBuilder:
    """Accumulates pieces into one mesh. Pieces can carry a ``tag`` that is
    stored as a ``piece_<tag>`` vertex group, which the rig step uses to pick
    the bones each piece may be weighted to."""

    def __init__(self):
        self.verts, self.faces, self.uvs, self.tags = [], [], [], []

    def add(self, data, tag=None):
        v, f, uv = data
        o = len(self.verts)
        self.verts += list(v)
        self.faces += [tuple(i + o for i in face) for face in f]
        self.uvs += list(uv)
        self.tags += [tag] * len(v)

    def build(self, name, mat):
        ob = mesh_object(name, self.verts, self.faces, mat)
        uvl = ob.data.uv_layers.new(name="UVMap")
        for loop in ob.data.loops:
            uvl.data[loop.index].uv = self.uvs[loop.vertex_index]
        for tag in sorted({t for t in self.tags if t}):
            vg = ob.vertex_groups.new(name="piece_" + tag)
            vg.add([i for i, t in enumerate(self.tags) if t == tag], 1.0, "REPLACE")
        return ob


def polyline(points, per_seg=6):
    out = []
    for i in range(len(points) - 1):
        for k in range(per_seg):
            out.append(points[i].lerp(points[i + 1], k / per_seg))
    out.append(points[-1].copy())
    return out


def flat_strip(path, width, thick, up_fn):
    """A flat ribbon/band along ``path``; width/thick are callables over t."""
    verts, faces, uvs = [], [], []
    n = len(path)
    for i, p in enumerate(path):
        t = i / (n - 1)
        tan = (path[min(i + 1, n - 1)] - path[max(i - 1, 0)]).normalized()
        out = up_fn(p)
        out = (out - tan * out.dot(tan)).normalized()
        side = tan.cross(out).normalized()
        w, h = width(t), thick(t)
        for k, (sx, sy) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
            verts.append(p + side * (w * sx) + out * (h * sy))
            uvs.append((k / 4, t))
    for i in range(n - 1):
        for k in range(4):
            a = i * 4 + k
            b = i * 4 + (k + 1) % 4
            faces.append((a, b, b + 4, a + 4))
    faces.append((3, 2, 1, 0))
    o = (n - 1) * 4
    faces.append((o, o + 1, o + 2, o + 3))
    return verts, faces, uvs
