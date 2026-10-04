# Nova — the avatar generator

Nova (COSMOS's 3D anime avatar) is built **entirely from code** inside Blender:
head, face features, hair, body, outfit, skeleton, skin weights, blendshapes and
animation clips. Nothing is hand-edited, so the model can be rebuilt, tweaked
and re-exported at any time.

Output: [`src/renderer/src/assets/avatar/nova.glb`](../../src/renderer/src/assets/avatar/nova.glb)
(about 3.2 MB, 67k triangles, 71 bones, 12 clips).

## Rebuilding

Blender 4.4+ (built and tested on 5.2). From Blender's Python console, or
through the Blender MCP bridge:

```python
NOVA_ROOT = r"D:\AI\cosmos_ai\tools\avatar"
exec(open(NOVA_ROOT + r"\build.py").read())
```

This clears the scene, runs every step and writes the GLB. While iterating,
set `NOVA_STEPS` first to stop early, e.g.
`NOVA_STEPS = ["head", "face", "hair"]`. `nova.preview.render(...)` renders a
still for a quick look.

| Module | Builds |
|---|---|
| `head.py` | Anime skull (superellipse slices from front/side profile tables) |
| `face.py` | Eyes, lashes, creases, brows, mouth, blush, plus their blendshapes |
| `hair.py` | Volume cap, layered bangs, side locks, waist-length curtain, ahoge; spring-chain joints |
| `body.py` | Neck, hands (5-finger), legs; hidden skin is skipped |
| `clothes.py` | Jacket, sleeves, bow, pleated skirt, thigh-highs, sneakers, cat-ear headset |
| `rig.py` | VRM-named skeleton + analytic "capsule" skin weights |
| `anims.py` | Clips authored as poses (FK + Blender IK baked to rotations) |
| `export.py` | Merges meshes by material, exports the GLB |

## Contract with the app

`src/renderer/src/features/avatar` looks things up **by name**. Keep these
names when changing the generator.

- **Materials:** `Skin`, `Hair`, `Eye_L`, `Eye_R`, `Lash`, `LashLower`,
  `Crease`, `Brow`, `Mouth`, `Blush`, `Accent` (theme-tinted glow),
  `Cloth_White`, `Cloth_Dark`, `Ribbon`, `Sock`, `Shoe`, `Sole`, `Headset`,
  `Headset_Dark`.
- **Blendshapes:**
  - Eyes and lashes (per side `_L` / `_R`): `E_Blink`, `E_Happy`, `E_Wide`, `E_Relax`, `E_Sad`, `E_Angry`.
  - Brows (per side): `B_Up`, `B_Angry`, `B_Sad`.
  - Mouth: visemes `V_A`, `V_I`, `V_U`, `V_E`, `V_O`, plus `M_Smile`, `M_Frown`, `M_Joy`, `M_Grin`, `M_Pout`, `M_Small`.
- **Bones:** VRM humanoid names (`hips`, `spine`, `chest`, `upperChest`,
  `neck`, `head`, `leftUpperArm`, `leftIndexProximal`, …). The spring-bone
  hair chains are `hair_back_{C,L,R}_n`, `hair_side_{L,R}_n` and `hair_ahoge_n`.
- **Clips:** the looping state bases `Idle`, `Listen`, `Think` and `Talk`,
  and the one-shots `Wave`, `Nod`, `Happy`, `Bow`, `Surprised`, `Shy`,
  `Stretch` and `Explain`. Every clip keys the full body pose so any two can
  be crossfaded. Quaternions are kept sign-continuous between keys.
- **Eye centres** `(±0.0403, 1.3752)` and the iris radii are mirrored in
  `avatarAsset.ts` and `toonMaterials.ts`. Update them there if the eyes move.

## Conventions

Blender units are metres. Z is up and she faces −Y, so her left is +X. The
glTF exporter converts this to three.js Y-up / +Z-forward.
