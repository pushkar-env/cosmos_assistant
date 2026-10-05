"""Character spec for the shared avatar kit (built from a user reference).

Skeleton, spring chains (pigtails, front locks, the haori's skirt), how each
mesh is weighted, reach targets for the shared clip set (her resting stance
is a hand on the hip), and which meshes merge for the app.
"""

import math

from mathutils import Vector

from kit.common import smoothstep
from kit.rig import side_sets

from . import body, clothes, face, hair, head
from .body import JOINTS, KNUCKLE, arm_dir, finger_chain, palm_frame  # noqa: F401 — part of the spec

NAME = "Tsunade"
GLB = "tsunade.glb"
ARM_REST = 37
BASE_STYLE = "hip"

POINTS = {
    "hands_behind": Vector((0.050, 0.150, 1.030)),
    "chin_wrist": Vector((-0.050, -0.188, 1.312)),
    "waist_hold": Vector((-0.020, -0.175, 1.115)),
    "talk": Vector((0.19, -0.23, 1.13)),
    "wave": JOINTS["rightUpperArm"] + Vector((-0.17, -0.08, 0.22)),
    "bow_front": Vector((0.0, -0.17, 1.03)),
    "chest_front": Vector((0.0, -0.215, 1.27)),
    "shy_front": Vector((0.0, -0.16, 0.99)),
    "stretch_top": JOINTS["head"] + Vector((0, -0.01, 0.37)),
    "explain": Vector((-0.24, -0.25, 1.17)),
    "hip_left": Vector((0.190, -0.105, 1.045)),
}
# hand on the hip, pressing the coat panel to it (as in the reference): fingers
# angled in and down, palm on the cloth
HIP_HAND = ((-0.80, -0.14, -0.58), (-0.40, 0.92, 0.0))
# her hand style, layered on every pose: each finger curls a little more
# than the one before it (index → little) and they fan slightly
FINGER_CASCADE = 10.0
# fingers lying on these rest ON them in every clip: lifted clear when sunk
# in, curled down onto them when hovering (see kit.anims.settle_hands)
HAND_CONTACT = ("Kimono", "Obi")
FINGER_SPREAD = 0.0

MERGES = {
    "Body": ["Body", "Hand_L", "Hand_R", "Foot_L", "Foot_R"],
    "Hair": ["HairCap", "HairStrands"],
    "Lashes": ["Lash_L", "Lash_R"],
    "LashesLower": ["LashLower_L", "LashLower_R"],
    "Creases": ["Crease_L", "Crease_R"],
    "Brows": ["Brow_L", "Brow_R"],
    "Coat": ["Coat", "CoatSleeve_L", "CoatSleeve_R"],
    "Pants": ["Pants_L", "Pants_R"],
    "Sandals": ["Sandal_L", "Sandal_R"],
}

_UPPER = ["hips", "spine", "chest", "upperChest", "neck", "leftShoulder", "rightShoulder", "leftUpperArm", "rightUpperArm"]

# garments layered over the torso take their weights from the body surface
# underneath (see kit.rig), so coat, kimono and obi move as one
_LAYERED = {"Kimono", "KimonoPiping", "BustShadow", "BustFold", "Coat", "CoatTrim", "Obi", "ObiCord"}


_SURFACE = None


def _surface():
    """KD-tree over the torso surface (the same formula the skin is built
    from), so a garment vertex can find the skin point right beneath it."""
    global _SURFACE
    if _SURFACE is None:
        from mathutils.kdtree import KDTree

        pts = [body.torso_point(0.87 + 0.004 * i, math.radians(a)) for i in range(153) for a in range(360)]
        _SURFACE = KDTree(len(pts))
        for i, q in enumerate(pts):
            _SURFACE.insert(q, i)
        _SURFACE.balance()
    return _SURFACE


def weight_proxy(name, p):
    # the nearest skin point — not torso_point at the vertex's angle: the
    # torso is a superellipse, whose parameter is not the geometric angle,
    # and over the bust that mismatch handed the kimono half the skin's
    # breast weight (the skin then pushed through it when she posed)
    if name not in _LAYERED:
        return p
    q, _i, _d = _surface().find(Vector((p.x, p.y, min(max(p.z, 0.87), 1.48))))
    return q


def bust_joints(side):
    """Root inside the chest wall → apex → a short tip (the tip only gives the
    second bone a length; the spring sim swings the first)."""
    c = body.BUST_CENTER[side]
    root = Vector((c.x * 0.84, -0.040, c.z + 0.010))
    apex = Vector((c.x, -0.196, c.z - 0.010))
    return [root, apex, apex + (apex - root).normalized() * 0.02]


