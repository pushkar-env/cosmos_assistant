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
   - `main` + `full` → the full HUD: ambient aura, `OrbScene`, then every panel
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

A React Three Fiber scene, the only WebGL surface in the app.

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
