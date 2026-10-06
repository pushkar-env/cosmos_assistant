"""Gesture & loop clips, authored as code and exported as glTF animations.

Shared by every character: poses are expressed against the character spec
(``SPEC.JOINTS``, ``SPEC.arm_dir``, ``SPEC.palm_frame``) and its named reach
targets (``SPEC.POINTS``), so one clip set fits any body.

Every clip keys the FULL body pose (spine, arms, hands, fingers, legs) on
every key so the app can crossfade between any two clips without bones
falling back to the A-pose. Hair chains are left alone — the app simulates
them as spring bones. Facial expressions are NOT baked here: the app drives
the blendshapes live from the conversation (emotion, lip-sync, blinking).

Poses are written in armature rest space (X = her left, Y = back, Z = up),
using two helpers:
  * ``rot(bone, axis, deg)`` — rotate a bone about a rest-space axis,
  * ``reach(side, target, pole)`` — two-bone IK for the arm (Blender's IK
    solver), baked straight back into plain rotations.
"""

import math

import bpy
from mathutils import Matrix, Quaternion, Vector

from .common import smoothstep
from .rig import FINGER_SEGS, FINGERS

# the character being animated — set by build_actions()
SPEC = None

FPS = 30
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))

BODY_BONES = (
    ["hips", "spine", "chest", "upperChest", "neck", "head"]
    + [f"{s}{b}" for s in ("left", "right") for b in ("Shoulder", "UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot")]
    + [f"{s}{f}{seg}" for s in ("left", "right") for f in FINGERS for seg in FINGER_SEGS]
)


def _side(s):
    return 1 if s == "left" else -1


# without a sleeve, contact ignores the forearm this far down from the elbow
ELBOW_SKIP = 0.09
# what PoseKit.clear did on every pose it solved (the build reports it)
CONTACT_LOG = []
_SLEEVE_REACH = {}


def _sleeve_reach(arm_ob, side):
    """How far down the forearm (from the elbow, in rest) the side's sleeve
    covers it, less a centimetre — contact ignores the arm above that."""
    if side not in _SLEEVE_REACH:
        reach = ELBOW_SKIP
        sleeve = bpy.data.objects.get(getattr(SPEC, "SLEEVES", {}).get(side, ""))
        if sleeve is not None:
            b = arm_ob.data.bones[side + "LowerArm"]
            axis = (b.tail_local - b.head_local).normalized()
            reach = max((v.co - b.head_local).dot(axis) for v in sleeve.data.vertices) - 0.01
        _SLEEVE_REACH[side] = reach
    return _SLEEVE_REACH[side]


def _posed_mesh(name, dg):
    """World-space (vertices, polygons) of a mesh as posed, or None."""
    ob = bpy.data.objects.get(name)
    if ob is None:
        return None
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    mw = ob.matrix_world
    verts = [mw @ v.co for v in me.vertices]
    polys = [tuple(p.vertices) for p in me.polygons]
    ev.to_mesh_clear()
    return verts, polys


def _solids():
    """what a hand must never cut through: her clothes, skin, head and hair
    (``SPEC.HAND_SOLIDS``)"""
    return list(getattr(SPEC, "HAND_SOLIDS", ()))