def chains():
    out = {name: {"joints": joints, "parent": "head"} for name, joints in hair.chain_joints().items()}
    out.update({name: {"joints": joints, "parent": "hips"} for name, joints in clothes.coat_chain_joints().items()})
    for side, sfx in ((1, "L"), (-1, "R")):
        out["bust_" + sfx] = {"joints": bust_joints(side), "parent": "chest"}
    return out


# skin and every layer over the chest share the same breast weights (computed
# at the proxy point on the body), so they sway together
_BUST_OBJECTS = {"Body", "SkinLines", "SkinShade", "Kimono", "KimonoPiping", "BustShadow", "BustFold", "Coat", "CoatTrim"}


def adjust_weights(name, q, weights):
    if name not in _BUST_OBJECTS and name not in _LAYERED:
        return weights
    out = dict(weights)
    # the flanks under the armpit stay with the torso when an arm is raised —
    # otherwise linear skinning folds the coat in there and the skin and
    # kimono push through it (only the torso: arms and legs are far out/down)
    if abs(q.x) < 0.19 and 1.12 < q.z < 1.36:
        under = smoothstep(1.21, 1.31, q.z)
        for arm in ("leftUpperArm", "rightUpperArm"):
            if arm in out:
                out[arm] *= under
    # across the front of the chest the upper arms have no business pulling
    # the skin (or what's over it): lowering an arm would crease the
    # collarbone. Fade their influence out toward the middle; the flanks keep
    # it so the coat still follows a raised arm.
    if q.y < -0.02 and q.z > 1.12:
        keep = smoothstep(0.085, 0.135, abs(q.x))
        for arm in ("leftUpperArm", "rightUpperArm"):
            if arm in out:
                out[arm] *= keep
    if name not in _BUST_OBJECTS:
        items = sorted(out.items(), key=lambda x: -x[1])[:4]
        tot = sum(v for _b, v in items) or 1.0
        return [(b, v / tot) for b, v in items if v / tot > 0.01]
    for side, sfx in ((1, "L"), (-1, "R")):
        c = body.BUST_CENTER[side]
        d = ((q.x - c.x) / 0.086) ** 2 + ((q.y - c.y) / 0.108) ** 2 + ((q.z - c.z) / 0.086) ** 2
        w = (1.0 - smoothstep(0.2, 1.0, d)) * smoothstep(-0.02, -0.06, q.y)
        if w > 0.01:
            out = {b: bw * (1.0 - w) for b, bw in out.items()}
            out[f"bust_{sfx}_1"] = out.get(f"bust_{sfx}_1", 0.0) + w
    items = sorted(out.items(), key=lambda x: -x[1])[:4]
    tot = sum(v for _b, v in items)
    return [(b, v / tot) for b, v in items if v / tot > 0.01]


def smooth_weights(name):
    """The fused hands: relax their per-part weights so the finger webs and
    knuckles bend smoothly (factor, passes)."""
    return (0.5, 24) if name.startswith("Hand_") else None


def panels():
    coat = {"chains": [n for n, _az in clothes.COAT_CHAINS], "upper": _UPPER, "open_front": True,
            "blend_above": 0.05, "blend_below": 0.07}
    return {"Coat": coat, "CoatTrim": coat}


def object_candidates(name):
    if name in ("Kimono", "KimonoPiping", "BustShadow", "BustFold"):
        return _UPPER + ["leftUpperLeg", "rightUpperLeg"]
    if name in ("Obi", "ObiCord"):
        return ["hips", "spine", "chest"]
    for prefix, kind in (("CoatSleeve_", "arm"), ("Pants_", "leg"), ("Sandal_", "foot")):
        if name.startswith(prefix):
            s = "left" if name.endswith("_L") else "right"
            arm, _palm, leg = side_sets(s)
            if kind == "arm":
                return arm
            if kind == "leg":
                return leg
            return [s + "LowerLeg", s + "Foot", s + "Toes"]
    return None  # rigid on the head (face features, hair cap, ties)


def after_anims(arm_ob):
    """Once she can pose: the haori pressed under her resting hand."""
    return {"hand_press": clothes.add_hand_press(arm_ob)}


def build_meshes(steps):
    out = {}
    head_ob = head.build_head()
    out["head"] = head_ob.name
    if "face" in steps:
        out["face"] = face.build_face(head_ob)
    if "hair" in steps:
        out["hair"] = hair.build_hair(head_ob)
    if "body" in steps:
        out["body"] = body.build_body()
    if "clothes" in steps:
        out["clothes"] = clothes.build_clothes(head_ob)
    return out
