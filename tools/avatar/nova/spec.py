"""Nova — character spec for the shared avatar kit.

Everything the kit's rig / animation / export steps need to know about her:
skeleton joints, hand geometry, spring chains, how each mesh is weighted,
named reach targets for the clip set, and which meshes merge for the app.
"""

from mathutils import Vector

from kit.rig import side_sets

from . import body, clothes, face, hair, head
from .body import JOINTS, arm_dir, finger_chain, palm_frame  # noqa: F401 — part of the spec

NAME = "Nova"
GLB = "nova.glb"
KNUCKLE = 0.084  # wrist → knuckles along the hand
ARM_REST = 37  # degrees the arms lower from the A-pose in the resting stance
BASE_STYLE = "relaxed"

# reach targets for the shared clips (armature space)
POINTS = {
    "hands_behind": Vector((0.045, 0.118, 0.925)),
    "chin_wrist": Vector((-0.045, -0.142, 1.172)),
    "waist_hold": Vector((-0.02, -0.135, 1.005)),
    "talk": Vector((0.17, -0.19, 1.02)),
    "wave": JOINTS["rightUpperArm"] + Vector((-0.15, -0.07, 0.20)),
    "bow_front": Vector((0.0, -0.13, 0.93)),
    "chest_front": Vector((0.0, -0.17, 1.13)),
    "shy_front": Vector((0.0, -0.12, 0.90)),
    "stretch_top": JOINTS["head"] + Vector((0, -0.01, 0.34)),
    "explain": Vector((-0.20, -0.21, 1.07)),
}

MERGES = {
    "Hair": ["HairCap", "HairStrands"],
    "Lashes": ["Lash_L", "Lash_R"],
    "LashesLower": ["LashLower_L", "LashLower_R"],
    "Creases": ["Crease_L", "Crease_R"],
    "Brows": ["Brow_L", "Brow_R"],
    "Outfit": ["Jacket", "Sleeve_L", "Sleeve_R"],
    "OutfitDark": ["Skirt", "JacketHem", "Cuff_L", "Cuff_R"],
    "Glow": ["JacketGlow", "CuffGlow_L", "CuffGlow_R", "SkirtStripe", "SockBand_L", "SockBand_R", "HeadsetGlow"],
    "Socks": ["Sock_L", "Sock_R"],
    "Shoes": ["Shoe_L", "Shoe_R"],
    "Soles": ["Sole_L", "Sole_R"],
}


def chains():
    return {name: {"joints": joints, "parent": "head"} for name, joints in hair.chain_joints().items()}


def panels():
    return {}


def object_candidates(name):
    if name in ("Jacket", "JacketHem", "JacketGlow"):
        return ["hips", "spine", "chest", "upperChest", "neck", "leftShoulder", "rightShoulder", "leftUpperArm", "rightUpperArm"]
    if name == "Bow":
        return ["chest", "upperChest", "neck"]
    if name in ("Skirt", "SkirtStripe"):
        return ["hips", "spine", "leftUpperLeg", "rightUpperLeg"]
    for prefix, kind in (("Sleeve_", "arm"), ("Cuff_", "arm"), ("CuffGlow_", "arm"), ("Sock_", "leg"),
                         ("SockBand_", "leg"), ("Shoe_", "foot"), ("Sole_", "foot")):
        if name.startswith(prefix):
            s = "left" if name.endswith("_L") else "right"
            arm, _palm, _leg = side_sets(s)
            if kind == "arm":
                return arm
            if kind == "leg":
                return [s + "UpperLeg", s + "LowerLeg", s + "Foot"]
            return [s + "Foot", s + "Toes"]
    return None  # rigid on the head


def build_meshes(steps):
    out = {}
    head_ob = head.build_head()
    out["head"] = head_ob.name
    if "face" in steps:
        out["face"] = face.build_face(head_ob)
    if "hair" in steps:
        out["hair"] = hair.build_hair(head_ob)
    if "body" in steps:
        out["body"] = body.build_body().name
    if "clothes" in steps:
        out["clothes"] = clothes.build_clothes(head_ob)
    return out
