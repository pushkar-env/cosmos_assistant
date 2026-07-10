import { app } from 'electron'
import { execFile, spawn } from 'child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  existsSync
} from 'fs'
import { dirname, join } from 'path'
import { createHash, randomUUID } from 'crypto'
import {
  BUNDLED_VOICES,
  DEFAULT_ELEVEN_MODEL,
  DEFAULT_PIPER_VOICE,
  type ElevenVoice,
  type SynthesisResult,
  type VoiceSettings
} from '@shared/types'
import type { SettingsService } from '../SettingsService'

/** where a user-installed or bundled Piper typically lives */
export interface PiperPaths {
  piperPath: string
  piperModelPath: string
}

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
    // Reuse previously-synthesized audio for identical lines (the launch
    // greeting, acknowledgements, repeated phrases). This saves ElevenLabs
    // credits and re-synthesis latency, and is keyed by the exact voice/model
    // so switching voices never returns stale audio.
    const ext = voice.ttsProvider === 'elevenlabs' ? 'mp3' : 'wav'
    const key = this.cacheKey(clean, voice.ttsProvider, voice, ext)
    const cached = this.readCache(key, ext)
    if (cached) return cached

    let result: SynthesisResult
    switch (voice.ttsProvider) {
      case 'elevenlabs':
        result = await this.elevenLabs(clean, voice.elevenLabsKey, voice.elevenLabsVoiceId, voice.elevenLabsModel)
        break
      case 'piper': {
        const resolved = this.resolvePiper(voice)
        result = await this.piper(clean, resolved.piperPath, resolved.piperModelPath)
        break
      }
      case 'windows':
      default:
        result = await this.windowsSapi(clean)
        break
    }
    this.writeCache(key, ext, clean, result)
    return result
  }

  // ── synthesis cache (LRU, size-capped) ─────────────────────────────────────

  /** longest line we bother caching — repeated lines are short; unique long
   *  replies rarely recur and would just churn the cache */
  private static readonly CACHE_MAX_TEXT = 600
  private static readonly CACHE_MAX_BYTES = 40 * 1024 * 1024
  private static readonly CACHE_MAX_FILES = 400

  private cacheDir(): string {
    const dir = join(app.getPath('userData'), 'tts-cache')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private cacheKey(text: string, provider: string, voice: VoiceSettings, ext: string): string {
    const id =
      provider === 'elevenlabs'
        ? `${voice.elevenLabsVoiceId}:${voice.elevenLabsModel}`
        : provider === 'piper'
          ? voice.piperVoiceId
          : 'sapi'
    return createHash('sha1').update(`${provider}|${id}|${ext}|${text}`).digest('hex')
  }

  private readCache(key: string, ext: string): SynthesisResult | null {
    const file = join(this.cacheDir(), `${key}.${ext}`)
    if (!existsSync(file)) return null
    try {
      const data = readFileSync(file)
      const now = new Date() // touch mtime → LRU keeps hot lines
      try {
        utimesSync(file, now, now)
      } catch {
        /* touch is best-effort */
      }
      return { data: bufferToArrayBuffer(data), mime: ext === 'mp3' ? 'audio/mpeg' : 'audio/wav' }
    } catch {
      return null
    }
  }

  private writeCache(key: string, ext: string, text: string, result: SynthesisResult): void {
    if (text.length > TtsService.CACHE_MAX_TEXT) return
    if (result.data.byteLength === 0) return
    try {
      writeFileSync(join(this.cacheDir(), `${key}.${ext}`), Buffer.from(result.data))
      this.enforceCacheCap()
    } catch {
      /* cache is best-effort — never let it break playback */
    }
  }

  /** evict oldest files until under the size/count caps */
  private enforceCacheCap(): void {
    try {
      const dir = this.cacheDir()
      const files = readdirSync(dir).map((name) => {
        const st = statSync(join(dir, name))
        return { path: join(dir, name), size: st.size, mtime: st.mtimeMs }
      })
      let total = files.reduce((s, f) => s + f.size, 0)
      if (total <= TtsService.CACHE_MAX_BYTES && files.length <= TtsService.CACHE_MAX_FILES) return
      files.sort((a, b) => a.mtime - b.mtime) // oldest first
      let count = files.length
      for (const f of files) {
        if (total <= TtsService.CACHE_MAX_BYTES && count <= TtsService.CACHE_MAX_FILES) break
        try {
          unlinkSync(f.path)
          total -= f.size
          count--
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  private async elevenLabs(
    text: string,
    key: string,
    voiceId: string,
    model: string
  ): Promise<SynthesisResult> {
    if (!key) throw new Error('ElevenLabs API key is not set (Settings → Voice)')
    if (!voiceId) throw new Error('No ElevenLabs voice selected (Settings → Voice)')
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: model || DEFAULT_ELEVEN_MODEL,
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

  /** List the voices on the user's ElevenLabs account for the Settings picker. */
  async listElevenLabsVoices(): Promise<ElevenVoice[]> {
    const key = this.settings.get().voice.elevenLabsKey
    if (!key) return []
    try {
      const res = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': key },
        signal: AbortSignal.timeout(15_000)
      })
      if (!res.ok) return []
      const data = (await res.json()) as {
        voices?: { voice_id: string; name: string; labels?: Record<string, string> }[]
      }
      return (data.voices ?? []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        accent: v.labels?.accent,
        language: v.labels?.language
      }))
    } catch {
      return [] // network/key issue — dropdown falls back to a manual id field
    }
  }

  private piper(text: string, exePath: string, modelPath: string): Promise<SynthesisResult> {
    if (!exePath || !existsSync(exePath)) {
      throw new Error('Piper executable not found — set its path in Settings → Voice')
    }
    if (!modelPath || !existsSync(modelPath)) {
      throw new Error('Piper voice model (.onnx) not found — set its path in Settings → Voice')
    }
    // Piper's phonemizer needs espeak-ng-data + its DLLs. They ship next
    // to piper.exe, so run FROM that directory and point --espeak_data at
    // it explicitly — this is what makes it work regardless of the app's
    // (packaged) working directory. If the folder isn't there we still
    // try without the flag rather than failing outright.
    const exeDir = dirname(exePath)
    const espeakData = join(exeDir, 'espeak-ng-data')
    const args = ['-m', modelPath, '-f']
    const outFile = this.tempFile('wav')
    args.push(outFile)
    if (existsSync(espeakData)) args.push('--espeak_data', espeakData)

    return new Promise((resolve, reject) => {
      let stderr = ''
      let settled = false
      const proc = spawn(exePath, args, { windowsHide: true, cwd: exeDir })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        proc.kill()
        rmSync(outFile, { force: true })
        reject(new Error('Piper timed out after 30s'))
      }, 30_000)
      const fail = (msg: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rmSync(outFile, { force: true })
        reject(new Error(msg))
      }
      proc.stderr?.on('data', (d) => {
        stderr += String(d)
      })
      proc.on('error', (err) => fail(`Piper failed to start: ${err.message}`))
      proc.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0 || !existsSync(outFile)) {
          rmSync(outFile, { force: true })
          const detail = stderr.trim().split('\n').pop() || `exit code ${code}`
          return reject(new Error(`Piper failed: ${detail}`))
        }
        try {
          const data = readFileSync(outFile)
          rmSync(outFile, { force: true })
          resolve({ data: bufferToArrayBuffer(data), mime: 'audio/wav' })
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
      proc.stdin.on('error', () => {
        /* piper may exit before we finish writing — handled by close/error */
      })
      proc.stdin.write(text)
      proc.stdin.end()
    })
  }

  /** candidate roots that may contain piper.exe + voices, best first */
  private piperRoots(): string[] {
    return [
      join(process.resourcesPath ?? '', 'piper'), // bundled — always present
      join(app.getPath('userData'), 'piper'), // user's COSMOS profile
      app.isPackaged ? '' : join(app.getAppPath(), 'resources', 'piper') // dev
    ].filter(Boolean)
  }

  /** locate piper.exe across the candidate roots */
  private findPiperExe(): string {
    for (const root of this.piperRoots()) {
      const exe = join(root, 'piper.exe')
      if (existsSync(exe)) return exe
      const nested = this.findFirst(root, (n) => n.toLowerCase() === 'piper.exe', 3)
      if (nested) return nested
    }
    return ''
  }

  /** locate a bundled voice model by its id (file stem) across the roots */
  private findVoiceById(voiceId: string): string {
    for (const root of this.piperRoots()) {
      const direct = join(root, 'voices', `${voiceId}.onnx`)
      if (existsSync(direct)) return direct
    }
    return ''
  }

  /**
   * Resolve the piper exe + model to actually use, in priority order:
   *  1. a valid custom override (advanced users who set explicit paths)
   *  2. the selected bundled voice, resolved live from resourcesPath — no
   *     absolute path is stored, so it works on any machine
   *  3. any voice we can find (last-ditch), so playback never dies silently
   * The exe always comes from the bundled/found piper.exe.
   */
  private resolvePiper(voice: VoiceSettings): PiperPaths {
    // 1. explicit custom override, only if both paths still exist
    if (
      voice.piperPath &&
      existsSync(voice.piperPath) &&
      voice.piperModelPath &&
      existsSync(voice.piperModelPath)
    ) {
      return { piperPath: voice.piperPath, piperModelPath: voice.piperModelPath }
    }

    const piperPath = this.findPiperExe()
    // 2. the selected voice id → its bundled .onnx
    const voiceId = voice.piperVoiceId || DEFAULT_PIPER_VOICE
    let modelPath = this.findVoiceById(voiceId)
    // 3. fall back to the default voice, then to ANY voice present
    if (!modelPath && voiceId !== DEFAULT_PIPER_VOICE) {
      modelPath = this.findVoiceById(DEFAULT_PIPER_VOICE)
    }
    if (!modelPath) {
      for (const root of this.piperRoots()) {
        const any = this.findFirst(join(root, 'voices'), (n) => n.toLowerCase().endsWith('.onnx'), 2)
        if (any) {
          modelPath = any
          break
        }
      }
    }
    return { piperPath, piperModelPath: modelPath }
  }

  /**
   * Which bundled voice ids are actually present on disk — the renderer
   * uses this to only offer voices that will really play.
   */
  availableVoiceIds(): string[] {
    return BUNDLED_VOICES.filter((v) => !!this.findVoiceById(v.id)).map((v) => v.id)
  }

  /** shallow recursive search for the first file whose name matches */
  private findFirst(dir: string, match: (name: string) => boolean, depth: number): string {
    if (depth < 0 || !existsSync(dir)) return ''
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return ''
    }
    // files first so a match in this dir wins over deeper ones
    for (const e of entries) {
      if (e.isFile() && match(e.name)) return join(dir, e.name)
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const found = this.findFirst(join(dir, e.name), match, depth - 1)
        if (found) return found
      }
    }
    return ''
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
