"""Armature + skin weights, shared by every character.

Bone names follow the VRM humanoid naming (hips, spine, chest, upperChest,
neck, head, leftUpperArm, leftIndexProximal, …) so the app — and any
VRM-aware tooling — can address them by convention. Spring chains (hair,
cloth) come from ``spec.chains()`` and are named ``<chain>_<n>``; the app
simulates them as spring bones.

Weights are computed analytically:
  * capsule weights — nearest bone *segments* among a candidate set, with an
    inverse-distance falloff (smooth at every joint, no watertight-mesh needs);
  * chain weights — root→tip along a spring chain, glued to the parent above
    the root (hair);
  * panel weights — cloth hanging around the body (coat skirts): blend the two
    chains either side of a vertex by angle, then along them by height.

The character module (``spec``) supplies: NAME, JOINTS, KNUCKLE, arm_dir(),
finger_chain(), chains(), object_candidates() and panels(); optionally
``weight_proxy(object_name, point)``, which maps a vertex to the point its
capsule weights are computed at, and ``adjust_weights(object_name, point,
weights)``, which may blend extra bones (e.g. breast springs) into a vertex's
weights at that same proxy point. Layered garments use it to weight from the
body surface underneath, so every layer at the same spot gets the same
weights and the layers move as one (a coat never peels off the shirt under
it when an arm lifts).
"""

import math

import bpy
from mathutils import Vector
from mathutils.geometry import intersect_point_line

from .common import COLL, link, smoothstep

FINGERS = ("Thumb", "Index", "Middle", "Ring", "Little")
FINGER_SEGS = ("Proximal", "Intermediate", "Distal")
SPINE = ["hips", "spine", "chest", "upperChest", "neck", "head"]
FORWARD = Vector((0, -1, 0))


def build_armature(spec):
    arm = bpy.data.armatures.new(spec.NAME + "Rig")
    ob = bpy.data.objects.new(spec.NAME, arm)
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

    J = spec.JOINTS
    bone("root", (0, 0, 0), (0, 0, 0.12))
    bone("hips", J["hips"], J["spine"], "root")
    bone("spine", J["spine"], J["chest"], "hips", connect=True)
    bone("chest", J["chest"], J["upperChest"], "spine", connect=True)
    bone("upperChest", J["upperChest"], J["neck"], "chest", connect=True)
    bone("neck", J["neck"], J["head"], "upperChest", connect=True)
    bone("head", J["head"], J["headTop"], "neck", connect=True)

    for side, s in ((1, "left"), (-1, "right")):
        d = spec.arm_dir(side)
        knuckles = J[s + "Hand"] + d * spec.KNUCKLE
        bone(s + "Shoulder", J[s + "Shoulder"], J[s + "UpperArm"], "upperChest")
        bone(s + "UpperArm", J[s + "UpperArm"], J[s + "LowerArm"], s + "Shoulder", connect=True)
        bone(s + "LowerArm", J[s + "LowerArm"], J[s + "Hand"], s + "UpperArm", connect=True)
        bone(s + "Hand", J[s + "Hand"], knuckles, s + "LowerArm", connect=True)
        for f in FINGERS:
            pts = spec.finger_chain(side, f)
            parent = s + "Hand"
            for i, seg in enumerate(FINGER_SEGS):
                name = f"{s}{f}{seg}"
                # z axis toward the back of the hand: curling is a rotation about x
                bone(name, pts[i], pts[i + 1], parent, roll_to=Vector((0, 0, 1)), connect=i > 0)
                parent = name
        bone(s + "UpperLeg", J[s + "UpperLeg"], J[s + "LowerLeg"], "hips")
        bone(s + "LowerLeg", J[s + "LowerLeg"], J[s + "Foot"], s + "UpperLeg", connect=True)
        bone(s + "Foot", J[s + "Foot"], J[s + "Toes"], s + "LowerLeg", connect=True)
        toe_tip = J.get(s + "ToeTip", J[s + "Toes"] + Vector((0, -0.055, 0)))
        bone(s + "Toes", J[s + "Toes"], toe_tip, s + "Foot", connect=True)

    for chain, info in spec.chains().items():
        joints = info["joints"]
        parent = info["parent"]
        for i in range(len(joints) - 1):
            name = f"{chain}_{i + 1}"
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
    """Root→tip weights along a chain (by projected arc length)."""
    best = None
    acc = 0.0
    lens = []
    for i in range(len(joints) - 1):
        a, b = joints[i], joints[i + 1]
        seg = (b - a).length
        _closest, t = intersect_point_line(p, a, b)
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
        # above the first joint — glued to the parent, easing in
        k = smoothstep(-blend, 0.0, s) * 0.5
        return [(root_bone, 1.0 - k), (bone_names[0], k)] if k > 0.01 else [(root_bone, 1.0)]
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


