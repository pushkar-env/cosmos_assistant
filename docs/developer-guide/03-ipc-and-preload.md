# 03 · IPC & the Preload Bridge

Every interaction between the UI and the OS/services crosses one narrow,
fully-typed bridge. This page documents that contract and how to add to it.

---

## The three pieces of the contract

| File | Role |
|---|---|
| [`src/shared/ipc.ts`](../../src/shared/ipc.ts) | The `IPC` constant — the **only** place channel strings live — plus push-event payload types. |
| [`src/preload/index.ts`](../../src/preload/index.ts) | Exposes `window.cosmos`: a namespaced, typed object wrapping `ipcRenderer`. |
| [`src/main/ipc.ts`](../../src/main/ipc.ts) | `registerIpc()` binds each channel to a service method with `ipcMain.handle`/`.on`. |

Because all three import `@shared`, a payload-type change breaks compilation on
both ends until fixed. That's the point — the contract can't silently drift.

---

## Two directions, two mechanisms

### Renderer → Main: `invoke` (request/response)

```ts
// preload
chat: (req: ChatRequest): Promise<string> => ipcRenderer.invoke(IPC.AI_CHAT, req)
// main
ipcMain.handle(IPC.AI_CHAT, async (_e, req: ChatRequest) => { … })
```

Returns a `Promise`. Used for everything the UI asks for: settings, files,
memory, secrets, commands, transcription, etc.

A few high-frequency, fire-and-forget calls use `ipcRenderer.send` /
`ipcMain.on` instead (no round-trip), e.g. `WINDOW_ORB_MOVE` (one position
update per animation frame during an orb drag) and the tool-approval response.

### Main → Renderer: push events (`send` + `on`)

Main pushes to the renderer via `win.webContents.send(channel, payload)`; the
preload wraps `ipcRenderer.on` in a `subscribe()` helper that returns an
**unsubscribe** function:

```ts
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
```

Stores call these in their `init()` and (where relevant) keep the unsubscribe.

---

## `window.cosmos` — the namespaced API

The preload groups methods by domain. This is the complete public surface the
renderer may touch:

| Namespace | Methods (abridged) | Backed by |
|---|---|---|
| `system` | `onStats(cb)` | `SystemStatsService` (pushed every 2s) |
| `weather` | `get()` | `WeatherService` |
| `ai` | `chat(req)`, `abort(id)`, `translate(text, lang)`, `listOllamaModels()`, `onToken/onDone/onError` | `AIService` |
| `tools` | `onEvent`, `onAgentEvent`, `onApprovalRequest`, `respondApproval(id, decision)` | `AIService` agent loop |
| `history` | `get`, `new`, `clearAll`, `count` | `MemoryService` |
| `sessions` | `list`, `active`, `switch`, `delete`, `rename` | `MemoryService` |
| `vault` | `listMemories`, `addMemory`, `deleteMemory`, `listAudit` | `MemoryService` |
| `secrets` | `list`, `reveal`, `create`, `update`, `delete` | `SecretsService` |
| `settings` | `get`, `set(patch)` | `SettingsService` |
| `commands` | `run(id, arg?)` | `CommandService` |
| `voice` | `transcribe`, `synthesize`, `listAvailableVoices`, `listElevenLabsVoices` | `SttService` / `TtsService` |
| `notes` | `list`, `get`, `save`, `delete`, `getFolder`, `pickFolder`, `revealFolder` | `MemoryService` / `NotesExportService` |
| `plugins` | `get()` | `PluginService` |
| `apps` | `list(refresh?)`, `launch(app)` | `AppLauncher` |
| `cleaner` | `scan`, `clean`, `largeFiles`, `diskUsage`, `programs`, `uninstall`, `delete`, `reveal` | `CleanerService` |
| `workspace` | `getRoot`, `pick`, `pickFile`, `setRoot`, `onFilesChanged` | `WorkspaceService` |
| `files` | `tree`, `list`, `read`, `write`, `create`, `rename`, `delete`, `reveal` | `WorkspaceService` |
| `preview` | `serve(relPath?)` | `PreviewServer` |
| `terminal` | `start`, `list`, `create`, `input`, `reset`, `close`, `onData` | `WorkspaceService` |
| `github` | `connect`, `disconnect`, `identity`, `status` | `GitService` |
| `app` | `onPaletteToggle`, `onNotify`, `windowControl`, `openExternal`, `setMode`, `orbMove`, `onModeChanged`, `onWindowShown`, `quit`, `onHandsFreeToggle`, `notifyHandsFreeChanged` | `index.ts` window controller |

