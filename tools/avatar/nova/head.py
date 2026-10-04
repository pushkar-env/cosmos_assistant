"""Head base mesh — an anime-proportioned skull built by deforming a sphere.

The face is deliberately simple geometry (tiny nose, no ears — the headset
covers them): in anime rendering the *features* (eyes, lashes, brows, mouth,
blush) are separate thin meshes laid onto this surface, and the app's toon
shader bends the face normals toward a sphere so the shading stays clean.
"""

import math

from mathutils import Vector

from .common import lerp, material, mesh_object, pchip, smoothstep, srgb

# head pivot (roughly the centre of the cranium), world space
HEAD_C = Vector((0.0, 0.0, 1.40))

# head-local landmark heights (metres relative to HEAD_C)
TOP_Z = 0.118
CHIN_Z = -0.124
EYE_Z = -0.026
EYE_X = 0.0395
NOSE_Z = -0.056
MOUTH_Z = -0.087

SKIN = "#fde7dc"


HALF_W = 0.091  # cranium half-width
FRONT = 0.0905  # forehead depth in front of the pivot
BACK = 0.1035  # skull depth behind the pivot

# lower-face profiles over head-local Z (front view half-width, side-view
# front/back extents). The back extent swings forward under the jaw so the
# underside rises from the chin to the nape instead of sagging.
_W = pchip(
    [(-0.124, 0.0), (-0.1215, 0.014), (-0.116, 0.027), (-0.107, 0.043), (-0.095, 0.060),
     (-0.080, 0.074), (-0.065, 0.083), (-0.050, 0.088), (-0.030, 0.0905), (0.0, HALF_W)]
)
_F = pchip(
    [(-0.124, 0.064), (-0.115, 0.0745), (-0.100, 0.0805), (-0.080, 0.0855),
     (-0.060, 0.0885), (-0.030, 0.0898), (0.0, FRONT)]
)
_B = pchip(
    [(-0.124, -0.060), (-0.1215, -0.036), (-0.117, -0.008), (-0.110, 0.020), (-0.100, 0.042),
     (-0.085, 0.064), (-0.070, 0.080), (-0.050, 0.092), (-0.025, 0.100), (0.0, BACK)]
)


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
        n_front = lerp(2.35, 2.0, smoothstep(0.0, 0.6, z))
    else:
        Z = z * (-CHIN_Z)
        W, F, B = _W(Z), _F(Z), _B(Z)
        n_front = 2.35
    yc = (B - F) * 0.5
    d = (F + B) * 0.5
    s, c = math.sin(th), math.cos(th)
    # flatter, fuller cheeks in front; plain ellipse round the back
    n = n_front if c > 0 else 2.0
    p = Vector((W * _superellipse(s, n), yc - d * _superellipse(c, n), Z))

    X, Z = p.x, p.z
    if p.y < 0:
        front = smoothstep(0.0, -0.05, p.y)
        # tiny pointed nose: soft on top, crisp underneath
        dz = Z - NOSE_Z
        sz = 0.010 if dz > 0 else 0.004
        p.y -= 0.0036 * math.exp(-((X / 0.0045) ** 2) - (dz / sz) ** 2) * front
        # a hint of baby fat under the eyes
        for sx in (-1, 1):
            g = math.exp(-(((X - sx * 0.05) / 0.022) ** 2) - ((Z + 0.062) / 0.02) ** 2)
            p.y -= 0.0018 * g * front
    return p


def build_head(rings=72, segs=80):
    verts = []
    faces = []
    # top pole
    verts.append(HEAD_C + head_point(0, 0, 1))
    for i in range(1, rings):
        phi = math.pi * i / rings
        for j in range(segs):
            th = 2 * math.pi * j / segs
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
