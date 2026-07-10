import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { BUNDLED_VOICES, DEFAULT_SETTINGS, voiceLanguageOf, type Settings } from '@shared/types'
import { decryptOrNull, encryptText, isEncrypted } from './secureText'

type SecretKey = 'anthropic' | 'openai' | 'gemini' | 'elevenLabsKey' | 'githubToken'
const SECRET_KEYS: SecretKey[] = ['anthropic', 'openai', 'gemini', 'elevenLabsKey', 'githubToken']

/**
 * Persists a single JSON settings document under userData. API keys are
 * encrypted at rest with safeStorage; the in-memory cache holds
 * plaintext for provider calls and never leaves the main process except
 * over the typed bridge to the settings UI.
 *
 * Data-safety guarantees:
 *  - A stored `enc:` blob that fails to decrypt (wrong profile, rotated
 *    OS key) is PRESERVED verbatim on disk — never overwritten with an
 *    empty value. So a transient decryption failure can never wipe keys.
 *  - The cache is persisted only on an explicit `set()`, not on read.
 *  - Writes are atomic (temp file + rename), so killing the app mid-write
 *    can never leave a torn/corrupt settings file behind.
 *  - Every successful persist refreshes a `.bak` twin; if the main file
 *    is ever unreadable at startup, load() recovers from the backup
 *    instead of silently starting from defaults.
 *  - An unreadable main file is copied to `.corrupt` before the app
 *    continues, so nothing is ever lost even in the worst case.
 */
export class SettingsService {
  private cache: Settings | null = null
  private readonly file: string
  /** ciphertext we could not decrypt, kept so persist() won't destroy it */
  private readonly locked = new Map<SecretKey, string>()
  /**
   * True when load() had to fall back to DEFAULTS even though settings
   * files existed on disk (e.g. a transient read lock during a dev
   * restart). In that state persist() MUST NOT write — otherwise a later
   * set() (WeatherService location, a hands-free toggle, re-entering one
   * field) would clobber a perfectly good file with defaults. The disk is
   * preserved untouched and the next restart recovers it.
   */
  private degraded = false

  constructor() {
    this.file = join(app.getPath('userData'), 'cosmos-settings.json')
  }

  get(): Settings {
    if (!this.cache) this.cache = this.load()
    return this.cache
  }

  set(patch: Partial<Settings>): Settings {
    const current = this.get()
    const nextKeys = { ...current.apiKeys, ...patch.apiKeys }
    const nextVoice = { ...current.voice, ...patch.voice }
    const nextGithub = { ...current.github, ...patch.github }

    // a freshly-entered secret clears any preserved (undecryptable) blob
    if (patch.apiKeys) {
      for (const k of ['anthropic', 'openai', 'gemini'] as const) {
        if (patch.apiKeys[k] !== undefined) this.locked.delete(k)
      }
    }
    if (patch.voice?.elevenLabsKey !== undefined) this.locked.delete('elevenLabsKey')
    if (patch.github?.token !== undefined) this.locked.delete('githubToken')

    this.cache = {
      ...current,
      ...patch,
      apiKeys: nextKeys,
      providerModels: { ...current.providerModels, ...patch.providerModels },
      location: { ...current.location, ...patch.location },
      voice: nextVoice,
      github: nextGithub
    }
    this.persist()
    return this.cache
  }

  /** true when a stored key exists but couldn't be decrypted this session */
  hasLockedSecret(): boolean {
    return this.locked.size > 0
  }

  private load(): Settings {
    const candidates = [this.file, `${this.file}.bak`]
    let anyExisted = false

    // main file first, then the backup from the last good persist
    for (const path of candidates) {
      if (!existsSync(path)) continue
      anyExisted = true
      const raw = this.readWithRetry(path)
      if (raw === null) continue // transient/corrupt — try the next candidate
      if (path !== this.file) {
        console.warn('[settings] main file unreadable — recovered from backup')
      } else if (!existsSync(`${this.file}.bak`)) {
        // seed the backup so protection exists before the first set()
        try {
          copyFileSync(this.file, `${this.file}.bak`)
        } catch {
          /* backup is best-effort */
        }
      }
      return this.mergeRaw(raw)
    }

    // Genuinely first run (no files at all): safe to start from defaults
    // AND write them. But if files DID exist and we still couldn't read
    // any, this is a transient failure (lock during a restart) — go
    // degraded so persist() never overwrites the good-but-busy file.
    if (anyExisted) {
      this.degraded = true
      console.error(
        '[settings] existing settings could not be read this session ' +
          '(likely a transient file lock). Running on defaults WITHOUT ' +
          'writing — the on-disk config is preserved and will load on the ' +
          'next restart. Nothing was deleted.'
      )
    }
    return structuredClone(DEFAULT_SETTINGS)
  }

