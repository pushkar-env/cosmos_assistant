# COSMOS — Developer Guide

A code-grounded reference for new developers. Where the top-level [docs/](../)
folder explains *what* COSMOS is (product, design system, roadmap, plugins),
this guide explains *how the code works* — every process, module, and contract —
so you can find your way around and make changes confidently.

> **New here? Read in this order:** [Getting Started](01-getting-started.md) →
> [Architecture](02-architecture.md) → the area you need to touch.

---

## What COSMOS is (30-second version)

COSMOS is a **cinematic, voice-first desktop AI assistant for Windows**, built on
**Electron + React 19 + TypeScript**, with a WebGL "AI core" orb (Three.js /
React Three Fiber). It runs a multi-provider streaming chat (Anthropic, OpenAI,
Gemini, Ollama) wrapped in an **agent loop** that can call ~80 real tools —
files, terminal, apps, web, browser automation, vision, memory, git, and system
control — each gated by an **Approve / Always / Deny** permission layer. It has
voice in and out, long-term vector memory, a code Studio (editor + terminal),
and a CCleaner-style system cleaner.

---

## The three runtimes

COSMOS is one Electron app split across three JavaScript contexts. Almost every
feature is a collaboration between them, so knowing the split is the key to the
whole codebase:

| Runtime | Folder | Runs | Owns |
|---|---|---|---|
| **Main** | [`src/main/`](../../src/main) | Node.js | The OS, API keys, the database, all services, the AI agent loop |
| **Preload** | [`src/preload/`](../../src/preload) | Isolated bridge | The single typed `window.cosmos` API surface |
| **Renderer** | [`src/renderer/`](../../src/renderer) | Chromium | All UI: the orb, HUD, chat, panels, voice capture/playback |
| **Shared** | [`src/shared/`](../../src/shared) | Imported by all | Types, IPC channel names, tool types, the personality compiler |

The renderer **never** touches Node, the filesystem, or secrets. Everything
crosses the `window.cosmos` bridge (see [IPC & Preload](03-ipc-and-preload.md)).

---

## Guide contents

| # | Doc | What's inside |
|---|---|---|
| 01 | [Getting Started](01-getting-started.md) | Prerequisites, install, dev/build scripts, project layout, path aliases, TypeScript setup |
| 02 | [Architecture](02-architecture.md) | Process model, app lifecycle (`index.ts`), window modes, single-instance, tray, the end-to-end request flow |
| 03 | [IPC & Preload](03-ipc-and-preload.md) | The `window.cosmos` contract, channel catalog, push vs. invoke, adding a channel |
| 04 | [AI & the Agent Loop](04-ai-and-agent-loop.md) | `AIService`, the tool loop, assistant modes, system prompt, sub-agents, the provider abstraction & streaming |
| 05 | [Tools](05-tools.md) | `ToolRegistry`, `ToolSpec`, the full tool catalog, sensitivity & approval, local-model curation, adding a tool |
| 06 | [Main-Process Services](06-main-services.md) | Reference for every service class in `src/main/services` |
| 07 | [The Renderer](07-renderer.md) | UI architecture, Zustand stores, feature panels, the orb, token coalescing, HMR-safe singletons |
| 08 | [The Voice Pipeline](08-voice-pipeline.md) | STT, TTS, hands-free wake word, sentence chunking, echo suppression, barge-in |
| 09 | [Data & Security](09-data-and-security.md) | SQLite persistence, `safeStorage`/DPAPI encryption, the userData profile, the "keys disappear" lesson |
| 10 | [Personality System](10-personality-system.md) | Persona presets, trait dials, the bilingual prompt compiler |
| 11 | [Extending COSMOS](11-extending.md) | Step-by-step recipes: add a tool, IPC channel, service, panel, provider, or plugin |

---

## Conventions used in this guide

- **File references** are clickable and relative to the repo root, e.g.
  [`src/main/services/ai/AIService.ts`](../../src/main/services/ai/AIService.ts).
- Code identifiers are in `monospace`.
- "Frontier providers" = Anthropic / OpenAI / Gemini (full tool + vision
  support). "Local" = Ollama (offline, curated toolset in chat mode).
- Everything here reflects the code as it stands. If a doc and the code
  disagree, the code wins — please fix the doc.

---

## The golden rules of this codebase

1. **The renderer is untrusted UI.** No Node, no `fs`, no keys. Add capabilities
   by exposing a typed method on the preload bridge, never by loosening
   isolation.
2. **`src/shared` is the single source of truth** for types and IPC channel
   names. Both processes import it, so a contract change is caught by the
   compiler on both sides.
3. **Features never import each other.** Renderer features talk through stores
   (`src/renderer/src/core/stores`) or the palette action registry — never by
   importing another feature's components.
4. **One tool registry, one approval path.** Every capability the AI can invoke
   is a `ToolSpec` in the registry; sensitivity and audit are enforced centrally
   in the agent loop.
5. **Secrets stay in main, encrypted at rest.** API keys, tokens, and the
   secrets vault are DPAPI-encrypted via `safeStorage`; ciphertext never reaches
   the renderer.
