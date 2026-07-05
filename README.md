# COSMOS

A cinematic, voice-first desktop AI assistant. Dark holographic HUD, a living
shader-driven AI core, live system telemetry, and streaming multi-provider AI —
built on Electron, React 19, TypeScript, Three.js/R3F, Framer Motion and GSAP.

![status](https://img.shields.io/badge/roadmap-complete%20%C2%B7%207%2F7%20phases-2dd4a7)

## Quick start

```bash
npm install        # once, after cloning or pulling new code
npm run dev        # run in development (hot reload)
```

Then open **Settings (⚙ or Ctrl+Space → "Open Settings")** and paste an API key
for Claude / OpenAI / Gemini — or run [Ollama](https://ollama.com) locally for a
fully offline model. Switch providers instantly from the chat panel tabs.

## Running & building — the reliable way

COSMOS stores your API keys, memory and settings in **`%APPDATA%\COSMOS`**,
encrypted with Windows DPAPI. Dev mode and the installed app share that one
folder, so **keys you enter once work in both** — you don't re-enter them per
run.

**Run in development** (for editing code, hot reload):

```bash
npm run dev
```

**Build the installer** (`.exe`) and use COSMOS like a normal app:

```bash
npm run dist
```

This produces **`release\COSMOS Setup 0.1.0.exe`**. Run it to install COSMOS
into your Start menu; launch it from there like any app. This is the
recommended way to actually *use* COSMOS day-to-day (no terminal needed). To
ship a new version after code changes, just run `npm run dist` again and
re-run the installer.

> **Note on API keys:** keys are tied to the Windows user + the `%APPDATA%\COSMOS`
> profile. They survive updates and reinstalls. The only time you'd re-enter
> them is if you delete that folder or move to a different Windows account — and
> even then, COSMOS never *deletes* an unreadable key, it just asks you to type
> it again.

| Shortcut | Action |
|---|---|
| `Ctrl+Space` | Command palette (works globally, even when unfocused) |
| `Ctrl+J` | Speak to COSMOS (push-to-talk; press again to finish early) |
| `Enter` | Send message |
| `Esc` | Close palette / settings |

## Voice

Voice replies work out of the box using the built-in Windows voice; switch to
**ElevenLabs** (API key) or **Piper** (offline neural TTS) in Settings → Voice.
Voice *input* uses the OpenAI Whisper API, so it needs an OpenAI key.

Enable **Hands-Free** in Settings (or the palette) and just say
*"Cosmos, …"* — a local voice-activity detector segments your speech and only
utterances addressed to Cosmos are executed. Speaking again, sending a new
message, or hitting Stop interrupts him mid-sentence.

## Tools — Cosmos can act

With Claude or GPT selected, Cosmos has real hands: ask him to *"find my tax
PDFs and zip them"*, *"take a screenshot"*, *"what's hogging my CPU?"*, or
*"open Spotify and turn the volume down"*. He can list/read/write/search/move
files, delete to the Recycle Bin, zip/unzip, run PowerShell commands, use the
clipboard, launch apps and URLs, and control volume and power.

**Sensitive actions always ask first** — writes, moves, deletes, terminal
commands, and power actions pause with an Approve / Always / Deny card in the
chat. Read-only tools run automatically, and every action shows live in the
transcript. Conversations persist in SQLite and are restored on launch.

## The Team & the Web

For complex work, Cosmos leads a team. Ask for something multi-step —
*"research the best Rust game engines and write me a comparison doc"* — and
he'll delegate to specialist agents: **planner**, **researcher**, **coder**,
**debugger**, **reviewer**. You'll see them materialize as glowing chips
orbiting the core while they work, and every tool they touch is tagged in the
transcript. He can also browse: web search, page reading, and full browser
automation (via your installed Edge/Chrome — clicking and form-filling always
ask permission first).

## Eyes & Engines

Cosmos can see: *"look at my screen and tell me what this error means"* uses
your vision model on a live capture, and offline OCR (Windows' built-in
engine, no API call) extracts exact text from the screen or any image.

For game developers: say *"install your bridge into D:\\Projects\\MyGame"*
and Cosmos drops a `CosmosBridge.cs` into the Unity project. From then on he
can read the console (including compile errors), dump the scene hierarchy,
refresh assets, and enter/exit play mode — so "write me a player controller"
becomes write → recompile → check errors → fix, hands-free. Unreal projects
are reachable through the engine's Remote Control API plugin.

## Platform

- **Dashboard** (▦) — live overview: telemetry, weather, today's actions,
  memories, quick actions
- **Workspace** (✎) — persistent encrypted notes; agents write research and
  reports straight into it
- **Notifications** (◔) — glass toasts + a notification center; Cosmos can
  alert you proactively via his `notify` tool
- **Compact mode** (⧉) — Cosmos shrinks to a floating always-on-top orb you
  can keep over your game or IDE
- **Plugins** — drop a `plugin.json` into the plugins folder to add palette
  commands ([docs/PLUGINS.md](docs/PLUGINS.md))

## Memory & the Vault

Cosmos remembers you. Durable preferences, projects, and goals are saved to
long-term memory (automatically via tool use, or manually) and recalled by
semantic similarity into every conversation — tell him once that you build in
Unity, and he'll know next week. Open the **Vault** (◈ in the title bar) to
browse and delete memories, revoke "Always allow" tool grants, and review the
audit log of everything Cosmos has done on your machine. API keys, chat
history, and memory content are encrypted at rest with Windows DPAPI.

## What's in Phase 1

- **Boot cinematic** — particle field, scanline sweep, GSAP glyph-scramble
  module init, glowing COSMOS reveal, synthesized power-on sound
- **AI Core** — custom GLSL noise-displaced orb with fresnel rim, 2,400
  orbiting GPU particles, gyroscope rings; visibly shifts between
  idle / listening / thinking / speaking
- **Holographic HUD** — draggable glass cards: CPU, GPU, RAM, network,
  battery, clock, weather (keyless Open-Meteo), all live
- **AI conversation** — streaming, interruptible, provider-switchable
  (Anthropic / OpenAI / Gemini / Ollama), keys never leave the main process
- **Command palette** — apps, websites, power controls (with confirmation
  for destructive actions), themes, AI actions
- **5 themes** · **synthesized UI sound design** · **searchable settings**

## Scripts

```bash
npm run dev         # dev mode with HMR
npm run build       # production bundles into out/
npm run start       # preview the production build
npm run typecheck   # strict TS across main + renderer
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — process model, folder
  structure, IPC contracts, provider abstraction
- [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) — tokens, glass recipe,
  motion language, orb states, sound design
- [docs/ROADMAP.md](docs/ROADMAP.md) — Phases 2–7: voice, automation daemon,
  vector memory, multi-agent, Unity/Unreal, plugins