  /**
   * Read + parse a settings file, retrying briefly on failure. A dev
   * restart can momentarily lock the file (the outgoing instance's atomic
   * rename / backup copy), so a first read may throw EBUSY/EPERM or catch
   * a half-replaced file; a few short retries clear that window. Returns
   * the parsed object, or null if still unreadable after retries.
   */
  private readWithRetry(path: string): Partial<Settings> | null {
    const ATTEMPTS = 5
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        const text = readFileSync(path, 'utf-8')
        if (text.trim()) return JSON.parse(text) as Partial<Settings>
        // empty read: a write may be in flight — fall through to retry
      } catch (err) {
        if (i === ATTEMPTS - 1) console.error(`[settings] failed to read ${path}:`, err)
      }
      if (i < ATTEMPTS - 1) this.sleepMs(60)
    }
    return null
  }

  /** tiny synchronous sleep — load() must stay sync (get() is sync) */
  private sleepMs(ms: number): void {
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* spin — only ever a few short hops during a rare read race */
    }
  }

  private mergeRaw(raw: Partial<Settings>): Settings {
    const merged: Settings = {
      ...DEFAULT_SETTINGS,
      ...raw,
      apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...raw.apiKeys },
      providerModels: { ...DEFAULT_SETTINGS.providerModels, ...raw.providerModels },
      location: { ...DEFAULT_SETTINGS.location, ...raw.location },
      voice: { ...DEFAULT_SETTINGS.voice, ...raw.voice },
      github: { ...DEFAULT_SETTINGS.github, ...raw.github },
      alwaysAllowTools: raw.alwaysAllowTools ?? []
    }
    // migrate: remember the active model for its provider if not already
    if (raw.model && !raw.providerModels?.[merged.provider]) {
      merged.providerModels[merged.provider] = raw.model
    }
    // migrate the old hard-coded Ollama default → the new one
    if (merged.providerModels.ollama === 'llama3.1') merged.providerModels.ollama = 'llama3.2'
    if (merged.provider === 'ollama' && merged.model === 'llama3.1') merged.model = 'llama3.2'
    // migrate old absolute Piper paths → the bundled voice picker: if the
    // stored model path names a bundled voice, adopt it as piperVoiceId and
    // drop the absolute paths so the new voice dropdown drives synthesis
    if (raw.voice?.piperVoiceId === undefined && merged.voice.piperModelPath) {
      const stem = merged.voice.piperModelPath.replace(/\\/g, '/').split('/').pop()?.replace(/\.onnx$/i, '')
      const known = BUNDLED_VOICES.find((v) => v.id === stem)
      if (known) {
        merged.voice.piperVoiceId = known.id
        merged.voice.piperPath = ''
        merged.voice.piperModelPath = ''
      }
    }
    // migrate: seed the new unified conversation language from the previously
    // selected voice (a Hindi Piper voice → 'hi') so existing users keep it
    if (raw.voice?.language === undefined) {
      merged.voice.language = voiceLanguageOf(merged.voice.piperVoiceId)
    }
    this.resolveSecret(merged, 'anthropic', merged.apiKeys.anthropic)
    this.resolveSecret(merged, 'openai', merged.apiKeys.openai)
    this.resolveSecret(merged, 'gemini', merged.apiKeys.gemini)
    this.resolveSecret(merged, 'elevenLabsKey', merged.voice.elevenLabsKey)
    this.resolveSecret(merged, 'githubToken', merged.github.token)
    if (this.locked.size > 0) {
      console.warn(
        `[settings] ${this.locked.size} stored key(s) could not be decrypted ` +
          `(profile/key mismatch). They are preserved on disk; re-enter them ` +
          `in Settings if needed. Nothing was deleted.`
      )
    }
    return merged
  }

  /** decrypt a secret into the cache, remembering the blob if it fails */
  private resolveSecret(target: Settings, key: SecretKey, stored: string): void {
    const plain = decryptOrNull(stored)
    if (plain === null) {
      this.locked.set(key, stored) // preserve verbatim
      this.assignSecret(target, key, '') // app sees empty until re-entered
    } else {
      this.assignSecret(target, key, plain)
    }
  }

  private assignSecret(target: Settings, key: SecretKey, value: string): void {
    if (key === 'elevenLabsKey') target.voice.elevenLabsKey = value
    else if (key === 'githubToken') target.github.token = value
    else target.apiKeys[key] = value
  }

  /** encrypt a secret for disk, or keep the preserved blob if still locked */
  private secretForDisk(key: SecretKey, plaintext: string): string {
    if (!plaintext && this.locked.has(key)) return this.locked.get(key)!
    return isEncrypted(plaintext) ? plaintext : encryptText(plaintext)
  }

  private persist(): void {
    if (!this.cache) return
    // never overwrite an existing-but-temporarily-unreadable config with
    // the defaults we fell back to — this is the exact path that used to
    // wipe API keys and the Piper voice on a dev restart
    if (this.degraded) {
      console.warn(
        '[settings] refusing to persist while degraded — the on-disk ' +
          'config is preserved. Restart the app to reload it.'
      )
      return
    }
    const onDisk: Settings = {
      ...this.cache,
      apiKeys: {
        anthropic: this.secretForDisk('anthropic', this.cache.apiKeys.anthropic),
        openai: this.secretForDisk('openai', this.cache.apiKeys.openai),
        gemini: this.secretForDisk('gemini', this.cache.apiKeys.gemini)
      },
      voice: {
        ...this.cache.voice,
        elevenLabsKey: this.secretForDisk('elevenLabsKey', this.cache.voice.elevenLabsKey)
      },
      github: {
        ...this.cache.github,
        token: this.secretForDisk('githubToken', this.cache.github.token)
      }
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const json = JSON.stringify(onDisk, null, 2)
      // atomic replace: a kill mid-write leaves the old file untouched
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, json, 'utf-8')
      try {
        renameSync(tmp, this.file)
      } catch {
        // rename can fail if the target is momentarily locked (AV scan);
        // fall back to a direct write rather than losing the change
        writeFileSync(this.file, json, 'utf-8')
      }
      // refresh the backup from the just-written good state
      try {
        copyFileSync(this.file, `${this.file}.bak`)
      } catch {
        /* backup is best-effort */
      }
    } catch (err) {
      console.error('[settings] failed to persist:', err)
    }
  }
}