class PoseKit:
    def __init__(self, arm_ob):
        self.ob = arm_ob
        self.pb = arm_ob.pose.bones
        for p in self.pb:
            p.rotation_mode = "QUATERNION"
        self._last_q = {}
        self.reset()

    # ── primitives ──
    def reset(self):
        # set by hip_pose: the left hand rests on her hip, or is held ``lift``
        # off it (see rest_hand)
        self.resting = False
        self.lift = 0.0
        # set by poses with one hand laid on the other: their fingers settle
        # onto it (elsewhere two fingertips that merely come near each other
        # would be curled into each other)
        self.hands_touch = False
        for p in self.pb:
            p.rotation_quaternion = Quaternion()
            p.location = Vector()
            p.scale = Vector((1, 1, 1))
            for c in list(p.constraints):
                p.constraints.remove(c)

    def rest_q(self, name):
        return self.ob.data.bones[name].matrix_local.to_quaternion()

    def rot(self, name, axis, deg):
        """Compose a rotation about a REST-space axis onto the bone."""
        if abs(deg) < 1e-6:
            return self
        B = self.rest_q(name)
        R = Quaternion(Vector(axis).normalized(), math.radians(deg))
        p = self.pb[name]
        p.rotation_quaternion = p.rotation_quaternion @ (B.inverted() @ R @ B)
        return self

    def move(self, name, offset):
        """Translate a bone (only used on the hips) by a rest-space offset."""
        B = self.ob.data.bones[name].matrix_local.to_3x3()
        self.pb[name].location = B.inverted() @ Vector(offset)
        return self

    def bone_dir(self, name):
        b = self.ob.data.bones[name]
        return (b.tail_local - b.head_local).normalized()

    # ── body language ──
    def spine(self, bend=0.0, twist=0.0, side=0.0, weights=(0.25, 0.35, 0.4)):
        """Spread a forward bend / twist / side lean over spine→upperChest."""
        for name, w in zip(("spine", "chest", "upperChest"), weights):
            self.rot(name, X, bend * w).rot(name, Z, twist * w).rot(name, Y, side * w)
        return self

    def look(self, yaw=0.0, pitch=0.0, tilt=0.0):
        """Head turn: yaw (+ = her left), pitch (+ = down), tilt (+ = toward her left shoulder)."""
        for name, w in (("neck", 0.4), ("head", 0.6)):
            self.rot(name, Z, yaw * w).rot(name, X, pitch * w).rot(name, Y, tilt * w)
        return self

    def arm(self, s, down=0.0, forward=0.0, twist=0.0, elbow=0.0, wrist=0.0, wrist_side=0.0, shrug=0.0):
        """FK arm. down: lower from the A-pose; forward: swing toward the
        front; twist: about the arm axis; elbow: flex; wrist: flex."""
        k = _side(s)
        d = SPEC.arm_dir(k)
        fwd = Vector((0, -1, 0))
        flex_axis = d.cross(fwd)
        self.rot(s + "Shoulder", Y, -shrug * k)
        self.rot(s + "UpperArm", Y, down * k)
        self.rot(s + "UpperArm", X, -forward)
        self.rot(s + "UpperArm", d, twist * k)
        self.rot(s + "LowerArm", flex_axis, elbow)
        self.rot(s + "Hand", flex_axis, wrist)
        self.rot(s + "Hand", fwd, wrist_side * k)
        return self

    def fingers(self, s, curl=15.0, thumb=10.0, spread=0.0, per=None, thumb_out=0.0):
        """Curl every finger (degrees per joint). ``per`` overrides one finger.
        ``spread`` fans the fingers (degrees between neighbours); ``thumb_out``
        swings the thumb away from the index, in the plane of the palm.

        A character's hand style is layered on every pose: ``FINGER_CASCADE``
        curls each finger a little more than the one before it (index → little,
        the way a real relaxed hand falls) and ``FINGER_SPREAD`` fans them."""
        k = _side(s)
        _d, _thumb, palm_n = SPEC.palm_frame(k)
        cascade = getattr(SPEC, "FINGER_CASCADE", 0.0)
        spread += getattr(SPEC, "FINGER_SPREAD", 0.0)
        for f in FINGERS:
            c = (per or {}).get(f, thumb if f == "Thumb" else curl)
            if f != "Thumb":
                c += cascade * (FINGERS.index(f) - 1) / 3.0
            for i, seg in enumerate(FINGER_SEGS):
                name = f"{s}{f}{seg}"
                fd = self.bone_dir(name)
                axis = fd.cross(palm_n)
                w = (0.8, 1.1, 0.9)[i] if f != "Thumb" else (0.5, 1.0, 1.0)[i]
                self.rot(name, axis, c * w)
                if i == 0 and spread and f != "Thumb":
                    # fan out from the middle: about palm_n (times the side),
                    # a positive angle turns a finger toward the thumb
                    idx = FINGERS.index(f) - 2.5
                    self.rot(name, palm_n, -spread * idx * k)
        if thumb_out:
            self.rot(f"{s}ThumbProximal", palm_n, thumb_out * k)
        return self

    def reach(self, s, target, pole, hand_q=None):
        """Place the wrist at ``target`` (armature space) with Blender's IK,
        elbow pointing at ``pole``, then bake to plain rotations."""
        arm_ob = self.ob
        tgt = bpy.data.objects.new("_ik_target", None)
        pol = bpy.data.objects.new("_ik_pole", None)
        bpy.context.scene.collection.objects.link(tgt)
        bpy.context.scene.collection.objects.link(pol)
        tgt.location = arm_ob.matrix_world @ Vector(target)
        pol.location = arm_ob.matrix_world @ Vector(pole)
        lower = self.pb[s + "LowerArm"]
        # a straight arm is a singular start for the solver (it can't tell
        # which way to fold for a close target) — pre-bend the elbow first
        d = SPEC.arm_dir(_side(s))
        lower.rotation_quaternion = Quaternion()
        self.rot(s + "LowerArm", d.cross(Vector((0, -1, 0))), 60)
        c = lower.constraints.new("IK")
        c.target = tgt
        c.pole_target = pol
        c.pole_angle = math.radians(-90)
        c.chain_count = 2
        c.use_tail = True
        bpy.context.view_layer.update()
        mats = {}
        for name in (s + "UpperArm", s + "LowerArm"):
            p = self.pb[name]
            mats[name] = arm_ob.convert_space(pose_bone=p, matrix=p.matrix, from_space="POSE", to_space="LOCAL")
        lower.constraints.remove(c)
        bpy.data.objects.remove(tgt)
        bpy.data.objects.remove(pol)
        for name, m in mats.items():
            self.pb[name].rotation_quaternion = m.to_quaternion()
        bpy.context.view_layer.update()
        return self

    def twist(self, s, forearm=0.0, hand_flex=0.0, hand_side=0.0):
        """After IK: roll the forearm about its own axis (palm up/down) and
        flex the wrist — neither moves the wrist position."""
        k = _side(s)
        self.rot(s + "LowerArm", self.bone_dir(s + "LowerArm"), forearm * k)
        d = self.bone_dir(s + "Hand")
        self.rot(s + "Hand", d.cross(Vector((0, -1, 0))), hand_flex)
        self.rot(s + "Hand", Vector((0, -1, 0)), hand_side * k)
        return self

    def aim_hand(self, s, direction, palm):
        """Point the hand along ``direction`` with the palm facing ``palm``
        (both armature space), whatever the forearm is doing."""
        bpy.context.view_layer.update()
        pbh = self.pb[s + "Hand"]
        y = Vector(direction).normalized()
        p = Vector(palm)
        p = (p - y * p.dot(y)).normalized()
        # the bone's +X is the palm normal on the left hand, -X on the right
        x = p if s == "left" else -p
        z = x.cross(y).normalized()
        m = Matrix((x, y, z)).transposed().to_4x4()
        m.translation = pbh.matrix.translation
        local = self.ob.convert_space(pose_bone=pbh, matrix=m, from_space="POSE", to_space="LOCAL")
        pbh.rotation_quaternion = local.to_quaternion()
        return self

    def wrist_pos(self, s):
        bpy.context.view_layer.update()
        return self.pb[s + "Hand"].head.copy()

    # ── contact ──
    def cuts(self, s, against, trees=None, hand_only=False):
        """How many of the ``s`` hand's triangles cut through the meshes in
        ``against`` ("hand" = the other hand) in the current pose. Only the arm
        past its sleeve counts (the hand meshes run up to the shoulder): what
        the sleeve covers is hidden, and the hand's own sleeve is skipped.
        ``hand_only`` counts the hand alone, from the wrist on (for poses
        whose bare forearm brushes the coat beside her, out of sight under
        the wide sleeve). Always 0 for a spec without ``HAND_MESHES``."""
        from mathutils.bvhtree import BVHTree

        hands = getattr(SPEC, "HAND_MESHES", None)
        if not hands:
            return 0
        trees = {} if trees is None else trees
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()

        def hand_tree(side, only=False):
            t = trees.get(("hand", side, only))
            if t is None:
                verts, polys = _posed_mesh(hands[side], dg)
                mw = self.ob.matrix_world
                lower = self.pb[side + "LowerArm"]
                elbow, wrist = mw @ lower.head, mw @ lower.tail
                axis = (wrist - elbow).normalized()
                skip = (wrist - elbow).length - 0.01 if only else _sleeve_reach(self.ob, side)
                keep = [p for p in polys if (verts[p[0]] - elbow).dot(axis) > skip]
                t = trees[("hand", side, only)] = BVHTree.FromPolygons(verts, keep)
            return t

        mine = hand_tree(s, hand_only)
        own_sleeve = getattr(SPEC, "SLEEVES", {}).get(s)
        n = 0
        for name in against:
            if name == own_sleeve:
                continue  # the forearm runs inside it
            if name == "hand":
                t = hand_tree("right" if s == "left" else "left")
            else:
                t = trees.get(name)
                if t is None:
                    posed = _posed_mesh(name, dg)
                    if posed is None:
                        continue
                    t = trees[name] = BVHTree.FromPolygons(*posed)
            n += len(mine.overlap(t))
        return n

    def clear(self, pose, moves, step=0.004, limit=0.10, extra=0.003, patience=0.06):
        """Pose with ``pose(offsets)``, then push hands off what they cut.

        ``offsets`` maps each side to a Vector the pose adds to that hand's
        reach target. ``moves`` lists ``(side, axis, against[, hand_only])``
        (see ``cuts``): while that
        hand cuts through anything in ``against`` ("hand" = the other hand),
        its offset grows along ``axis`` a step at a time (earlier entries
        first) for at most ``limit``, then ``extra`` more so it sits just
        clear rather than grazing. A push that stops helping — ``patience``
        further along without cutting through any less — is taken back to
        where the hand cut least: what's left is a cut this push can't fix
        (a forearm brushing the coat by the elbow), and pushing on would only
        float the hand off what it rests on. ``pose`` must rebuild the whole
        pose from scratch. Returns the hands still cutting through something
        (logged in ``CONTACT_LOG``)."""
        offs = {"left": Vector(), "right": Vector()}
        pose(offs)
        if not getattr(SPEC, "HAND_MESHES", None):
            return []
        spent = {m[0]: 0.0 for m in moves}
        best = {m[0]: None for m in moves}  # (fewest cuts, push there)
        done = set()
        while True:
            trees = {}
            bad = None
            for m in moves:
                s, axis, against = m[:3]
                if s in done or spent[s] >= limit:
                    continue
                n = self.cuts(s, against, trees, hand_only=len(m) > 3 and m[3])
                if n == 0:
                    continue
                b = best[s]
                if b is None or n < b[0]:
                    best[s] = (n, spent[s])
                elif spent[s] - b[1] >= patience - 1e-9:
                    # no better for a while: back to where it cut least
                    offs[s] -= Vector(axis).normalized() * (spent[s] - b[1])
                    spent[s] = b[1]
                    done.add(s)
                    pose(offs)
                    trees = {}
                    continue
                bad = m
                break
            if bad is None:
                break
            s, axis = bad[0], bad[1]
            offs[s] += Vector(axis).normalized() * step
            spent[s] += step
            pose(offs)
        moved = [m for m in moves if spent[m[0]] > 0]
        for m in moved:
            offs[m[0]] += Vector(m[1]).normalized() * extra
        if moved:
            pose(offs)
        trees = {}
        stuck = [m[0] for m in moves if self.cuts(m[0], m[2], trees, hand_only=len(m) > 3 and m[3])]
        CONTACT_LOG.append({"pose": getattr(pose, "__qualname__", "?"), "moved_cm": {s: round(v * 100, 1) for s, v in spent.items()}, "stuck": stuck})
        return stuck

    def land(self, pose, moves, step=0.004, limit=0.10, extra=0.003):
        """Pose with ``pose(offsets)``, then bring hands in until they rest on
        what's in front of them: each hand in ``moves`` — ``(side, axis,
        against[, hand_only])`` as for ``clear`` — travels against ``axis`` a
        step at a time until it first cuts through something, then backs off
        to just clear (``extra``). A hand that meets nothing within ``limit``
        stays where the pose put it; one cutting from the start is pushed off
        by ``clear``. Logged in ``CONTACT_LOG`` like ``clear``."""
        offs = {"left": Vector(), "right": Vector()}
        pose(offs)
        if not getattr(SPEC, "HAND_MESHES", None):
            return []
        landed = {}
        for m in moves:
            s, axis, against = m[:3]
            only = len(m) > 3 and m[3]
            a = Vector(axis).normalized()
            if self.cuts(s, against, {}, hand_only=only):
                landed[s] = None
                continue
            went = 0.0
            while went < limit:
                offs[s] -= a * step
                went += step
                pose(offs)
                if self.cuts(s, against, {}, hand_only=only):
                    offs[s] += a * (step + extra)
                    pose(offs)
                    break
            else:
                offs[s] += a * went
                pose(offs)
                went = 0.0
            landed[s] = went
        start = {s: Vector(v) for s, v in offs.items()}

        def again(o):
            pose({s: start[s] + o[s] for s in o})

        stuck = self.clear(again, [m for m in moves if landed.get(m[0]) is None], step, limit, extra) if None in landed.values() else []
        CONTACT_LOG.append({"pose": getattr(pose, "__qualname__", "?"), "landed_cm": {s: (round(v * 100, 1) if v is not None else None) for s, v in landed.items()}, "stuck": stuck})
        return stuck

    # ── keys ──
    def key(self, action, frame):
        # fingers lying on her clothes — or on her other hand — rest ON them
        # (the pose is final now)
        if self.resting:
            rest_hand(self, self.lift)  # (fingers included: settled once, on the stance)
        contact = getattr(SPEC, "HAND_CONTACT", None)
        if contact:
            hands = getattr(SPEC, "HAND_MESHES", None) if self.hands_touch else None
            settle_hands(self, contact, hands=hands, skip=("left",) if self.resting else ())
        # q and -q are the same rotation, but interpolating from one to the
        # other swings through garbage. IK-baked poses can come back with either
        # sign, so keep every bone on the same hemisphere as its previous key.
        last = self._last_q.setdefault(action.name, {})
        for name in BODY_BONES:
            p = self.pb[name]
            q = p.rotation_quaternion.copy()
            prev = last.get(name)
            if prev is not None and prev.dot(q) < 0:
                q.negate()
                p.rotation_quaternion = q
            last[name] = q
            p.keyframe_insert("rotation_quaternion", frame=frame, group=name)
        self.pb["hips"].keyframe_insert("location", frame=frame, group="hips")


