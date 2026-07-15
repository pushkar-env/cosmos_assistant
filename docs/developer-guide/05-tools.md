# 05 · Tools

Tools are how COSMOS *acts*. Every capability the AI can invoke — read a file,
run a command, launch an app, search the web, drive a browser, clean the PC — is
a `ToolSpec` in a single registry. This page covers the registry, the approval
model, the full catalog, and how to add one.

---

## Anatomy of a tool

Defined by three shapes in [`src/shared/tools.ts`](../../src/shared/tools.ts) and
[`ToolRegistry.ts`](../../src/main/services/tools/ToolRegistry.ts):

```ts
interface ToolDef {                 // what the model sees
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema (Anthropic input_schema shape)
  sensitive: boolean                     // true → requires user approval
}

interface ToolSpec {                // what the registry stores
  def: ToolDef
  summary: (args) => string         // short human label shown in the UI/audit
  run: (args, ctx: ToolExecContext) => Promise<string>   // the implementation
}
```

`run` returns a **string** — the tool result that's fed back to the model. It
receives a `ToolExecContext`:

```ts
interface ToolExecContext {
  win: BrowserWindow          // to push events
  requestId: string
  signal: AbortSignal         // aborts on barge-in
  provider: ProviderId
  model: string
  depth: number               // 0 = orchestrator, 1 = sub-agent (can't delegate)
  workspaceRoot?: string      // bare-relative paths resolve against this
  autoApproveCoding?: boolean // Autonomous Builder
  editFailures?: Map<string, number>  // nudge weak models from fs_edit → fs_write
}
```

---

## The registry

`ToolRegistry` is constructed in `index.ts` with a bag of service instances
(`RegistryDeps`). Its constructor spreads every tool group into one `Map` keyed
by tool name:

```ts
new ToolRegistry({ stats, commands, memory, browser, vision, ocr, unity,
                   unreal, media, workspace, git, secrets, cleaner })
```

Each group is a factory that closes over the services it needs — e.g.
`gitTools(git)`, `cleanerTools(cleaner)`, `codingTools(workspace)`. The
`delegate` tool is registered later by `AIService` (it needs the agent runner).

Key methods:

| Method | Purpose |
|---|---|
| `defs(names?)` | Tool definitions, optionally filtered to an allowlist (used for sub-agent tool sets) |
| `defsFor(provider, mode)` | The set to expose to a provider+mode (see curation below) |
| `isSensitive(name)` | Whether a call needs approval (defaults to **true** for unknown tools) |
| `summarize(call)` | Human-readable one-liner for the UI/audit |
| `execute(call, ctx)` | Dispatch to the matching `ToolSpec.run` |

### Local-model curation

Frontier models handle the full ~80-tool catalog fine. A 7–8B Ollama model does
not — the definitions overflow its context and it either loses the tools or
can't pick one. So `defsFor()` narrows the set for **Ollama in chat/research
mode**:

- `LOCAL_CHAT_TOOLS` (~40 tools) — apps, media, system control, files, light
  building, quick web, memory, secrets.
- `LOCAL_RESEARCH_TOOLS` — just `research`, `web_search`, `web_fetch`,
  `news_search`, so calling `research` is almost unavoidable.

Local **agent/ultra** keeps the full catalog (the user opted into a heavier task,
and the Ollama provider raises `num_ctx` to hold it).

---

## The permission model

Sensitivity is per-tool (`def.sensitive`) and enforced centrally in
`AIService.executeCalls()`:

```
for each tool call:
  emit TOOL_EVENT(running)
  granted = alwaysAllowTools.includes(name)
            || (autoApproveCoding && AUTO_APPROVE_CODING.has(name))
  if isSensitive(name) && !granted:
      approved = await requestApproval(...)   // TOOL_APPROVAL_REQUEST → renderer
      if !approved: audit('denied'); result = "The user denied this action."; continue
  result = await executeWithTimeout(call)     // 90s cap
  emit TOOL_EVENT(ok | error); audit(...)
```

- The renderer shows an **Approve / Always / Deny** card
  (`features/chat/ApprovalCard.tsx`, `useApprovalStore`).
- **Always** adds the tool to `settings.alwaysAllowTools` (revocable in the
  Vault).
- Read-only tools (`sensitive: false`) run without a prompt.
- Every execution — ok, error, or denied — is written to the **audit log**
  (`MemoryService.audit`), reviewable in the Vault.

> Unknown tool name ⇒ treated as sensitive. Fail safe.

---

## The catalog

~80 tools across 10 groups. One file per group in
[`src/main/services/tools/`](../../src/main/services/tools). Sensitivity below is
"needs approval?" — read-only tools don't.

### Files — [`fileTools.ts`](../../src/main/services/tools/fileTools.ts)
`fs_list` · `fs_read` · `fs_write`* · `open_path` · `fs_mkdir`* · `fs_search` ·
`fs_move`* · `fs_delete`* (→ Recycle Bin) · `fs_zip`* · `fs_unzip`*
Works anywhere on the system; paths resolve via `userPaths.ts` folder shortcuts
(`Desktop/…`, `Documents/…`, `~/…`).

