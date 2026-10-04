"""Gesture & loop clips, authored as code and exported as glTF animations.

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

from .body import JOINTS, _arm_dir, palm_frame
from .rig import FINGER_SEGS, FINGERS

FPS = 30
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))

BODY_BONES = (
    ["hips", "spine", "chest", "upperChest", "neck", "head"]
    + [f"{s}{b}" for s in ("left", "right") for b in ("Shoulder", "UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot")]
    + [f"{s}{f}{seg}" for s in ("left", "right") for f in FINGERS for seg in FINGER_SEGS]
)


def _side(s):
    return 1 if s == "left" else -1


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
        d = _arm_dir(k)
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

    def fingers(self, s, curl=15.0, thumb=10.0, spread=0.0, per=None):
        """Curl every finger (degrees per joint). ``per`` overrides one finger."""
        k = _side(s)
        _d, _thumb, palm_n = palm_frame(k)
        for f in FINGERS:
            c = (per or {}).get(f, thumb if f == "Thumb" else curl)
            for i, seg in enumerate(FINGER_SEGS):
                name = f"{s}{f}{seg}"
                fd = self.bone_dir(name)
                axis = fd.cross(palm_n)
                w = (0.8, 1.1, 0.9)[i] if f != "Thumb" else (0.5, 1.0, 1.0)[i]
                self.rot(name, axis, c * w)
                if i == 0 and spread and f != "Thumb":
                    idx = FINGERS.index(f) - 2.5
                    self.rot(name, palm_n, spread * idx * k)
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
        d = _arm_dir(_side(s))
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

    # ── keys ──
    def key(self, action, frame):
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


def base(k, breathe=0.0, sway=0.0):
    """Relaxed stand: arms by the sides, soft elbows, natural hands."""
    k.reset()
    k.spine(bend=1.5 + breathe * -1.2, side=sway * 0.8)
    k.look(pitch=-1.0 + breathe * 0.6, tilt=sway * 1.2)
    for s in ("left", "right"):
        k.arm(s, down=37 + breathe * 0.8, forward=4, twist=-8, elbow=12 + breathe * 1.5, wrist=6, shrug=breathe * 1.2)
        k.fingers(s, curl=14, thumb=12)
    k.move("hips", (sway * 0.004, 0, breathe * 0.0015))
    return k


def hands_behind(k):
    for s in ("left", "right"):
        sd = _side(s)
        tgt = Vector((sd * 0.045, 0.118, 0.925))
        k.reach(s, tgt, Vector((sd * 0.36, 0.16, 1.02)))
        k.twist(s, forearm=30, hand_flex=10)
        k.fingers(s, curl=38, thumb=24)
    return k


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
    """Attentive: hands clasped behind her back, leaning in, head tilted."""
    act = new_action(arm_ob, "Listen", 120, True)
    for f, br in ((0, 0.0), (60, 1.0), (120, 0.0)):
        k.reset()
        k.spine(bend=6 + br * 0.8, side=-1.5)
        k.look(pitch=2 - br * 0.5, tilt=-9 - br, yaw=2)
        hands_behind(k)
        k.move("hips", (0, 0, br * 0.0015))
        k.key(act, f)
    return act


def clip_think(arm_ob, k):
    """Curled right hand resting under her chin, left arm across her waist
    propping the elbow, head tilted, eyes drifting up."""
    act = new_action(arm_ob, "Think", 150, True)
    for f, br in ((0, 0.0), (75, 1.0), (150, 0.0)):
        k.reset()
        k.spine(bend=3, twist=4, side=1.5 + br * 0.6)
        k.look(yaw=6, pitch=-4 - br * 1.5, tilt=8 + br)
        wrist = Vector((-0.045, -0.142, 1.172 + br * 0.003))
        k.reach("right", wrist, Vector((-0.22, -0.06, 0.96)))
        k.twist("right", forearm=-35)
        k.aim_hand("right", (0.28, -0.10, 1.0), (0.25, 0.85, 0.35))
        k.fingers("right", curl=62, thumb=25, per={"Index": 30})
        waist = Vector((-0.02, -0.135, 1.005))
        k.reach("left", waist, Vector((0.30, -0.02, 0.94)))
        k.twist("left", forearm=-40, hand_flex=10)
        k.fingers("left", curl=40, thumb=22)
        k.key(act, f)
    return act


def clip_talk(arm_ob, k):
    """Relaxed conversational loop with small open-palm gestures in front."""
    act = new_action(arm_ob, "Talk", 180, True)
    poses = (
        (0, 0.0, 0.0, 0.0),
        (40, 0.6, 1.0, 0.0),
        (80, 0.2, 0.35, 0.0),
        (120, 0.8, 0.0, 1.0),
        (155, 0.3, 0.0, 0.25),
        (180, 0.0, 0.0, 0.0),
    )
    for f, br, rg, lg in poses:
        base(k, breathe=br, sway=(rg - lg) * 0.6)
        for s, sd, g in (("right", -1, rg), ("left", 1, lg)):
            if g < 0.01:
                continue
            rest = k.wrist_pos(s)
            gesture = Vector((sd * 0.17, -0.19, 1.02))
            tgt = rest.lerp(gesture, g)
            k.reach(s, tgt, tgt + Vector((sd * 0.30, 0.12, -0.06)))
            k.twist(s, forearm=-95 * g, hand_flex=-12 * g)
            k.fingers(s, curl=14 - 9 * g, thumb=12 - 8 * g, spread=5 * g)
        k.look(yaw=(rg - lg) * -4, tilt=(rg - lg) * 2)
        k.key(act, f)
    return act


def clip_wave(arm_ob, k):
    """A bright, friendly wave with her right hand."""
    act = new_action(arm_ob, "Wave", 96, False)
    up = JOINTS["rightUpperArm"] + Vector((-0.15, -0.07, 0.20))
    pole = up + Vector((-0.35, 0.10, -0.25))

    def raised(swing, f):
        base(k, breathe=0.3)
        k.spine(side=-2.5, twist=-3)
        k.look(tilt=-8, yaw=-3)
        k.reach("right", up + Vector((-0.02 * swing, 0, 0.0)), pole)
        k.arm("right", wrist=-6, wrist_side=22 * swing, twist=-12)
        k.fingers("right", curl=3, thumb=2, spread=5)
        k.key(act, f)

    base(k).key(act, 0)
    raised(0.0, 14)
    for i, f in enumerate((22, 30, 38, 46, 54, 62)):
        raised(1.0 if i % 2 == 0 else -1.0, f)
    raised(0.0, 70)
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
        base(k, breathe=0.5)
        for s, sd in (("left", 1), ("right", -1)):
            k.arm(s, down=26 - 10 * amt, forward=30 * amt, elbow=120 * amt, twist=-30 * amt, wrist=-10 * amt)
            k.fingers(s, curl=14 + 60 * amt, thumb=12 + 30 * amt)
        k.spine(bend=-3 * amt, side=0)
        k.look(pitch=-5 * amt, tilt=6 * amt)
        k.move("hips", (0, 0, hop))
        k.key(act, f)

    cheer(0, 0.0, 0.0)
    cheer(10, 1.0, 0.0)
    cheer(18, 1.0, 0.035)
    cheer(26, 1.0, 0.0)
    cheer(34, 1.0, 0.025)
    cheer(42, 1.0, 0.0)
    cheer(64, 0.0, 0.0)
    return act


def clip_bow(arm_ob, k):
    """A polite greeting bow, hands folded in front."""
    act = new_action(arm_ob, "Bow", 72, False)
    front = Vector((0.0, -0.13, 0.93))

    def bow(f, amt):
        base(k)
        k.spine(bend=24 * amt, weights=(0.3, 0.35, 0.35))
        k.look(pitch=12 * amt)
        if amt > 0:
            for s, sd in (("left", 1), ("right", -1)):
                k.reach(s, front + Vector((sd * 0.025, 0, 0)), front + Vector((sd * 0.35, 0.10, 0.02)))
                k.fingers(s, curl=20, thumb=15)
        k.key(act, f)

    bow(0, 0.0)
    bow(14, 0.35)
    bow(28, 1.0)
    bow(44, 1.0)
    bow(60, 0.25)
    bow(72, 0.0)
    return act


def clip_surprised(arm_ob, k):
    act = new_action(arm_ob, "Surprised", 54, False)
    chest = Vector((0.0, -0.17, 1.13))

    def gasp(f, amt):
        base(k)
        k.spine(bend=-6 * amt)
        k.look(pitch=-6 * amt)
        if amt > 0.01:
            for s, sd in (("left", 1), ("right", -1)):
                tgt = chest + Vector((sd * 0.07, 0, 0.0))
                k.reach(s, tgt, tgt + Vector((sd * 0.3, 0.1, -0.25)))
                k.arm(s, wrist=-35 * amt)
                k.fingers(s, curl=6, thumb=4, spread=8 * amt)
        k.key(act, f)

    gasp(0, 0.0)
    gasp(7, 1.0)
    gasp(36, 1.0)
    gasp(54, 0.0)
    return act


def clip_shy(arm_ob, k):
    """Hands clasped in front, swaying, head ducked — bashful."""
    act = new_action(arm_ob, "Shy", 100, False)
    front = Vector((0.0, -0.12, 0.90))
    for f, sw in ((0, None), (14, 0.0), (35, 1.0), (55, -1.0), (75, 0.6), (100, None)):
        if sw is None:
            base(k).key(act, f)
            continue
        base(k, sway=sw)
        k.spine(bend=4, twist=sw * 4)
        k.look(pitch=10, tilt=-10 + sw * 4, yaw=-sw * 5)
        for s, sd in (("left", 1), ("right", -1)):
            k.reach(s, front + Vector((sd * 0.018, 0, 0)), front + Vector((sd * 0.35, 0.05, 0.05)))
            k.fingers(s, curl=40, thumb=25)
        k.key(act, f)
    return act


def clip_stretch(arm_ob, k):
    """Idle variation: a big stretch with arms overhead."""
    act = new_action(arm_ob, "Stretch", 130, False)
    top = JOINTS["head"] + Vector((0, -0.01, 0.34))

    def stretch(f, amt):
        base(k)
        k.spine(bend=-8 * amt, side=0)
        k.look(pitch=-12 * amt)
        if amt > 0:
            for s, sd in (("left", 1), ("right", -1)):
                tgt = JOINTS[s + "UpperArm"].lerp(top + Vector((sd * 0.02, 0, 0)), amt)
                tgt = tgt + Vector((sd * 0.12 * (1 - amt), -0.05 * (1 - amt), 0))
                k.reach(s, tgt, tgt + Vector((sd * 0.4, 0.1, -0.1)))
                k.arm(s, wrist=20 * amt)
                k.fingers(s, curl=30 * amt, thumb=20 * amt)
        k.move("hips", (0, 0, 0.012 * amt))
        k.key(act, f)

    stretch(0, 0.0)
    stretch(25, 0.6)
    stretch(45, 1.0)
    stretch(80, 1.0)
    stretch(105, 0.3)
    stretch(130, 0.0)
    return act


def clip_explain(arm_ob, k):
    """'Here's the thing…' — right palm opens up and out toward you."""
    act = new_action(arm_ob, "Explain", 80, False)

    def ex(f, amt, beat=0.0):
        base(k, breathe=0.4)
        if amt > 0.01:
            rest = k.wrist_pos("right")
            tgt = rest.lerp(Vector((-0.20, -0.21, 1.07 + beat * 0.012)), amt)
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


def build_actions(arm_ob):
    bpy.context.scene.render.fps = FPS
    k = PoseKit(arm_ob)
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
