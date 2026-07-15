# COSMOS — Software Architecture

> **New developer?** For a code-grounded, module-by-module walkthrough of the
> actual implementation, see the [Developer Guide](developer-guide/README.md).
> This document is the higher-level architectural overview.

## 1. System Overview

COSMOS is a desktop AI operating layer built on Electron. It runs as **one
application split across three JavaScript runtimes**, each with a strict
responsibility boundary. There is no separate server or daemon: the AI agent
loop, all tools, and all automation run **inside the main process**.

```
┌────────────────────────────────────────────────────────────────────┐
│  RENDERER (Chromium)  — the Experience Layer                        │
│  React 19 · TypeScript · Tailwind · Framer Motion · R3F/Three.js    │
│  Boot cinematic · AI Core orb · HUD · Chat · Palette · Studio ·     │
│  Vault · Secrets · Cleaner · Dashboard · Voice capture & playback   │
│  contextIsolation: true · nodeIntegration: false                    │
└──────────────────────────────▲─────────────────────────────────────┘
                               │  window.cosmos  — typed contextBridge (preload)
┌──────────────────────────────┴─────────────────────────────────────┐
│  MAIN (Node.js)  — the Service Layer                                │
│  index.ts (lifecycle, windows, tray, shortcuts) · ipc.ts (bindings) │
│  AIService — agent loop + sub-agents (Claude/OpenAI/Gemini/Ollama)  │
│  ToolRegistry — ~80 tools · MemoryService (SQLite) · SettingsService│
│  SecretsService · Workspace/Preview/Git · Cleaner · Weather · Stats │
│  Voice (STT/TTS) · Vision/OCR · Browser (Playwright) · Unity/Unreal │
└─────────────────────────────────────────────────────────────────────┘
       │ shells out to: PowerShell · git · piper · nvidia-smi · playwright-core
       │ talks to: AI provider HTTP APIs · Unity bridge (localhost:17890) · Unreal RC
```

### Why this split

- **The renderer never touches the OS or API keys.** `contextIsolation: true`,
  `nodeIntegration: false` (see `webPreferences` in `src/main/index.ts`).
  Everything crosses an explicit, typed preload surface (`window.cosmos`).
- **Main owns everything sensitive.** AI provider calls, the database, and all
  secrets live in main, so keys never enter the DOM and a streaming response
  survives a renderer reload.
