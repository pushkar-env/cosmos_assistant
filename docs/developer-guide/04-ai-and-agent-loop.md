# 04 · AI & the Agent Loop

The brain of COSMOS. This page covers [`AIService`](../../src/main/services/ai/AIService.ts),
the agent tool-loop, assistant modes, the system prompt, sub-agents, and the
provider abstraction that makes all four AI backends interchangeable.

---

## `AIService` responsibilities

`AIService(settings, tools, memory, workspace)` is the orchestrator. It:

- runs the **agent loop** — streams a model turn, executes any tool calls,
  feeds results back, repeats until the model answers in plain text;
- enforces **tool approval** and writes the **audit log**;
- drives **sub-agent delegation** (planner / researcher / coder / debugger /
  reviewer);
- handles **abort** (barge-in), **translation**, and saving **research reports**
  to Notes;
- builds the **system prompt** (persona + mode + clock + language + recalled
  memories).

It's constructed once in `index.ts` and reached over IPC via `AI_CHAT`,
`AI_ABORT`, `AI_TRANSLATE`.

---

## The agent loop

`chat(win, req)` is the core. Simplified:

```ts
for (let round = 0; round < maxRounds; round++) {
  const { calls } = await provider.streamChat({ model, system, messages, tools }, ctx, emit, signal)
  //  emit(delta) → win.webContents.send(AI_TOKEN, …)   ← live streaming to UI
  if (calls.length === 0) break                          // model gave a final answer
  messages.push({ role: 'assistant-tools', text, calls })
  const results = await this.executeCalls(calls, execCtx) // approval + run + audit
  messages.push({ role: 'tool-results', results })
}
```

Key parameters and behaviours:

| Concept | Value / behaviour |
|---|---|
| `MAX_TOOL_ROUNDS` | 8 rounds in chat/research mode |
| `MAX_AGENT_ROUNDS` | 24 rounds in agent/ultra (building a project needs many tool calls) |
| `MAX_SUBAGENT_ROUNDS` | 10 rounds per delegated sub-agent |
| Per-tool timeout | 90s (`executeWithTimeout`) — a hung tool rejects so the loop stays alive |
| Approval timeout | 120s — an unanswered approval request auto-denies |
| Abort | Every request has an `AbortController` in an `inflight` map; `abort(id)` cancels the stream and all pending tool waits |

### Error recovery (agent / ultra)

In agentic modes, a failed tool result is a **step, not a stop**. `chat()`:

- detects failure as a tool exception **or** a command that exited non-zero
  (`run_command` returns a failed command's output as a "successful" result, so
  `isError` alone would miss build/test failures — it also regex-matches
  `[exit code N]`);
- appends an **error nudge** to the failed result telling the model to try a
  different approach itself rather than punting the fix to the user;
- if the model tries to end its turn right after a failure, pushes a
  **keep-going nudge** (bounded by `KEEP_GOING_CAP = 3`) so it iterates like a
  real coding agent.

---

## Assistant modes

`AssistantMode` (`shared/types.ts`) shapes each turn. Set per-conversation in the
chat panel; the mode travels in the `ChatRequest`.

| Mode | Behaviour | Rounds | Tools (local models) |
|---|---|---|---|
| `chat` | Conversational, still calls tools to *do* things and does quick web lookups | 8 | curated `LOCAL_CHAT_TOOLS` |
| `agent` | Autonomous software-engineer loop: orient → plan → implement → **verify** → report | 24 | full catalog |
| `research` | First action *must* be the `research` tool; then writes a sourced report, saved to Notes | 8 | `LOCAL_RESEARCH_TOOLS` |
| `ultra` | Model silently picks chat / agent / research per query | 24 | full catalog |

The mode's instructions are injected by `modeDirective()`. **Autonomous Builder**
(`settings.agentAutoApprove`) only takes effect in agent/ultra: it auto-approves
a fixed set of coding tools (`run_command`, `fs_write`, `fs_edit`, `fs_mkdir`,
`fs_move`, `fs_zip`, `fs_unzip`) so a build doesn't prompt per step — but delete,
power, and close-app still ask.

---

## The system prompt

`buildSystemPrompt()` concatenates, in order:

1. **`COSMOS_SYSTEM_PROMPT`** — a large constant defining the J.A.R.V.I.S.-style
   identity, the tool-usage doctrine (how to open apps, play media, control
   hardware, build software, use git, handle attachments, recency policy), and
   the "report the real outcome, never claim an action you didn't take" rule.
2. **User name** (if set).
3. **Persona block** — compiled by `buildPersonaPrompt()` from the personality
   settings, in the reply language (see [Personality](10-personality-system.md)).
4. **Tool-availability note** — if the provider can't do tools, tell the user to
   switch to Claude/GPT.
