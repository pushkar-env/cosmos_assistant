"""Build orchestration — each step can be run on its own while iterating."""

import os

from . import body, clothes, common, export, face, hair, head, rig

ALL_STEPS = ["head", "face", "hair", "body", "clothes", "rig", "anim", "merge", "export"]

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
GLB_PATH = os.path.join(REPO, "src", "renderer", "src", "assets", "avatar", "nova.glb")


def run(steps=None):
    steps = set(steps or ALL_STEPS)
    common.clear_scene()
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
    arm_ob = None
    if "rig" in steps:
        arm_ob = rig.build_armature()
        rig.skin_all(arm_ob)
        out["rig"] = arm_ob.name
    if "anim" in steps and arm_ob is not None:
        from . import anims

        out["anim"] = anims.build_actions(arm_ob)
    if "merge" in steps:
        out["merge"] = export.consolidate()
    if "export" in steps:
        os.makedirs(os.path.dirname(GLB_PATH), exist_ok=True)
        export.export_glb(GLB_PATH)
        out["glb"] = GLB_PATH
        out["glb_kb"] = round(os.path.getsize(GLB_PATH) / 1024)
    return out
