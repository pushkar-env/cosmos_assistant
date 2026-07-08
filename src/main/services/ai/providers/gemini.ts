import { randomUUID } from 'node:crypto'
import type { AIProvider } from '../types'
import { sseEvents, raiseForStatus } from '../types'
import type { AgentMessage, ToolCall, ToolDef } from '@shared/tools'

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: { result: string } }
}

interface GeminiStreamChunk {
  candidates?: { content?: { parts?: GeminiPart[] } }[]
}

function toWire(messages: AgentMessage[]): { role: 'user' | 'model'; parts: GeminiPart[] }[] {
  const out: { role: 'user' | 'model'; parts: GeminiPart[] }[] = []
  for (const m of messages) {
    if (m.role === 'assistant-tools') {
      const parts: GeminiPart[] = []
      if (m.text) parts.push({ text: m.text })
      for (const c of m.calls) parts.push({ functionCall: { name: c.name, args: c.args } })
      out.push({ role: 'model', parts })
    } else if (m.role === 'tool-results') {
      out.push({
        role: 'user',
        parts: m.results.map((r) => ({
          functionResponse: { name: r.name, response: { result: r.result } }
        }))
      })
    } else if (m.role !== 'system') {
      out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })
    }
  }
  return out
}

function toDeclarations(tools: ToolDef[]): { name: string; description: string; parameters?: Record<string, unknown> }[] {
  return tools.map((t) => {
    const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    return {
      name: t.name,
      description: t.description,
      // Gemini rejects empty object schemas — omit parameters instead
      parameters: Object.keys(props).length > 0 ? t.inputSchema : undefined
    }
  })
}

export const geminiProvider: AIProvider = {
  id: 'gemini',
  supportsTools: true,

  async streamChat(req, ctx, emit, signal) {
    if (!ctx.apiKey) throw new Error('Gemini API key is not set (Settings → AI Providers)')

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`

    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': ctx.apiKey
      },
      body: JSON.stringify({
        contents: toWire(req.messages),
        systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
        tools: req.tools?.length ? [{ functionDeclarations: toDeclarations(req.tools) }] : undefined
      })
    })
    await raiseForStatus(res, 'Gemini')
    if (!res.body) throw new Error('Gemini returned no stream body')

    const calls: ToolCall[] = []
    for await (const data of sseEvents(res.body, signal)) {
      const chunk = JSON.parse(data) as GeminiStreamChunk
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) emit(part.text)
        if (part.functionCall?.name) {
          calls.push({
            // globally-unique so the same tool across rounds never collides
            // (an index-based id resets per round → stuck "running" cards)
            id: randomUUID(),
            name: part.functionCall.name,
            args: part.functionCall.args ?? {}
          })
        }
      }
    }
    return { calls }
  }
}
