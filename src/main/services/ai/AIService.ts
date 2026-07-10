import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import {
  IPC,
  type AIDoneEvent,
  type AIErrorEvent,
  type AITokenEvent,
  type ApprovalDecision
} from '@shared/ipc'
import type {
  AssistantMode,
  ChatRequest,
  NotificationPayload,
  ProviderId,
  VoiceLanguageId
} from '@shared/types'
import type {
  AgentEvent,
  AgentMessage,
  AgentRole,
  ToolApprovalRequest,
  ToolCall,
  ToolEvent,
  ToolOutcome
} from '@shared/tools'
import type { AIProvider, ProviderContext } from './types'
import { anthropicProvider } from './providers/anthropic'
import { openaiProvider } from './providers/openai'
import { geminiProvider } from './providers/gemini'
import { ollamaProvider } from './providers/ollama'
import { AGENTS, AGENT_ROLE_NAMES } from './agents'
import type { SettingsService } from '../SettingsService'
import type { ToolRegistry, ToolExecContext } from '../tools/ToolRegistry'
import type { MemoryService } from '../MemoryService'
import type { WorkspaceService } from '../WorkspaceService'

const MAX_TOOL_ROUNDS = 8
/** agent/ultra can chain many more tool rounds — building a project needs them */
const MAX_AGENT_ROUNDS = 24
const MAX_SUBAGENT_ROUNDS = 10
const APPROVAL_TIMEOUT_MS = 120_000

/**
 * The coding/build tools that Autonomous Builder mode auto-approves — the ones
 * an agent fires repeatedly while building a project. Deliberately excludes
 * fs_delete, power, app_close and other higher-consequence actions, which keep
 * asking even in Builder mode.
 */
const AUTO_APPROVE_CODING = new Set([
  'run_command',
  'fs_write',
  'fs_edit',
  'fs_mkdir',
  'fs_move',
  'fs_zip',
  'fs_unzip'
])

