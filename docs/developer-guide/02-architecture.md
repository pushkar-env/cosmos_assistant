# 02 · Architecture

How COSMOS is put together: the process model, the app lifecycle, window modes,
and the end-to-end path a chat request takes.

---

## Process model

```
┌──────────────────────────────────────────────────────────────────┐
│  RENDERER  (Chromium)  —  src/renderer                             │
│  React 19 · Zustand · Tailwind · Framer Motion · R3F/Three.js      │
│  Orb · HUD · Chat · Palette · Panels · Voice capture & playback    │
│  contextIsolation: true · nodeIntegration: false                   │
└───────────────────────────────▲──────────────────────────────────┘
                                │  window.cosmos  (typed bridge)
┌───────────────────────────────┴──────────────────────────────────┐
│  PRELOAD  —  src/preload/index.ts                                  │
│  contextBridge.exposeInMainWorld('cosmos', …)                      │
│  invoke() for request/response · on() for push events              │
└───────────────────────────────▲──────────────────────────────────┘
                                │  ipcMain.handle / .on  (src/main/ipc.ts)
┌───────────────────────────────┴──────────────────────────────────┐
│  MAIN  (Node.js)  —  src/main                                      │
│  index.ts: lifecycle, windows, tray, shortcuts                     │
│  Services: AI · Memory · Settings · Secrets · Workspace · Cleaner… │
│  Owns: OS access · API keys · SQLite DB · the agent loop           │
└───────────────────────────────────────────────────────────────────┘
```

### Why this split

- **The renderer never touches the OS or secrets.** `contextIsolation: true`,
  `nodeIntegration: false` (see `webPreferences` in
  [`src/main/index.ts`](../../src/main/index.ts)). The renderer's only capability
  surface is the explicit, typed `window.cosmos` object.
- **Main owns everything sensitive.** AI provider calls run in main, so API keys
  never enter the DOM and a streaming response survives a renderer reload.
- **`sandbox: false`, `webviewTag: true`** — the Studio's live-preview pane embeds
  a `<webview>`, and `backgroundThrottling: false` keeps the mic/audio alive when
  the window is hidden to the tray (important for hands-free voice).

---

## App lifecycle — `src/main/index.ts`

This file is the entry point and the single owner of app-level concerns. Read it
top to bottom; the ordering is deliberate.

### 1. Pin identity *before* anything else

```ts
app.setName('COSMOS')
app.setPath('userData', join(app.getPath('appData'), 'COSMOS'))
```

This runs at module top, before any service constructs. Without it a bare
`electron` dev run resolves to the default `Electron` profile, which has a
*different* DPAPI key — and encrypted API keys from the installed app fail to
decrypt, appearing "lost". Pinning guarantees dev and packaged builds share
`%APPDATA%\COSMOS`. (See [Data & Security](09-data-and-security.md).)

### 2. Construct services (dependency graph)

All services are plain classes, wired by hand in `index.ts`. The dependency
order matters:

```
SettingsService ─┬─> WeatherService, EmbeddingService, NotesExportService,
                 │   WorkspaceService, GitService, MediaService, AIService, Stt/Tts
EmbeddingService ──> MemoryService ──(attachNotesExport)──> NotesExportService
BrowserService ────> MediaService
WorkspaceService ──> PreviewServer, GitService
                     ↓
ToolRegistry { stats, commands, memory, browser, vision, ocr, unity, unreal,
               media, workspace, git, secrets, cleaner }
                     ↓
AIService(settings, tools, memory, workspace)
```

`ToolRegistry` receives a bag of service instances and builds the tool catalog;
`AIService` receives the registry and drives the agent loop. See
[Tools](05-tools.md) and [AI & the Agent Loop](04-ai-and-agent-loop.md).

### 3. Create the window & tray, register IPC

`createWindow()` builds a frameless, transparent `BrowserWindow`.
`registerIpc(getWindow, services)` binds every service method to its IPC channel
([`src/main/ipc.ts`](../../src/main/ipc.ts)). Then background services start:
`stats.start()`, `memory.init()`, `secrets.init()`, `plugins.load()`.

### 4. Global shortcut

`Ctrl+Space` is registered globally (works even when COSMOS is unfocused): it
summons the window, forces `full` mode, and sends `PALETTE_TOGGLE` to the
renderer.

### 5. Migration from "JARVIS X"

`migrateFromJarvisX()` runs once on ready. COSMOS was renamed from "JARVIS X";
this copies the old memory DB / history / plugins into the COSMOS profile.
Crucially it **strips `enc:` values** from the old settings (they're tied to the
old profile's DPAPI key and can't be decrypted here), so keys must be re-entered
rather than silently decaying to empty strings.

