# 07 · The Renderer

The renderer (`src/renderer/src`) is the whole visible experience: the boot
cinematic, the WebGL AI-core orb, the HUD, chat, the command palette, and every
panel. It's a React 19 app with Zustand state, Tailwind styling, Framer Motion
DOM transitions, and React Three Fiber for the orb.

---

## Top-level composition — `App.tsx`

[`App.tsx`](../../src/renderer/src/App.tsx) is the single mount point. Its
structure:

1. **On mount**, it initializes every store (`init()` on settings, system,
   assistant, approval, agent, notification, ui, voice) and wires global
   listeners: palette toggle, tray hands-free toggle, and the keyboard shortcuts
   (`Ctrl+Space` palette, `Ctrl+J` push-to-talk, `Esc` closes panels).
2. It renders by **phase** (`boot` → `main`) and **window mode**:
   - `boot` → `BootSequence`.
   - `main` + `orb` → `OrbWidget` (the floating orb, transparent window).
   - `main` + `compact` → `MiniView`.
   - `main` + `full` → the full HUD: ambient aura, `CoreStage` (Nova the avatar,
     or the orb — `Settings.coreVisual`), then every panel
     component (`StatusBar`, `AgentRing`, `HudLayer`, `ChatPanel`,
     `CommandPalette`, and all the `*Panel`s), plus `NotificationCenter` and
     `Toasts`.
3. After boot it fires a persona-flavoured welcome toast (and the greeting is
   spoken during the boot wordmark reveal).

Panels are always mounted; they animate in/out based on `useUIStore.activePanel`
rather than conditional mounting, so their state survives being closed.

---

## State: Zustand stores

State lives in small Zustand stores. **Cross-feature** stores are in
[`core/stores/`](../../src/renderer/src/core/stores); **feature-local** stores sit
inside their feature folder. Components subscribe with selectors; stores expose an
`init()` that subscribes to the relevant `window.cosmos.*` events.

| Store | Location | Holds |
|---|---|---|
| `useUIStore` | core/stores | `phase`, `activePanel`, `paletteOpen`, window `mode`; panel/mode navigation |
| `useSystemStore` | core/stores | Latest `SystemStats` (from `SYSTEM_STATS`) |
| `useSettingsStore` | core/stores | The `Settings` document; `init`, `update(patch)` (persists via `settings.set`) |
| `useAssistantStore` | core/stores | The chat: `messages`, `state`, `sessions`, streaming handlers, `send`, `interrupt` |
| `useNotificationStore` | core/stores | Toasts + notification center; `push`, subscribes to `NOTIFY` |
| `useVoiceStore` | features/voice | Mic mode/status, the whole voice pipeline (see [08](08-voice-pipeline.md)) |
| `useApprovalStore` | features/chat | Pending tool-approval requests → the Approve/Always/Deny card |
| `useAgentStore` | features/agents | Live sub-agents → the ring animation around the orb |
| `useStudioStore` | features/studio | Studio layout (open files, panel sizes, active view) |
| `useCleanerStore` | features/cleaner | Cleaner scan results, selections, progress |

### The assistant store in depth

[`useAssistantStore.ts`](../../src/renderer/src/core/stores/useAssistantStore.ts)
is the busiest store. Its `init()` subscribes to the AI event stream and turns it
into the chat UI:

- **`onToken`** → append the delta to the open assistant bubble (see coalescing
  below) and `notify({type:'delta'})` for the voice chunker.
- **`onEvent`** (tool events) → insert a **tool-activity card** on `running`,
  resolve it by `callId` on ok/error/denied. It closes the current text bubble
  and opens a fresh one so cards and prose keep chronological order.
- **`onDone`** → finalize, drop a trailing empty bubble, refresh the sessions
  list, play the success sound.
