import type { TranscriptionResult, VoiceLanguageId, VoiceSettings } from '@shared/types'
import type { SettingsService } from '../SettingsService'

/** Shared config for the OpenAI-compatible Whisper endpoints (OpenAI + Groq). */
interface WhisperTarget {
  name: string
  baseUrl: string
  key: string
  model: string
  /** what to tell the user to set when the key is missing */
  keyHint: string
}

/**
 * Speech-to-text with three swappable providers, selected by
 * `voice.sttProvider`:
 *  - openai     — OpenAI Whisper (whisper-1), needs the OpenAI API key
 *  - groq       — Groq Whisper large-v3 (free & very fast), needs a free Groq key
 *  - elevenlabs — ElevenLabs Scribe, reuses the ElevenLabs API key
 *
 * Audio arrives from the renderer as an encoded webm/opus buffer straight
 * off MediaRecorder. New engines slot in behind the same `transcribe` call,
 * so the renderer never changes.
 */
export class SttService {
  constructor(private readonly settings: SettingsService) {}

  async transcribe(audio: ArrayBuffer, mime: string): Promise<TranscriptionResult> {
    const s = this.settings.get()
    const voice = s.voice
    const target = voice.language // the conversation language (en | hi)

    switch (voice.sttProvider) {
      case 'groq':
        return this.whisper(audio, mime, target, {
          name: 'Groq',
          baseUrl: 'https://api.groq.com/openai/v1',
          key: voice.groqApiKey,
          model: 'whisper-large-v3',
          keyHint: 'a free Groq API key (Settings → Groq API Key)'
        })
      case 'elevenlabs':
        return this.elevenLabs(audio, mime, target, voice)
      case 'openai':
      default:
        return this.whisper(audio, mime, target, {
          name: 'Whisper',
          baseUrl: 'https://api.openai.com/v1',
          key: s.apiKeys.openai,
          model: 'whisper-1',
          keyHint: 'an OpenAI API key (Settings → OpenAI API Key)'
        })
    }
  }

  /**
   * OpenAI-compatible Whisper (OpenAI and Groq share the same wire format).
   * The conversation language is authoritative: for ENGLISH we use the
   * /translations endpoint so ANY spoken language (incl. Hindi) comes back as
   * English; for HINDI we transcribe with the `hi` hint (Hindi → Devanagari),
   * and a spoken-English utterance is translated to Hindi downstream.
   */
  private async whisper(
    audio: ArrayBuffer,
    mime: string,
    target: VoiceLanguageId,
    t: WhisperTarget
  ): Promise<TranscriptionResult> {
    if (!t.key) throw new Error(`Voice input needs ${t.keyHint}`)

    const endpoint =
      target === 'en'
        ? `${t.baseUrl}/audio/translations`
        : `${t.baseUrl}/audio/transcriptions`

    const form = new FormData()
    form.append('file', new Blob([audio], { type: mime }), `speech.${extFor(mime)}`)
    form.append('model', t.model)
    if (target !== 'en') form.append('language', 'hi')

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}` },
      body: form,
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`${t.name} STT error ${res.status}: ${detail || res.statusText}`)
    }
    const body = (await res.json()) as { text?: string }
    return { text: (body.text ?? '').trim() }
  }

  /**
   * ElevenLabs Scribe — multilingual STT. Hindi conversations force the `hi`
   * hint; English lets Scribe auto-detect (spoken English stays English, and
   * any other language is translated to the reply language downstream by the
   * assistant store).
   */
  private async elevenLabs(
    audio: ArrayBuffer,
    mime: string,
    target: VoiceLanguageId,
    voice: VoiceSettings
  ): Promise<TranscriptionResult> {
    const key = voice.elevenLabsKey
    if (!key) {
      throw new Error(
        'ElevenLabs speech-to-text needs the ElevenLabs API key (Settings → ElevenLabs API Key)'
      )
    }

    const form = new FormData()
    form.append('file', new Blob([audio], { type: mime }), `speech.${extFor(mime)}`)
    form.append('model_id', 'scribe_v1')
    if (target === 'hi') form.append('language_code', 'hi')

    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`ElevenLabs STT error ${res.status}: ${detail || res.statusText}`)
    }
    const body = (await res.json()) as { text?: string }
    return { text: (body.text ?? '').trim() }
  }
}

/** file extension MediaRecorder's mime implies, for the upload filename */
function extFor(mime: string): string {
  return mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : 'wav'
}
