import type { TranscriptionResult } from '@shared/types'
import type { SettingsService } from '../SettingsService'

/**
 * Speech-to-text via the OpenAI Whisper API. Audio arrives from the
 * renderer as an encoded webm/opus buffer straight off MediaRecorder.
 * (A local whisper.cpp provider slots in here in a later phase.)
 */
export class SttService {
  constructor(private readonly settings: SettingsService) {}

  async transcribe(audio: ArrayBuffer, mime: string): Promise<TranscriptionResult> {
    const key = this.settings.get().apiKeys.openai
    if (!key) {
      throw new Error('Voice input needs an OpenAI API key (Settings → OpenAI API Key)')
    }

    const form = new FormData()
    const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : 'wav'
    form.append('file', new Blob([audio], { type: mime }), `speech.${ext}`)
    form.append('model', 'whisper-1')
    form.append('language', 'en')

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`Whisper API error ${res.status}: ${detail || res.statusText}`)
    }
    const body = (await res.json()) as { text?: string }
    return { text: (body.text ?? '').trim() }
  }
}