- **Tools run in-process but are crash-guarded.** Each tool call is wrapped in a
  90-second timeout and an `AbortController`, so a hung browser automation or a
  stuck command rejects and the agent loop stays alive rather than freezing the
  HUD. Out-of-process work (PowerShell, git, Playwright's browser, Piper) is
  spawned as child processes.

## 2. Folder Structure (feature-based)

```
cosmos_ai/
├── docs/                        # product docs + developer-guide/ (code walkthrough)
├── resources/                   # bundled Piper TTS runtime + voices (fetched, gitignored)
├── src/
│   ├── shared/                  # code shared across all three processes
│   │   ├── ipc.ts               # IPC channel names + push-event payload types
│   │   ├── types.ts             # domain types + defaults (Settings, SystemStats, …)
│   │   ├── tools.ts             # tool-use types (ToolDef, ToolCall, AgentEvent, …)
│   │   └── personality.ts       # persona presets + bilingual prompt compiler
│   ├── main/
│   │   ├── index.ts             # app lifecycle, windows, tray, shortcuts, migration
│   │   ├── ipc.ts               # binds every service to its IPC channel
│   │   └── services/
│   │       ├── ai/              # AIService (agent loop), agents.ts, providers/
│   │       ├── tools/           # the ~80-tool catalog + ToolRegistry
│   │       ├── voice/           # SttService, TtsService
│   │       ├── unity/           # UnityService + C# bridge template
│   │       └── *.ts             # Settings, Memory, Secrets, Workspace, Cleaner, Git,
│   │                            #   Weather, SystemStats, Command, Browser, Media, …
│   ├── preload/
│   │   └── index.ts             # contextBridge: the ONLY renderer↔main surface
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx / App.tsx
│           ├── core/            # cross-feature runtime
│           │   ├── stores/      # zustand: ui, system, settings, assistant, notifications
│           │   ├── theme/       # theme tokens (CSS custom properties)
│           │   ├── sound/       # WebAudio-synthesized UI sound design
│           │   └── voice/       # MicRecorder, SpeechPlayer, voiceSignal
│           ├── features/        # boot · orb · hud · chat · palette · voice · agents ·
│           │                    #   settings · personality · vault · secrets · dashboard ·
│           │                    #   workspace · studio · appcenter · cleaner · notifications · compact
│           └── shared/ui/       # Glass, Markdown, StatCard, StatusDot
├── electron.vite.config.ts      # 3-target build + path aliases (@shared, @)
├── electron-builder.yml         # NSIS installer config
├── tailwind.config.ts
└── tsconfig{,.node,.web}.json   # split: node (main+preload) / web (renderer)
```

**Rule:** renderer features may import from `core/` and `shared/`, never from
each other. Cross-feature communication goes through Zustand stores or the
palette action registry.

## 3. Key Contracts

### 3.1 IPC (src/shared/ipc.ts + src/preload/index.ts)

All channel names are constants in `shared/ipc.ts`; all payloads are typed. The
preload exposes a namespaced `window.cosmos`, and `export type CosmosApi = typeof
cosmosApi` is the single source of truth the renderer's `global.d.ts` binds to.
The surface is broad — the main namespaces:

```
system · weather · ai · tools · history · sessions · vault · secrets ·
settings · commands · voice · notes · plugins · apps · cleaner ·
workspace · files · preview · terminal · github · app
```

Two mechanisms: `ipcRenderer.invoke` / `ipcMain.handle` for request/response, and
`webContents.send` / `ipcRenderer.on` for main→renderer push events
(`SYSTEM_STATS`, `AI_TOKEN/DONE/ERROR`, `TOOL_EVENT`, `TOOL_APPROVAL_REQUEST`,
`AGENT_EVENT`, `NOTIFY`, `FILES_CHANGED`, `TERM_DATA`, …). Full catalog in the
[Developer Guide → IPC & Preload](developer-guide/03-ipc-and-preload.md).

### 3.2 AI Provider Contract (src/main/services/ai/types.ts)

Every provider implements one streaming method. The agent loop stays
provider-agnostic; each provider converts the internal message shape to its own
wire format and returns any tool calls the model made:

```ts
interface AIProvider {
  id: ProviderId                 // 'anthropic' | 'openai' | 'gemini' | 'ollama'
  supportsTools: boolean
  streamChat(
    req: ProviderRequest,        // { model, system, messages, tools? }
    ctx: ProviderContext,        // { apiKey, baseUrl?, numCtx? }
    emit: (delta: string) => void,
    signal: AbortSignal
  ): Promise<TurnResult>         // { calls: ToolCall[] }  (empty ⇒ final answer)
}
```

Providers are `fetch`-based (SSE for Claude/OpenAI/Gemini, NDJSON for Ollama),
**no vendor SDKs** — zero native deps, instant model switching mid-conversation,
and Ollama works fully offline.

### 3.3 The Agent Loop (src/main/services/ai/AIService.ts)

`AIService.chat()` runs the model in a loop: stream a turn, execute any requested
tools (with approval + audit), feed the results back, repeat until the model
answers in plain text — bounded by a per-mode round cap (8 in chat/research, 24
in agent/ultra). It can **delegate** to five specialist sub-agents (planner,
researcher, coder, debugger, reviewer), each a system-prompted session over the
same `AIService` running at `depth: 1` with a restricted tool allowlist and no
ability to delegate further. Everything is abortable (barge-in) via an
`AbortController` per `requestId`. See
[Developer Guide → AI & the Agent Loop](developer-guide/04-ai-and-agent-loop.md).

### 3.4 Tool Registry & Permission Model (src/main/services/tools)

Every capability the AI can invoke is a `ToolSpec` in a single `ToolRegistry`.
Each `ToolDef` carries a `sensitive` flag; the agent loop enforces it centrally:

```ts
interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>   // JSON Schema
  sensitive: boolean                       // true ⇒ requires user approval
}
```

Sensitive tools raise a `TOOL_APPROVAL_REQUEST` and pause for an **Approve /
Always / Deny** decision (unless the tool is on the "Always allow" list, or
Autonomous Builder auto-approves the coding tool set in agent/ultra mode).
Read-only tools run automatically. Every execution — ok, error, or denied — is
written to the audit log, reviewable (and revocable) in the Vault. See
[Developer Guide → Tools](developer-guide/05-tools.md).

### 3.5 Assistant State Machine

The orb, sound design, and chat all key off one state, held in
`useAssistantStore`:

```
idle ──▶ listening ──▶ thinking ──▶ speaking ──▶ idle
  ▲                                    │
  └────────────── interrupt ◀──────────┘
```

Every visual system (shader uniforms, particle speed, glow, HUD pulse) derives
from it, and the orb's pulse is driven by the real audio envelope — the mic while
listening, TTS while speaking.

### 3.6 Command / Action Registry (src/renderer/src/features/palette/actions.ts)

A renderer-side registry of `Action` objects powers the `Ctrl+Space` command
palette — the one place features are invoked generically (open a panel, switch
theme, run a system command, launch a plugin command), so features never import
each other. Dangerous actions set `danger` and go through a confirmation flow.
(This is distinct from the AI tool-approval system in §3.4, which gates what the
*model* can do.)

## 4. Data & Persistence

Everything lives under `%APPDATA%\COSMOS` (the `userData` profile, pinned at the
top of `index.ts` so dev and the packaged app share one profile — critical for
`safeStorage` decryption).

- **Settings:** `SettingsService` persists one JSON document
  (`cosmos-settings.json`, with a `.bak`). Secret fields (API keys, tokens) are
  stored `enc:`-prefixed via `safeStorage`.
- **Database:** SQLite via the built-in **`node:sqlite`** (no native rebuild).
  `MemoryService` fronts conversations/sessions, long-term memory with
  embeddings for semantic recall, notes, and the audit log; `SecretsService`
  stores the encrypted secrets vault. Message/memory content is encrypted at
  rest.
- **Secrets:** API keys, tokens, and the vault are DPAPI-encrypted through
  `safeStorage` (`services/secureText.ts`). Ciphertext never leaves the main
  process; the renderer sees only masked previews. `SettingsService` is
  hardened to **never clobber an undecryptable blob** — see the "keys disappear"
  post-mortem in [Developer Guide → Data & Security](developer-guide/09-data-and-security.md).
- **On-disk mirrors:** notes & research reports are also written as `.md` files
  (`NotesExportService`); the TTS audio cache lives in `tts-cache/`.

## 5. Performance Model

- 60 FPS target on the composited UI; the R3F canvas is the only WebGL surface,
  `frameloop="always"` with capped DPR (`Math.min(dpr, 2)`).
- Shader-driven animation (GPU) for the orb & particles; Framer Motion only for
  DOM transitions; transform/opacity animations only.
- **Streaming tokens are coalesced** in the renderer: deltas are buffered and
  committed to the chat store at most ~25×/s, so a long markdown reply's
  re-parse can't starve the always-animating orb's frame loop — while the voice
  pipeline still receives every token immediately. (See
  `useAssistantStore.ts`.)
- System stats are polled every ~2s in main and **pushed** — the renderer never
  polls.
- Panels are always mounted and animate on `activePanel` (state survives
  closing) rather than being mounted/unmounted per open.

## 6. Multi-Agent Architecture

COSMOS's orchestrator can delegate to five specialist sub-agents — **planner,
researcher, coder, debugger, reviewer** — via the `delegate` tool
(`src/main/services/ai/agents.ts`). Each agent is a system-prompted session over
the same `AIService`, given a focused tool allowlist, and run to completion in
its own bounded message loop; its report becomes the tool result handed back to
the orchestrator. Agents run **in the main process** (not a separate daemon or
MCP host), at `depth: 1`, and cannot delegate further — no recursion. The
renderer animates them as a ring around the orb via `AGENT_EVENT`s. Details in
[Developer Guide → AI & the Agent Loop](developer-guide/04-ai-and-agent-loop.md#sub-agents-delegation)
and the roadmap narrative in [ROADMAP.md](ROADMAP.md).
