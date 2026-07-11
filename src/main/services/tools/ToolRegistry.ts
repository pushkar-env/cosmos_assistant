import type { BrowserWindow } from 'electron'
import type { ProviderId } from '@shared/types'
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
