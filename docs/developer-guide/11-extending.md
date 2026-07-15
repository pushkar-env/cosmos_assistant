# 11 · Extending COSMOS

Practical, step-by-step recipes for the common ways you'll extend the app. Each
points back to the deeper reference doc.

---

## Recipe 1 — Add a tool the AI can call

Give COSMOS a new capability (e.g. "read the current Spotify track").

1. **Write the `ToolSpec`** in the right group file under
   `src/main/services/tools/` (or a new file). If it needs a service, the group
   is a factory (`export function spotifyTools(spotify): ToolSpec[]`).
   ```ts
   {
     def: {
       name: 'spotify_now_playing',
       description: 'Return the track currently playing in Spotify.',
       inputSchema: { type: 'object', properties: {} },
       sensitive: false            // read-only → no approval prompt
     },
     summary: () => 'spotify: now playing',
     run: async (_a, ctx) => spotify.nowPlaying()
   }
   ```
2. **Register the group** in `ToolRegistry`'s constructor and add any new service
   to `RegistryDeps` + the `new ToolRegistry({…})` call in `index.ts`.
3. If small local models should get it in chat mode, add the name to
   `LOCAL_CHAT_TOOLS`.
4. `npm run typecheck`, then test in agent mode.

Reference: [Tools](05-tools.md#adding-a-tool--checklist). Mark anything that
writes/deletes/spends/controls the OS `sensitive: true`.

---

## Recipe 2 — Add an IPC channel (UI ↔ main)

Let the renderer call a new main-process method.

1. Add `FOO_BAR: 'foo:bar'` to `IPC` in `src/shared/ipc.ts` (+ a payload type if
   needed).
2. Expose it on the bridge in `src/preload/index.ts` under a namespace:
   `foo: { bar: (x) => ipcRenderer.invoke(IPC.FOO_BAR, x) }`.
3. Bind it in `registerIpc()` in `src/main/ipc.ts`:
   `ipcMain.handle(IPC.FOO_BAR, (_e, x) => services.foo.bar(x))` and add `foo` to
   `Services`.
4. Call `await window.cosmos.foo.bar(3)` from the renderer.

For a **push** channel (main → renderer), `win.webContents.send(IPC.FOO_EVENT,
payload)` in main and a `subscribe()`-based `onEvent` wrapper in preload.

Reference: [IPC & Preload](03-ipc-and-preload.md#adding-a-new-ipc-channel--checklist).

---

## Recipe 3 — Add a main-process service

For a new subsystem with OS/network/DB access.

1. Create `src/main/services/FooService.ts` as a plain class; take dependencies
   (e.g. `SettingsService`) via the constructor.
2. Construct it in `index.ts` in dependency order, and pass it wherever it's
   needed (`ToolRegistry` deps, `Services` for IPC, etc.).
3. Expose its functionality via **tools** (for the AI) and/or **IPC** (for the
   UI) — usually both, so the panel and the assistant drive one engine (as
   `CleanerService` does).
4. If it holds OS resources (a server, a watcher, a child process), add teardown
   in the `before-quit` handler.

Reference: [Main-Process Services](06-main-services.md).

---

## Recipe 4 — Add a renderer feature / panel

For a new UI surface (e.g. a "Timers" panel).

1. Create `src/renderer/src/features/timers/` with the components and, if it holds
   state, a local `useTimersStore.ts` (Zustand) whose `init()` subscribes to any
   relevant `window.cosmos.*` events.
2. If it's a slide-in panel, add its id to the `Panel` union in
   `core/stores/useUIStore.ts` and mount `<TimersPanel />` in `App.tsx` (panels
   are always mounted and animate on `activePanel`).
3. Add a **palette action** in `features/palette/actions.ts` to open it (this is
   how features are invoked without importing each other).
4. Style with the design tokens (`var(--accent)` etc.) and the `Glass`/`Markdown`
   primitives from `shared/ui`.

Reference: [The Renderer](07-renderer.md).

---

## Recipe 5 — Add an AI provider

To support another backend (e.g. a new API).

1. Create `src/main/services/ai/providers/foo.ts` implementing `AIProvider`
   (`id`, `supportsTools`, `streamChat(req, ctx, emit, signal)`). Reuse the
   helpers in `ai/types.ts` (`sseEvents`/`ndjsonLines`, `splitAttachments`,
   `withDocuments`, `plainMessages`, `raiseForStatus`). Parse the stream, call
   `emit(delta)` for text, return `{ calls }` for tool use.
2. Register it in `AIService.providers`, add its id to `ProviderId`
   (`shared/types.ts`), and add defaults to `DEFAULT_MODELS` / `PROVIDER_MODELS`.
3. If it needs a key, add it to `Settings.apiKeys` and the Settings UI (encrypted
   at rest — follow the existing key handling in `SettingsService`).

Reference: [AI & the Agent Loop](04-ai-and-agent-loop.md#the-provider-abstraction).

---

## Recipe 6 — Add a persona or trait

1. Append a bilingual `PersonaPreset` to `PERSONA_PRESETS` in
   `src/shared/personality.ts` (keep `custom` last). The picker and the prompt
   compiler pick it up automatically.
2. For a new trait, extend `PersonaTraitId`, `PERSONA_TRAITS`, `NEUTRAL_TRAITS`,
   every preset's `traits`, and `TRAIT_COPY` (bilingual high/low sentences).

Reference: [Personality System](10-personality-system.md#adding-a-persona-preset).

---

## Recipe 7 — Ship a plugin (no rebuild)

Plugins add command-palette entries without touching the app source. Drop a
`plugin.json` into `%APPDATA%\COSMOS\plugins\`:

```json
{
  "name": "My Pack",
  "version": "1.0.0",
  "commands": [
    { "id": "open-jira", "title": "Open Jira", "type": "url", "target": "https://jira.example.com" }
  ]
}
```

`type` is `url` (open in browser), `app` (launch executable), or `shell` (run
PowerShell — always confirmed). `PluginService.load()` reads and validates them at
startup; they appear in the palette. Full format in
[docs/PLUGINS.md](../PLUGINS.md).

---

## Before you commit

- `npm run typecheck` (both projects) — the shared types catch most contract
  breaks.
- Manually exercise the affected flow (there are no unit tests). For an
  AI/tool/voice change, run the real path end to end.
- Respect the invariants: renderer stays sandboxed, secrets stay encrypted in
  main, `SettingsService` never clobbers locked blobs, destructive ops go to the
  Recycle Bin, and sensitive tools stay `sensitive: true`.

See also the product docs: [ARCHITECTURE](../ARCHITECTURE.md) ·
[DESIGN_SYSTEM](../DESIGN_SYSTEM.md) · [PLUGINS](../PLUGINS.md) ·
[ROADMAP](../ROADMAP.md).
