<div align="center">

# 🌌 COSMOS

### The desktop AI assistant that feels like J.A.R.V.I.S.

A cinematic, voice-first AI operating layer for Windows — a living, shader-driven
AI core, a holographic HUD, real system control, and a team of AI agents at your command.

<br />

![Status](https://img.shields.io/badge/roadmap-7%2F7_phases_complete-2dd4a7?style=for-the-badge)
![Platform](https://img.shields.io/badge/platform-Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-a78bfa?style=for-the-badge)

![Electron](https://img.shields.io/badge/Electron-2B2E3A?style=flat&logo=electron&logoColor=9FEAF9)
![React](https://img.shields.io/badge/React_19-20232A?style=flat&logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-000000?style=flat&logo=three.js&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-06B6D4?style=flat&logo=tailwindcss&logoColor=white)

</div>

<!--
  📸 Tip: drop a screenshot or a short GIF of COSMOS here for maximum impact, e.g.
  <p align="center"><img src="docs/preview.gif" width="820" alt="COSMOS preview" /></p>
-->

---

## ✨ What is COSMOS?

COSMOS is **not a chatbot in a window**. It's a full AI experience: launch it and a
cinematic boot sequence reveals a **living AI core** — a custom GLSL orb wrapped in
2,400 orbiting particles that reacts to your voice, your cursor, and its own thoughts.
Around it float live holograms of your system, and behind it is a genuine assistant
that can **see your screen, control your PC, browse the web, remember you, and command
a team of specialist agents**.

<div align="center">

| 🎬 Cinematic | 🎙️ Voice-first | 🛠️ Real hands | 🧠 Remembers you |
|:---:|:---:|:---:|:---:|
| Shader orb, glass HUD, particle FX | Wake word, STT + neural TTS | Files, apps, terminal, web | Encrypted long-term memory |

</div>

---

## 🚀 Quick Start

```bash
git clone <your-repo-url>
cd cosmos_ai
npm install        # once
npm run dev        # launch with hot reload
```

Then open **Settings** (`⚙` in the title bar, or `Ctrl+Space` → *"Open Settings"*) and
paste an API key for **Claude**, **OpenAI**, or **Gemini** — or run
[Ollama](https://ollama.com) locally for a **100% offline** model. Switch providers
instantly from the tabs at the top of the chat panel.

> [!TIP]
> Voice replies and offline OCR work out of the box. Voice **input** (Whisper) and
> **vision** use your OpenAI/Claude/Gemini key.

---

## 📦 Build the App

To use COSMOS like a normal installed app (no terminal):

```bash
npm run dist       # → release/COSMOS Setup 0.1.0.exe
```

Run the installer, launch COSMOS from your Start menu, and it lives in your **system
tray** — closing the window keeps it running in the background. Ship an update by
running `npm run dist` again.

> [!NOTE]
> Your API keys, memory, and settings live encrypted in `%APPDATA%\COSMOS` (Windows
> DPAPI). Dev mode and the installed app **share that folder**, so you enter keys once
> and they survive updates and reinstalls.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|:--|:--|
| `Ctrl` + `Space` | **Command palette** — works globally, even when COSMOS is unfocused |
| `Ctrl` + `J` | **Push-to-talk** — speak to COSMOS (press again to finish early) |
| `Enter` | Send message |
| `Esc` | Close the palette / any panel |

---

## 🧠 AI Providers

Switch between any of these instantly — keys never leave the main process.

| Provider | Models | Notes |
|:--|:--|:--|
| **Anthropic** | Claude | Full tool use + vision |
| **OpenAI** | GPT | Full tool use + vision |
| **Google** | Gemini | Full tool use + vision |
| **Ollama** | Llama 3.1, Qwen, Mistral… | **Fully offline**, tool use on supported models |

---

## 🎙️ Voice

- **Speaks out of the box** with the built-in Windows voice — upgrade to
  **ElevenLabs** (premium) or **Piper** (offline neural TTS) in *Settings → Voice*.
- **Push-to-talk** (`Ctrl+J`) or fully **hands-free**: enable it and just say
  *"Cosmos, …"* — a local voice-activity detector segments your speech and only
  utterances addressed to Cosmos are executed.
- **Barge-in** — talk over it, send a new message, or hit Stop to interrupt mid-sentence.
- The orb's pulse is driven by the **real audio envelope** — mic while listening, TTS
  while speaking.

---

## 🛠️ What COSMOS Can Do

With Claude, GPT, or Gemini selected, COSMOS has **real hands**:

> 💬 *"Find my tax PDFs and zip them to the desktop"*
> 💬 *"Open Steam and play Believer by Imagine Dragons"*
> 💬 *"What's hogging my CPU right now?"*
> 💬 *"Research the best Rust game engines and save me a comparison note"*

<table>
<tr>
<td valign="top" width="50%">

**🗂️ Files & System**
- List / read / write / search / move files
- Delete to Recycle Bin, zip / unzip
- Run PowerShell commands
- Launch & **close** apps, open URLs
- Volume, power (sleep / restart / shutdown)
- Clipboard, screenshots, live telemetry

</td>
<td valign="top" width="50%">

**🌐 Web & Vision**
- Web search + news + page reading
- Full browser automation (Edge / Chrome)
- **Play media** in your default browser
- See your screen (vision model)
- Offline OCR (Windows engine, no API)

</td>
</tr>
</table>

> [!IMPORTANT]
> **Sensitive actions always ask first.** Writes, deletes, terminal commands, and power
> actions pause with an **Approve / Always / Deny** card. Read-only tools run
> automatically, every action is shown live in the transcript, and everything is written
> to an **audit log** you can review in the Vault.

---

## 👥 The Team — Multi-Agent

<details open>
<summary><b>COSMOS leads a team of specialist agents for complex work.</b></summary>

<br />

Ask for something multi-step and COSMOS **delegates** to focused sub-agents — you'll
see them materialize as glowing chips **orbiting the AI core** while they work, each
tool they touch tagged in the transcript.

| Agent | Role |
|:--|:--|
| 🧭 **Planner** | Decomposes a goal into a concrete plan |
| 🔎 **Researcher** | Web + local research with cited findings |
| 💻 **Coder** | Reads projects, writes code, runs tests |
| 🐛 **Debugger** | Reproduces, root-causes, and fixes |
| 🔍 **Reviewer** | Read-only code review by severity |

</details>

---

## 👁️ Vision & Creator Integrations

- **See the screen** — *"look at my screen and tell me what this error means"* runs your
  vision model on a live capture. Offline **OCR** extracts exact text with no API call.
- **Unity** — *"install your bridge into my Unity project"* drops a `CosmosBridge.cs`
  editor script; COSMOS can then read the console (incl. compile errors), dump the scene
  hierarchy, refresh assets, and enter/exit play mode. *Write → recompile → fix*, hands-free.
- **Unreal** — reachable through the engine's Remote Control API plugin.

---

## 🗄️ Memory & The Vault

COSMOS **remembers you**. Durable preferences, projects, and goals are saved to
long-term memory and recalled by **semantic similarity** into every conversation — tell
it once you build in Unity, and it knows next week.

Open the **Vault** (`◈`) to:
- 🧠 Browse, add, and delete memories
- 🔐 Revoke *"Always allow"* tool grants
- 📜 Review the full audit log of everything COSMOS has done

> API keys, chat history, and memory content are **encrypted at rest** with Windows DPAPI.

---

## 🎨 Platform

| | Feature |
|:--:|:--|
| ▦ | **Dashboard** — live telemetry, weather, today's activity, quick actions |
| ✎ | **Workspace** — persistent encrypted notes the agents can write into |
| ◔ | **Notifications** — glass toasts + a center; COSMOS can alert you proactively |
| ◉ | **Orb / Compact mode** — shrink to a floating always-on-top orb over your game or IDE |
| ⧉ | **System tray** — runs in the background; quit only when *you* say so |
| 🎨 | **5 themes** — Cyber Blue · Crimson · Nebula Purple · Emerald · Arctic White |
| 🧩 | **Plugins** — drop a `plugin.json` to add palette commands ([guide](docs/PLUGINS.md)) |

---

## 🧬 Tech Stack

<div align="center">

| Layer | Technologies |
|:--|:--|
| **Shell** | Electron · electron-vite |
| **UI** | React 19 · TypeScript · TailwindCSS · Framer Motion · GSAP |
| **3D / FX** | Three.js · React Three Fiber · custom GLSL shaders |
| **State** | Zustand |
| **AI** | Claude · OpenAI · Gemini · Ollama (streaming, native tool-use) |
| **Voice** | Whisper (STT) · Windows SAPI / ElevenLabs / Piper (TTS) |
| **Data** | SQLite (`node:sqlite`) · safeStorage (DPAPI) encryption |
| **Automation** | Playwright · PowerShell · Windows OCR |

</div>

---

## 📂 Project Structure

```
src/
├── shared/          # types + IPC contracts shared across processes
├── main/            # Node.js — services, AI, tools, tray, windows
│   └── services/    # AIService, MemoryService, tools/, voice/, unity/ …
├── preload/         # the single typed renderer ↔ main bridge
└── renderer/src/
    ├── core/        # stores (zustand), theme, sound, voice
    └── features/    # boot · orb · hud · chat · palette · vault · agents …
```

---

## 📖 Documentation

| Doc | What's inside |
|:--|:--|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model, folder structure, IPC contracts, provider abstraction |
| [DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | Design tokens, glass recipe, motion language, orb states, sound design |
| [ROADMAP.md](docs/ROADMAP.md) | All 7 shipped phases + the post-roadmap backlog |
| [PLUGINS.md](docs/PLUGINS.md) | Plugin format & examples |

---

## 🧑‍💻 Scripts

```bash
npm run dev         # dev mode with hot reload
npm run build       # production bundles into out/
npm run dist        # build the Windows installer → release/
npm run typecheck   # strict TypeScript across main + renderer
npm run start       # preview the production build
```

---

<div align="center">

## 📜 License

Released under the [MIT License](LICENSE).

<br />

**Built to feel like the real thing.**
<br />
<sub>🌌 COSMOS</sub>

</div>