`export type CosmosApi = typeof cosmosApi` is the source of truth; the renderer's
[`global.d.ts`](../../src/renderer/src/global.d.ts) declares `window.cosmos:
CosmosApi` so calls are fully typed with no manual duplication.

---

## Push-event channels (main → renderer)

These are the events the UI subscribes to. Payload types are in `shared/ipc.ts`
or `shared/tools.ts`.

| Channel | Payload | Purpose |
|---|---|---|
| `SYSTEM_STATS` | `SystemStats` | CPU/GPU/RAM/net/battery, every 2s |
| `AI_TOKEN` | `AITokenEvent` | A streamed text delta of the current reply |
| `AI_DONE` | `AIDoneEvent` | Reply finished |
| `AI_ERROR` | `AIErrorEvent` | Reply failed |
| `TOOL_EVENT` | `ToolEvent` | A tool started / ok / error / denied (drives tool cards) |
| `TOOL_APPROVAL_REQUEST` | `ToolApprovalRequest` | A sensitive tool needs Approve/Always/Deny |
| `AGENT_EVENT` | `AgentEvent` | A sub-agent started/finished (drives the agent ring) |
| `PALETTE_TOGGLE` | — | Global `Ctrl+Space` hit |
| `WINDOW_SHOWN` | — | Window returned from minimize/hidden → re-arm the mic |
| `WINDOW_MODE_CHANGED` | `WindowMode` | Mode changed from main (tray/shortcut) |
| `FILES_CHANGED` | — | Workspace files changed on disk → refresh the tree |
| `TERM_DATA` | `TerminalChunk` | A streamed chunk from an integrated terminal |
| `NOTIFY` | `NotificationPayload` | A toast / notification-center entry |
| `HANDSFREE_TOGGLE` | — | Tray asked the renderer to toggle hands-free |

---

## Adding a new IPC channel — checklist

Say you want the UI to call a new `FooService.bar(x)`.

1. **Add the channel name** to the `IPC` constant in
   [`src/shared/ipc.ts`](../../src/shared/ipc.ts):
   ```ts
   FOO_BAR: 'foo:bar',
   ```
   If it's a push event, also add its payload `interface` there.

2. **Type the payload** (if new) in `shared/types.ts` or `shared/tools.ts`.

3. **Expose it on the bridge** in
   [`src/preload/index.ts`](../../src/preload/index.ts), in the right namespace:
   ```ts
   foo: {
     bar: (x: number): Promise<string> => ipcRenderer.invoke(IPC.FOO_BAR, x)
   }
   ```
   (`CosmosApi` picks it up automatically — no `.d.ts` edit needed.)

4. **Bind it in main** in `registerIpc()`
   ([`src/main/ipc.ts`](../../src/main/ipc.ts)):
   ```ts
   ipcMain.handle(IPC.FOO_BAR, (_e, x: number) => services.foo.bar(x))
   ```
   Add `foo: FooService` to the `Services` interface and pass it from
   `index.ts`.

5. **Call it from the renderer**: `await window.cosmos.foo.bar(3)`.

For a **push** channel, in main call `win.webContents.send(IPC.FOO_EVENT,
payload)` and in the renderer subscribe with `window.cosmos.foo.onEvent(cb)`
(add an `onEvent` wrapper in preload using the `subscribe` helper).

> Full worked recipe in [Extending COSMOS](11-extending.md).

---

Next: [AI & the Agent Loop →](04-ai-and-agent-loop.md)
