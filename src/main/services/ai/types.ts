import type { ProviderId } from '@shared/types'
import type { AgentMessage, ToolCall, ToolDef } from '@shared/tools'

export interface ProviderContext {
  apiKey: string
  baseUrl?: string
}

/** One streamed model turn in the agent loop. */
export interface ProviderRequest {
  model: string
  system?: string
  messages: AgentMessage[]
  /** omitted for providers without tool support */
  tools?: ToolDef[]
}

export interface TurnResult {
  /** tool invocations the model requested this turn (empty = final answer) */
  calls: ToolCall[]
}

/**
 * The universal provider contract. Streaming is mandatory — every
 * provider parses its own wire format (SSE or NDJSON), emits plain text
 * deltas, and returns any tool calls the model made.
 */
export interface AIProvider {
  id: ProviderId
  /** whether this provider implementation supports tool use */
  supportsTools: boolean
  streamChat(
    req: ProviderRequest,
    ctx: ProviderContext,
    emit: (delta: string) => void,
    signal: AbortSignal
  ): Promise<TurnResult>
}

/** flatten agent messages for providers without tool support */
export function plainMessages(
  messages: AgentMessage[]
): { role: 'user' | 'assistant' | 'system'; content: string }[] {
  const out: { role: 'user' | 'assistant' | 'system'; content: string }[] = []
  for (const m of messages) {
    if (m.role === 'assistant-tools') {
      if (m.text) out.push({ role: 'assistant', content: m.text })
    } else if (m.role === 'tool-results') {
      // tool transcripts are meaningless to a tool-less provider
    } else {
      out.push(m)
    }
  }
  return out
}

/** Iterate an SSE body, yielding the `data:` payload of each event. */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data) yield data
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Iterate an NDJSON body (Ollama), yielding each parsed line. */
export async function* ndjsonLines<T>(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) yield JSON.parse(line) as T
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export async function raiseForStatus(res: Response, provider: string): Promise<void> {
  if (res.ok) return
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 400)
  } catch {
    /* body unreadable */
  }
  throw new Error(`${provider} API error ${res.status}: ${detail || res.statusText}`)
}