# ── reusable poses ──────────────────────────────────────────────────────


# the resting stance's relaxed hands
BASE_FINGERS = {"curl": 14, "thumb": 12}


def base(k, breathe=0.0, sway=0.0, hip=True, lift=0.0):
    """The character's resting stance. ``relaxed``: arms by the sides, soft
    elbows. ``hip``: the same, but her left hand rests on her hip with her
    weight shifted onto one leg (pass ``hip=False`` when a clip drives the
    left arm itself; ``lift`` holds that hand off her hip — see HIP_LIFT)."""
    k.reset()
    k.spine(bend=1.5 + breathe * -1.2, side=sway * 0.8)
    k.look(pitch=-1.0 + breathe * 0.6, tilt=sway * 1.2)
    a = SPEC.ARM_REST
    for s in ("left", "right"):
        k.arm(s, down=a + breathe * 0.8, forward=4, twist=-8, elbow=12 + breathe * 1.5, wrist=6, shrug=breathe * 1.2)
        k.fingers(s, **BASE_FINGERS)
    k.move("hips", (sway * 0.004, 0, breathe * 0.0015))
    if hip and SPEC.BASE_STYLE == "hip":
        hip_pose(k, breathe, lift)
    return k


_RADII = {"Thumb": 0.0080, "Index": 0.0062, "Middle": 0.0064, "Ring": 0.0060, "Little": 0.0053}


