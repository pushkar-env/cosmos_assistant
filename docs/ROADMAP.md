# COSMOS — Implementation Roadmap

Each phase ships a runnable, polished increment. No phase leaves broken UI
behind.

## Phase 1 — The Living Shell  ✅ (this codebase)
- Electron + electron-vite + React 19 + TS strict scaffold
- Cinematic boot sequence (particles, scan, module init, wordmark reveal)
- AI Core orb: R3F shader orb + particle field + gyro rings, 4-state machine
- Holographic HUD: CPU / GPU / RAM / network / battery / clock / weather,
  live-updating, draggable glass cards
- Multi-provider streaming chat (Claude, OpenAI, Gemini, Ollama) with
  instant model switching; keys stored main-side only
- CTRL+SPACE command palette with action registry, fuzzy search,
  danger-confirmation flow (apps, web, power, themes)
- 5 themes, WebAudio sound design, searchable settings

## Phase 2 — Voice  ✅
- Push-to-talk (Ctrl+J / mic button) with energy-based VAD auto-stop
- Hands-free wake mode: continuous local VAD segmentation; only utterances
  addressed to "Cosmos" execute (recorder never clips the wake word — it
  cuts segments at silence boundaries, so the full utterance is captured)
- Whisper STT (OpenAI API) from the main process
- TTS with three engines: ElevenLabs (online), Piper (offline,
  user-installed), Windows SAPI (offline, zero-setup default)
- Sentence-by-sentence synthesis while the LLM streams → fast first audio
- Full barge-in: new speech/message stops playback and aborts the stream
- Orb `speaking`/`listening` amplitude driven by the real audio envelope
  (AnalyserNode → shared voiceSignal read by the R3F frame loop)
- Deferred to a later pass: dedicated wake-word engine (Porcupine WASM has
  a built-in "Cosmos" keyword but requires a Picovoice access key),
  local whisper.cpp STT, streamed TTS chunks

## Phase 3 — Hands  ✅
- Agentic tool-use loop in the main process: streamed native function
  calling for **Anthropic and OpenAI** (multi-round, abortable); tool
  transcripts stay main-side, renderer sees live activity events
- 17-tool registry: fs list/read/write/search/move/mkdir, delete → Recycle
  Bin, zip/unzip, PowerShell terminal (30s cap, output truncation),
  clipboard read/write, screenshots (desktopCapturer → Pictures), app/URL
  launch, volume (SendKeys media keys), power actions, live telemetry
- Permission system: sensitive tools pause the loop for an Approve/Deny
  card in the chat (2-min timeout → deny); read-only tools auto-run
- SQLite conversation persistence via `node:sqlite` (verified active in
  Electron; JSON fallback if the module is ever unavailable); history
  restored on launch, Clear Conversation starts a new one
- Deferred: Gemini/Ollama function calling, PTY terminal sessions
  (node-pty is a native dep), OCR (tesseract WASM), brightness/WiFi/BT
  toggles, out-of-process Express daemon + MCP host (revisit when
  Playwright lands in Phase 5)

## Phase 4 — Memory & Trust  ✅
- Long-term memory: `memories` table with embeddings (OpenAI
  text-embedding-3-small → Ollama nomic-embed-text → keyword fallback),
  in-process cosine recall (no native sqlite-vec needed at this scale);
  top-5 relevant memories auto-injected into the system prompt each turn
- Model-facing tools: memory_save / memory_search / memory_delete, with
  system-prompt guidance to capture durable preferences/projects/goals
- Vault panel (◈): memory browser (add/forget), permission grants,
  audit log — palette: "Open Vault"
- Trust: "Always allow" per-tool grants on the approval card (persisted,
  revocable in the Vault); every tool execution audit-logged
  (ok/error/denied, capped 500)
- Encryption at rest via safeStorage/DPAPI: API keys (verified migrated
  on disk to enc: blobs), conversation messages, memory content;
  embeddings stored as plaintext vectors (documented trade-off)

## Phase 5 — The Team (Multi-Agent)  ✅
- Orchestrator pattern: COSMOS delegates via a `delegate` tool to five
  specialists — planner, researcher, coder, debugger, reviewer — each a
  system-prompted session over the same provider with a role-filtered
  tool allowlist, bounded rounds (6), depth-limited (no recursive
  delegation), sharing the abort signal and approval/audit pipeline
