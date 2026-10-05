"""Draw-call consolidation + glTF export."""

import bpy

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


def consolidate(merges):
    """Join meshes that share a material (and the skeleton) so the app draws
    fewer skinned meshes. ``merges``: {new name: [object names]}."""
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    out = []
    for new_name, names in merges.items():
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