### System — [`systemTools.ts`](../../src/main/services/tools/systemTools.ts)
`terminal_run`* · `notify` · `clipboard_read` · `clipboard_write` · `screenshot`
· `app_open` · `app_close`* · `app_list` · `play_youtube` · `media_control` ·
`url_open` · `system_stats` · `get_time` · `power`* (sleep/restart/shutdown/lock).

### System control — [`systemControlTools.ts`](../../src/main/services/tools/systemControlTools.ts)
`system_cleanup`* · `recycle_bin_empty`* · `wifi`* · `bluetooth`* · `sound` ·
`brightness`. PowerShell-backed hardware/settings control.

### Coding — [`codingTools.ts`](../../src/main/services/tools/codingTools.ts)
`project_tree` · `read_file` · `fs_edit`* (surgical find/replace) · `search_code`
(grep) · `run_command`* (in the workspace terminal the user watches in Studio).

### Git / GitHub — [`gitTools.ts`](../../src/main/services/tools/gitTools.ts)
`git_status` · `git_diff` · `git_log` · `git_init` · `git_branch`* · `git_commit`*
· `git_push`* · `git_pull`* · `git_set_remote`* · `git_clone`* · `github_publish`*
(create repo + wire origin + commit + push). Uses the connected GitHub identity.

### Web & browser — [`browserTools.ts`](../../src/main/services/tools/browserTools.ts)
`web_fetch` · `web_search` · `news_search` · `research` (search **and** read top
sources in one step) · `browser_goto`* · `browser_read` · `browser_inputs` ·
`browser_click`* · `browser_type`* · `browser_screenshot` · `browser_tabs` ·
`browser_close_tab`* · `browser_close`. Automation via `playwright-core`.

### Memory & notes — [`memoryTools.ts`](../../src/main/services/tools/memoryTools.ts)
`memory_save` · `memory_search` · `memory_delete` · `note_write` · `note_list` ·
`note_read`.

### Vision / OCR / engines — [`creatorTools.ts`](../../src/main/services/tools/creatorTools.ts)
`vision_screen` · `vision_image` (vision model) · `ocr_screen` · `ocr_image`
(offline Windows OCR) · `unity_install_bridge`* · `unity_status` · `unity_console`
· `unity_scene` · `unity_refresh`* · `unity_play`* · `unity_stop`* · `unity_menu`*
· `unreal_status` · `unreal_command`*.

### System cleaner — [`cleanerTools.ts`](../../src/main/services/tools/cleanerTools.ts)
`cleaner_scan` · `cleaner_clean`* · `find_large_files` · `disk_usage` ·
`list_programs` · `uninstall_app`*. Scans are read-only; the engine refuses
protected paths and deletes to the Recycle Bin.

### Secrets — [`secretsTools.ts`](../../src/main/services/tools/secretsTools.ts)
`secret_copy` (copies a stored secret to the clipboard on-device; the raw value
is never returned to the model) · `secret_list`.

### Delegation
`delegate` — registered by `AIService`; hands a self-contained brief to a
specialist sub-agent (see [Agent Loop](04-ai-and-agent-loop.md#sub-agents)).

<sub>* = `sensitive: true` (asks for approval unless "Always allowed" or
auto-approved in Builder mode).</sub>

---

## Adding a tool — checklist

1. Pick or create a group file in `src/main/services/tools/`. Groups that need a
   service are **factory functions** (`export function fooTools(dep):
   ToolSpec[]`); stateless ones are a plain `ToolSpec[]` (like `fileTools`).

2. Add the `ToolSpec`:
   ```ts
   {
     def: {
       name: 'my_tool',
       description: 'Clear, model-facing description of when to use it.',
       inputSchema: {
         type: 'object',
         properties: { path: { type: 'string', description: '…' } },
         required: ['path']
       },
       sensitive: true            // does it write / delete / spend / affect the OS?
     },
     summary: (a) => `my_tool ${String(a.path ?? '')}`,
     run: async (a, ctx) => {
       // do the work; return a string result for the model
       return `Done: ${a.path}`
     }
   }
   ```

3. **Register the group** in `ToolRegistry`'s constructor (spread it into the
   list), adding any new service to `RegistryDeps` and to the `new ToolRegistry({…})`
   call in `index.ts`.

4. If small local models should get it in chat mode, add its name to
   `LOCAL_CHAT_TOOLS`.

5. `npm run typecheck`, then exercise it in agent mode.

**Guidelines:** honest, actionable descriptions (the model chooses tools from
these); mark anything that writes/deletes/spends/controls the OS `sensitive:
true`; return a concise, information-dense string; respect `ctx.signal` for
long-running work; resolve user paths through `WorkspaceService.resolve` /
`userPaths.resolveUserPath` rather than hand-building `C:\Users\…`.

---

Next: [Main-Process Services →](06-main-services.md)
