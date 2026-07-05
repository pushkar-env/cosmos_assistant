import type { AIProvider } from '../types'
import { sseEvents, raiseForStatus } from '../types'
import type { AgentMessage, ToolCall } from '@shared/tools'

interface AnthropicStreamEvent {
  type: string
  content_block?: { type: string; id?: string; name?: string }
  delta?: { type: string; text?: string; partial_json?: string }
  index?: number
}

type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

function toWire(messages: AgentMessage[]): { role: 'user' | 'assistant'; content: string | AnthropicContent[] }[] {
  const out: { role: 'user' | 'assistant'; content: string | AnthropicContent[] }[] = []
  for (const m of messages) {
    if (m.role === 'assistant-tools') {
      const content: AnthropicContent[] = []
      if (m.text) content.push({ type: 'text', text: m.text })
      for (const c of m.calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args })
      out.push({ role: 'assistant', content })
    } else if (m.role === 'tool-results') {
      out.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: r.result,
          is_error: r.isError
        }))
      })
    } else if (m.role !== 'system') {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

export const anthropicProvider: AIProvider = {
  id: 'anthropic',
  supportsTools: true,

  async streamChat(req, ctx, emit, signal) {
    if (!ctx.apiKey) throw new Error('Anthropic API key is not set (Settings → AI Providers)')

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: 4096,
        stream: true,
        system: req.system,
        messages: toWire(req.messages),
        tools: req.tools?.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema
        }))
      })
    })
    await raiseForStatus(res, 'Anthropic')
    if (!res.body) throw new Error('Anthropic returned no stream body')

    const calls: ToolCall[] = []
    let pending: { id: string; name: string; json: string } | null = null

    for await (const data of sseEvents(res.body, signal)) {
      const event = JSON.parse(data) as AnthropicStreamEvent
      switch (event.type) {
        case 'content_block_start':
          if (event.content_block?.type === 'tool_use') {
            pending = {
              id: event.content_block.id ?? `tool-${calls.length}`,
              name: event.content_block.name ?? '',
              json: ''
            }
          }
          break
        case 'content_block_delta':
          if (event.delta?.type === 'text_delta' && event.delta.text) emit(event.delta.text)
          if (event.delta?.type === 'input_json_delta' && pending) {
            pending.json += event.delta.partial_json ?? ''
          }
          break
        case 'content_block_stop':
          if (pending) {
            let args: Record<string, unknown> = {}
            try {
              args = pending.json ? (JSON.parse(pending.json) as Record<string, unknown>) : {}
            } catch {
              /* malformed args → empty; the tool will report the problem */
            }
            calls.push({ id: pending.id, name: pending.name, args })
            pending = null
          }
          break
      }
    }
    return { calls }
  }
}