def settle_hands(k, surfaces, clearance=0.002, touch=0.007, most=8, radii=None, hands=None, skip=()):
    """Make every finger that lies on (or in) one of ``surfaces`` rest ON it:
    one sunk into the cloth lifts just enough to clear it, one hovering
    within ``touch`` of it curls down onto it (at most ``most`` degrees).
    Fingers touching nothing are left as posed. Each finger is swung as a
    chain of capsules round its own curl axes (the ones ``fingers`` uses)
    against the posed surfaces, so it runs on every key of every clip — the
    body may have moved under a hand since it was placed.

    ``hands`` ({side: mesh}) adds the OTHER hand as a surface for each hand's
    fingers, so folded or clasped fingers lie on the hand under them. Sides
    in ``skip`` are left alone."""
    from mathutils.bvhtree import BVHTree

    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    # (tree, oriented): cloth sheets have no reliable inside, so their normals
    # are turned to face away from her middle; a closed hand mesh's own
    # normals already point out
    cloth = [(BVHTree.FromObject(bpy.data.objects[n], dg), False) for n in surfaces if n in bpy.data.objects]
    hand_trees = {s: BVHTree.FromObject(bpy.data.objects[n], dg) for s, n in (hands or {}).items() if n in bpy.data.objects}
    radii = radii or _RADII
    mw = k.ob.matrix_world
    for s in ("left", "right"):
        if s in skip:
            continue
        other = hand_trees.get("right" if s == "left" else "left")
        trees = cloth + ([(other, True)] if other else [])
        _d, _thumb, palm_n = SPEC.palm_frame(_side(s))
        for f in FINGERS:
            names = [f"{s}{f}{seg}" for seg in FINGER_SEGS]
            pbs = [k.pb[n] for n in names]
            pts = [mw @ pbs[0].head, mw @ pbs[1].head, mw @ pbs[2].head, mw @ pbs[2].tail]
            pts.append(pts[3] + (pts[3] - pts[2]).normalized() * radii[f] * 0.3)  # the fingertip ends about here
            axes = []
            for n, pb in zip(names, pbs):
                rest = k.ob.data.bones[n].matrix_local.to_3x3()
                ax = k.bone_dir(n).cross(palm_n).normalized()
                axes.append((mw.to_3x3() @ pb.matrix.to_3x3() @ rest.inverted() @ ax).normalized())
            w = (0.5, 1.0, 1.0) if f == "Thumb" else (0.8, 1.1, 0.9)

            def clearance_at(delta):
                p = [v.copy() for v in pts]
                a = [v.copy() for v in axes]
                for j in range(3):
                    R = Quaternion(a[j], math.radians(delta * w[j]))
                    for i in range(j + 1, len(p)):
                        p[i] = p[j] + R @ (p[i] - p[j])
                    for i in range(j + 1, 3):
                        a[i] = R @ a[i]
                worst = 1.0
                for i in range(len(p) - 1):
                    for t in (0.0, 0.33, 0.66, 1.0):
                        q = p[i].lerp(p[i + 1], t)
                        for tree, oriented in trees:
                            loc, nrm, _x, _dist = tree.find_nearest(q, 0.03)
                            if loc is None:
                                continue
                            gap = q - loc
                            # only a surface the finger actually lies over counts —
                            # not one it merely passes at a rim (the obi's lower edge)
                            if gap.length > 1e-5 and abs(nrm.dot(gap.normalized())) < 0.6:
                                continue
                            if not oriented and nrm.dot(Vector((loc.x, loc.y, 0.0))) < 0:
                                nrm = -nrm
                            worst = min(worst, gap.dot(nrm) - radii[f])
                return worst

            c0 = clearance_at(0)
            if c0 >= touch:
                continue  # resting on nothing
            # curl down onto it as far as it still clears, or lift it free
            tries = range(most, 0, -1) if c0 >= clearance else range(-1, -31, -1)
            delta = 0
            for d in tries:
                if clearance_at(d) >= clearance:
                    delta = d
                    break
            else:
                delta = 0 if c0 >= clearance else -30
            for i, n in enumerate(names):
                k.rot(n, k.bone_dir(n).cross(palm_n), delta * w[i])
    return k


# the resting hand in hips space — (hand matrix, elbow, finger rotations) —
# from the reference stance; set up by build_actions (None while that stance
# is being made)
_HIP_REF = None


def _hip_fingers(k):
    """the resting hand's fingers, from scratch (base hand + the hip style)"""
    for f in FINGERS:
        for seg in FINGER_SEGS:
            k.pb[f"left{f}{seg}"].rotation_quaternion = Quaternion()
    k.fingers("left", **BASE_FINGERS)
    # (``fingers`` arguments — a character may set its own)
    k.fingers("left", **getattr(SPEC, "HIP_FINGERS", {"curl": 11, "thumb": 4, "spread": 4}))


def rest_hand(k, lift=0.0):
    """Put the left hand back on her hip: where it rests in the reference
    stance, relative to her hips as they are now. It rests on cloth hanging
    from her hips, so it must ride with them — however a clip has bent or
    turned her spine since (or her hips have breathed), a hand left where it
    was placed slides through that cloth. ``PoseKit.key`` calls this on
    every key of a hand-on-hip pose.

    ``lift`` (m) holds the hand that far off her hip, straight out from its
    palm: the way a hand leaves the hip (see ``HIP_LIFT``)."""
    bpy.context.view_layer.update()
    H = k.pb["hips"].matrix.copy()
    hand, elbow, fingers = _HIP_REF
    W = H @ hand
    R = W.to_3x3()
    out = -R.col[0].normalized() * lift  # (+X is the left palm's normal)
    k.reach("left", W.translation + out, H @ elbow + out)
    # the bone's +Y runs along the hand, +X is the left palm's normal
    k.aim_hand("left", R.col[1], R.col[0])
    # the fingers as they were settled on her clothes in that stance — settling
    # them afresh on every key would curl one down onto the obi wherever a
    # turn of her spine brought it near, through the coat lying between
    for name, q in fingers.items():
        k.pb[name].rotation_quaternion = q.copy()
    return k


