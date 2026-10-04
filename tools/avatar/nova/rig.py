"""Armature + skin weights.

Bone names follow the VRM humanoid naming (hips, spine, chest, upperChest,
neck, head, leftUpperArm, leftIndexProximal, …) so the app — and any VRM-aware
tooling — can address them by convention. Hair/ahoge chains are named
``hair_<group>_<n>`` and are simulated as spring bones at runtime.

Weights are computed analytically ("capsule" weights): each vertex is
weighted to the nearest bone *segments* among a per-piece candidate set with
an inverse-distance falloff, which blends smoothly around every joint and
needs none of bone-heat's watertight-mesh requirements. Hair chains use a
root→tip parametrisation instead so the scalp part stays glued to the head.
"""

import bpy
from mathutils import Vector
from mathutils.geometry import intersect_point_line

from .body import JOINTS, _arm_dir, finger_chain
from .common import link, smoothstep
from .hair import chain_joints

FINGERS = ("Thumb", "Index", "Middle", "Ring", "Little")
FINGER_SEGS = ("Proximal", "Intermediate", "Distal")
SPINE = ["hips", "spine", "chest", "upperChest", "neck", "head"]
FORWARD = Vector((0, -1, 0))


def build_armature():
    arm = bpy.data.armatures.new("NovaRig")
    ob = bpy.data.objects.new("Nova", arm)
    link(ob)
    ob.show_in_front = True
    for o in bpy.context.selected_objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.edit_bones

    def bone(name, head, tail, parent=None, roll_to=FORWARD, connect=False):
        b = eb.new(name)
        b.head, b.tail = Vector(head), Vector(tail)
        b.align_roll(roll_to)
        if parent:
            b.parent = eb[parent]
            b.use_connect = connect
        return b

    J = JOINTS
    bone("root", (0, 0, 0), (0, 0, 0.12))
    bone("hips", J["hips"], J["spine"], "root")
    bone("spine", J["spine"], J["chest"], "hips", connect=True)
    bone("chest", J["chest"], J["upperChest"], "spine", connect=True)
    bone("upperChest", J["upperChest"], J["neck"], "chest", connect=True)
    bone("neck", J["neck"], J["head"], "upperChest", connect=True)
    bone("head", J["head"], J["headTop"], "neck", connect=True)

    for side, s in ((1, "left"), (-1, "right")):
        d = _arm_dir(side)
        knuckles = J[s + "Hand"] + d * 0.084
        bone(s + "Shoulder", J[s + "Shoulder"], J[s + "UpperArm"], "upperChest")
        bone(s + "UpperArm", J[s + "UpperArm"], J[s + "LowerArm"], s + "Shoulder", connect=True)
        bone(s + "LowerArm", J[s + "LowerArm"], J[s + "Hand"], s + "UpperArm", connect=True)
        bone(s + "Hand", J[s + "Hand"], knuckles, s + "LowerArm", connect=True)
        for f in FINGERS:
            pts = finger_chain(side, f)
            parent = s + "Hand"
            for i, seg in enumerate(FINGER_SEGS):
                name = f"{s}{f}{seg}"
                # z axis toward the back of the hand: curling is a rotation about x
                bone(name, pts[i], pts[i + 1], parent, roll_to=Vector((0, 0, 1)), connect=i > 0)
                parent = name
        bone(s + "UpperLeg", J[s + "UpperLeg"], J[s + "LowerLeg"], "hips")
        bone(s + "LowerLeg", J[s + "LowerLeg"], J[s + "Foot"], s + "UpperLeg", connect=True)
        bone(s + "Foot", J[s + "Foot"], J[s + "Toes"], s + "LowerLeg", connect=True)
        bone(s + "Toes", J[s + "Toes"], J[s + "Toes"] + Vector((0, -0.055, 0)), s + "Foot", connect=True)

    for group, joints in chain_joints().items():
        parent = "head"
        for i in range(len(joints) - 1):
            name = f"hair_{group}_{i + 1}"
            bone(name, joints[i], joints[i + 1], parent, connect=i > 0)
            parent = name

    bpy.ops.object.mode_set(mode="OBJECT")
    return ob


# ── weights ─────────────────────────────────────────────────────────────


def _segments(arm_ob):
    mw = arm_ob.matrix_world
    return {b.name: (mw @ b.head_local, mw @ b.tail_local) for b in arm_ob.data.bones}


def _seg_dist(p, a, b):
    closest, t = intersect_point_line(p, a, b)
    if t < 0:
        closest = a
    elif t > 1:
        closest = b
    return (p - closest).length


def capsule_weights(p, segs, candidates, power=8.0, max_inf=4):
    ws = []
    for name in candidates:
        a, b = segs[name]
        d = max(_seg_dist(p, a, b), 1e-4)
        ws.append((name, 1.0 / d**power))
    ws.sort(key=lambda x: -x[1])
    ws = ws[:max_inf]
    tot = sum(w for _n, w in ws)
    return [(n, w / tot) for n, w in ws if w / tot > 0.01]


