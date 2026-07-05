import { app } from 'electron'
import { execFile, spawn } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { SynthesisResult } from '@shared/types'
import type { SettingsService } from '../SettingsService'

/**
 * Text-to-speech with three providers:
 *  - elevenlabs — premium online voices (needs API key)
 *  - piper      — fully offline neural TTS (user supplies piper.exe + model)
 *  - windows    — SAPI via PowerShell; zero-setup offline fallback,
 *                 always available on Windows
 * The renderer decodes the returned buffer with WebAudio and drives the
 * orb's speaking amplitude from an AnalyserNode.
 */
export class TtsService {
  constructor(private readonly settings: SettingsService) {}

  async synthesize(text: string): Promise<SynthesisResult> {
    const clean = text.trim()
    if (!clean) return { data: new ArrayBuffer(0), mime: 'audio/wav' }

    const voice = this.settings.get().voice
    switch (voice.ttsProvider) {
      case 'elevenlabs':
        return this.elevenLabs(clean, voice.elevenLabsKey, voice.elevenLabsVoiceId)
      case 'piper':
        return this.piper(clean, voice.piperPath, voice.piperModelPath)
      case 'windows':
      default:
        return this.windowsSapi(clean)
    }
  }

  private async elevenLabs(text: string, key: string, voiceId: string): Promise<SynthesisResult> {
    if (!key) throw new Error('ElevenLabs API key is not set (Settings → Voice)')
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        }),
        signal: AbortSignal.timeout(30_000)
      }
    )
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`ElevenLabs error ${res.status}: ${detail || res.statusText}`)
    }
    return { data: await res.arrayBuffer(), mime: 'audio/mpeg' }
  }

  private piper(text: string, exePath: string, modelPath: string): Promise<SynthesisResult> {
    if (!exePath || !existsSync(exePath)) {
      throw new Error('Piper executable not found — set its path in Settings → Voice')
    }
    if (!modelPath || !existsSync(modelPath)) {
      throw new Error('Piper voice model (.onnx) not found — set its path in Settings → Voice')
    }
    const outFile = this.tempFile('wav')
    return new Promise((resolve, reject) => {
      const proc = spawn(exePath, ['-m', modelPath, '-f', outFile], { windowsHide: true })
      proc.on('error', (err) => reject(new Error(`Piper failed to start: ${err.message}`)))
      proc.on('close', (code) => {
        if (code !== 0) return reject(new Error(`Piper exited with code ${code}`))
        try {
          const data = readFileSync(outFile)
          rmSync(outFile, { force: true })
          resolve({ data: bufferToArrayBuffer(data), mime: 'audio/wav' })
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
      proc.stdin.write(text)
      proc.stdin.end()
    })
  }

  private windowsSapi(text: string): Promise<SynthesisResult> {
    const textFile = this.tempFile('txt')
    const outFile = this.tempFile('wav')
    // text goes through a temp file so quoting can never break the command
    writeFileSync(textFile, text, 'utf-8')
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      `$s.SetOutputToWaveFile('${outFile.replace(/'/g, "''")}');`,
      `$t = Get-Content -Raw -Encoding UTF8 '${textFile.replace(/'/g, "''")}';`,
      '$s.Rate = 1;',
      '$s.Speak($t);',
      '$s.Dispose();'
    ].join(' ')

    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 30_000 },
        (err) => {
          rmSync(textFile, { force: true })
          if (err) {
            rmSync(outFile, { force: true })
            return reject(new Error(`Windows TTS failed: ${err.message}`))
          }
          try {
            const data = readFileSync(outFile)
            rmSync(outFile, { force: true })
            resolve({ data: bufferToArrayBuffer(data), mime: 'audio/wav' })
          } catch (readErr) {
            reject(readErr instanceof Error ? readErr : new Error(String(readErr)))
          }
        }
      )
    })
  }

  private tempFile(ext: string): string {
    const dir = join(app.getPath('temp'), 'cosmos-tts')
    mkdirSync(dir, { recursive: true })
    return join(dir, `${randomUUID()}.${ext}`)
  }
}

function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}
