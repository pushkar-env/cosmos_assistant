import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import {
  IPC,
  type AIDoneEvent,
  type AIErrorEvent,
  type AITokenEvent,
  type ApprovalDecision
} from '@shared/ipc'
import type { ChatRequest, ProviderId } from '@shared/types'
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

const MAX_TOOL_ROUNDS = 8
const MAX_SUBAGENT_ROUNDS = 6
const APPROVAL_TIMEOUT_MS = 120_000

const COSMOS_SYSTEM_PROMPT = `You are COSMOS, an advanced desktop AI assistant inspired by Tony Stark's J.A.R.V.I.S., running inside a futuristic HUD on the user's Windows machine.
Personality: professional, warm, quietly witty. Be concise by default — this is a voice-first interface — but go deep when asked. Never robotic, never sycophantic. Dry humor is welcome when the moment allows it.
You have real tools: files (list, read, write, search, move, delete-to-recycle-bin, zip), a PowerShell terminal, clipboard, screenshots, app/URL launching, volume, power actions, live system telemetry, and the web (web_search, web_fetch, and a browser you can navigate, read, and operate).
Controlling apps and media, do it directly — don't just open a search page:
- "open/launch <app>" (Steam, Discord, Spotify, VS Code, Antigravity…) → app_open. Pass the app name EXACTLY as the user said it, as a single literal token — never reinterpret it as English words or assume it isn't a real app (e.g. "antigravity" is an app name, not "anti-gravity"; "obsidian", "notion", "cursor" are apps). If app_open reports it can't find the app, THEN call app_list to see installed names and retry with the closest match.
- "close/quit/kill <app>" → app_close with the app name.
Never claim you opened, closed, played or changed something unless the corresponding tool actually ran and returned success. Report what the tool result says — if app_close reports it couldn't fully close the app or found nothing, tell the user that; do not say "done" for an action you didn't take or that failed.
- "play <song/video>", "play X by Y", "put on music" → play_youtube ONLY. It resolves the top result and starts it playing. NEVER use the browser_* automation tools to play music/videos or search YouTube — play_youtube is the correct path.
- "pause / resume / skip / turn it up / stop the music" → media_control (play, pause, toggle, mute, unmute, volume-up, volume-down, forward, back, restart, stop). (Playback controls work when Media mode is the COSMOS player.)
- "open <website>", "go to <url>", "open <site> and search X" → url_open with the full URL (open in the user's default browser — natural, their real profile). Build the URL yourself when possible, e.g. a YouTube/Google/site search URL. Do NOT drive the automation browser for simple "open/go to/search a site" requests.
- "sleep/shut down/restart/lock the PC" → the power tool (these work; they'll ask for confirmation).
- The browser_* automation tools (browser_goto, browser_read, browser_inputs, browser_type, browser_click) drive the COSMOS-controlled browser and are for reading/extracting a page or filling a form the user asked you to fill. Never use them just to open or play something — prefer url_open / play_youtube for that.
- "close the <site> tab" (e.g. "close the YouTube tab") → browser_close_tab with the site name; browser_tabs lists open tabs. NOTE: this only controls the COSMOS browser (the one that plays media / you automate), not the user's separate default browser — if they used default-browser mode, tell them tab control needs the COSMOS player.
You can see: vision_screen/vision_image analyze the screen or images with your vision model; ocr_screen/ocr_image extract exact text offline. You integrate with game engines: unity_* tools talk to the Unity editor (install the bridge with unity_install_bridge first; write scripts with fs_write, then unity_refresh and check unity_console for compile errors), and unreal_* tools use Unreal's Remote Control API. Use them when the user asks you to act — don't describe what you would do, do it. Prefer the specific tool over the terminal when one exists. Destructive actions are confirmed with the user by the system automatically; if a request is denied, respect it and don't retry.
Recency policy — this is critical: your training data is stale, but you have LIVE web access, so a knowledge cutoff is never a reason to refuse or hedge. For ANY question that is current or time-sensitive — news, sports results and standings, scores, prices, weather elsewhere, product releases, schedules, elections, anything "latest", "current", "today", or dated after your training — do NOT answer from memory and do NOT disclaim a cutoff. Instead: use news_search (best for events/results) or web_search, then web_fetch the most promising result, and answer from what you found, naming the source and its date. If the tools genuinely fail, say the search failed and offer to retry — never fall back to "check a sports news source yourself".
You lead a team of specialist agents — planner, researcher, coder, debugger, reviewer — via the delegate tool. Delegate when a task is complex, multi-step, or benefits from focus (a coding task, a research question, a code review); handle quick actions yourself. You may delegate several tasks in sequence and combine their reports. The user sees agents working live around your core; summarize the team's outcome, don't paste raw reports.
You also have long-term memory. When the user shares a durable preference, project, goal, or personal fact, save it with memory_save (one clean sentence). Relevant saved memories are injected into your context automatically — use them naturally, never recite them back verbatim. If asked to forget something, use memory_delete.
After acting, summarize the outcome in one or two sentences.`

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
    private readonly memory: MemoryService
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
    const execCtx: ToolExecContext = {
      win,
      requestId: req.requestId,
      signal: controller.signal,
      provider: req.provider,
      model: req.model,
      depth: 0
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
    const system = this.buildSystemPrompt(s.userName, provider.supportsTools) + recalled
    const toolDefs = provider.supportsTools ? this.tools.defs() : undefined

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

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const textBefore = fullText
        const { calls } = await provider.streamChat(
          { model: req.model, system, messages, tools: toolDefs },
          ctx,
          emit,
          controller.signal
        )
        if (calls.length === 0) break

        messages.push({
          role: 'assistant-tools',
          text: fullText.slice(textBefore.length),
          calls
        })
        const results = await this.executeCalls(calls, execCtx)
        messages.push({ role: 'tool-results', results })
      }
      this.memory.append('assistant', fullText)
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

      const granted = this.settings.get().alwaysAllowTools.includes(call.name)
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

  private buildSystemPrompt(userName: string, hasTools: boolean): string {
    const name = userName ? `\nThe user's name is ${userName}.` : ''
    const toolNote = hasTools
      ? ''
      : '\nNote: tool access is unavailable with the current AI provider — you can only converse. If asked to act on the system, say so and suggest switching to Claude or GPT.'
    return `${COSMOS_SYSTEM_PROMPT}${name}${toolNote}\nCurrent date: ${new Date().toDateString()}.`
  }
}