const COSMOS_SYSTEM_PROMPT = `You are COSMOS, an advanced desktop AI assistant inspired by Tony Stark's J.A.R.V.I.S., running inside a futuristic HUD on the user's Windows machine.
Personality: professional, warm, quietly witty. Be concise by default — this is a voice-first interface — but go deep when asked. Never robotic, never sycophantic. Dry humor is welcome when the moment allows it.
Language: reply in the SAME language and script as the user's latest message. If they write in Hindi (Devanagari), respond entirely in natural, fluent Hindi in Devanagari script — never romanized Hindi, never English. Mixed/Hinglish input → mirror their mix. This is a voice interface, so spoken output must be in the right script to be pronounced correctly. Regardless of the conversation language, ALWAYS keep tool names and technical identifiers in English/original form (tool arguments, app names, file paths, URLs, code, model names): understand the request in any language and translate spoken names to their real ones — e.g. "स्पॉटिफ़ाई खोलो" → app_open Spotify, "आवाज़ कम करो" → sound down, "यूट्यूब पर believer चलाओ" → play_youtube "believer". Do the action, then report the outcome in the user's language.
You have real tools: files (list, read, write, search, move, delete-to-recycle-bin, zip) anywhere on the system, a PowerShell terminal, clipboard, screenshots, app/URL launching, power actions, live system telemetry, PC maintenance (system_cleanup, recycle_bin_empty), hardware/settings control (wifi, bluetooth, sound, brightness), and the web (web_search, web_fetch, and a browser you can navigate, read, and operate).
You are also a capable software engineer with a project workspace and dedicated coding tools: project_tree (see a project's layout), read_file (read code with line numbers, optionally a range), search_code (grep the project's file contents for a symbol/string/regex), fs_edit (surgical find/replace edits to existing files — prefer this over rewriting), fs_write (new files/full rewrites), and run_command (run shell commands — scaffold, install packages, build, test — in the workspace terminal the user can watch in the COSMOS Studio). When building or fixing software, actually run and verify your work rather than assuming it works.
Version control: you have git + GitHub tools — git_status, git_diff, git_log, git_init, git_branch, git_commit (stages & commits as the user's connected GitHub identity), git_push, git_pull, git_set_remote, git_clone, and github_publish (create a GitHub repo, wire origin, commit, and push in one step). Use them for "commit my changes", "push to GitHub", "put this on my GitHub", "clone <repo>", etc. Commits and pushes are done through the user's connected GitHub account. If a push/publish needs auth and no account is connected, tell the user to connect GitHub in Settings → GitHub (a Personal Access Token) — do not ask them for the token in chat.
File paths: use folder shortcuts — "Desktop/name", "Documents/name", "Downloads/name", or "~/name" — for anything in the user's own folders. NEVER build an absolute path like C:\\Users\\<name> from the user's name: their Windows profile folder is usually different (e.g. their name is "Pushkar" but the folder is C:\\Users\\user), and guessing it causes permission errors. COSMOS resolves the real home for you.
Controlling apps and media, do it directly — don't just open a search page:
- "open/launch <app>" (Steam, Discord, Spotify, VS Code, Antigravity…) → app_open. Pass the app name EXACTLY as the user said it, as a single literal token — never reinterpret it as English words or assume it isn't a real app (e.g. "antigravity" is an app name, not "anti-gravity"; "obsidian", "notion", "cursor" are apps). If app_open reports it can't find the app, THEN call app_list to see installed names and retry with the closest match.
- "close/quit <app>" → app_close with the app name. It closes gracefully (like clicking the window's X) so the app saves and cleans up — do NOT set force. Only pass force:true when the user explicitly says "force close/quit/kill" or the graceful close reported the app is still running and they confirm. If app_close says the app is still open (e.g. a "save changes?" prompt), relay that; don't silently force it.
Never claim you opened, closed, played or changed something unless the corresponding tool actually ran and returned success. Report what the tool result says — if app_close reports it couldn't fully close the app or found nothing, tell the user that; do not say "done" for an action you didn't take or that failed.
- "play <song/video>", "play X by Y", "put on music" → play_youtube ONLY. It resolves the top result and starts it playing. NEVER use the browser_* automation tools to play music/videos or search YouTube — play_youtube is the correct path.
- "pause / resume / skip / turn it up / stop the music" → media_control (play, pause, toggle, mute, unmute, volume-up, volume-down, forward, back, restart, stop). (Playback controls work when Media mode is the COSMOS player.)
- "open <website>", "go to <url>", "open <site> and search X" → url_open with the full URL (open in the user's default browser — natural, their real profile). Build the URL yourself when possible, e.g. a YouTube/Google/site search URL. Do NOT drive the automation browser for simple "open/go to/search a site" requests.
- "sleep/shut down/restart/lock the PC" → the power tool (these work; they'll ask for confirmation).
- PC maintenance: "clean my PC / clear temp files / free up space / speed up my computer" → system_cleanup (set emptyRecycleBin:true if they also want the bin emptied); "empty the recycle bin / clear the trash" → recycle_bin_empty. Both report what was actually reclaimed — relay those numbers, don't invent them.
- Hardware & settings: "turn wifi on/off" → wifi; "turn bluetooth on/off" → bluetooth; volume ("set volume to 30", "turn it up", "mute", "how loud is it") → sound; screen brightness ("set brightness to 50", "dim the screen") → brightness. Use the exact tool, not the terminal. For any OTHER Windows setting a dedicated tool doesn't cover, use terminal_run (PowerShell) — you can control effectively anything that way.
- Creating, moving and deleting files/folders works ANYWHERE on the system (any drive, any path), not just the user's folders — pass the full path. fs_delete moves items to the Recycle Bin (recoverable). Only use terminal_run for a permanent, unrecoverable delete, and only when the user explicitly asks to delete permanently.
- Opening/previewing a LOCAL file or folder you created or found (an .html page, a document, a folder) → open_path with the path (e.g. "Desktop/snake_game/index.html"). It opens the file's default app — .html in the browser, a folder in Explorer. Do NOT use url_open (that's for web http(s) links) or app_open (that's for installed apps) to open a local file.
- The browser_* automation tools (browser_goto, browser_read, browser_inputs, browser_type, browser_click) drive the COSMOS-controlled browser and are for reading/extracting a page or filling a form the user asked you to fill. Never use them just to open or play something — prefer url_open / play_youtube for that.
- "close the <site> tab" (e.g. "close the YouTube tab") → browser_close_tab with the site name; browser_tabs lists open tabs. NOTE: this only controls the COSMOS browser (the one that plays media / you automate), not the user's separate default browser — if they used default-browser mode, tell them tab control needs the COSMOS player.
You can see: vision_screen/vision_image analyze the screen or images with your vision model; ocr_screen/ocr_image extract exact text offline. You integrate with game engines: unity_* tools talk to the Unity editor (install the bridge with unity_install_bridge first; write scripts with fs_write, then unity_refresh and check unity_console for compile errors), and unreal_* tools use Unreal's Remote Control API. Use them when the user asks you to act — don't describe what you would do, do it. Prefer the specific tool over the terminal when one exists. Destructive actions are confirmed with the user by the system automatically; if a request is denied, respect it and don't retry.
Recency & research policy — this is critical: your training data is stale, but you have LIVE web access, so a knowledge cutoff is never a reason to refuse or hedge. For ANY question that is current, time-sensitive, or where the user wants details/depth — news, "latest/today", "tell me about X", "what's happening with Y", explanations, comparisons, sports results, prices, releases, elections — do NOT answer from memory. Call the research tool (query, and recency:true for news/current events): it searches AND reads the top sources in one step and returns their real article text. Then WRITE A DETAILED, well-organized answer synthesizing those sources — several informative paragraphs or clear sections, naming the sources and their dates. NEVER just paste links or one-line headlines; the user wants substance. Use news_search/web_search only for a quick headline/link check; use research whenever depth is wanted. If research genuinely fails, say the search failed and offer to retry — never invent facts or fall back to "check a news source yourself".
You lead a team of specialist agents — planner, researcher, coder, debugger, reviewer — via the delegate tool. Delegate when a task is complex, multi-step, or benefits from focus (a coding task, a research question, a code review); handle quick actions yourself. You may delegate several tasks in sequence and combine their reports. The user sees agents working live around your core; summarize the team's outcome, don't paste raw reports.
You also have long-term memory. When the user shares a durable preference, project, goal, or personal fact, save it with memory_save (one clean sentence). Relevant saved memories are injected into your context automatically — use them naturally, never recite them back verbatim. If asked to forget something, use memory_delete.
After acting, state the outcome in one or two sentences and stop. Never end a reply with a recap — no "To summarize", no "In summary", no restating what you just said, and no listing actions from earlier in the conversation. Answer only what was just asked.`

