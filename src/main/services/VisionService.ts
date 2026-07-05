import type { SettingsService } from './SettingsService'

const MAX_TOKENS = 1024

/**
 * "Cosmos can see": one-shot multimodal analysis of a PNG using the
 * active provider (Claude / GPT / Gemini). Separate from the streaming
 * agent loop — a vision call is a tool, its answer a tool result.
 */
export class VisionService {
  constructor(private readonly settings: SettingsService) {}

  async analyze(pngBase64: string, question: string): Promise<string> {
    const s = this.settings.get()
    const q = question.trim() || 'Describe what you see on this screen, concisely.'

    switch (s.provider) {
      case 'anthropic':
        return this.anthropic(s.apiKeys.anthropic, s.model, pngBase64, q)
      case 'openai':
        return this.openai(s.apiKeys.openai, s.model, pngBase64, q)
      case 'gemini':
        return this.gemini(s.apiKeys.gemini, s.model, pngBase64, q)
      default:
        throw new Error('Vision needs Claude, GPT or Gemini as the active provider')
    }
  }

  private async anthropic(key: string, model: string, data: string, q: string): Promise<string> {
    if (!key) throw new Error('Anthropic API key is not set')
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
              { type: 'text', text: q }
            ]
          }
        ]
      }),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new Error(`Anthropic vision error ${res.status}`)
    const body = (await res.json()) as { content?: { type: string; text?: string }[] }
    return body.content?.find((c) => c.type === 'text')?.text ?? '(no answer)'
  }

  private async openai(key: string, model: string, data: string, q: string): Promise<string> {
    if (!key) throw new Error('OpenAI API key is not set')
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
              { type: 'text', text: q }
            ]
          }
        ]
      }),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new Error(`OpenAI vision error ${res.status}`)
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return body.choices?.[0]?.message?.content ?? '(no answer)'
  }

  private async gemini(key: string, model: string, data: string, q: string): Promise<string> {
    if (!key) throw new Error('Gemini API key is not set')
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ inline_data: { mime_type: 'image/png', data } }, { text: q }]
            }
          ]
        }),
        signal: AbortSignal.timeout(60_000)
      }
    )
    if (!res.ok) throw new Error(`Gemini vision error ${res.status}`)
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
    }
    return (
      body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') || '(no answer)'
    )
  }
}
