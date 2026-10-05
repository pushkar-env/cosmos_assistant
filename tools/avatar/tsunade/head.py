"""Head base mesh — a mature anime woman's skull (longer, slimmer jaw, small
defined nose) built from front/side profile tables. Features (eyes, lashes,
brows, lips, the forehead mark) are thin meshes laid onto this surface; the
long face-framing locks cover the ears.
"""

import math

from mathutils import Vector

from kit.common import lerp, material, mesh_object, pchip, smoothstep, srgb

# head pivot (roughly the centre of the cranium), world space
HEAD_C = Vector((0.0, 0.0, 1.535))

# head-local landmark heights (metres relative to HEAD_C)
TOP_Z = 0.112
CHIN_Z = -0.118  # a short, softly pointed chin under a small mouth
EYE_Z = -0.019
EYE_X = 0.0355
NOSE_Z = -0.058
MOUTH_Z = -0.0785  # close under the nose, as in the reference
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
_B = pchip(
    [(-0.128, -0.064), (-0.1255, -0.040), (-0.121, -0.012), (-0.113, 0.016), (-0.102, 0.038),
     (-0.087, 0.058), (-0.070, 0.074), (-0.048, 0.087), (-0.022, 0.096), (0.0, BACK)]
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
        # tiny pointed nose: soft on top, crisp underneath
        dz = Z - NOSE_Z
        sz = 0.014 if dz > 0 else 0.0042
        p.y -= 0.0060 * math.exp(-((X / 0.0047) ** 2) - (dz / sz) ** 2) * front
        # gentle cheekbones
        for sx in (-1, 1):
            g = math.exp(-(((X - sx * 0.052) / 0.02) ** 2) - ((Z + 0.045) / 0.018) ** 2)
            p.y -= 0.0012 * g * front
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