/**
 * The agent loop: streams model turns, executes requested tools (with
 * user approval for sensitive ones), feeds results back, and repeats
 * until the model answers in plain text. Everything is abortable.
 */
export class AIService {
  private readonly providers: Record<ProviderId, AIProvider> = {
    anthropic: anthropicProvider,
    openai: openaiProvider,
    gemini: geminiProvider,
    ollama: ollamaProvider
  }

  private readonly inflight = new Map<string, AbortController>()
  private readonly pendingApprovals = new Map<
    string,
    { tool: string; resolve: (approved: boolean) => void }
  >()

  constructor(
    private readonly settings: SettingsService,
    private readonly tools: ToolRegistry,
    private readonly memory: MemoryService,
    private readonly workspace: WorkspaceService
  ) {
    // registered here because the tool closes over the agent runner
    this.tools.register({
      def: {
        name: 'delegate',
        description:
          `Delegate a task to a specialist agent and get their report back. Agents: ${AGENT_ROLE_NAMES.map(
            (r) => `${r} (${AGENTS[r].description})`
          ).join('; ')}. Give the agent a complete, self-contained brief — it cannot see the conversation.`,
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', enum: AGENT_ROLE_NAMES },
            task: { type: 'string', description: 'Complete, self-contained brief' }
          },
          required: ['agent', 'task']
        },
        sensitive: false
      },
      summary: (a) => `${String(a.agent ?? '')}: ${String(a.task ?? '').slice(0, 90)}`,
      run: (a, ctx) => {
        if (ctx.depth > 0) {
          return Promise.resolve('Error: specialist agents cannot delegate further.')
        }
        const role = String(a.agent) as AgentRole
        if (!AGENTS[role]) return Promise.resolve(`Error: unknown agent "${role}".`)
        return this.runSubAgent(role, String(a.task), ctx)
      }
    })
  }

  async chat(win: BrowserWindow, req: ChatRequest): Promise<void> {
    const provider = this.providers[req.provider]
    const controller = new AbortController()
    this.inflight.set(req.requestId, controller)

    const s = this.settings.get()
    const ctx = this.providerCtx(req.provider)
    const workspaceRoot = await this.workspace.getRoot()
    // Autonomous Builder only takes effect in agent/ultra mode — chat never
    // auto-runs terminal/file mutations.
    const reqMode = req.mode ?? 'chat'
    const autoApproveCoding =
      s.agentAutoApprove && (reqMode === 'agent' || reqMode === 'ultra')
    const execCtx: ToolExecContext = {
      win,
      requestId: req.requestId,
      signal: controller.signal,
      provider: req.provider,
      model: req.model,
      depth: 0,
      workspaceRoot,
      autoApproveCoding
    }

    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')
    if (lastUser) this.memory.append('user', lastUser.content)

    // auto-recall: fold relevant long-term memories into the system prompt
    let recalled = ''
    if (lastUser) {
      try {
        const memories = await this.memory.recall(lastUser.content, 5)
        if (memories.length > 0) {
          recalled =
            '\nRelevant long-term memories (use naturally, do not recite):\n' +
            memories.map((m) => `- [${m.category}] ${m.content}`).join('\n')
        }
      } catch (err) {
        console.error('[ai] memory recall failed:', err)
      }
    }

    const messages: AgentMessage[] = [...req.messages]
    // Reply language = the language of the user's LATEST message: Devanagari →
    // Hindi, otherwise English. PURELY message-based so an English query always
    // gets an English reply (even mid-conversation after Hindi turns, and
    // regardless of the voice-language setting), and a Hindi query gets Hindi.
    const hindiMode = /[ऀ-ॿ]/.test(lastUser?.content ?? '')
    const mode: AssistantMode = req.mode ?? 'chat'
    const system =
      this.buildSystemPrompt(s.userName, provider.supportsTools, hindiMode, mode, workspaceRoot) +
      recalled
    const maxRounds = mode === 'agent' || mode === 'ultra' ? MAX_AGENT_ROUNDS : MAX_TOOL_ROUNDS
    const toolDefs = provider.supportsTools ? this.tools.defs() : undefined
    // Small local models drift to the other language when a tool returns text
    // in it, or when the conversation history is in it. Re-assert the reply
    // language right after tool results (recency) so it stays consistent.
    const langReminder = hindiMode
      ? '\n\n[Language: reply to the user ENTIRELY in Hindi (Devanagari). Translate any English in this tool output into Hindi — do NOT answer in English, and do NOT invent facts if the tool failed.]'
      : '\n\n[Language: reply to the user in ENGLISH. Do NOT switch to Hindi/Devanagari, and do NOT invent facts if the tool failed.]'

    let fullText = ''
    const emit = (delta: string): void => {
      fullText += delta
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.AI_TOKEN, {
          requestId: req.requestId,
          delta
        } satisfies AITokenEvent)
      }
    }

    let researchUsed = false
    try {
      for (let round = 0; round < maxRounds; round++) {
        const textBefore = fullText
        const { calls } = await provider.streamChat(
          { model: req.model, system, messages, tools: toolDefs },
          ctx,
          emit,
          controller.signal
        )
        if (calls.length === 0) break
        if (calls.some((c) => c.name === 'research')) researchUsed = true

        messages.push({
          role: 'assistant-tools',
          text: fullText.slice(textBefore.length),
          calls
        })
        const results = await this.executeCalls(calls, execCtx)
        if (results.length > 0) {
          results[results.length - 1].result += langReminder
        }
        messages.push({ role: 'tool-results', results })
      }
      this.memory.append('assistant', fullText)
      // Research mode (and Ultra when it decided to research) → persist the
      // detailed answer to Notes so the user keeps it.
      if (fullText.trim() && (mode === 'research' || (mode === 'ultra' && researchUsed))) {
        this.saveResearchNote(win, lastUser?.content ?? '', fullText)
      }
      this.finish(win, req.requestId)
    } catch (err) {
      if (controller.signal.aborted) {
        this.memory.append('assistant', fullText)
        this.finish(win, req.requestId)
      } else if (!win.isDestroyed()) {
        win.webContents.send(IPC.AI_ERROR, {
          requestId: req.requestId,
          message: err instanceof Error ? err.message : String(err)
        } satisfies AIErrorEvent)
      }
    } finally {
      this.inflight.delete(req.requestId)
    }
  }

  abort(requestId: string): void {
    this.inflight.get(requestId)?.abort()
  }

  /**
   * Translate text into the conversation language (used when the user's query
   * is in a different language than their setting). Uses the current provider/
   * model with no tools. Returns the original text on any failure.
   */
  async translate(text: string, target: VoiceLanguageId): Promise<string> {
    const clean = text.trim()
    if (!clean) return clean
    const s = this.settings.get()
    const provider = this.providers[s.provider]
    const langName = target === 'hi' ? 'Hindi (Devanagari script)' : 'English'
    const system =
      `You are a translation engine. Translate the user's message into ${langName}. ` +
      `Output ONLY the translated text — no quotes, no commentary, no notes. Preserve the ` +
      `meaning, tone, intent and any instruction. Keep proper nouns, code, URLs, file paths ` +
      `and numbers intact. If it is already in ${langName}, return it unchanged.`
    let out = ''
    try {
      await provider.streamChat(
        { model: s.model, system, messages: [{ role: 'user', content: clean }], tools: undefined },
        this.providerCtx(s.provider),
        (d) => {
          out += d
        },
        new AbortController().signal
      )
    } catch (err) {
      console.error('[ai] translate failed:', err)
      return clean
    }
    const ci = out.lastIndexOf('</think>') // strip reasoning models' scratchpad
    if (ci >= 0) out = out.slice(ci + 8)
    return out.trim() || clean
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return
    this.pendingApprovals.delete(approvalId)
    if (decision === 'always') {
      const s = this.settings.get()
      if (!s.alwaysAllowTools.includes(pending.tool)) {
        this.settings.set({ alwaysAllowTools: [...s.alwaysAllowTools, pending.tool] })
      }
    }
    pending.resolve(decision !== 'deny')
  }

  private async executeCalls(
    calls: ToolCall[],
    ctx: ToolExecContext,
    agent?: AgentRole
  ): Promise<ToolOutcome[]> {
    const { win, requestId, signal } = ctx
    const outcomes: ToolOutcome[] = []
    for (const call of calls) {
      if (signal.aborted) {
        outcomes.push({ id: call.id, name: call.name, result: 'Interrupted.', isError: true })
        continue
      }
      const summary = this.tools.summarize(call)
      this.sendToolEvent(win, { requestId, callId: call.id, tool: call.name, status: 'running', summary, agent })

      const granted =
        this.settings.get().alwaysAllowTools.includes(call.name) ||
        (ctx.autoApproveCoding === true && AUTO_APPROVE_CODING.has(call.name))
      if (this.tools.isSensitive(call.name) && !granted) {
        const approved = await this.requestApproval(win, call, summary, signal)
        if (!approved) {
          this.sendToolEvent(win, { requestId, callId: call.id, tool: call.name, status: 'denied', summary, agent })
          this.memory.audit(call.name, summary, 'denied')
          outcomes.push({
            id: call.id,
            name: call.name,
            result: 'The user denied this action.',
            isError: true
          })
          continue
        }
      }

      try {
        const result = await this.executeWithTimeout(call, ctx)
        this.sendToolEvent(win, { requestId, callId: call.id, tool: call.name, status: 'ok', summary, agent })
        this.memory.audit(call.name, summary, 'ok')
        outcomes.push({ id: call.id, name: call.name, result })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.sendToolEvent(win, { requestId, callId: call.id, tool: call.name, status: 'error', summary, agent })
        this.memory.audit(call.name, summary, 'error')
        outcomes.push({ id: call.id, name: call.name, result: `Error: ${message}`, isError: true })
      }
    }
    return outcomes
  }

  /**
   * Runs a tool but never lets it hang the agent loop: if it neither
   * resolves nor rejects within the cap, we reject with a timeout so the
   * conversation stays alive. `signal` aborting also unblocks the wait.
   */
  private executeWithTimeout(call: ToolCall, ctx: ToolExecContext): Promise<string> {
    const CAP_MS = 90_000
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        fn()
      }
      const timer = setTimeout(
        () => done(() => reject(new Error(`Tool "${call.name}" timed out after 90s`))),
        CAP_MS
      )
      const onAbort = (): void => done(() => reject(new Error('Interrupted')))
      ctx.signal.addEventListener('abort', onAbort)

      this.tools.execute(call, ctx).then(
        (r) => done(() => resolve(r)),
        (e) => done(() => reject(e instanceof Error ? e : new Error(String(e))))
      )
    })
  }

  /** run one specialist agent to completion; its report is the tool result */
  private async runSubAgent(role: AgentRole, task: string, parent: ToolExecContext): Promise<string> {
    const def = AGENTS[role]
    const agentId = randomUUID()
    const { win, requestId } = parent
    const provider = this.providers[parent.provider]
    const ctx = this.providerCtx(parent.provider)
    const execCtx: ToolExecContext = { ...parent, depth: parent.depth + 1 }

    this.sendAgentEvent(win, { requestId, agentId, role, status: 'started', task })

    const messages: AgentMessage[] = [{ role: 'user', content: task }]
    const system = `${def.prompt}\nCurrent date: ${new Date().toDateString()}.`
    const toolDefs = provider.supportsTools ? this.tools.defs(def.tools) : undefined
    let report = ''

    try {
      for (let round = 0; round < MAX_SUBAGENT_ROUNDS; round++) {
        let roundText = ''
        const { calls } = await provider.streamChat(
          { model: parent.model, system, messages, tools: toolDefs },
          ctx,
          (delta) => {
            roundText += delta
          },
          parent.signal
        )
        report += roundText
        if (calls.length === 0) break
        messages.push({ role: 'assistant-tools', text: roundText, calls })
        const results = await this.executeCalls(calls, execCtx, role)
        messages.push({ role: 'tool-results', results })
      }
      this.sendAgentEvent(win, { requestId, agentId, role, status: 'done', task })
      return report.trim() || '(the agent produced no report)'
    } catch (err) {
      this.sendAgentEvent(win, { requestId, agentId, role, status: 'error', task })
      if (parent.signal.aborted) return 'Interrupted.'
      return `Agent failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  private providerCtx(provider: ProviderId): ProviderContext {
    const s = this.settings.get()
    return {
      apiKey: provider === 'ollama' ? '' : s.apiKeys[provider as keyof typeof s.apiKeys] ?? '',
      baseUrl: provider === 'ollama' ? s.ollamaUrl : undefined,
      numCtx: provider === 'ollama' ? s.ollamaNumCtx : undefined
    }
  }

  private sendAgentEvent(win: BrowserWindow, event: AgentEvent): void {
    if (!win.isDestroyed()) win.webContents.send(IPC.AGENT_EVENT, event)
  }

  private requestApproval(
    win: BrowserWindow,
    call: ToolCall,
    summary: string,
    signal: AbortSignal
  ): Promise<boolean> {
    if (win.isDestroyed()) return Promise.resolve(false)
    const approvalId = randomUUID()
    win.webContents.send(IPC.TOOL_APPROVAL_REQUEST, {
      approvalId,
      tool: call.name,
      summary,
      args: call.args
    } satisfies ToolApprovalRequest)

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS)
      const onAbort = (): void => settle(false)
      const settle = (approved: boolean): void => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        this.pendingApprovals.delete(approvalId)
        resolve(approved)
      }
      signal.addEventListener('abort', onAbort)
      this.pendingApprovals.set(approvalId, { tool: call.name, resolve: settle })
    })
  }

  private sendToolEvent(win: BrowserWindow, event: ToolEvent): void {
    if (!win.isDestroyed()) win.webContents.send(IPC.TOOL_EVENT, event)
  }

  private finish(win: BrowserWindow, requestId: string): void {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.AI_DONE, { requestId } satisfies AIDoneEvent)
    }
  }

  private modeDirective(mode: AssistantMode, workspaceRoot?: string): string {
    const wsLine = workspaceRoot
      ? ` The active project workspace is: ${workspaceRoot}. When the user asks you to build, scaffold, or create a project/app/files WITHOUT naming a folder, work INSIDE this workspace — use bare relative paths (e.g. "my-app/index.html", "src/main.py") and they land there automatically. Only write elsewhere when the user explicitly names another folder (e.g. "on my Desktop") or gives an absolute path.`
      : ''
    switch (mode) {
      case 'agent':
        return `\nMODE: AGENT — you are a world-class autonomous software engineer.${wsLine}
Work like a senior developer building or fixing real software:
1. ORIENT: for an existing project, call project_tree first, then read_file the relevant files before changing anything. Never edit code you have not read.
2. PLAN: decide the concrete steps. Delegate a focused sub-task to a specialist (delegate tool: planner/coder/debugger/reviewer) when it sharpens the work.
3. IMPLEMENT incrementally: use fs_write for NEW files and fs_edit for surgical changes to existing files (match the project's existing style, imports and conventions). Scaffold and install with run_command — you have a real PowerShell in the workspace: create the project (npm/npx/vite/create-*, git init, python -m venv, dotnet new, cargo new…), and install ANY packages/dependencies it needs (npm i <pkg>, pnpm/yarn, pip install, cargo add, dotnet add package, winget). Long installs are fine — the terminal waits as long as they're producing output. Start dev servers with background:true so they don't block you.
4. VERIFY: actually run it — install deps, build, run tests or the app with run_command — and READ the output. Use search_code to locate symbols/usages across the project. If it fails, diagnose the real root cause and fix it, then re-run. Iterate until it genuinely works; do not claim success you have not verified.
5. REPORT: when done, give a short summary — what you built/changed, how you verified it, and how to run it. The user can watch and edit everything live in the COSMOS Studio (editor + terminal).
Be decisive and thorough. Prefer run_command in the workspace terminal over describing commands for the user to run. Never fabricate file contents or command output.`
      case 'research':
        return `\nMODE: RESEARCH. The user wants a thorough, well-sourced answer. ALWAYS call the research tool first (recency:true for current/news topics). Then write a COMPREHENSIVE, well-structured report: begin with a title as a markdown H1 heading (e.g. "# <topic>"), then organized sections with headings, key findings, specifics (names, numbers, dates), and cite the sources you used. Be detailed and substantive — several paragraphs. (Your report is saved to the user's Notes automatically.)`
      case 'ultra':
        return `\nMODE: ULTRA — you choose the approach. Silently decide which fits the request: (a) CHAT — a quick conversational answer; (b) AGENT — a multi-step or coding task, so plan, use tools/delegate, and for building/fixing software follow a real engineering loop: orient (project_tree, read_file), implement (fs_write/fs_edit), then VERIFY by running it with run_command and iterating until it works; or (c) RESEARCH — a question needing depth or current info, so call the research tool and write a detailed, well-structured report (start with a "# title" heading; it gets saved to Notes). Pick the lightest approach that fully satisfies the request, and act — don't announce which mode you picked.${wsLine}`
      case 'chat':
      default:
        return `\nMODE: CHAT. Be conversational and direct. Answer succinctly and naturally. Still look up current facts with your tools when the question needs them, but don't over-plan, delegate, or pad the reply.`
    }
  }

  private saveResearchNote(win: BrowserWindow, query: string, content: string): void {
    try {
      // title: the report's first markdown heading, else the user's question
      const heading = /^\s*#{1,3}\s+(.+?)\s*$/m.exec(content)?.[1]
      const title = (heading || query || 'Research')
        .replace(/[*_`#]/g, '')
        .trim()
        .slice(0, 80)
      this.memory.saveNote(null, title, content)
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.NOTIFY, {
          title: 'Saved to Notes',
          body: title,
          kind: 'success'
        } satisfies NotificationPayload)
      }
    } catch (err) {
      console.error('[ai] failed to save research note:', err)
    }
  }

  private buildSystemPrompt(
    userName: string,
    hasTools: boolean,
    hindiMode: boolean,
    mode: AssistantMode,
    workspaceRoot?: string
  ): string {
    const name = userName ? `\nThe user's name is ${userName}.` : ''
    const toolNote = hasTools
      ? ''
      : '\nNote: tool access is unavailable with the current AI provider — you can only converse. If asked to act on the system, say so and suggest switching to Claude or GPT.'
    const now = new Date()
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const stamp = now.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
    // Running on the user's machine, so we KNOW the wall-clock time — state it
    // plainly so the model never claims it "can't access the current time".
    const clock = `\nRight now it is ${stamp} (${tz}), local time on the user's PC. You DO know the current date and time — answer date/time questions directly from this (or call get_time for a fresh reading); never say you lack real-time clock access.`
    // In Hindi mode (a Hindi voice is selected) force Hindi output everywhere —
    // this is spoken aloud, so a stray English sentence gets read by the Hindi
    // voice and sounds broken.
    const langDirective = hindiMode
      ? `\nThis is a HINDI conversation. Respond ONLY in natural, fluent Hindi (Devanagari script) for EVERY reply — greetings, explanations, and especially summaries of web-search results, news, and tool outputs: translate any English source material into Hindi rather than quoting it. Keep only tool names, code, URLs, file paths, and untranslatable proper nouns in their original form. Never reply in English or romanized Hindi unless the user explicitly asks you to switch to English.`
      : `\nThe user's latest message is in English, so reply in English. Do NOT reply in Hindi or Devanagari script — even if earlier messages in this conversation, tool outputs, or recalled memories are in Hindi. Always match the language of the user's latest message.`
    return `${COSMOS_SYSTEM_PROMPT}${name}${toolNote}${clock}${langDirective}${this.modeDirective(mode, workspaceRoot)}`
  }
}