- Live visualization: AGENT_EVENT stream → agent chips orbit the orb
  while working (pulse → ✓/✕, linger 3s); transcript tool cards carry
  the acting agent's tag
- Browser agent: `playwright-core` over installed Edge/Chrome (channel
  launch, no downloads — verified: msedge headless OK); tools:
  browser_goto/read/inputs/click/type/screenshot/close + web_search
  (DuckDuckGo) + web_fetch (tagless HTTP). click/type are
  approval-gated; session auto-closes after 3 min idle
- Deferred: VS Code extension bridge (the coder agent already covers
  read-project/edit/test/commit via fs + terminal); Designer agent
  (needs the Phase 7 workspace to design into); typed task-graph
  parallelism (sequential delegation shipped first)

## Phase 6 — Creator Integrations  ✅
- Vision: vision_screen / vision_image — screen or image analysis via the
  active multimodal provider (Claude/GPT/Gemini, one-shot non-streaming
  calls in VisionService); "find the button", "explain this error"
- OCR: ocr_screen / ocr_image — fully offline via the Windows built-in
  OCR engine (WinRT through a PowerShell shim; emitted shim verified
  end-to-end against a rendered test image)
- Unity: self-installing editor bridge — unity_install_bridge writes
  CosmosBridge.cs (HTTP listener :17890, main-thread marshaling via
  EditorApplication.update) into Assets/Editor; tools: status, console
  (logs + compile errors), scene hierarchy dump, refresh, play/stop,
  menu execution (sensitive). Script gen loop = fs_write → unity_refresh
  → unity_console
- Unreal: unreal_status / unreal_command over the built-in Remote
  Control API plugin (:30010); Blueprint/C++ work rides the coder agent
- Agents: researcher + debugger gained vision/OCR; coder + debugger
  gained Unity tools
- Deferred: Unity bridge cannot be compile-verified here (no Unity
  install) — C# kept conservative; prefab/asset introspection and
  build-and-run orchestration once a real project can validate them

## Phase 7 — Platform  ✅
- Notifications: glass toast stack + bell/center in the status bar
  (unread badge, mark-read, clear); `notify` tool lets Cosmos alert
  proactively; request failures auto-toast
- Dashboard (▦): greeting, live telemetry/weather, today's action &
  denial counts from the audit log, memory/note counts, quick actions —
  all real data, zero placeholders
- AI Workspace (✎): SQLite-persisted notes (encrypted at rest),
  two-pane editor with debounced autosave; note_write/note_list/
  note_read tools — researcher & coder write reports into it
- Compact mode (⧉): always-on-top 400×560 floating Cosmos (orb + last
  reply + mic + composer); bounds restored on expand
- Plugin system v1 (docs/PLUGINS.md): declarative plugin.json in
  userData/plugins contributes palette commands (url / app / shell);
  shell commands always confirm; no plugin code executes in-process
- Packaging: electron-builder NSIS config + `npm run dist`
- Deferred: whiteboard & mind maps, GitHub activity feed (needs OAuth),
  auto-update (needs a publish target), sandboxed scripted plugins
  (v2 — see PLUGINS.md), custom app icon

---

**All seven phases shipped.** Post-roadmap upgrades landed since:
- **Live-information overhaul**: recency policy in the system prompt (a
  knowledge cutoff is never a reason to refuse — search instead, cite
  source + date); `news_search` (Google News RSS, dated headlines);
  `web_search` rebuilt as fast HTTP DuckDuckGo scrape with snippets and
  browser fallback; `web_fetch` auto-renders JS-heavy pages via the
  browser when static HTML comes back thin; **Gemini and Ollama gained
  native function calling** — every provider now has the full toolset
  (unsupported Ollama models get a friendly error naming ones that work)

Remaining backlog, roughly ordered: custom icon + installer branding ·
auto-update · PTY terminal sessions · wake-word engine (Porcupine) ·
parallel agent task graph · plugin v2 (themes/widgets/scripted) ·
Unity bridge field-testing · whiteboard.

## Engineering invariants (all phases)
- TS `strict`; no `any` at API boundaries; IPC types shared from one module
- Feature folders stay isolated; cross-talk via stores/registry only
- 60 FPS floor; transform/opacity-only DOM animation; GPU work in shaders
- Every new capability lands with: types → service → IPC → store → UI
