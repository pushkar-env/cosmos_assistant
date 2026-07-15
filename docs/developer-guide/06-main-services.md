# 06 · Main-Process Services

Every capability that touches the OS, the network, secrets, or the database is a
service class in [`src/main/services/`](../../src/main/services). They're plain
classes, constructed and wired by hand in
[`index.ts`](../../src/main/index.ts), and reached from the UI over IPC or from
the AI via tools. This is a reference for each.

> AI-specific services (`ai/AIService`, `ai/agents`, `ai/providers`) are covered
> in [AI & the Agent Loop](04-ai-and-agent-loop.md); the tool wrappers in
> [Tools](05-tools.md); voice in [The Voice Pipeline](08-voice-pipeline.md).

---

## Configuration & data

### `SettingsService`
[`SettingsService.ts`](../../src/main/services/SettingsService.ts) — the single
persisted `Settings` document (`cosmos-settings.json` in userData).

- `get()` returns the in-memory settings; `set(patch)` shallow-merges, persists,
  and returns the new value. `hasLockedSecret()` reports undecryptable blobs.
- **Secret fields** (API keys, GitHub token, ElevenLabs/Groq keys) are stored
  `enc:`-prefixed via `safeStorage`; they're decrypted into memory on load and
  re-encrypted on write.
- **Data-loss hardening** (learned the hard way — see
  [Data & Security](09-data-and-security.md)): it *preserves* undecryptable
  `enc:` blobs verbatim (never clobbers real keys with `encrypt('')`), persists
  **only on explicit `set()`**, and recovers from a `.bak` file. This is the most
  safety-critical service — read the comments before editing it.

### `SecretsService`
[`SecretsService.ts`](../../src/main/services/SecretsService.ts) — the user's
encrypted **secrets vault** (API keys, passwords, tokens, cards, notes), stored
in SQLite with a JSON fallback.

- `list()` returns `SecretMeta[]` — **never** the plaintext; each carries a
  masked `preview` and a `locked` flag (whether this profile can decrypt it).
- `reveal(id)` returns the plaintext for an explicit user request; `create` /
  `update` / `delete` manage entries; `findByQuery` powers the `secret_copy`
  tool (which copies on-device, never surfacing the value to the model).
- Values are DPAPI-encrypted; category-aware masking (`sanitize`) generates the
  preview hint.

### `MemoryService`
[`MemoryService.ts`](../../src/main/services/MemoryService.ts) — the heart of
persistence, over `node:sqlite` (`cosmos-memory.db`). Fronts **everything**
stored: conversations, long-term memory, embeddings, audit log, notes.

- **Conversations/sessions:** `history()`, `append(role, content)`,
  `listConversations()`, `switchConversation`, `deleteConversation`,
  `renameConversation`, `newConversation`, `clearAllHistory`. Message content is
  encrypted at rest; titles derive from the first user message.
- **Long-term memory:** `saveMemory(content, category)` (embeds via
  `EmbeddingService`), `listMemories`, `deleteMemory`, and `recall(query, k)` —
  the semantic recall folded into the system prompt each turn (cosine similarity
  over stored embeddings).
- **Notes:** `saveNote`, `getNote`, `listNotes`, `deleteNote` — also mirrored to
  `.md` files on disk by an attached `NotesExportService`.
- **Audit:** `audit(tool, summary, status)` + `listAudit(limit)`.
- Uses `addColumnIfMissing` for lightweight schema migrations; JSON-mirrors some
  state defensively.

### `EmbeddingService`
[`EmbeddingService.ts`](../../src/main/services/EmbeddingService.ts) — turns text
into vectors for memory recall. `embed(text)` returns `number[] | null`
(null when no embedding backend is configured); `cosine(a, b)` is the similarity
used by `MemoryService.recall`.

### `NotesExportService`
[`NotesExportService.ts`](../../src/main/services/NotesExportService.ts) — mirrors
notes & research reports as `.md` files to a user-chosen folder (default
`Documents/COSMOS Notes`). `folder()`, `setFolder`, `pick(win)`, `reveal()`,
`write(id, title, content)`, `remove(id)`.

