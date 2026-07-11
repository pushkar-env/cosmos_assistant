import { randomUUID } from 'node:crypto'
import type { AIProvider } from '../types'
import { ndjsonLines, splitAttachments, withDocuments } from '../types'
import type { AgentMessage, ToolCall } from '@shared/tools'

interface OllamaToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> }
}

interface OllamaStreamChunk {
  message?: { content?: string; tool_calls?: OllamaToolCall[] }
  done?: boolean
}

type OllamaMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string; images?: string[] }
  | {
      role: 'assistant'
      content: string
      tool_calls: { function: { name: string; arguments: Record<string, unknown> } }[]
    }
  | { role: 'tool'; content: string; tool_name?: string }

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
      // tool_name helps newer Ollama match results to the right call
      for (const r of m.results) out.push({ role: 'tool', content: r.result, tool_name: r.name })
    } else if (m.role === 'user' && m.attachments?.length) {
      // multimodal Ollama models accept a base64 `images` array; text docs are
      // inlined, and PDFs (unsupported here) are noted
      const { media, docs } = splitAttachments(m.attachments)
      const images = media.filter((a) => a.kind === 'image').map((a) => a.data ?? '')
      const pdfs = media.filter((a) => a.kind === 'pdf')
      let text = withDocuments(m.content, docs)
      if (pdfs.length) {
        const note = `[Attached PDF${pdfs.length > 1 ? 's' : ''}: ${pdfs
          .map((p) => p.name)
          .join(', ')} — this model may not read PDFs. Switch to Claude or Gemini to analyze PDF files.]`
        text = text ? `${text}\n\n${note}` : note
      }
      out.push(images.length ? { role: 'user', content: text, images } : { role: 'user', content: text })
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

    const hasTools = !!req.tools?.length
    const body = {
      model: req.model,
      stream: true,
      messages: toWire(req.system, req.messages),
      tools: req.tools?.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      })),
      // keep the model loaded between tool rounds (no reload latency)
      keep_alive: '15m',
      options: {
        // CRITICAL for agentic use: the big system prompt + ~45 tool
        // definitions + tool results overflow Ollama's small default
        // context (2048) and the model silently loses its tools.
        num_ctx: ctx.numCtx && ctx.numCtx >= 2048 ? ctx.numCtx : 8192,
        // lower temperature → more reliable, deterministic tool calls
        temperature: 0.6
      }
    }

    let res: Response
    try {
      res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch {
      throw new Error(`Cannot reach Ollama at ${base} — is it running? (run: ollama serve)`)
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 400)
      if (res.status === 404) {
        throw new Error(
          `Model "${req.model}" is not installed. Run: ollama pull ${req.model}`
        )
      }
      if (hasTools && /tool|function/i.test(detail)) {
        throw new Error(
          `Model "${req.model}" doesn't support tools/agentic actions. Use a tool-capable model — recommended: qwen2.5:7b or llama3.1:8b (or llama3.2 for lighter machines).`
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
            // globally-unique: an index-based id resets each round, so the same
            // tool called across rounds would collide and leave the second
            // tool card stuck "running" in the UI.
            id: randomUUID(),
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