- **`onError`** → surface the message in-bubble + an error toast.
- **`send(text, attachments)`** → barge-in (interrupt any in-flight reply),
  optimistically render the user message, optionally **translate** the query into
  the conversation language, build history (last `CONTEXT_WINDOW = 30` non-tool
  messages), and call `window.cosmos.ai.chat`.
- **`interrupt()`** → abort the request and always land on `idle` (Stop also
  works while merely speaking a finished reply).

<a id="token-coalescing"></a>
### Token coalescing (why the orb stays smooth)

The model emits many deltas per second. Committing each one re-renders the chat
and makes `react-markdown` re-parse the whole growing reply every token —
O(n²) — on the same main thread as the always-animating R3F orb loop, visibly
stuttering the orb on long replies.

So tokens are **buffered** (`pendingDelta`) and committed to the store at most
once per animation frame, throttled to `FLUSH_INTERVAL_MS = 40` (~25×/s). The
markdown re-parse happens at a fixed rate regardless of token speed. Crucially,
the **voice pipeline still receives every token immediately** via `notify()`, so
speech pacing is unaffected. `flushTokensNow()` forces a commit before any
handler that reshapes the message list (tool cards, done, error).

---

## HMR-safe singletons (important dev gotcha)

Both `useAssistantStore` and `useVoiceStore` stash their instance (and listener
registries) on `globalThis`, not module scope.

**Why:** React Fast Refresh re-evaluates a module when it (or an importer)
changes. A plain module-level store would be recreated on re-eval — the chat UI
would bind to a *new* store while the IPC/voice listeners set up at startup keep
driving the *original* one. Result: replies stream to voice but never render,
and the Stop button never appears. For voice, a second `SpeechPlayer` +
listener means every reply gets spoken twice by overlapping voices.

Pinning to `globalThis` keeps exactly one store, one recorder, one player, one
listener set for the life of the page across any number of hot reloads. If you
edit these files' logic, do a **manual reload** to take effect — an accepted
trade-off for never desyncing live chat/voice.

---

## The AI core orb — `features/orb`

A React Three Fiber scene — the classic centrepiece, and the fallback whenever
the avatar is switched off or can't load.

- [`OrbScene.tsx`](../../src/renderer/src/features/orb/OrbScene.tsx) — the R3F
  canvas (capped DPR, `frameloop="always"`).
- [`shaders.ts`](../../src/renderer/src/features/orb/shaders.ts) — the custom GLSL
  for the core sphere and the ~2,400-particle field.
- [`orbConfig.ts`](../../src/renderer/src/features/orb/orbConfig.ts) — tunables per
  assistant state.

The orb reads the **assistant state machine** (`idle → listening → thinking →
speaking → idle`) from `useAssistantStore.state` and drives shader uniforms
(color, glow, particle speed) from it. Its pulse is driven by the **real audio
envelope** — the mic while listening, TTS while speaking — bridged through
`core/voice/voiceSignal.ts`. Every visual system keys off the same state, so
adding a new voice/agent surface means driving the store, not touching the shader.

---

## Nova, the 3D avatar — `features/avatar`

The default centrepiece: an anime girl who reacts to the conversation. The model
(`assets/avatar/nova.glb`) is generated from code in Blender by
[`tools/avatar`](../../tools/avatar/README.md); this folder brings her to life.

- [`CoreStage.tsx`](../../src/renderer/src/features/avatar/CoreStage.tsx) — picks
  Nova or the orb from `Settings.coreVisual`; any load/render failure falls back to
  the orb.
- [`AvatarScene.tsx`](../../src/renderer/src/features/avatar/AvatarScene.tsx) — the
  R3F canvas (60 fps cap via the shared `FrameDriver`, parked while hidden), the
  camera rig (head-to-hips, easing in while she speaks), the holographic halo and
  motes, theme colours, click hit-testing (headpats), and the wiring from the chat:
  your message → `readUserMessage`, her streamed reply → `readReplySentence` per
  sentence.