5. **Clock** — the real local time + timezone, so the model never claims it can't
   access the current time.
6. **Language directive** — hard-forces English or Hindi output to match the
   user's latest message.
7. **Mode directive** — from `modeDirective()`.
8. **Recalled memories** — appended by `chat()` from a semantic recall over
   long-term memory (top 5).

### Language handling

Reply language is decided **purely from the user's latest message**: Devanagari
(`/[ऀ-ॿ]/`) → Hindi, else English. This is re-asserted after every tool result
(`langReminder`) because small local models drift into the language of tool
output. The persona block is emitted in the same language, so a Hindi turn gets a
natural Hindi personality rather than English text read by a Hindi voice.

---

## Sub-agents (delegation)

COSMOS can delegate to five specialist agents. The `delegate` tool is registered
in the `AIService` constructor (it closes over the agent runner). Definitions
live in [`src/main/services/ai/agents.ts`](../../src/main/services/ai/agents.ts):

| Agent | Role | Tool allowlist |
|---|---|---|
| `planner` | Decompose a goal into an ordered plan | read-only FS |
| `researcher` | Web + local research, cited findings | web + FS-read + vision + notes + memory |
| `coder` | Write/modify code, run & verify | FS read/write + run_command + unity + notes |
| `debugger` | Reproduce, root-cause, fix | FS + code + unity + vision |
| `reviewer` | Read-only code review by severity | read-only FS |

`runSubAgent()` runs one agent to completion in its own message loop (up to
`MAX_SUBAGENT_ROUNDS`), sends `AGENT_EVENT`s so the renderer animates the ring
around the orb, and returns the agent's report as the tool result. Sub-agents run
at `depth: 1` and **cannot delegate further** (the `delegate` tool refuses at
depth > 0) — no infinite recursion. Their tool sets never include `delegate`.

---

## The provider abstraction

Every AI backend implements one interface, in
[`src/main/services/ai/types.ts`](../../src/main/services/ai/types.ts):

```ts
interface AIProvider {
  id: ProviderId
  supportsTools: boolean
  streamChat(
    req: ProviderRequest,           // { model, system, messages, tools? }
    ctx: ProviderContext,           // { apiKey, baseUrl?, numCtx? }
    emit: (delta: string) => void,  // called for every text delta
    signal: AbortSignal
  ): Promise<TurnResult>            // { calls: ToolCall[] }
}
```

Implementations live in `providers/`:

| Provider | Wire format | Notes |
|---|---|---|
| [`anthropic.ts`](../../src/main/services/ai/providers/anthropic.ts) | SSE | Claude messages API + tool use + vision |
| [`openai.ts`](../../src/main/services/ai/providers/openai.ts) | SSE | GPT chat completions + tool calls + vision |
| [`gemini.ts`](../../src/main/services/ai/providers/gemini.ts) | SSE | Gemini generateContent + function calling + vision |
| [`ollama.ts`](../../src/main/services/ai/providers/ollama.ts) | NDJSON | Local, offline; raises `num_ctx` to fit the tool payload |

**No vendor SDKs** — every provider is `fetch`-based and parses its own stream.
Shared helpers in `types.ts` do the heavy lifting:

- `sseEvents()` / `ndjsonLines()` — async generators over the two stream formats.
- `splitAttachments()` — media (image/pdf → native provider blocks) vs. text
  docs (inlined into the prompt so even non-vision providers can read them).
- `withDocuments()` — fold extracted document text into a user message.
- `plainMessages()` — flatten the agent-message shape for tool-less providers.
- `raiseForStatus()` — uniform HTTP error surfacing.

Benefits: zero native deps, instant model switching mid-conversation (the new
model picks up the full history), and Ollama works fully offline.

### The `AgentMessage` shape

The loop stays provider-agnostic by using an internal message union
(`shared/tools.ts`); each provider converts it to its wire format:

```ts
type AgentMessage =
  | { role: 'user' | 'assistant' | 'system'; content: string; attachments?: Attachment[] }
  | { role: 'assistant-tools'; text: string; calls: ToolCall[] }   // a turn that called tools
  | { role: 'tool-results'; results: ToolOutcome[] }               // the results fed back
```

---

## Translation & research reports

- **`translate(text, target)`** — used when the user's query language differs from
  the conversation language. Runs the current provider with a translation-only
  system prompt, no tools; returns the original text on any failure. Strips a
  reasoning model's `</think>` scratchpad.
- **Research note saving** — in research mode (and ultra when it chose to
  research), the final answer is reformatted by `formatResearchReport()` into a
  polished Markdown document and saved to Notes via `MemoryService.saveNote()`,
  with a `NOTIFY` toast.

---

Next: [Tools →](05-tools.md)