def hip_pose(k, breathe=0.0, lift=0.0):
    """Left hand on the hip, weight on the left leg — a confident stance.
    The hand itself is (re)placed by ``rest_hand`` when the pose is keyed
    (``lift``: held that far off the hip)."""
    if _HIP_REF is None:
        # the reference stance: the hand put on her hip, then her hips and
        # spine settle into the stance around it (the look it was tuned for)
        P = SPEC.POINTS
        k.reach("left", P["hip_left"], P["hip_left"] + Vector((0.20, 0.28, 0.12)))
        # (finger direction, palm normal) — a character may set its own
        direction, palm = getattr(SPEC, "HIP_HAND", ((-0.30, -0.25, -1.0), (-1.0, 0.25, 0.1)))
        k.aim_hand("left", direction, palm)
        _hip_fingers(k)
    # contrapposto: hips tip and slide over the standing leg, chest answers
    k.move("hips", (0.014, 0, breathe * 0.0015))
    k.rot("hips", Y, 3.0)
    # a slightly wider stance, soles kept level
    for s, sd in (("left", 1), ("right", -1)):
        k.rot(s + "UpperLeg", Y, -2.0 * sd)
        k.rot(s + "Foot", Y, 2.0 * sd)
    # the free arm hangs a touch away from her — clear of the coat swinging
    # beside it — elbow soft, the hand relaxed with its palm toward her thigh
    k.arm("right", down=-3)
    k.rot("rightLowerArm", SPEC.arm_dir(-1).cross(Vector((0, -1, 0))), 14)
    k.aim_hand("right", (0.06, -0.20, -1.0), (1.0, 0.12, 0.0))
    k.spine(side=-4.0)
    k.look(tilt=-3.0)
    if _HIP_REF is not None:
        k.resting = True
        k.lift = lift
        rest_hand(k, lift)
    return k


# how far a hand-on-hip character lifts her hand off her hip (straight out
# from the palm) before it goes anywhere: the coat it rests on is pressed in
# under it (HipPress) and hangs ~5 cm further out once the hand has gone, so
# a hand gliding straight off the hip toward a gesture would sweep through it
HIP_LIFT = 0.08


def hip_style():
    return SPEC.BASE_STYLE == "hip"


def lifted(k, act, f, part=1.0, **kw):
    """Key her stance with the resting hand lifted off the hip (``part`` of
    ``HIP_LIFT``) — between a key with the hand on her hip and one where it's
    elsewhere. Nothing for a character without a hand-on-hip stance."""
    if hip_style():
        base(k, lift=HIP_LIFT * part, **kw).key(act, f)


def hip_wrist(k, lift=0.0):
    """Where the resting hand's wrist is (``lift`` off the hip), given her hips
    as they are now — for gestures that start from it."""
    bpy.context.view_layer.update()
    W = k.pb["hips"].matrix @ _HIP_REF[0]
    return W.translation - W.to_3x3().col[0].normalized() * lift


_NO_OFFSET = {"left": Vector(), "right": Vector()}


def hands_behind(k, offs=_NO_OFFSET):
    """Hands clasped behind her back, one laid in the other: both palms face
    back, the left against her, the right over it (fingers crossing). The
    right hand sits lower, so the left thumb (which juts toward it) clears
    its top edge. The solver (``PoseKit.clear``) pushes them apart."""
    b = SPEC.POINTS["hands_behind"]
    for s in ("left", "right"):
        sd = _side(s)
        tgt = Vector((sd * b.x, b.y, b.z)) + offs[s]
        if s == "right":
            tgt += Vector((0.0, 0.0, -0.045))
        k.reach(s, tgt, Vector((sd * 0.36, b.y + 0.04, b.z + 0.10)) + offs[s])
        k.aim_hand(s, (-sd * 0.80, 0.08, -0.60), (0.0, 1.0, 0.0))
        if s == "left":
            k.fingers(s, curl=10, thumb=0)
        else:
            k.fingers(s, curl=4, thumb=8, per={"Ring": 0, "Little": -6})
    k.hands_touch = True
    return k


def fold_hands(k, at, offs=_NO_OFFSET):
    """Hands folded in front of her, the right laid over the left: palms in,
    the left hand's fingers toward her right and down, the right hand's
    toward her left. The right sits a little higher and further over, so the
    left hand's upper edge nests in its thumb web (a thumb juts out of the
    palm — stacked squarely, the thumb would hold the hands apart). The
    solver (``PoseKit.clear``) pushes the left hand off her clothes and the
    right one off the left."""
    for s in ("left", "right"):
        sd = _side(s)
        tgt = at + Vector((sd * 0.045, 0.0, 0.0)) + offs[s]
        if s == "right":
            tgt += Vector((0.025, 0.0, 0.045))
        k.reach(s, tgt, tgt + Vector((sd * 0.33, 0.12, 0.03)))
        k.aim_hand(s, (-sd * 0.78, -0.06, -0.62), (0.0, 1.0, 0.0))
        # the outer hand lies nearly flat over the inner one (key-time
        # settling curls its fingers down onto it)
        if s == "left":
            k.fingers(s, curl=10, thumb=0)
        else:
            k.fingers(s, curl=2, thumb=8, thumb_out=8, per={"Ring": -2, "Little": -6})
    k.hands_touch = True
    return k


def folded(k, pose):
    """Solve a pose built on ``fold_hands``: the left hand clears her clothes,
    the right clears her clothes and the left hand (both come forward)."""
    fwd = (0.0, -1.0, 0.0)
    return k.clear(pose, [("left", fwd, _solids()), ("right", fwd, _solids() + ["hand"])])


def _eased(anchors, f):
    """A value eased between ``(frame, value)`` anchors. Clips whose hands meet
    are keyed every few frames with it: each key is solved (IK + contact),
    and rotations interpolated across a long span — a bending, swaying body
    under two hands — would let the hands drift into each other."""
    i = max([j for j in range(len(anchors)) if anchors[j][0] <= f] or [0])
    (fa, a), (fb, b) = anchors[i], anchors[min(i + 1, len(anchors) - 1)]
    return a if fb == fa else a + (b - a) * smoothstep(fa, fb, f)


def new_action(arm_ob, name, frames, loop):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    act.frame_range = (0, frames)
    act.use_frame_range = True
    act["loop"] = loop
    arm_ob.animation_data_create()
    arm_ob.animation_data.action = act
    return act


def push_to_nla(arm_ob, act):
    track = arm_ob.animation_data.nla_tracks.new()
    track.name = act.name
    track.strips.new(act.name, 0, act)
    track.mute = True
    arm_ob.animation_data.action = None