- [`AvatarController.ts`](../../src/renderer/src/features/avatar/AvatarController.ts) —
  the per-frame "nervous system", in order: body clips (a base loop per assistant
  state — Idle/Listen/Think/Talk — crossfaded by hand, one-shot gestures on top),
  gaze (eyes track the cursor with saccades, head follows), face (emotion preset +
  blinking + lip-sync blended into the blendshapes), then spring-bone hair. An
  avatar with `fingerLife` gets living hands, layered over the clips:
  - every finger joint drifts a few degrees on its own slow rhythm, and the free wrist sways a little;
  - every few seconds there's a small hand "moment": fingers drumming or rippling on the resting hand, or a flex, an opening, a thumb or a wrist turn on the free one.
  - Fingers only ever *lift* off the pose (at the knuckle), so a hand resting on her clothes never presses into them.
  - `handPress` names a morph that presses her clothes under the resting hand (`restingHand`). It follows how close that hand is to its resting spot: full within 2 cm, gone by 8 cm. That is slower than the clips lift the hand off, so the cloth springing back never catches it.
  - `pressHolds` lists the spring bones carrying the cloth under that hand. They're held at rest as far as the press is in, so the breeze can't swing pressed cloth back out through the fingers.
  - Outline shells share their mesh's morph weights.

  Every rotation the controller layers on top of the clips (head turns, living hands) is taken back off before the mixer runs each frame. Three.js's `AnimationMixer` only rewrites a bone when the clip's value *changes*, so during a held pose anything layered on top would otherwise compound.
