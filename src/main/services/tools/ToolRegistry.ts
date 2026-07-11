import type { BrowserWindow } from 'electron'
import type { AssistantMode, ProviderId } from '@shared/types'
import type { ToolCall, ToolDef } from '@shared/tools'
import { fileTools } from './fileTools'
import { systemTools } from './systemTools'
import { systemControlTools } from './systemControlTools'
import { memoryTools } from './memoryTools'
import { browserTools } from './browserTools'
import { creatorTools } from './creatorTools'
import { codingTools } from './codingTools'
import { gitTools } from './gitTools'
import type { SystemStatsService } from '../SystemStatsService'
import type { CommandService } from '../CommandService'
import type { MemoryService } from '../MemoryService'
import type { BrowserService } from '../BrowserService'
import type { VisionService } from '../VisionService'
import type { OcrService } from '../OcrService'
import type { UnityService } from '../unity/UnityService'
import type { UnrealService } from '../UnrealService'
import type { MediaService } from '../MediaService'
import type { WorkspaceService } from '../WorkspaceService'
import type { GitService } from '../GitService'

export interface RegistryDeps {
  stats: SystemStatsService
  commands: CommandService
  memory: MemoryService
  browser: BrowserService
  vision: VisionService
  ocr: OcrService
  unity: UnityService
  unreal: UnrealService
  media: MediaService
  workspace: WorkspaceService
  git: GitService
}

/** runtime context a tool may need (delegate spawns sub-agents with it) */
export interface ToolExecContext {
  win: BrowserWindow
  requestId: string
  signal: AbortSignal
  provider: ProviderId
  model: string
  /** 0 = orchestrator; sub-agents run at depth 1 and cannot delegate */
  depth: number
  /** the active project root — bare-relative file paths resolve against it */
  workspaceRoot?: string
  /** Autonomous Builder on: skip approval for the coding/build tool set */
  autoApproveCoding?: boolean
  /** per-file fs_edit failure counts — used to nudge weak models to fs_write */
  editFailures?: Map<string, number>
}

export interface ToolSpec {
  def: ToolDef
  /** short human-readable summary of a call, shown in the UI */
  summary: (args: Record<string, unknown>) => string
  run: (args: Record<string, unknown>, ctx: ToolExecContext) => Promise<string>
}

/**
 * Curated core toolset for small local (Ollama) models in CHAT mode.
 *
 * Frontier models (Claude/GPT/Gemini) handle the full ~79-tool catalog fine,
 * but a 7–8B local model does not: 79 tool definitions (~4–5k tokens) on top of
 * the system prompt overflow its context and it either loses the tools entirely
 * ("I don't have tools for that") or is too swamped to pick one and just narrates
 * the action it never took. A focused ~30-tool set that covers everyday assistant
 * actions — apps, media, system control, files, light building, quick web —
 * makes tool selection reliable. The heavier/niche groups (git, unity/unreal,
 * browser automation, vision/ocr, deep multi-source research, delegation) are
 * reserved for AGENT/ULTRA mode, where the user opted into a bigger task and we
 * raise num_ctx to fit them.
 */
export const LOCAL_CHAT_TOOLS = [
  // apps · media · system control — the everyday "do this" actions
  'app_open', 'app_close', 'app_list', 'play_youtube', 'media_control', 'url_open', 'open_path',
  'sound', 'brightness', 'wifi', 'bluetooth', 'power', 'system_stats', 'get_time',
  'system_cleanup', 'recycle_bin_empty', 'screenshot', 'clipboard_read', 'clipboard_write',
  'terminal_run',
  // files · light building (create/preview a script or page without agent mode)
  'fs_list', 'fs_read', 'fs_write', 'fs_mkdir', 'fs_move', 'fs_delete', 'fs_search',
  'read_file', 'run_command',
  // quick web lookups · long-term memory
  'web_search', 'web_fetch', 'memory_save', 'memory_search', 'memory_delete'
]

/**
 * Focused toolset for small local (Ollama) models in RESEARCH mode. Research
 * mode's whole contract is "search the web, read sources, then write a sourced
 * report" — but handed the full ~79-tool catalog a 7–8B model gets overwhelmed
 * and skips the research call entirely, answering from stale memory. Narrowing
 * it to just the web tools makes calling `research` the obvious, almost
 * unavoidable action.
 */
export const LOCAL_RESEARCH_TOOLS = ['research', 'web_search', 'web_fetch', 'news_search']

/**
 * Every capability Cosmos can invoke. One registry feeds the LLM tool
 * definitions, the execution dispatcher, and the approval layer.
 */
export class ToolRegistry {
  private readonly specs = new Map<string, ToolSpec>()

  constructor(deps: RegistryDeps) {
    for (const spec of [
      ...fileTools,
      ...systemTools(deps.stats, deps.commands, deps.media),
      ...systemControlTools(),
      ...memoryTools(deps.memory),
      ...browserTools(deps.browser),
      ...creatorTools(deps),
      ...codingTools(deps.workspace),
      ...gitTools(deps.git)
    ]) {
      this.specs.set(spec.def.name, spec)
    }
  }

  /** late registration (the delegate tool closes over AIService) */
  register(spec: ToolSpec): void {
    this.specs.set(spec.def.name, spec)
  }

  defs(names?: string[]): ToolDef[] {
    const all = [...this.specs.values()].map((s) => s.def)
    return names ? all.filter((d) => names.includes(d.name)) : all
  }

  /**
   * The tool set to expose to a given provider + mode. Frontier providers always
   * get the full catalog. Local (Ollama) models in chat mode get the curated
   * core (see LOCAL_CHAT_TOOLS) so a small model can actually pick the right tool
   * and its context doesn't overflow; local agent/ultra keep the full set (the
   * user opted into a heavier task, and the Ollama provider raises num_ctx to
   * hold it).
   */
  defsFor(provider: ProviderId, mode: AssistantMode): ToolDef[] {
    if (provider === 'ollama') {
      if (mode === 'chat') return this.defs(LOCAL_CHAT_TOOLS)
      if (mode === 'research') return this.defs(LOCAL_RESEARCH_TOOLS)
    }
    return this.defs()
  }

  isSensitive(name: string): boolean {
    return this.specs.get(name)?.def.sensitive ?? true
  }

  summarize(call: ToolCall): string {
    const spec = this.specs.get(call.name)
    return spec ? spec.summary(call.args) : JSON.stringify(call.args).slice(0, 120)
  }

  async execute(call: ToolCall, ctx: ToolExecContext): Promise<string> {
    const spec = this.specs.get(call.name)
    if (!spec) throw new Error(`Unknown tool: ${call.name}`)
    return spec.run(call.args, ctx)
  }
}