# ── clips ───────────────────────────────────────────────────────────────


def clip_idle(arm_ob, k):
    act = new_action(arm_ob, "Idle", 120, True)
    for f, br, sw in ((0, 0.0, 0.0), (30, 0.5, 0.6), (60, 1.0, 0.0), (90, 0.5, -0.6), (120, 0.0, 0.0)):
        base(k, breathe=br, sway=sw).key(act, f)
    return act


def clip_listen(arm_ob, k):
    """Attentive: leaning in, head tilted, hands clasped behind her back. A
    hand-on-hip character listens in her stance instead — hand on hip, the
    other arm by her side: the app crossfades into and out of this loop
    bone by bone, and that blend swings a hand going behind her back
    straight through her hip and thigh (and sweeps a resting hand through
    the coat it lies on)."""
    act = new_action(arm_ob, "Listen", 120, True)
    back = (0.0, 1.0, 0.0)
    for f, br in ((0, 0.0), (60, 1.0), (120, 0.0)):
        if hip_style():
            base(k, breathe=br)
            k.spine(bend=6 + br * 0.8, side=-1.5)
            k.look(pitch=2 - br * 0.5, tilt=-9 - br, yaw=2)
            # leaning in swings a hanging arm back with her — into the coat
            # beside it; the free arm keeps hanging (a touch forward)
            k.arm("right", forward=8 + br * 0.8)
            k.key(act, f)
            continue

        def pose(offs, br=br):
            k.reset()
            k.spine(bend=6 + br * 0.8, side=-1.5)
            k.look(pitch=2 - br * 0.5, tilt=-9 - br, yaw=2)
            hands_behind(k, offs)
            k.move("hips", (0, 0, br * 0.0015))

        # the left hand comes off her coat, the right off the left
        k.clear(pose, [("left", back, _solids()), ("right", back, _solids() + ["hand"])])
        k.key(act, f)
    return act


def clip_think(arm_ob, k):
    """Curled right hand resting under her chin, head tilted, eyes drifting
    up. The left arm crosses her waist and props the right elbow — unless
    she stands hand-on-hip (``BASE_STYLE``): then her left hand stays on her
    hip and the right elbow rests out by her side, the forearm rising past
    the outside of her chest (an arm folded across a full bust and an open
    coat can only cut through them)."""
    act = new_action(arm_ob, "Think", 150, True)
    P = SPEC.POINTS
    hip = SPEC.BASE_STYLE == "hip"
    for f, br in ((0, 0.0), (75, 1.0), (150, 0.0)):

        def pose(offs, br=br):
            if hip:
                base(k, breathe=br)
            else:
                k.reset()
            k.spine(bend=3, twist=4, side=1.5 + br * 0.6)
            k.look(yaw=6, pitch=-4 - br * 1.5, tilt=8 + br)
            wrist = P["chin_wrist"] + Vector((0, 0, br * 0.003)) + offs["right"]
            elbow = (-0.30, -0.04, -0.12) if hip else (-0.175, 0.08, -0.21)
            k.reach("right", wrist, wrist + Vector(elbow))
            k.twist("right", forearm=-35)
            k.aim_hand("right", (0.28, -0.10, 1.0), (0.25, 0.85, 0.35))
            k.fingers("right", curl=62, thumb=25, per={"Index": 30})
            if not hip:
                waist = P["waist_hold"]
                k.reach("left", waist, waist + Vector((0.32, 0.115, -0.065)))
                k.twist("left", forearm=-40, hand_flex=10)
                k.fingers("left", curl=40, thumb=22)

        k.clear(pose, [("right", (0.0, -1.0, 0.0), _solids())])
        k.key(act, f)
    return act


def clip_talk(arm_ob, k):
    """Relaxed conversational loop with small open-palm gestures in front."""
    act = new_action(arm_ob, "Talk", 180, True)
    # (frame, breath, right gesture, left gesture, left hand lifted off the hip)
    poses = (
        (0, 0.0, 0.0, 0.0, False),
        (40, 0.6, 1.0, 0.0, False),
        (60, 0.4, 0.68, 0.0, False),
        (80, 0.2, 0.35, 0.0, False),
        (90, 0.35, 0.26, 0.0, True),
        (120, 0.8, 0.0, 1.0, False),
        (155, 0.3, 0.0, 0.25, False),
        (170, 0.12, 0.0, 0.0, True),
        (180, 0.0, 0.0, 0.0, False),
    )
    for f, br, rg, lg, up in poses:
        if up and not hip_style():
            continue
        base(k, breathe=br, sway=(rg - lg) * 0.6, hip=lg < 0.01, lift=HIP_LIFT if up else 0.0)
        for s, sd, g in (("right", -1, rg), ("left", 1, lg)):
            if g < 0.01:
                continue
            # a hand-on-hip character's left hand sets off from her hip
            rest = hip_wrist(k, HIP_LIFT) if s == "left" and hip_style() else k.wrist_pos(s)
            t = SPEC.POINTS["talk"]
            gesture = Vector((sd * t.x, t.y, t.z))
            # out to the gesture and back on an arc bowed forward: on the
            # straight line the hand brushed the coat's front edge
            tgt = rest.lerp(gesture, g) + Vector((0.0, -0.05 * math.sin(math.pi * g), 0.0))
            k.reach(s, tgt, tgt + Vector((sd * 0.30, 0.12, -0.06)))
            k.twist(s, forearm=-95 * g, hand_flex=-12 * g)
            k.fingers(s, curl=14 - 9 * g, thumb=12 - 8 * g, spread=5 * g)
        k.look(yaw=(rg - lg) * -4, tilt=(rg - lg) * 2)
        k.key(act, f)
    return act