---

## System & hardware

### `SystemStatsService`
[`SystemStatsService.ts`](../../src/main/services/SystemStatsService.ts) — live
telemetry via `systeminformation` (+ an `nvidia-smi` path for NVIDIA GPUs).
`start(getWindow)` polls every ~2s and pushes `SystemStats` over `SYSTEM_STATS`;
`snapshot()` gives a one-shot reading (used by the `system_stats` tool);
`stop()` on quit. The renderer never polls.

### `CommandService`
[`CommandService.ts`](../../src/main/services/CommandService.ts) — OS-level
commands from the palette/assistant: `run(id, arg)` dispatches `SystemCommandId`s
(open-app, close-app, open-url, open-path, lock, sleep, restart, shutdown,
empty-recycle-bin, shell-exec). Holds a `launcher: AppLauncher`.

### `AppLauncher`
[`AppLauncher.ts`](../../src/main/services/AppLauncher.ts) — installed-app
discovery and launching (PowerShell-backed). `launch(query)` fuzzy-matches a name
and starts it; `close(query, force)` closes gracefully (or force-kills);
`catalog(refresh)` builds the **App Centre** list with extracted icons;
`launchEntry(app)` launches a chosen entry; `listApps(filter)` powers `app_list`.
`bestMatch` does the fuzzy resolution.

### `CleanerService`
[`CleanerService.ts`](../../src/main/services/CleanerService.ts) — the
CCleaner-style engine behind the Cleaner panel **and** the cleaner tools.

- `scan()` reports reclaimable junk per safe category **without deleting**;
  `clean(categoryIds)` clears selected categories; `findLargeFiles`,
  `diskUsage`, `listPrograms`, `uninstall(id)`, `deletePaths(paths, permanent)`,
  `reveal(target)`.
- **Safety is absolute:** `isProtectedPath()` refuses Windows/Program Files/user
  profile roots; deletions go to the Recycle Bin (recoverable) by default. Never
  weaken these guards.

### `WeatherService`
[`WeatherService.ts`](../../src/main/services/WeatherService.ts) — keyless weather
via Open-Meteo + IP geolocation. `get()` → `WeatherInfo | null`, cached; feeds the
Dashboard.

---

## Workspace, code & git

### `WorkspaceService`
[`WorkspaceService.ts`](../../src/main/services/WorkspaceService.ts) — the agent's
**project workspace** and the backend for COSMOS **Studio** (editor + terminal +
file tree). Large and central.

- **Root:** `getRoot()` (defaults to `Documents/COSMOS Projects`), `setRoot`,
  `resolve(input, sandbox)` — resolves bare-relative paths against the root.
- **Files:** `tree()`, `textTree()` (for `project_tree`), `listDir`, `readFile`,
  `writeFile`, `create`, `rename`, `trash` (→ Recycle Bin), `reveal`; a `chokidar`
  watcher pushes `FILES_CHANGED` so the tree stays live.
- **Terminals:** persistent PowerShell sessions — `terminalStart/List/Create/
  Input/Reset/Close`, streaming output over `TERM_DATA`. `agentRun(command,
  background)` is what `run_command` calls; background servers stream without
  blocking, with idle/hard timeouts.
- `attachWindow(getWindow)` gives it a path back to the renderer; `dispose()`
  kills terminals + watcher on quit.

### `PreviewServer`
[`PreviewServer.ts`](../../src/main/services/PreviewServer.ts) — a tiny static
HTTP server for Studio's live preview. `urlFor(relPath)` starts it on demand and
returns a localhost URL; `dispose()` stops it.

### `GitService`
[`GitService.ts`](../../src/main/services/GitService.ts) — git + GitHub. `connect`
(store a PAT, resolve identity via the GitHub API), `disconnect`, `identity`,
`status`/`statusText`, `diff`, `log`, `init`, `branch`, `commit` (as the connected
identity), `push`, `pull`, `setRemote`, `clone`, and the composite
`github_publish`. Shells out to `git` with auth args injected from the encrypted
token.

