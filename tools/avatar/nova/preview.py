"""Preview camera/lights so each build step can be checked with a quick render."""

import math

import bpy
from mathutils import Euler, Vector

from .common import link


def _camera(name):
    cam = bpy.data.objects.get(name)
    if cam is None:
        cd = bpy.data.cameras.new(name)
        cam = bpy.data.objects.new(name, cd)
        link(cam, "Preview")
    return cam


def setup_lights():
    if bpy.data.objects.get("KeyLight"):
        return
    for name, rot, energy, color in (
        ("KeyLight", (math.radians(55), 0, math.radians(-30)), 3.2, (1.0, 0.97, 0.94)),
        ("FillLight", (math.radians(70), 0, math.radians(50)), 1.2, (0.85, 0.9, 1.0)),
        ("RimLight", (math.radians(110), 0, math.radians(180)), 2.5, (0.6, 0.95, 1.0)),
    ):
        ld = bpy.data.lights.new(name, "SUN")
        ld.energy = energy
        ld.color = color
        ld.angle = math.radians(8)
        ob = bpy.data.objects.new(name, ld)
        ob.rotation_euler = Euler(rot)
        link(ob, "Preview")
    world = bpy.context.scene.world or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.05, 0.06, 0.08, 1)
        bg.inputs[1].default_value = 0.6


def render(path, target=(0, 0, 1.38), dist=0.75, yaw=0.0, pitch=0.0, lens=85, res=(900, 900), ortho=None):
    """Render a still looking at ``target`` from ``dist`` metres.

    yaw rotates around the character (0 = front, 90 = her left side)."""
    setup_lights()
    sc = bpy.context.scene
    cam = _camera("PreviewCam")
    t = Vector(target)
    y = math.radians(yaw)
    p = math.radians(pitch)
    offs = Vector((math.sin(y) * math.cos(p), -math.cos(y) * math.cos(p), math.sin(p))) * dist
    cam.location = t + offs
    direction = t - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = lens
    cam.data.clip_start = 0.01
    if ortho:
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = ortho
    else:
        cam.data.type = "PERSP"
    sc.camera = cam
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = path
    try:
        sc.view_settings.view_transform = "Standard"
    except Exception:
        pass
    bpy.ops.render.render(write_still=True)
    return path