- [`toonMaterials.ts`](../../src/renderer/src/features/avatar/toonMaterials.ts) —
  cel-shading `ShaderMaterial`s on three's skinning/morph chunks: spherical face
  normals, theme-tinted rim, angel-ring hair highlight, voice-reactive glow trims,
  the procedural eye (iris drawn from the *morphed* position so lids cover it),
  mouth and blush shaders, soft-edged painted shading (`soft`: lid shadow,
  nose shading, lip gloss, feathered over each decal's UVs) and inverted-hull
  outlines. A decal can be drawn only where its surface faces the camera
  (`facing`: a mark on the side of the nose shows in profile and fades as she
  turns to face you). A face with a sculpted profile sets `crease` on its skin
  material: inside the nose-and-mouth region its outline is pushed back along
  the view ray, so the hull folding out of a crease (from the usual camera,
  below her face, the up-facing upper lip's hull showed in the pocket under
  the nose as a dark band) hides behind her own skin, while on a profile, with
  only background behind it, the line stays. glTF stores UV v flipped, so the
  eye, mouth and soft shaders read `1 − uv.y`. The hair's height bands (skull shading, angel ring) are tuned on
  Nova's head and measured from the head as it is *now* (`uHeadCenter`), so they
  ride along when she bows or crouches; the outline's fringe fade uses rest
  positions and each model's own head height (`uHeadShift`, set on load).
  Every material also carries the stage's teleport dissolve (`uDissolve`) and
  card cut-outs (`uCut`) — see *Her stage* below.
- [`lipsync.ts`](../../src/renderer/src/features/avatar/lipsync.ts) — vowel shapes
  (A/I/U/E/O) from the TTS loudness + four formant bands that `SpeechPlayer`
  writes to `voiceSignal.bands`; a synthetic chatter when replies are text-only.
- [`emotion.ts`](../../src/renderer/src/features/avatar/emotion.ts) — a lexicon
  reader: sentences → emotion + intensity + optional gesture (greeting → wave,
  compliment → shy, thanks → bow, …). No model call, no latency.
- [`springBones.ts`](../../src/renderer/src/features/avatar/springBones.ts) —
  verlet spring joints with body colliders, for hair and cloth chains. Colliders
  only hold the joints off the body; the cloth between joints can still cut what
  lies just under it. So cloth chains can also be kept within limits of where
  they hang at rest, measured from the body's axis: `inward` (never more than
  this much closer, so the coat can't swing in through the tunic) and `outward`
  per joint (never more than this much further, so it can't sweep through an arm
  hanging beside it; joints past the list, such as a hem, swing freely).
  `hold(bone, amount)` pins a joint at its animated rest.

- [`avatars.ts`](../../src/renderer/src/features/avatar/avatars.ts) — the avatar
  registry: per character, its model, camera framing, eye geometry and iris
  colours, per-material shading, spring-chain physics (hair and cloth) and body
  colliders. Models are discovered with `import.meta.glob`, so only avatars whose
  `.glb` is present are offered (`Settings.avatarId` falls back to the first one).

Materials are matched to the GLB **by material name**, blendshapes and bones **by
name** — see the contract in [`tools/avatar/README.md`](../../tools/avatar/README.md).
For tuning without the whole app, serve `src/renderer` with plain Vite and open
`/avatar-lab.html` (dev only; drives states, feelings, gestures, a fake voice, and
the stage: a stroll, a crouch, a teleport).

### Her stage — `features/avatar/stage`

The avatar can leave her spot: walk about, crouch, put her hands on the HUD and
the chat. Left alone (`Settings.avatarPlay`) she wanders over every 30 s
(`IDLE_LOOP`, counted from your last input or her last play) and
plays with the HUD cards; "start a new chat" sends her to press **New**; a
message mid-scene dissolves her and she re-forms at home.

- [`body.ts`](../../src/renderer/src/features/avatar/stage/body.ts) — `BodyRig`,
  the procedural body: analytic two-bone IK for arms and legs with a real hinge
  (each bone's own along/hinge axes, from the bind pose), forearm roll to carry
  the hand's twist, hand aiming (finger direction + palm normal), finger poses
  (curl, spread, thumb — the thumb also joint by joint, so its base can swing it
  round in front of the palm while the rest stays straight), shoulder lift,
  hips and spine offsets. A hand lands by its palm, its index fingertip, its
  wrist, or the web of its thumb (`pinch`). A long reach brings the shoulder
  blade forward with it (`protract`); and an arm keeps out of her body
  (`stage.keepOut` in `avatars.ts`: spheres riding on her bones — Tsunade's
  bust — and `stage.armRadius`, the arm's thickness with its sleeve): the
  elbow swings round the shoulder→wrist line by the least that clears it,
  eased frame to frame, and a hand that would sink into her is moved out. It
  never owns a bone: everything is layered through the controller and taken
  back off before the mixer runs, each limb blended by its own weight. Layered
  deltas are normalised — `invert()` is a conjugate and the clips' quaternions
  are only unit to float32, so an un-normalised delta compounds through the
  layer/undo cycle until the bone explodes.
- [`locomotion.ts`](../../src/renderer/src/features/avatar/stage/locomotion.ts) —
  procedural walking on a real gait cycle. The root glides toward a goal with
  eased acceleration (never far ahead of a foot still on the floor); a stride
  clock moves the feet. Each foot spends ~60% of a stride on the ground — heel
  strike, rolling flat, the heel peeling up over the ball (the toes stay flat on
  the floor) — and ~40% swinging, where its ankle rises to whatever height gives
  the knee its natural swing bend (folded up behind her, then reaching out for
  the next heel strike). Landing spots are planned from where her body will be
  when the foot comes down, half a stance ahead of it. Sideways, the leading foot
  steps out and the other closes in behind it, so they never cross. The pelvis
  bobs, sways over the standing foot, turns with the stride and dips on the
  swinging side; the chest turns against it; the hips never sit so high that a
  standing knee locks straight — and start lowering ahead of each heel strike
  (from where the foot will land and where her hips will be by then), so they
  never drop onto it. The swinging knee's bend grows out of the bend it left
  the floor with, the root holds still until the legs have fully taken over
  from the clip, and the landing heading is eased like the landing spot — each
  of those once made a foot jump. Setting off, the foot on the side she's heading
  for opens the turn; stopping, the last steps bring her feet together. A crouch
  is a skirt-friendly kneeling squat: one foot steps back (the reaching hand's
  side) and sinks onto its ball, knees together.
- [`actor.ts`](../../src/renderer/src/features/avatar/stage/actor.ts) — her body
  as a script can direct it: `walkTo`, `crouchTo`, `reach(side, target, dur)`,
  `rest`, `setShape`, `lookAt`, `grab`/`release`/`fly`/`tidy` for cards,
  `teleportHome`. Each is a promise that rejects with `Aborted` when the scene is
  interrupted. A hand resting on her hip (`restingHand`) is anchored to her
  hips at `begin`, then lifts straight off and hangs free for the whole scene
  (a hand left on her hip through a walk or a game looked pinned there): it
  swings with her stride, rests on her knee when she crouches, and goes back
  on her hip only once she's home (`handsHome`, called by `end`). Each arm's
  moves carry a `claim`, so a move in several steps gives way to whatever
  started since. A free
  arm walks by IK too — hanging as wide as her clip's (clear of the haori),
  palm in, swinging opposite its leg, fingers loosely curled. While she strides or crouches the cloth's
  `outward` limits loosen (`clothFree` → `SpringBones.outwardFree`) so her legs
  can push the coat aside. Her chest turns a little toward what her hands
  reach for (across her most of all) and toward what she watches — here,
  before her hands are placed: the controller's own chest-follow-the-look
  (`chestFollow`) fades out while she acts, as turning her chest after the IK
  dragged her hands a few cm off whatever they held.
- [`director.ts`](../../src/renderer/src/features/avatar/stage/director.ts) — the
  scenes: idle play (carry a card out and squish/stretch it in both hands or
  toss and catch it; boop one; flick one into a spin; crouch to a low one; a
  finger snap springs every card home), pressing **New**, and interruptions.
  `playBits([...])` runs chosen bits (dev aid). She takes a card the way you'd
  hold up a photo: her hand comes up behind it from below, fingers open and
  the thumb out of the way; its bottom edge slides into the web of her thumb;
  the thumb closes round onto its face (`pinchCard`). Then it rides in her
  hand — a hand's width in from its ends when she holds it in both, so her
  hands stay behind it — held out in front of her nearer than the glass
  (`HOLD_Z`, a good bend in her elbows) and on the holding hand's own side:
  reaching her hand across, her upper arm swept through her bust. Letting go,
  the thumb comes off first (`letGo`). A boop or a flick pokes the card from
  behind, palm turned in so the curled fingers fold sideways, not into it.
  The hand's targets read the card's place live until she has it — after
  that the card follows the hand, and a target following the card chased the
  hand back into her body.
- [`widgets.ts`](../../src/renderer/src/features/avatar/stage/widgets.ts) — what
  she can touch: `StatCard`s register their framer-motion values (she drives
  the same `x`/`y`/`scale` a drag does), the chat's New button registers a
  `press`. DOM panels hang on "the glass", a plane just in front of her: a screen
  point maps to a point on it and back. Touch ripples and sparks are DOM.
- [`vfx.tsx`](../../src/renderer/src/features/avatar/stage/vfx.tsx) — the teleport
  (she dissolves into motes sampled off her skinned body; re-forms behind a
  glowing seam rising from her feet), footstep ripples, a contact shadow that
  follows her.
- [`bridge.ts`](../../src/renderer/src/features/avatar/stage/bridge.ts) — the seam
  to the rest of the app (`stageBridge`, no three.js) and `useStageStore.acting`.
  While she acts her canvas sits above the HUD and chat (`z-[25]`, no pointer
  events — every click still goes through) and the camera holds still.

**Cards in front of her.** The cards are DOM, under her canvas while she acts,
yet they're on the glass in front of her. Every card on screen is a rounded
rect (`shared.uCut`) with the world depth of its plane: the glass, or — for a
card in her hands — just in front of the web of her thumb (`PINCH_DEPTH`),
wherever she holds it (a card she lets go of goes back to the glass). Inside
one, every fragment of hers is discarded except those skinned to her hand and
finger bones (`vHand`, from `uHandBones`) that lie in front of that plane
(`cutBehind`, on each fragment's world z). So a card hides her body, her
sleeve and the hand holding it from behind — all but the thumb wrapped onto
its face. Nothing else of hers may come in front of the glass: the swinging
arm, the finger snap and a hand going back to rest all stay behind it.

The "new chat" request is caught before the model sees it
([`features/chat/intents.ts`](../../src/renderer/src/features/chat/intents.ts) —
strict: the whole message must be the command, English or Hindi/Hinglish); her
"done!" goes into the fresh chat as an `ephemeral` message (shown and spoken,
never sent to the model). Without an avatar on screen it simply happens.

---

## Sound design — `core/sound/SoundEngine.ts`

All UI sound is **synthesized with the WebAudio API** (no audio files). `sound.play(name)`
plays cues (`activate`, `success`, `mic-on`, `mic-off`, error…). `sound.enabled`
is bound to `settings.soundEnabled` at startup. Stores call it at the right
moments (send, done, mic toggle).

---

## Theming — `core/theme/themes.ts`

Five themes (`cyber-blue`, `crimson`, `nebula-purple`, `emerald`, `arctic-white`)
expressed as CSS custom properties (`--accent`, `--bg`, glass tokens…). The active
theme comes from `settings.theme`; components read `var(--accent)` etc. rather
than hard-coding colors. See [docs/DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md) for the
token vocabulary, glass recipe, and motion language.

---

## Shared UI — `shared/ui`

Reusable presentational pieces used across features: `Glass` (the frosted-panel
primitive), `Markdown` (react-markdown + remark-gfm, used for chat bubbles),
`StatCard`, `StatusDot`. Features compose these rather than re-implementing glass
surfaces.

---

## Feature tour

| Feature | What it is |
|---|---|
| `boot` | Startup cinematic (`BootSequence`, `BootParticles`) + spoken greeting |
| `orb` | The R3F AI core |
| `hud` | `StatusBar` (top) + `HudLayer` floating telemetry cards |
| `chat` | `ChatPanel`, `SessionList`, `ToolCard`, `ApprovalCard`, attachments |
| `palette` | `Ctrl+Space` command palette + the action registry (`actions.ts`) |
| `voice` | `MicButton` + `useVoiceStore` + speech helpers |
| `agents` | `AgentRing` around the orb, `useAgentStore` |
| `settings` | Searchable settings panel |
| `personality` | Persona picker + trait dials |
| `vault` | Memories, "Always allow" grants, audit log |
| `secrets` | The encrypted secrets vault UI |
| `dashboard` | Telemetry, weather, activity, quick actions |
| `workspace` | Persistent encrypted notes |
| `studio` | Code editor (CodeMirror) + terminal + file tree + live preview |
| `appcenter` | Browse & launch installed apps |
| `cleaner` | The CCleaner-style maintenance UI |
| `notifications` | `Toasts` + `NotificationCenter` |
| `compact` | `MiniView` (compact) + `OrbWidget` (floating orb) |

---

## The command palette & action registry

`features/palette/actions.ts` is a registry of `Action` objects (id, title,
keywords, section, `danger?`, `run(ctx)`). The palette is the one place features
are invoked generically — open a panel, switch theme, run a system command,
launch a plugin command. Cross-feature actions go here rather than one feature
importing another. Dangerous actions (`shutdown`, `restart`) set `danger` and go
through a confirmation flow.

---

Next: [The Voice Pipeline →](08-voice-pipeline.md)