---

## Web, browser & media

### `BrowserService`
[`BrowserService.ts`](../../src/main/services/BrowserService.ts) — a
COSMOS-controlled browser via `playwright-core`. Two jobs: **media playback**
(`playMedia`, `mediaControl`, `stopMedia`, `listTabs`, `closeTab`) and **page
automation** (`goto`, `readText`, `search`, `listInputs`, `click`, `type`,
`screenshot`). Lazily launches; `close()` on quit.

### `MediaService`
[`MediaService.ts`](../../src/main/services/MediaService.ts) — the `play_youtube`
brain. `playYouTube(query)` resolves the top result and plays it (in the
dedicated COSMOS browser or the default browser per `settings.mediaPlayer`);
`control(action)`, `stop()`.

### Web-search helpers
[`tools/webSearch.ts`](../../src/main/services/tools/webSearch.ts) — shared search
primitives used by the web/research tools: `ddgSearch`, `newsSearch`,
`fetchArticleText`, `stripTags`, `formatResults`, plus a `CaptchaError` for
graceful degradation.

---

## Vision & game engines

### `VisionService`
[`VisionService.ts`](../../src/main/services/VisionService.ts) — `analyze(pngBase64,
question)` runs the configured vision model on an image/screenshot.

### `OcrService`
[`OcrService.ts`](../../src/main/services/OcrService.ts) — offline text extraction
via the Windows OCR engine (a bundled PowerShell script). `recognize(imagePath)`.
No API call.

### `screen.ts`
[`screen.ts`](../../src/main/services/screen.ts) — `captureScreenPng()` and
`captureScreenToFile()` for the screenshot/vision/ocr-screen tools.

### `UnityService`
[`UnityService.ts`](../../src/main/services/unity/UnityService.ts) — talks to the
Unity editor via a bridge. `installBridge(projectPath)` drops a `CosmosBridge.cs`
editor script (template in
[`bridgeTemplate.ts`](../../src/main/services/unity/bridgeTemplate.ts), HTTP on
port 17890); `call(endpoint, param)` hits it to read the console, dump the scene,
refresh assets, enter/exit play mode.

### `UnrealService`
[`UnrealService.ts`](../../src/main/services/UnrealService.ts) — reaches Unreal via
its Remote Control API. `status()`, `consoleCommand(command)`.

---

## Voice & plugins

### `SttService` / `TtsService`
`voice/SttService.ts` and `voice/TtsService.ts` — speech-to-text (OpenAI/Groq/
ElevenLabs Whisper) and text-to-speech (Windows SAPI / ElevenLabs / bundled Piper
neural voices, with an audio cache). Covered in
[The Voice Pipeline](08-voice-pipeline.md).

### `PluginService`
[`PluginService.ts`](../../src/main/services/PluginService.ts) — loads declarative
plugins from the `plugins/` folder. `load()` reads each `plugin.json`, `valid()`
checks the shape, `list()` returns `PluginManifest[]` (palette commands: url /
app / shell). Format in [docs/PLUGINS.md](../PLUGINS.md).

---

## Cross-cutting helpers

| File | Purpose |
|---|---|
| [`secureText.ts`](../../src/main/services/secureText.ts) | `encryptText` / `decryptText` / `decryptOrNull` / `isEncrypted` — the `safeStorage` (DPAPI) wrapper. `decryptOrNull` returns `null` on failure (never `''`) — the fix that stopped keys being clobbered. |
| [`userPaths.ts`](../../src/main/services/userPaths.ts) | `resolveUserPath(input, base)` — turns `Desktop/…`, `Documents/…`, `~/…` shortcuts into real absolute paths without ever guessing `C:\Users\<name>`. |

---

Next: [The Renderer →](07-renderer.md)