def clip_wave(arm_ob, k):
    """A bright, friendly wave with her right hand: forearm up, palm to the
    viewer, fingers up and loosely spread. The forearm rocks side to side
    from the elbow and the hand follows it a beat behind (the wrist lags, then
    overtakes), which is what makes a wave read as a wave rather than a
    flapping hand. Keyed densely so that lag survives the interpolation."""
    act = new_action(arm_ob, "Wave", 96, False)
    up = SPEC.POINTS["wave"]
    pole = up + Vector((-0.35, 0.10, -0.25))
    # (outward = toward her right, -X)

    def raised(swing, lag, f):
        base(k, breathe=0.3)
        k.spine(side=-2.5, twist=-3)
        k.look(tilt=-8, yaw=-3)
        # the wrist sweeps a shallow arc round the elbow
        tgt = up + Vector((-0.055 * swing, 0.0, -0.012 * swing * swing))
        k.reach("right", tgt, pole)
        # fingers up — leaning in a little with the forearm, so the wrist isn't
        # held bent — tilting with it (plus the wrist's lag); palm to the
        # viewer, turned a touch toward her middle
        a = math.radians(-10.0 + 15.0 * swing + 11.0 * lag)
        k.aim_hand("right", (-math.sin(a), 0.0, math.cos(a)), (0.25, -1.0, 0.0))
        # an open, waving hand: fingers fanned, thumb swung out, the outer
        # fingers following the swing a touch (a loose hand, not a paddle)
        k.fingers("right", curl=3, thumb=-2, spread=11 + 2.0 * abs(lag), thumb_out=5)
        k.key(act, f)

    base(k).key(act, 0)
    raised(0.0, 0.0, 12)
    # ~1.9 waves a second (16 frames per side-to-side cycle at 30 fps),
    # easing in from the raise and out before lowering
    w0, w1, period = 12, 72, 16.0
    for f in range(w0 + 2, w1 + 1, 2):
        u = (f - w0) / (w1 - w0)
        env = smoothstep(0.0, 0.22, u) * (1.0 - smoothstep(0.82, 1.0, u))
        ph = 2.0 * math.pi * (f - w0) / period
        raised(env * math.sin(ph), env * math.sin(ph - 1.0), f)
    base(k).key(act, 96)
    return act


def clip_nod(arm_ob, k):
    act = new_action(arm_ob, "Nod", 42, False)
    for f, p in ((0, 0), (8, 11), (16, -2), (24, 8), (32, 0), (42, 0)):
        base(k, breathe=0.4)
        k.look(pitch=p, tilt=2)
        k.spine(bend=p * 0.15)
        k.key(act, f)
    return act


def clip_happy(arm_ob, k):
    """'Yay!' — fists up by her chest with a little hop."""
    act = new_action(arm_ob, "Happy", 64, False)

    def cheer(f, amt, hop):
        if amt <= 0.0:
            # the clip starts and ends on her stance (for a hand-on-hip
            # character, the hand on her hip — not hanging, which the app
            # would have to blend through her coat to reach)
            base(k, breathe=0.5).key(act, f)
            return
        base(k, breathe=0.5, hip=False)
        for s, sd in (("left", 1), ("right", -1)):
            # every term scales with amt, so the clip starts and ends on the
            # base stance (a fixed extra drop pushed the hands into her hips)
            k.arm(s, down=16 * amt, forward=30 * amt, elbow=120 * amt, twist=-30 * amt, wrist=-10 * amt)
            k.fingers(s, curl=14 + 60 * amt, thumb=12 + 30 * amt)
        k.spine(bend=-3 * amt, side=0)
        k.look(pitch=-5 * amt, tilt=6 * amt)
        k.move("hips", (0, 0, hop))
        k.key(act, f)

    cheer(0, 0.0, 0.0)
    lifted(k, act, 4, breathe=0.5)
    cheer(10, 1.0, 0.0)
    cheer(18, 1.0, 0.035)
    cheer(26, 1.0, 0.0)
    cheer(34, 1.0, 0.025)
    cheer(42, 1.0, 0.0)
    lifted(k, act, 56, breathe=0.5)
    cheer(64, 0.0, 0.0)
    return act


def clip_bow(arm_ob, k):
    """A polite greeting bow, hands folded in front."""
    act = new_action(arm_ob, "Bow", 72, False)
    front = SPEC.POINTS["bow_front"]

    def bow(f, amt):
        def pose(offs):
            base(k, hip=amt <= 0)
            k.spine(bend=24 * amt, weights=(0.3, 0.35, 0.35))
            k.look(pitch=12 * amt)
            if amt > 0:
                fold_hands(k, front, offs)

        if amt > 0:
            folded(k, pose)
        else:
            pose(_NO_OFFSET)
        k.key(act, f)

    # keyed every few frames while the hands are folded (see _eased)
    anchors = ((14, 0.35), (28, 1.0), (44, 1.0), (60, 0.25))
    bow(0, 0.0)
    lifted(k, act, 5)
    for f in list(range(14, 60, 4)) + [60]:
        bow(f, _eased(anchors, f))
    lifted(k, act, 67)
    bow(72, 0.0)
    return act


def clip_surprised(arm_ob, k):
    """A gasp: both hands fly up to her upper chest, one each side, fingers
    up toward her collarbones and loosely spread — the fingertips stop short
    of each other instead of lacing through."""
    act = new_action(arm_ob, "Surprised", 54, False)
    chest = SPEC.POINTS["chest_front"]
    fwd = (0.0, -1.0, 0.0)
    # (finger direction, palm normal) for her left hand — mirrored for the
    # right; a spec can lay the hands along its own chest's slope. Each hand
    # then comes in from the target until it rests on her chest.
    (dx, dy, dz), (px, py, pz) = getattr(SPEC, "SURPRISED_HAND", ((0.36, 0.42, 1.0), (0.15, 1.0, -0.35)))

    def gasp(f, amt):
        def pose(offs):
            base(k, hip=amt <= 0.01)
            k.spine(bend=-6 * amt)
            k.look(pitch=-6 * amt)
            if amt > 0.01:
                for s, sd in (("left", 1), ("right", -1)):
                    tgt = chest + Vector((sd * 0.085, 0.0, -0.03)) + offs[s]
                    k.reach(s, tgt, tgt + Vector((sd * 0.3, 0.1, -0.25)))
                    k.aim_hand(s, (-sd * dx, dy, dz), (sd * px, py, pz))
                    k.fingers(s, curl=7, thumb=4, spread=5 * amt)

        if amt > 0.01:
            # each hand comes in until it rests on her chest (the hands alone
            # count: the bare forearms brush the coat by the elbows, out of
            # sight under the sleeves)
            k.land(pose, [("left", fwd, _solids() + ["hand"], True), ("right", fwd, _solids() + ["hand"], True)])
        else:
            pose(_NO_OFFSET)
        k.key(act, f)

    gasp(0, 0.0)
    # (a quick gesture: the hand comes off her hip in two steps, so it goes
    # straight out rather than wherever the blend of two keys would take it)
    lifted(k, act, 2, part=0.5)
    lifted(k, act, 4)
    gasp(7, 1.0)
    gasp(36, 1.0)
    lifted(k, act, 46)
    lifted(k, act, 50, part=0.5)
    gasp(54, 0.0)
    return act