---

## Window modes

COSMOS presents in three sizes, tracked by `windowMode` in `index.ts` and
mirrored into the renderer's `useUIStore`:

| Mode | Size | Behaviour |
|---|---|---|
| `full` | 1500×940 (opens maximized) | The full HUD app. |
| `compact` | 400×560 | A small always-on-top chat panel (`MiniView`). |
| `orb` | 128×128 | A floating, draggable, always-on-top orb (`OrbWidget`). |

`setWindowMode()` handles the transitions: it remembers how `full` was left
(maximized vs. bounds) to restore it exactly, pins compact/orb always-on-top,
and parks them bottom-right (or where the user dragged the orb). The transparent
window (`transparent: true`, `backgroundColor: '#00000000'`) is what lets orb
mode show only the round orb; the renderer sets `background: transparent` for
`orb` in [`App.tsx`](../../src/renderer/src/App.tsx).

Orb dragging is driven from the renderer via a fire-and-forget `WINDOW_ORB_MOVE`
`send` (one update per animation frame) rather than `-webkit-app-region: drag`,
which on Windows swallowed the click-to-talk tap and jittered the transparent
window.

---

## Single instance, tray, and quit semantics

- **Single instance:** `app.requestSingleInstanceLock()`; a second launch just
  focuses the running window.
- **Close = hide to tray** in packaged builds (COSMOS keeps running in the
  background). In **dev**, close fully quits — otherwise a hidden dev instance
  keeps the single-instance lock and the next `npm run dev` surfaces the stale
  window.
- **Tray menu:** Open / Orb widget / Hands-free toggle / Quit. Only an explicit
  Quit (or dev close) sets `isQuitting` and tears down (`stats.stop()`,
  `workspace.dispose()`, `preview.dispose()`, `browser.close()`).

---

## End-to-end: the life of a chat message

This is the single most important flow to understand. It spans all three
processes.

```
1. User types / speaks → useAssistantStore.send(text)         [renderer]
     • optional: translate query into the conversation language
     • build history (last 30 non-tool messages)
     • window.cosmos.ai.chat({ requestId, provider, model, messages, mode })

2. Preload → ipcRenderer.invoke(IPC.AI_CHAT, req)             [preload]

3. ipcMain.handle(AI_CHAT) → AIService.chat(win, req)         [main]
     fire-and-forget; results stream back over events

4. AIService.chat():                                          [main]
     • persist the user turn to memory, recall relevant memories
     • build the system prompt (persona + mode + clock + language)
     • loop up to maxRounds:
         provider.streamChat(...) → emits text deltas, returns tool calls
           deltas → win.webContents.send(AI_TOKEN, {requestId, delta})
         if tool calls:
           for each call: approval? → execute → audit → collect result
           feed results back into messages, loop again
         else: break (final answer)
     • send AI_DONE

5. Renderer event handlers (useAssistantStore.init):          [renderer]
     • onToken  → buffer delta, flush to chat ~25×/s; feed voice chunker
     • onEvent  → render/resolve tool-activity cards
     • onAgentEvent → animate the agent ring around the orb
     • onApprovalRequest → show the Approve/Always/Deny card
     • onDone   → finalize the bubble, refresh sessions
```

Key properties:
- **Streaming lives in main**, so a renderer reload doesn't kill an in-flight
  response.
- **Tokens are coalesced** in the renderer (commit ~25×/s) so a long markdown
  reply can't starve the always-animating orb's frame loop — while the voice
  pipeline still receives every token immediately. See
  [The Renderer](07-renderer.md#token-coalescing).
- **Every request has a `requestId`**; stale events (after a barge-in) are
  ignored by matching against `activeRequestId`.

Details of steps 3–4 are in [AI & the Agent Loop](04-ai-and-agent-loop.md); the
tool execution and approval in [Tools](05-tools.md); step 5 in
[The Renderer](07-renderer.md).

---

## Module boundary rules

1. **Renderer → main only via preload.** No `ipcRenderer` in feature code;
   everything goes through `window.cosmos`.
2. **`src/shared` imports nothing process-specific.** It's pure types + pure
   functions (personality compiler), safe to import from any runtime.
3. **Renderer features don't import each other.** They coordinate through
   `core/stores` or the palette action registry
   (`features/palette/actions.ts`).
4. **Services don't reach into the renderer** except by sending an IPC event on
   a `BrowserWindow` passed in (e.g. tool events, notifications).

---

Next: [IPC & Preload →](03-ipc-and-preload.md)
