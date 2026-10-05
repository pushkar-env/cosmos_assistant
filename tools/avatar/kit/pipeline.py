"""Build orchestration for any character spec — each step can be run on its
own while iterating (see tools/avatar/build.py)."""

import os

from . import anims, common, export, rig

ALL_STEPS = ["head", "face", "hair", "body", "clothes", "rig", "anim", "merge", "export"]

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
ASSETS = os.path.join(REPO, "src", "renderer", "src", "assets", "avatar")


def run(spec, steps=None):
    steps = set(steps or ALL_STEPS)
    common.clear_scene()
    out = spec.build_meshes(steps)
    arm_ob = None
    if "rig" in steps:
        arm_ob = rig.build_armature(spec)
        rig.skin_all(arm_ob, spec)
        out["rig"] = arm_ob.name
    if "anim" in steps and arm_ob is not None:
        out["anim"] = anims.build_actions(arm_ob, spec)
        # optional: anything that needs the posed character (e.g. morphs
        # worked out in a clip's pose)
        hook = getattr(spec, "after_anims", None)
        if hook:
            out["after_anims"] = hook(arm_ob)
    if "merge" in steps:
        out["merge"] = export.consolidate(spec.MERGES)
    if "export" in steps:
        path = os.path.join(ASSETS, spec.GLB)
        os.makedirs(ASSETS, exist_ok=True)
        export.export_glb(path)
        out["glb"] = path
        out["glb_kb"] = round(os.path.getsize(path) / 1024)
    return out
