# 01 · Getting Started

This page gets a new developer from a fresh clone to a running dev build, and
explains the project layout and build tooling.

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| **Node.js** | 20+ (with `node:sqlite`) | The app uses the built-in `node:sqlite` module — no native SQLite rebuild. Node 20.5+ / 22 recommended. |
| **npm** | bundled with Node | Package + script runner. |
| **Windows** | 10 / 11 | COSMOS is Windows-first — it shells out to PowerShell for app launching, system control, cleaning, OCR, and SAPI voices. It runs in dev on other platforms but most system tools are no-ops there. |
| Internet (first build only) | — | `npm run dist` downloads the Piper voice runtime (~270 MB) once. |

An **AI provider** is needed to do anything useful: an API key for Anthropic /
OpenAI / Gemini, **or** a local [Ollama](https://ollama.com) server for fully
offline models. Keys are entered in-app (Settings), never in code.

---

## Install & run

```bash
git clone <repo-url>
cd cosmos_ai
npm install          # once
npm run dev          # launch with hot reload (electron-vite)
```

On first launch you land in the boot cinematic, then the main HUD. Open
**Settings** (gear icon, or `Ctrl+Space` → "Open Settings") and paste an API key,
or point it at your local Ollama.

> **Dev vs. installed app share one profile.** `src/main/index.ts` pins the app
> identity to `%APPDATA%\COSMOS` before any service starts, so `npm run dev` and
> the installed `.exe` read the *same* encrypted keys, memory, and settings. See
> [Data & Security](09-data-and-security.md).

---

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev mode with hot-reload for all three processes (electron-vite). |
| `npm run build` | Type-check + production bundles into `out/`. |
| `npm run start` | Preview the production build (`electron-vite preview`). |
| `npm run dist` | Build the Windows NSIS installer → `release/COSMOS Setup 0.1.0.exe`. Runs `predist` first to fetch Piper voices. |
| `npm run setup:piper` | Fetch the Piper TTS runtime + bundled voices into `resources/` (auto-run before `dist`). |
| `npm run typecheck` | Strict TypeScript across main **and** renderer (`typecheck:node` + `typecheck:web`). |

**Always run `npm run typecheck` before committing.** There are no unit tests in
the repo; the compiler + a manual smoke test of the affected flow are the safety
net. The shared types make most contract mistakes a compile error.

---

## Project layout

```
cosmos_ai/
├── docs/                     # product docs + this developer-guide/
├── resources/                # bundled Piper TTS runtime + .onnx voices (gitignored, fetched)
├── scripts/                  # fetch-piper.mjs and other build scripts
├── electron.vite.config.ts   # 3-target build config + path aliases
├── electron-builder.yml      # installer/packaging config
├── tsconfig*.json            # base / node / web TypeScript projects
├── tailwind.config.ts        # design tokens
└── src/
    ├── shared/               # cross-process code (imported everywhere)
    │   ├── ipc.ts            # IPC channel names + push-event payload types
    │   ├── types.ts          # domain types + defaults (Settings, SystemStats, …)
    │   ├── tools.ts          # tool-use types (ToolDef, ToolCall, AgentEvent, …)
    │   └── personality.ts    # persona presets + the prompt compiler
    ├── main/                 # Node.js — the service layer
    │   ├── index.ts          # app lifecycle, windows, tray, shortcuts, migration
    │   ├── ipc.ts            # binds every service to its IPC channel
    │   ├── trayIcon.ts       # base64 tray PNG
    │   └── services/
    │       ├── ai/           # AIService, agent defs, provider abstraction
    │       │   └── providers/ # anthropic · openai · gemini · ollama
    │       ├── tools/        # the tool catalog (one file per group) + ToolRegistry
    │       ├── voice/        # SttService, TtsService
    │       ├── unity/        # UnityService + the C# bridge template
    │       └── *.ts          # Settings, Memory, Secrets, Workspace, Cleaner, …
    ├── preload/
    │   └── index.ts          # contextBridge — the ONLY renderer↔main surface
    └── renderer/
        ├── index.html
        └── src/
            ├── main.tsx / App.tsx    # React entry + top-level composition
            ├── core/                 # cross-feature runtime
            │   ├── stores/           # Zustand: ui, system, settings, assistant, notifications
            │   ├── theme/            # theme tokens
            │   ├── sound/            # WebAudio UI sound design
            │   └── voice/            # MicRecorder, SpeechPlayer, voiceSignal
            ├── features/             # one folder per feature (see below)
            ├── shared/ui/            # Glass, Markdown, StatusDot, StatCard
            └── styles/
```

### Feature folders (`src/renderer/src/features/`)

Each is a self-contained UI area: `boot`, `orb`, `hud`, `chat`, `palette`,
`voice`, `agents`, `settings`, `personality`, `vault`, `secrets`, `dashboard`,
`workspace`, `studio`, `appcenter`, `cleaner`, `notifications`, `compact`. Most
own their components and, where they hold state, a local Zustand store (e.g.
`features/voice/useVoiceStore.ts`). See [The Renderer](07-renderer.md).

---

## Path aliases

Defined once in [`electron.vite.config.ts`](../../electron.vite.config.ts) and
mirrored in the tsconfigs:

| Alias | Resolves to | Available in |
|---|---|---|
| `@shared/*` | `src/shared/*` | main, preload, renderer |
| `@/*` | `src/renderer/src/*` | renderer only |

So `import { IPC } from '@shared/ipc'` works in every process, and `import { sound }
from '@/core/sound/SoundEngine'` works in the renderer. Prefer aliases over deep
relative paths.

---

## Build targets & TypeScript projects

electron-vite builds **three** separate bundles from one config:

- **main** and **preload** — externalize node deps (`externalizeDepsPlugin`),
  alias `@shared`.
- **renderer** — the React app (`@vitejs/plugin-react`), aliases `@` and
  `@shared`.

TypeScript is split to match the two runtimes:

- `tsconfig.node.json` → main + preload (Node lib, `typecheck:node`).
- `tsconfig.web.json` → renderer (DOM lib, `typecheck:web`).

This separation is why renderer code can't accidentally import Node APIs and
vice-versa — the two projects have different `lib`/`types`.

---

## Where things are stored at runtime

Everything lives under `%APPDATA%\COSMOS` (Windows):

| File / folder | Contents |
|---|---|
| `cosmos-settings.json` | Settings, with secret fields DPAPI-encrypted (`enc:` prefix) |
| `cosmos-memory.db` | SQLite: conversations, long-term memory, embeddings, audit log, notes, secrets |
| `plugins/` | Dropped-in `plugin.json` command packs |
| TTS cache | Synthesized audio cache (capped) |

Details in [Data & Security](09-data-and-security.md).

---

Next: [Architecture →](02-architecture.md)
