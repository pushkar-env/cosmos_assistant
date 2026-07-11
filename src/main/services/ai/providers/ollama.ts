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

/**
 * Reasoning-capable local models (qwen3, deepseek-r1, granite…) stream their
 * chain-of-thought INLINE in message.content, wrapped in <think>…</think>.
 * Frontier providers keep reasoning on a separate channel, so only Ollama leaks
 * it here. Left in, that reasoning is rendered in the chat bubble and — worse for
 * a voice-first assistant — read aloud by the TTS, so the user hears the model
 * think out loud (a "weird" second voice) alongside the actual answer. This
 * strips the think blocks from the streamed text so only the visible answer
 * reaches the UI, the speech pipeline, and the stored history.
 *
 * It is stateful: a think block spans many stream chunks, and either tag can be
 * split across a chunk boundary, so we hold back a short tail that might be the
 * start of a tag until the next chunk (or the final flush) resolves it.
 */
const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

/** longest suffix of `s` that is a non-empty proper prefix of any given tag */
function partialTagSuffix(s: string, tags: string[]): string {
  let best = 0
  for (const tag of tags) {
    const max = Math.min(s.length, tag.length - 1)
    for (let n = max; n > best; n--) {
      if (s.slice(s.length - n) === tag.slice(0, n)) {
        best = n
        break
      }
    }
  }
  return best > 0 ? s.slice(s.length - best) : ''
}

class ThinkFilter {
  private inThink = false
  /** buffered tail that might be the split prefix of a <think>/</think> tag */
  private held = ''

  feed(chunk: string): string {
    let s = this.held + chunk
    this.held = ''
    let out = ''
    for (;;) {
      if (this.inThink) {
        const close = s.indexOf(THINK_CLOSE)
        if (close === -1) {
          this.held = partialTagSuffix(s, [THINK_CLOSE])
          return out
        }
        s = s.slice(close + THINK_CLOSE.length)
        this.inThink = false
      } else {
        const open = s.indexOf(THINK_OPEN)
        if (open === -1) {
          const keep = partialTagSuffix(s, [THINK_OPEN])
          out += s.slice(0, s.length - keep.length)
          this.held = keep
          return out
        }
        out += s.slice(0, open)
        s = s.slice(open + THINK_OPEN.length)
        this.inThink = true
      }
    }
  }

  /** emit any leftover at stream end — a held partial tag was never real text */
  flush(): string {
    const rest = this.inThink ? '' : this.held
    this.held = ''
    return rest
  }
}

/**
 * Pick a safe num_ctx floor for a given number of tool definitions. Budgets
 * ~2.8k tokens for the system prompt, ~90 tokens per tool definition, and ~1.8k
 * of headroom for conversation + tool results, then rounds UP to a standard
 * window. The curated local-chat set (~34 tools) lands at 8192 — the same
 * window chat has always used, so no VRAM regression — while the full ~79-tool
 * agent/ultra set escalates to 16384 so its definitions never truncate. No tools
 * → a small window. Capped so a huge set can't demand an unloadable context.
 */
function contextFloor(toolCount: number): number {
  if (toolCount === 0) return 4096
  const needed = 2800 + toolCount * 90 + 1800
  for (const window of [8192, 16384, 24576]) if (needed <= window) return window
  return 32768
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
        // CRITICAL for agentic use. The fixed prompt overhead is large — a
        // ~2.7k-token system prompt PLUS every tool definition (~90–110 tokens
        // each) — and tool results pile on top. If num_ctx can't hold all of it,
        // Ollama silently truncates the prompt and the model loses its tools
        // ("I don't have tools to do that") or starts ignoring instructions.
        // Ollama's default is only 2048, so we size the window to the actual
        // tool payload and floor it well above the overhead. A larger user
        // setting always wins; cap keeps VRAM sane on huge tool sets.
        num_ctx: Math.max(ctx.numCtx ?? 0, contextFloor(req.tools?.length ?? 0)),
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
    const think = new ThinkFilter()
    for await (const chunk of ndjsonLines<OllamaStreamChunk>(res.body, signal)) {
      if (chunk.message?.content) {
        // drop any <think>…</think> reasoning so it's never shown or spoken
        const visible = think.feed(chunk.message.content)
        if (visible) emit(visible)
      }
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
    const tail = think.flush()
    if (tail) emit(tail)
    return { calls }
  }
}
