"""Draw-call consolidation + glTF export."""

import bpy

# meshes that share a material (and a skeleton) are joined so the app draws
# ~18 skinned meshes instead of ~40. Eyes stay separate: each eye's shader
# needs its own centre for the iris.
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


def _join(names, new_name):
    obs = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
    if not obs:
        return None
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    if len(obs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = new_name
    ob.data.name = new_name
    return ob


def consolidate():
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    out = []
    for new_name, names in MERGES.items():
        ob = _join(names, new_name)
        if ob:
            out.append(ob.name)
    return out


def export_glb(path):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_skins=True,
        export_influence_nb=4,
        export_morph=True,
        export_morph_normal=False,
        export_morph_animation=False,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_reset_pose_bones=True,
        export_rest_position_armature=True,
        export_leaf_bone=False,
        export_def_bones=False,
    )
    return path