def clip_shy(arm_ob, k):
    """Hands clasped in front, swaying, head ducked — bashful."""
    act = new_action(arm_ob, "Shy", 100, False)
    front = SPEC.POINTS["shy_front"]
    # the sway, keyed every few frames while the hands are folded (see _eased)
    anchors = ((14, 0.0), (35, 1.0), (55, -1.0), (75, 0.6))
    # (keys go in in time order: each is kept sign-continuous with the last)
    keys = [(0, None), (5, "lift")] + [(f, _eased(anchors, f)) for f in list(range(14, 75, 5)) + [75]]
    keys += [(91, "lift"), (100, None)]
    for f, sw in keys:
        if sw == "lift":
            lifted(k, act, f)
            continue
        if sw is None:
            base(k).key(act, f)
            continue

        def pose(offs, sw=sw):
            base(k, sway=sw, hip=False)
            k.spine(bend=4, twist=sw * 4)
            k.look(pitch=10, tilt=-10 + sw * 4, yaw=-sw * 5)
            fold_hands(k, front, offs)

        folded(k, pose)
        k.key(act, f)
    return act


def _sweep(a, b, c, t):
    """a → b → c on the unit sphere (t in 0..1)"""

    def slerp(u, v, s):
        om = math.acos(max(-1.0, min(1.0, u.dot(v))))
        if om < 1e-5:
            return u.copy()
        return (u * math.sin((1 - s) * om) + v * math.sin(s * om)) / math.sin(om)

    return slerp(a, b, t * 2) if t < 0.5 else slerp(b, c, t * 2 - 1)


def clip_stretch(arm_ob, k):
    """Idle variation: a big stretch, arms swept up overhead. Each wrist
    travels out round her side and up (never past her head) to finish above
    it, the hands apart, fingers up and loosely open, palms forward."""
    act = new_action(arm_ob, "Stretch", 130, False)
    top = SPEC.POINTS["stretch_top"]
    J = SPEC.JOINTS
    side_ways = (1.0, 0.0, 0.0)

    def stretch(f, amt):
        def pose(offs):
            base(k, hip=amt <= 0)
            k.spine(bend=-8 * amt, side=0)
            k.look(pitch=-12 * amt)
            if amt > 0:
                for s, sd in (("left", 1), ("right", -1)):
                    sh = J[s + "UpperArm"]
                    rest = k.wrist_pos(s) - sh
                    end = top + Vector((sd * 0.11, 0, 0)) + offs[s] - sh
                    out = Vector((sd * 0.95, -0.25, 0.25)).normalized()
                    d = _sweep(rest.normalized(), out, end.normalized(), amt)
                    tgt = sh + d * (rest.length + (end.length - rest.length) * amt)
                    k.reach(s, tgt, tgt + Vector((sd * 0.4, 0.1, -0.1)))
                    up = (-sd * 0.22, -0.05, 1.0)
                    k.aim_hand(s, d.lerp(Vector(up).normalized(), 0.35 + 0.65 * amt), (-sd * 0.35 * amt, -1.0, 0.1))
                    k.fingers(s, curl=3 * amt, thumb=4 * amt, spread=6 * amt)
            k.move("hips", (0, 0, 0.012 * amt))

        if amt > 0:
            # each hand keeps out of her head, her hair and the other hand
            k.clear(pose, [("left", side_ways, _solids() + ["hand"]), ("right", (-1.0, 0.0, 0.0), _solids() + ["hand"])])
        else:
            pose(_NO_OFFSET)
        k.key(act, f)

    stretch(0, 0.0)
    lifted(k, act, 6)
    stretch(25, 0.6)
    stretch(45, 1.0)
    stretch(80, 1.0)
    stretch(105, 0.3)
    lifted(k, act, 121)
    stretch(130, 0.0)
    return act


def clip_explain(arm_ob, k):
    """'Here's the thing…' — right palm opens up and out toward you."""
    act = new_action(arm_ob, "Explain", 80, False)

    def ex(f, amt, beat=0.0):
        base(k, breathe=0.4)
        if amt > 0.01:
            rest = k.wrist_pos("right")
            tgt = rest.lerp(SPEC.POINTS["explain"] + Vector((0, 0, beat * 0.012)), amt)
            k.reach("right", tgt, tgt + Vector((-0.30, 0.12, -0.08)))
            k.twist("right", forearm=-110 * amt, hand_flex=-20 * amt + beat * 6)
            k.fingers("right", curl=14 - 11 * amt, thumb=12 - 10 * amt, spread=7 * amt)
        k.spine(twist=-5 * amt, side=-1.5 * amt)
        k.look(yaw=-6 * amt, tilt=4 * amt + beat * 2, pitch=beat * 3)
        k.key(act, f)

    ex(0, 0.0)
    ex(14, 1.0)
    ex(30, 1.0, 1.0)
    ex(46, 1.0, 0.0)
    ex(58, 1.0, 0.6)
    ex(80, 0.0)
    return act


CLIPS = [
    clip_idle, clip_talk, clip_listen, clip_think, clip_wave, clip_nod, clip_happy,
    clip_bow, clip_surprised, clip_shy, clip_stretch, clip_explain,
]


def build_actions(arm_ob, spec):
    global SPEC, _HIP_REF
    SPEC = spec
    _SLEEVE_REACH.clear()
    CONTACT_LOG.clear()
    bpy.context.scene.render.fps = FPS
    k = PoseKit(arm_ob)
    _HIP_REF = None
    if SPEC.BASE_STYLE == "hip":
        # where the resting hand sits on her hip, in hips space (every
        # hand-on-hip key puts it back there — see rest_hand)
        base(k)
        contact = getattr(SPEC, "HAND_CONTACT", None)
        if contact:
            settle_hands(k, contact, hands=getattr(SPEC, "HAND_MESHES", None), skip=("right",))
        bpy.context.view_layer.update()
        H = k.pb["hips"].matrix.inverted()
        fingers = {f"left{f}{seg}": k.pb[f"left{f}{seg}"].rotation_quaternion.copy() for f in FINGERS for seg in FINGER_SEGS}
        _HIP_REF = (H @ k.pb["leftHand"].matrix, H @ k.pb["leftLowerArm"].head, fingers)
    names = []
    for fn in CLIPS:
        act = fn(arm_ob, k)
        push_to_nla(arm_ob, act)
        names.append(act.name)
    k.reset()
    return names


def preview_pose(arm_ob, action_name, frame):
    """Pose the armature at a clip frame (for preview renders)."""
    act = bpy.data.actions[action_name]
    arm_ob.animation_data_create()
    for t in arm_ob.animation_data.nla_tracks:
        t.mute = True
    arm_ob.animation_data.action = act
    bpy.context.scene.frame_set(frame)
