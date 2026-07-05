# COSMOS — Software Architecture

## 1. System Overview

COSMOS is a desktop AI operating layer built on Electron. It is structured as
three cooperating runtimes, each with a strict responsibility boundary:

```
┌────────────────────────────────────────────────────────────────────┐
│  RENDERER (Chromium)  — the Experience Layer                       │
│  React 19 · TypeScript · Tailwind · Framer Motion · R3F/Three.js   │
│  Boot sequence · AI Core orb · HUD holograms · Chat · Palette      │
└──────────────────────────────▲─────────────────────────────────────┘
                               │ typed IPC bridge (contextIsolation)
┌──────────────────────────────┴─────────────────────────────────────┐
│  MAIN (Node.js)  — the Service Layer                               │
│  WindowService · SettingsService · SystemStatsService              │
│  AIService (Claude/OpenAI/Gemini/Ollama) · CommandService          │
│  WeatherService · (Phase 3+) MemoryService · VoiceService          │
└──────────────────────────────▲─────────────────────────────────────┘
                               │ child processes / localhost
┌──────────────────────────────┴─────────────────────────────────────┐
│  AUTOMATION DAEMON (Phase 3) — Express + MCP host                  │
│  Playwright browser agent · Terminal agent · File agent            │
│  Unity / Unreal / VS Code bridges · Vector memory (SQLite + vec)   │
└────────────────────────────────────────────────────────────────────┘
```

### Why this split

- **Renderer never touches the OS or API keys.** `contextIsolation: true`,
  `nodeIntegration: false`. Everything flows through a preload bridge with an
  explicit, typed surface (`window.cosmos`).
- **Main process owns secrets and system access.** AI provider calls run in
  main so keys never enter the DOM, and so streaming survives renderer
  reloads.
- **Automation is out-of-process.** Playwright, MCP servers, and engine
  bridges are crash-isolated in a daemon so a hung browser automation can
  never freeze the HUD.

## 2. Folder Structure (feature-based)

```
cosmos_ai/
├── docs/                        # architecture, design system, roadmap
├── src/
│   ├── shared/                  # code shared across processes
│   │   ├── ipc.ts               # IPC channel names + payload types (single source of truth)
│   │   └── types.ts             # domain types: SystemStats, ChatMessage, Settings…
│   ├── main/
│   │   ├── index.ts             # app lifecycle, window creation, shortcut registration
│   │   ├── ipc.ts               # binds services to IPC channels
│   │   └── services/
│   │       ├── SettingsService.ts     # persisted JSON settings (userData)
│   │       ├── SystemStatsService.ts  # CPU/GPU/RAM/net/battery via systeminformation
│   │       ├── WeatherService.ts      # Open-Meteo (keyless) + IP geolocation
│   │       ├── CommandService.ts      # OS actions: apps, power, lock, URLs
│   │       └── ai/
│   │           ├── AIService.ts       # provider registry + stream orchestration
│   │           ├── types.ts           # provider contract
│   │           └── providers/         # anthropic.ts openai.ts gemini.ts ollama.ts
│   ├── preload/
│   │   └── index.ts             # contextBridge: the ONLY renderer↔main surface
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx / App.tsx
│           ├── core/            # cross-feature runtime
│           │   ├── stores/      # zustand: ui, system, assistant
│           │   ├── theme/       # theme tokens + ThemeProvider
│           │   └── sound/       # WebAudio-synthesized UI sound design
│           ├── features/
│           │   ├── boot/        # startup cinematic
│           │   ├── orb/         # R3F AI core (shaders, particles, state machine)
│           │   ├── hud/         # floating hologram stat cards
│           │   ├── chat/        # streaming conversation panel
│           │   ├── palette/     # CTRL+SPACE command palette + action registry
│           │   └── settings/    # searchable settings panel
│           └── shared/          # Glass, NeonText, hooks, utils
├── electron.vite.config.ts
├── tailwind.config.ts
└── tsconfig{,.node,.web}.json
```

**Rule:** features may import from `core/` and `shared/`, never from each
other. Cross-feature communication goes through stores or the action
registry.

## 3. Key Contracts

### 3.1 IPC (src/shared/ipc.ts)

All channels are constants; all payloads are typed. The preload exposes a
namespaced API:

```ts
window.cosmos = {
  system:   { onStats(cb) }                          // push, every 2s
  weather:  { get() }
  ai:       { chat(req) -> requestId, abort(id),
              onToken(cb), onDone(cb), onError(cb) } // streamed
  settings: { get(), set(patch) }
  commands: { run(commandId, args) }                 // OS-level actions
  app:      { onPaletteToggle(cb) }                  // global shortcut relay
}
```

### 3.2 AI Provider Contract

Every provider implements one function — streaming is universal:

```ts
interface AIProvider {
  id: 'anthropic' | 'openai' | 'gemini' | 'ollama'
  streamChat(req: ChatRequest, emit: (delta: string) => void,
             signal: AbortSignal): Promise<void>
}
```

Providers are fetch-based (SSE / NDJSON parsers), no vendor SDKs — zero
native deps, instant model switching, and Ollama works fully offline.

### 3.3 Assistant State Machine

The orb, sound design, and chat all key off one state:

```
idle ──▶ listening ──▶ thinking ──▶ speaking ──▶ idle
  ▲                                    │
  └────────────── interrupt ◀──────────┘
```

Held in `useAssistantStore`; every visual system (shader uniforms, particle
speed, glow intensity, HUD pulse) derives from it. Adding voice later means
driving the same store — no UI changes.

### 3.4 Command / Action Registry

One registry powers the palette, chat tool-use (later), and voice intents
(later):

```ts
interface Action {
  id: string; title: string; keywords: string[]
  section: 'apps' | 'system' | 'web' | 'ai' | 'theme' | 'settings'
  danger?: boolean          // requires confirmation modal
  run(ctx: ActionContext): Promise<void> | void
}
```

Destructive actions (`shutdown`, `restart`) set `danger` and go through the
confirmation flow — this is the seed of the Phase-4 permission system.

## 4. Data & Persistence

- **Phase 1–2:** `SettingsService` persists a single JSON document in
  `app.getPath('userData')`. Conversations kept in-memory per session.
- **Phase 3:** SQLite (via `node:sqlite`, no native rebuild) for
  conversations, long-term memory, and an embeddings table for vector
  recall. `MemoryService` fronts it; nothing else touches the DB.
- **Secrets:** API keys live in settings JSON in Phase 1; Phase 4 moves them
  to `safeStorage` (OS keychain-backed encryption).

## 5. Performance Budget

- 60 FPS minimum on the composited UI; the R3F canvas is the only WebGL
  surface, `frameloop="always"` but with capped DPR (`Math.min(dpr, 2)`).
- Shader-driven animation (GPU) for the orb & particles; Framer Motion only
  for DOM transitions; no layout-thrashing animations (transform/opacity
  only).
- System stats polled at 2s in main and pushed — renderer never polls.
- Heavy features (workspace, settings) lazy-loaded with `React.lazy`.

## 6. Multi-Agent Architecture (Phase 5)

Planner → {Coder, Researcher, Designer, Debugger, Reviewer} with Automation,
Browser, Terminal, and File agents as tool-executors. Agents are MCP clients
inside the daemon; the main process is only a message router. Each agent is
a system-prompted session over the same `AIService`, coordinated by a
Planner that emits a typed task graph. Detailed design lives in
`ROADMAP.md § Phase 5`.
