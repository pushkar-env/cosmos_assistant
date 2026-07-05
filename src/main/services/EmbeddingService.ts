import type { SettingsService } from './SettingsService'

/**
 * Text embeddings for memory recall. Tries OpenAI first (best quality,
 * needs the key the STT path already uses), then a local Ollama
 * embedding model. Returns null when neither is available — recall then
 * falls back to keyword scoring, so memory still works keyless.
 */
export class EmbeddingService {
  private ollamaBroken = false

  constructor(private readonly settings: SettingsService) {}

  async embed(text: string): Promise<number[] | null> {
    const s = this.settings.get()

    if (s.apiKeys.openai) {
      try {
        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${s.apiKeys.openai}`
          },
          body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
          signal: AbortSignal.timeout(15_000)
        })
        if (res.ok) {
          const body = (await res.json()) as { data?: { embedding?: number[] }[] }
          return body.data?.[0]?.embedding ?? null
        }
      } catch {
        /* fall through to ollama */
      }
    }

    if (!this.ollamaBroken) {
      try {
        const base = s.ollamaUrl.replace(/\/$/, '')
        const res = await fetch(`${base}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'nomic-embed-text', prompt: text.slice(0, 8000) }),
          signal: AbortSignal.timeout(15_000)
        })
        if (res.ok) {
          const body = (await res.json()) as { embedding?: number[] }
          if (body.embedding?.length) return body.embedding
        }
        this.ollamaBroken = true // model missing or server absent; stop retrying
      } catch {
        this.ollamaBroken = true
      }
    }
    return null
  }
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}
