/** Tool-use types shared between main, preload and renderer. */

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for the tool's arguments (Anthropic input_schema shape) */
  inputSchema: Record<string, unknown>
  /** sensitive tools require user approval before execution */
  sensitive: boolean
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ToolOutcome {
  id: string
  name: string
  result: string
  isError?: boolean
}

/**
 * Conversation messages for the agent loop. Providers convert these to
 * their wire format; the loop itself stays provider-agnostic.
 */
export type AgentMessage =
  | { role: 'user' | 'assistant' | 'system'; content: string }
  | { role: 'assistant-tools'; text: string; calls: ToolCall[] }
  | { role: 'tool-results'; results: ToolOutcome[] }

export type ToolEventStatus = 'running' | 'ok' | 'error' | 'denied'

/** Pushed to the renderer so the transcript shows live tool activity. */
export interface ToolEvent {
  requestId: string
  callId: string
  tool: string
  status: ToolEventStatus
  /** short human-readable description, e.g. the path being read */
  summary: string
  /** set when a sub-agent (not the orchestrator) ran this tool */
  agent?: AgentRole
}

export type AgentRole = 'planner' | 'researcher' | 'coder' | 'debugger' | 'reviewer'

export type AgentStatus = 'started' | 'done' | 'error'

/** Pushed to the renderer to animate the agent ring around the orb. */
export interface AgentEvent {
  requestId: string
  agentId: string
  role: AgentRole
  status: AgentStatus
  task: string
}

export interface ToolApprovalRequest {
  approvalId: string
  tool: string
  summary: string
  args: Record<string, unknown>
}
