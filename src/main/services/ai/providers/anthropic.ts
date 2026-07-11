import { randomUUID } from 'node:crypto'
import type { AIProvider } from '../types'
import { sseEvents, raiseForStatus, splitAttachments, withDocuments } from '../types'
import type { AgentMessage, ToolCall } from '@shared/tools'

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface AnthropicStreamEvent {
  type: string
  content_block?: { type: string; id?: string; name?: string }
  delta?: { type: string; text?: string; partial_json?: string }
  message?: { usage?: AnthropicUsage }
  usage?: AnthropicUsage
  index?: number
}

type AnthropicSource = { type: 'base64'; media_type: string; data: string }

type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: AnthropicSource }
  | { type: 'document'; source: AnthropicSource }
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
      // a user message may carry images/PDFs (native blocks) and text docs
      // (inlined) — Claude reads both images and PDFs natively
      if (m.role === 'user' && m.attachments?.length) {
        const { media, docs } = splitAttachments(m.attachments)
        const content: AnthropicContent[] = []
        const text = withDocuments(m.content, docs)
        if (text) content.push({ type: 'text', text })
        for (const a of media) {
          const source: AnthropicSource = { type: 'base64', media_type: a.mime, data: a.data ?? '' }
          content.push(
            a.kind === 'image'
              ? { type: 'image', source }
              : { type: 'document', source: { ...source, media_type: 'application/pdf' } }
          )
        }
        out.push({ role: 'user', content: content.length ? content : m.content })
      } else {
        out.push({ role: m.role, content: m.content })
      }
    }
  }
  return out
}

export const anthropicProvider: AIProvider = {
  id: 'anthropic',
  supportsTools: true,

  async streamChat(req, ctx, emit, signal) {
    if (!ctx.apiKey) throw new Error('Anthropic API key is not set (Settings → AI Providers)')

    // Prompt caching: the system prompt and tool definitions are the large,
    // stable prefix of every request in an agentic loop. Marking them with
    // cache_control makes rounds 2..N (and later turns within ~5 min) re-read
    // that prefix at ~10% of the input cost instead of paying full price each
    // round — a big saving on frontier models with no quality change.
    const ephemeral = { type: 'ephemeral' as const }
    type WireTool = { name: string; description: string; input_schema: unknown; cache_control?: typeof ephemeral }
    const tools: WireTool[] | undefined = req.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    }))
    if (tools && tools.length > 0) tools[tools.length - 1].cache_control = ephemeral
    const system = req.system
      ? [{ type: 'text' as const, text: req.system, cache_control: ephemeral }]
      : undefined

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
        system,
        messages: toWire(req.messages),
        tools
      })
    })
    await raiseForStatus(res, 'Anthropic')
    if (!res.body) throw new Error('Anthropic returned no stream body')

    const calls: ToolCall[] = []
    let pending: { id: string; name: string; json: string } | null = null
    const usage: AnthropicUsage = {}

    for await (const data of sseEvents(res.body, signal)) {
      const event = JSON.parse(data) as AnthropicStreamEvent
      switch (event.type) {
        case 'message_start':
          Object.assign(usage, event.message?.usage)
          break
        case 'message_delta':
          if (event.usage?.output_tokens) usage.output_tokens = event.usage.output_tokens
          break
        case 'content_block_start':
          if (event.content_block?.type === 'tool_use') {
            pending = {
              id: event.content_block.id ?? randomUUID(),
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
    // observability: prove prompt caching is working (read ≫ create over a loop)
    const read = usage.cache_read_input_tokens ?? 0
    const created = usage.cache_creation_input_tokens ?? 0
    if (read || created) {
      console.log(
        `[anthropic] tokens in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0} ` +
          `cache-read=${read} cache-write=${created}`
      )
    }
    return { calls }
  }
}
