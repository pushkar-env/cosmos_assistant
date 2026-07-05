import type { AIProvider } from '../types'
import { ndjsonLines } from '../types'
import type { AgentMessage, ToolCall } from '@shared/tools'

interface OllamaToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> }
}

interface OllamaStreamChunk {
  message?: { content?: string; tool_calls?: OllamaToolCall[] }
  done?: boolean
}

type OllamaMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'assistant'
      content: string
      tool_calls: { function: { name: string; arguments: Record<string, unknown> } }[]
    }
  | { role: 'tool'; content: string }

function toWire(system: string | undefined, messages: AgentMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m.role === 'assistant-tools') {
      out.push({
        role: 'assistant',
        content: m.text,
        tool_calls: m.calls.map((c) => ({ function: { name: c.name, arguments: c.args } }))
      })
    } else if (m.role === 'tool-results') {
      // Ollama matches tool results to calls by order
      for (const r of m.results) out.push({ role: 'tool', content: r.result })
    } else {
      out.push(m)
    }
  }
  return out
}

export const ollamaProvider: AIProvider = {
  id: 'ollama',
  supportsTools: true,

  async streamChat(req, ctx, emit, signal) {
    const base = (ctx.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '')

    let res: Response
    try {
      res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          stream: true,
          messages: toWire(req.system, req.messages),
          tools: req.tools?.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema }
          }))
        })
      })
    } catch {
      throw new Error(`Cannot reach Ollama at ${base} — is it running?`)
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      if (res.status === 400 && /tool/i.test(detail)) {
        throw new Error(
          `Model "${req.model}" does not support tools — try llama3.1, qwen2.5 or mistral-nemo`
        )
      }
      throw new Error(`Ollama API error ${res.status}: ${detail || res.statusText}`)
    }
    if (!res.body) throw new Error('Ollama returned no stream body')

    const calls: ToolCall[] = []
    for await (const chunk of ndjsonLines<OllamaStreamChunk>(res.body, signal)) {
      if (chunk.message?.content) emit(chunk.message.content)
      for (const tc of chunk.message?.tool_calls ?? []) {
        if (tc.function?.name) {
          calls.push({
            id: `ollama-${calls.length}-${tc.function.name}`,
            name: tc.function.name,
            args: tc.function.arguments ?? {}
          })
        }
      }
      if (chunk.done) break
    }
    return { calls }
  }
}