def chain_weights(p, joints, bone_names, root_bone="head", blend=0.035):
    """Root→tip weights along a hair chain (by projected arc length)."""
    # arc-length parameter of p's projection onto the polyline
    best = None
    acc = 0.0
    lens = []
    for i in range(len(joints) - 1):
        a, b = joints[i], joints[i + 1]
        seg = (b - a).length
        closest, t = intersect_point_line(p, a, b)
        tc = min(max(t, 0.0), 1.0)
        d = (p - (a + (b - a) * tc)).length
        s = acc + t * seg if i == 0 else acc + tc * seg
        if i == len(joints) - 2 and t > 1:
            s = acc + t * seg
        if best is None or d < best[0]:
            best = (d, s)
        lens.append(seg)
        acc += seg
    s = best[1]
    if s <= 0:
        # above the first joint: on the scalp — glued to the head, easing in
        k = smoothstep(-blend, 0.0, s) * 0.5
        return [(root_bone, 1.0 - k), (bone_names[0], k)] if k > 0.01 else [(root_bone, 1.0)]
    # find the bone this point sits on and blend across its joints
    acc = 0.0
    for i, seg in enumerate(lens):
        if s <= acc + seg or i == len(lens) - 1:
            u = (s - acc) / seg
            cur = bone_names[i]
            if u < 0.25:
                prev = bone_names[i - 1] if i > 0 else root_bone
                k = 0.5 + 0.5 * smoothstep(0.0, 0.25, u)
                return [(cur, k), (prev, 1 - k)]
            if u > 0.75 and i < len(lens) - 1:
                k = 0.5 * smoothstep(0.75, 1.0, u)
                return [(cur, 1 - k), (bone_names[i + 1], k)]
            return [(cur, 1.0)]
        acc += seg
    return [(bone_names[-1], 1.0)]


def _assign(ob, weights_per_vertex):
    groups = {}
    for vi, ws in enumerate(weights_per_vertex):
        for name, w in ws:
            groups.setdefault(name, []).append((vi, w))
    for name, items in groups.items():
        vg = ob.vertex_groups.get(name) or ob.vertex_groups.new(name=name)
        for vi, w in items:
            vg.add([vi], w, "REPLACE")


def _side_sets(s):
    arm = ["upperChest", s + "Shoulder", s + "UpperArm", s + "LowerArm", s + "Hand"]
    palm = [s + "LowerArm", s + "Hand", s + "ThumbProximal"] + [f"{s}{f}Proximal" for f in FINGERS[1:]]
    leg = ["hips", s + "UpperLeg", s + "LowerLeg", s + "Foot"]
    return arm, palm, leg


def piece_candidates(tag):
    s = "left" if tag.endswith("_L") else "right"
    arm, palm, leg = _side_sets(s)
    if tag == "torso":
        return SPINE + ["leftShoulder", "rightShoulder", "leftUpperArm", "rightUpperArm", "leftUpperLeg", "rightUpperLeg"]
    if tag.startswith("arm_"):
        return arm
    if tag.startswith("palm_"):
        return palm
    if tag.startswith("finger"):
        f = tag[len("finger") : -2]
        return [s + "Hand"] + [f"{s}{f}{seg}" for seg in FINGER_SEGS]
    if tag.startswith("leg_"):
        return leg
    raise KeyError(tag)


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
            arm, _palm, leg = _side_sets(s)
            if kind == "arm":
                return arm
            if kind == "leg":
                return [s + "UpperLeg", s + "LowerLeg", s + "Foot"]
            return [s + "Foot", s + "Toes"]
    return None  # rigid on the head


def skin_all(arm_ob, coll_name="Nova"):
    segs = _segments(arm_ob)
    chains = {g: j for g, j in chain_joints().items()}
    chain_bones = {g: [f"hair_{g}_{i + 1}" for i in range(len(j) - 1)] for g, j in chains.items()}
    for ob in bpy.data.collections[coll_name].objects:
        if ob.type != "MESH":
            continue
        verts = [ob.matrix_world @ v.co for v in ob.data.vertices]
        per_vertex = [[("head", 1.0)] for _ in verts]

        piece_groups = [vg for vg in ob.vertex_groups if vg.name.startswith("piece_")]
        hair_groups = [vg for vg in ob.vertex_groups if vg.name.startswith("hair_")]
        if piece_groups:
            idx_tag = {}
            for vg in piece_groups:
                tag = vg.name[len("piece_") :]
                for v in ob.data.vertices:
                    for g in v.groups:
                        if g.group == vg.index:
                            idx_tag[v.index] = tag
            for vi, p in enumerate(verts):
                per_vertex[vi] = capsule_weights(p, segs, piece_candidates(idx_tag[vi]))
            for vg in piece_groups:
                ob.vertex_groups.remove(vg)
        elif hair_groups:
            idx_grp = {}
            for vg in hair_groups:
                g = vg.name[len("hair_") :]
                for v in ob.data.vertices:
                    for gg in v.groups:
                        if gg.group == vg.index:
                            idx_grp[v.index] = g
            for vi, p in enumerate(verts):
                g = idx_grp.get(vi, "head")
                if g in chains:
                    per_vertex[vi] = chain_weights(p, chains[g], chain_bones[g])
            for vg in hair_groups:
                ob.vertex_groups.remove(vg)
        else:
            cands = object_candidates(ob.name)
            if cands:
                per_vertex = [capsule_weights(p, segs, cands) for p in verts]

        _assign(ob, per_vertex)
        mod = ob.modifiers.new("Armature", "ARMATURE")
        mod.object = arm_ob
        mw = ob.matrix_world.copy()
        ob.parent = arm_ob
        ob.matrix_world = mw
    return arm_ob