def _azimuth(p):
    """Degrees around the body axis: 0 = front, + toward her left."""
    return math.degrees(math.atan2(p.x, -p.y))


def panel_weights(p, segs, chains, panel, p_upper=None):
    """Cloth hanging around the body, driven by several chains.

    Above the chains' roots the cloth follows ``panel['upper']`` bones by
    capsule weights; below, each vertex blends the two chains either side of
    it (by azimuth) and walks down them (by height). With ``open_front`` the
    two front chains never blend across the opening."""
    names = panel["chains"]
    infos = [(name, chains[name]["joints"]) for name in names]
    roots_z = max(j[0].z for _n, j in infos)
    z_top, z_bot = roots_z + panel.get("blend_above", 0.04), roots_z - panel.get("blend_below", 0.06)
    k_low = smoothstep(z_top, z_bot, p.z)
    upper = capsule_weights(p_upper or p, segs, panel["upper"]) if k_low < 0.999 else []
    if k_low <= 0.001:
        return upper

    az = _azimuth(p)
    ordered = sorted(((_azimuth(j[0]), n, j) for n, j in infos), key=lambda x: x[0])
    # bracket the vertex azimuth between two neighbouring chains (wrapping)
    pair = None
    for i in range(len(ordered)):
        a0, n0, j0 = ordered[i]
        a1, n1, j1 = ordered[(i + 1) % len(ordered)]
        span = (a1 - a0) % 360 or 360
        off = (az - a0) % 360
        if off <= span:
            pair = (n0, j0, n1, j1, off / span, a0, span)
            break
    n0, j0, n1, j1, t, a0, span = pair
    # does the arc a0 → a1 (counter-clockwise) pass the front (azimuth 0)?
    crosses_front = panel.get("open_front") and ((-a0) % 360) < span
    if crosses_front:
        # the opening: stick to the nearer chain only
        t = 0.0 if t < 0.5 else 1.0
    lower = {}
    for name, joints, w in ((n0, j0, 1.0 - t), (n1, j1, t)):
        if w <= 1e-3:
            continue
        bones = [f"{name}_{i + 1}" for i in range(len(joints) - 1)]
        for b, bw in chain_weights(p, joints, bones, root_bone=chains[name]["parent"], blend=0.05):
            lower[b] = lower.get(b, 0.0) + bw * w
    out = {}
    for b, w in upper:
        out[b] = out.get(b, 0.0) + w * (1.0 - k_low)
    for b, w in lower.items():
        out[b] = out.get(b, 0.0) + w * k_low
    items = sorted(out.items(), key=lambda x: -x[1])[:4]
    tot = sum(w for _b, w in items)
    return [(b, w / tot) for b, w in items if w / tot > 0.01]


def smooth_weights(ob, per_vertex, factor=0.5, iterations=6, max_inf=4):
    """Relax skin weights across the surface, like a rigger's "smooth
    weights": each pass blends every vertex toward its neighbours. It softens
    the hard steps where separately weighted parts meet (a fused hand's finger
    webs and knuckles) and leaves the inside of each part alone."""
    me = ob.data
    nbrs = [[] for _ in me.vertices]
    for e in me.edges:
        a, b = e.vertices
        nbrs[a].append(b)
        nbrs[b].append(a)
    cur = [dict(ws) for ws in per_vertex]
    for _ in range(iterations):
        nxt = []
        for i, w in enumerate(cur):
            ns = nbrs[i]
            if not ns:
                nxt.append(w)
                continue
            avg = {}
            for j in ns:
                for bone, v in cur[j].items():
                    avg[bone] = avg.get(bone, 0.0) + v
            k = factor / len(ns)
            nxt.append({bone: (1.0 - factor) * w.get(bone, 0.0) + k * avg.get(bone, 0.0) for bone in set(w) | set(avg)})
        cur = nxt
    out = []
    for w in cur:
        items = sorted(w.items(), key=lambda x: -x[1])[:max_inf]
        tot = sum(v for _b, v in items) or 1.0
        out.append([(b, v / tot) for b, v in items if v / tot > 0.01])
    return out


