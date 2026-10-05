# COSMOS avatars — the generator

The 3D avatars are built **entirely from code** inside Blender: heads, face
features, hair, bodies, outfits, skeletons, skin weights, blendshapes and
animation clips. Nothing is hand-edited, so any model can be rebuilt, tweaked
and re-exported at any time.

```
tools/avatar/
  build.py        entry point (run inside Blender)
  kit/            shared engine — geometry, hair strands, rig + weights,
                  animation authoring, export, pipeline
  nova/           Nova (head, face, hair, body, clothes) + spec.py
  tsunade/        character built from a user reference + spec.py
```

Each character is the art (`head.py`, `face.py`, `hair.py`, `body.py`,
`clothes.py`) plus a `spec.py` telling the kit everything else:

- the skeleton joints;
- the spring chains (hair, cloth);
- how each mesh is weighted;
- named reach targets for the shared clip set;
- which meshes merge;
- the output `.glb` name.

Output goes to [`src/renderer/src/assets/avatar/`](../../src/renderer/src/assets/avatar).
The app's avatar registry is
[`avatars.ts`](../../src/renderer/src/features/avatar/avatars.ts). It bundles
whichever models are present there; a character whose `.glb` is missing simply
isn't offered.

## Rebuilding

Blender 4.4+ (built and tested on 5.2). From Blender's Python console, or
through the Blender MCP bridge:

```python
NOVA_ROOT = r"D:\AI\cosmos_ai\tools\avatar"
AVATAR = "tsunade"   # or "nova"
exec(open(NOVA_ROOT + r"\build.py").read())
```

This clears the scene, runs every step and writes the GLB. While iterating,
set `NOVA_STEPS` first to stop early, e.g.
`NOVA_STEPS = ["head", "face", "hair"]`. `kit.preview.render(...)` renders a
still for a quick look.

| Kit module | Does |
|---|---|
| `kit/common.py` | Maths, mesh/material helpers, shape keys |
| `kit/geom.py` | Lofts, tubes, open sheets, flat strips, `MeshBuilder` |
| `kit/strands.py` | Anime hair: skull shell, swept clumps, volume cap |
| `kit/rig.py` | VRM-named skeleton, plus capsule, chain and cloth-panel weights |
| `kit/anims.py` | 12 clips authored as poses (FK + Blender IK baked to rotations) |
| `kit/export.py` | Merges meshes by material, exports the GLB |

### Weights

- **Capsule:** nearest bone segments, smooth at the joints.
- **Chain:** hair, glued to the head above the chain root.
- **Panel:** cloth hanging around the body, such as a coat skirt. Each vertex blends the two chains either side of it, and never blends across an open front.
- **Proxy:** `spec.weight_proxy` lets layered garments weight from the body surface underneath, so shirt, sash and coat move as one. Return the *nearest* skin point. A body built from a superellipse has a parameter that isn't the geometric angle, and sampling it at the vertex's angle drifts sideways over curves (Tsunade's skin pushed through her kimono that way).
- **Adjust:** `spec.adjust_weights` blends extra bones into those weights at the same proxy point. Breast springs use it, so skin and every layer over the chest sway together. Tsunade's also fades the upper arms out of the chest front and the flanks under the armpits, so a raised arm doesn't fold the coat into the layers beneath it.
- **Layers under a coat** only need to exist where they can show. Tsunade's kimono stops at her flanks under the haori, so a pinched armpit has nothing to push through.

- **Smoothing:** `spec.smooth_weights(name)` returns `(factor, passes)` for meshes whose weights should be relaxed across the surface, like a rigger's "smooth weights". Tsunade's fused hands use it so finger webs and knuckles bend smoothly.

### Poses and hands

- A spec with `BASE_STYLE = "hip"` rests one hand on the hip. `POINTS["hip_left"]` is the wrist target, and `HIP_HAND` is an optional (finger direction, palm normal) pair.
- `k.fingers(..., spread=+n)` fans the fingers out on either hand.
- A spec's `HAND_CONTACT` lists surfaces (Tsunade's tunic and obi) that fingers rest ON in every key of every clip. `settle_hands` lifts a finger that has sunk in just clear of the cloth, and curls one hovering within a few millimetres down onto it. Fingers touching nothing are left alone.
- A spec's optional `after_anims(arm)` runs once the clips exist, for anything that needs her posed. Tsunade's adds the "HipPress" morph: the haori laid flat under her resting hand, worked out in the Idle pose and carried back to the rest pose through the skinning. The app fades it in and out with the hand (`handPress` in `avatars.ts`).
- A spec's `FINGER_CASCADE` and `FINGER_SPREAD` are layered on every finger pose. The cascade curls each finger a little more than the one before it, index to little; the spread fans them.
- **Tsunade's feet** are made the same way: a foot loft that slopes into the toes plus five toes, fused (`_fuse` in `tsunade/body.py`). Each toe is tapered, slightly flat, with knuckles and a tip pad resting on the sole. The joints sit on a slant, the lengths step down from the big toe, and the toes fan slightly. The toenails follow each toe's shape and are widest at the tip.
- **Tsunade's hands** are sculpted, not lofted. The forearm, palm, fingers and thumb are built as overlapping parts, then voxel-remeshed into one surface (real finger webs, a thumb growing from its pad, no wrist seam). The result is smoothed, decimated, and re-tagged per part for weighting; see `_fuse_hand` in `tsunade/body.py`. Her almond nails follow each fingertip's own cross-section, and `_seat_nails` re-seats them on the fused surface. The fingers rest fanned a little wider than a relaxed hand so they stay separate surfaces when fused. Her negative `FINGER_SPREAD` draws them back together in every pose.
- `build_cap(..., snap_edge=True)` lays the hair cap's cut edge on the hairline curve instead of letting it step along the head mesh's rows.

## Contract with the app

`src/renderer/src/features/avatar` looks things up **by name**. Keep these
names when changing a character.

- **Materials:** every material name must have an entry in that avatar's
  `materials` map in `avatars.ts`. Every avatar needs `Eye_L`, `Eye_R`, `Mouth`
  and `Blush`.
- **Blendshapes:**
  - Eyes and lashes (per side `_L` / `_R`): `E_Blink`, `E_Happy`, `E_Wide`, `E_Relax`, `E_Sad`, `E_Angry`.
  - Brows (per side): `B_Up`, `B_Angry`, `B_Sad`.
  - Mouth: visemes `V_A`, `V_I`, `V_U`, `V_E`, `V_O`, plus `M_Smile`, `M_Frown`, `M_Joy`, `M_Grin`, `M_Pout`, `M_Small`.
- **Bones:** VRM humanoid names (`hips`, `spine`, `chest`, `upperChest`,
  `neck`, `head`, `leftUpperArm`, `leftIndexProximal`, …). Spring chains are
  `<chain>_1..n` (`hair_*`, `cloth_*`). The app simulates the ones listed in
  the avatar's `springs`, and clips never key them.
- **Clips:** the looping state bases `Idle`, `Listen`, `Think` and `Talk`,
  and the one-shots `Wave`, `Nod`, `Happy`, `Bow`, `Surprised`, `Shy`,
  `Stretch` and `Explain`. Every clip keys the full body pose so any two can
  be crossfaded. Quaternions are kept sign-continuous between keys.
- **Eye centres and iris radii** are mirrored in the avatar's `eyes` config.
  Update them there if the eyes move.

## Conventions

Blender units are metres. Z is up and characters face −Y, so their left is
+X. The glTF exporter converts this to three.js Y-up / +Z-forward, which is
the space `avatars.ts` uses.
