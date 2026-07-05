import type { AIProvider } from '../types'
import { sseEvents, raiseForStatus } from '../types'
import type { AgentMessage, ToolCall } from '@shared/tools'

interface OpenAIStreamChunk {
  choices?: {
    delta?: {
      content?: string
      tool_calls?: {
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
  }[]
}

type OpenAIMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

function toWire(system: string | undefined, messages: AgentMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m.role === 'assistant-tools') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        tool_calls: m.calls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) }
        }))
      })
    } else if (m.role === 'tool-results') {
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.result })
      }
    } else {
      out.push(m)
    }
  }
  return out
}

export const openaiProvider: AIProvider = {
  id: 'openai',
  supportsTools: true,

  async streamChat(req, ctx, emit, signal) {
    if (!ctx.apiKey) throw new Error('OpenAI API key is not set (Settings → AI Providers)')

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.apiKey}`
      },
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
    await raiseForStatus(res, 'OpenAI')
    if (!res.body) throw new Error('OpenAI returned no stream body')

    const pending = new Map<number, { id: string; name: string; json: string }>()

    for await (const data of sseEvents(res.body, signal)) {
      if (data === '[DONE]') break
      const chunk = JSON.parse(data) as OpenAIStreamChunk
      const delta = chunk.choices?.[0]?.delta
      if (!delta) continue
      if (delta.content) emit(delta.content)
      for (const tc of delta.tool_calls ?? []) {
        const entry = pending.get(tc.index) ?? { id: '', name: '', json: '' }
        if (tc.id) entry.id = tc.id
        if (tc.function?.name) entry.name += tc.function.name
        if (tc.function?.arguments) entry.json += tc.function.arguments
        pending.set(tc.index, entry)
      }
    }

    const calls: ToolCall[] = [...pending.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, e]) => {
        let args: Record<string, unknown> = {}
        try {
          args = e.json ? (JSON.parse(e.json) as Record<string, unknown>) : {}
        } catch {
          /* malformed args → empty */
        }
        return { id: e.id || `call-${i}`, name: e.name, args }
      })
    return { calls }
  }
}