def _assign(ob, weights_per_vertex):
    groups = {}
    for vi, ws in enumerate(weights_per_vertex):
        for name, w in ws:
            groups.setdefault(name, []).append((vi, w))
    for name, items in groups.items():
        vg = ob.vertex_groups.get(name) or ob.vertex_groups.new(name=name)
        for vi, w in items:
            vg.add([vi], w, "REPLACE")


def side_sets(s):
    arm = ["upperChest", s + "Shoulder", s + "UpperArm", s + "LowerArm", s + "Hand"]
    palm = [s + "LowerArm", s + "Hand", s + "ThumbProximal"] + [f"{s}{f}Proximal" for f in FINGERS[1:]]
    leg = ["hips", s + "UpperLeg", s + "LowerLeg", s + "Foot"]
    return arm, palm, leg


def piece_candidates(tag):
    """Bones a tagged body piece may be weighted to (tags from MeshBuilder)."""
    s = "left" if tag.endswith("_L") else "right"
    arm, palm, leg = side_sets(s)
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
    if tag.startswith("foot_"):
        return [s + "LowerLeg", s + "Foot", s + "Toes"]
    raise KeyError(tag)


def _groups_by_vertex(ob, prefix):
    out = {}
    for vg in [g for g in ob.vertex_groups if g.name.startswith(prefix)]:
        for v in ob.data.vertices:
            for g in v.groups:
                if g.group == vg.index:
                    out[v.index] = vg.name
    return out


def skin_all(arm_ob, spec):
    segs = _segments(arm_ob)
    chains = spec.chains()
    panels = spec.panels()
    proxy = getattr(spec, "weight_proxy", None) or (lambda _name, p: p)
    for ob in bpy.data.collections[COLL].objects:
        if ob.type != "MESH":
            continue
        verts = [ob.matrix_world @ v.co for v in ob.data.vertices]
        per_vertex = [[("head", 1.0)] for _ in verts]

        piece = _groups_by_vertex(ob, "piece_")
        hair = _groups_by_vertex(ob, "hair_")
        if piece:
            for vi, p in enumerate(verts):
                per_vertex[vi] = capsule_weights(p, segs, piece_candidates(piece[vi][len("piece_") :]))
        elif hair:
            for vi, p in enumerate(verts):
                g = hair.get(vi, "hair_head")
                if g in chains:
                    bones = [f"{g}_{i + 1}" for i in range(len(chains[g]["joints"]) - 1)]
                    per_vertex[vi] = chain_weights(p, chains[g]["joints"], bones, root_bone=chains[g]["parent"])
        elif ob.name in panels:
            per_vertex = [panel_weights(p, segs, chains, panels[ob.name], proxy(ob.name, p)) for p in verts]
        else:
            cands = spec.object_candidates(ob.name)
            if cands:
                per_vertex = [capsule_weights(proxy(ob.name, p), segs, cands) for p in verts]
        for vg in [g for g in ob.vertex_groups if g.name.startswith(("piece_", "hair_"))]:
            ob.vertex_groups.remove(vg)
        adjust = getattr(spec, "adjust_weights", None)
        if adjust:
            per_vertex = [adjust(ob.name, proxy(ob.name, p), ws) for p, ws in zip(verts, per_vertex)]
        smooth = getattr(spec, "smooth_weights", None)
        cfg = smooth(ob.name) if smooth else None
        if cfg:
            per_vertex = smooth_weights(ob, per_vertex, *cfg)

        _assign(ob, per_vertex)
        mod = ob.modifiers.new("Armature", "ARMATURE")
        mod.object = arm_ob
        mw = ob.matrix_world.copy()
        ob.parent = arm_ob
        ob.matrix_world = mw
    return arm_ob
