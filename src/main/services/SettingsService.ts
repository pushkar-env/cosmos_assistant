import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { decryptOrNull, encryptText, isEncrypted } from './secureText'

type SecretKey = 'anthropic' | 'openai' | 'gemini' | 'elevenLabsKey'
const SECRET_KEYS: SecretKey[] = ['anthropic', 'openai', 'gemini', 'elevenLabsKey']

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
 */
export class SettingsService {
  private cache: Settings | null = null
  private readonly file: string
  /** ciphertext we could not decrypt, kept so persist() won't destroy it */
  private readonly locked = new Map<SecretKey, string>()

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

    // a freshly-entered secret clears any preserved (undecryptable) blob
    if (patch.apiKeys) {
      for (const k of ['anthropic', 'openai', 'gemini'] as const) {
        if (patch.apiKeys[k] !== undefined) this.locked.delete(k)
      }
    }
    if (patch.voice?.elevenLabsKey !== undefined) this.locked.delete('elevenLabsKey')

    this.cache = {
      ...current,
      ...patch,
      apiKeys: nextKeys,
      providerModels: { ...current.providerModels, ...patch.providerModels },
      location: { ...current.location, ...patch.location },
      voice: nextVoice
    }
    this.persist()
    return this.cache
  }

  /** true when a stored key exists but couldn't be decrypted this session */
  hasLockedSecret(): boolean {
    return this.locked.size > 0
  }

  private load(): Settings {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<Settings>
        const merged: Settings = {
          ...DEFAULT_SETTINGS,
          ...raw,
          apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...raw.apiKeys },
          providerModels: { ...DEFAULT_SETTINGS.providerModels, ...raw.providerModels },
          location: { ...DEFAULT_SETTINGS.location, ...raw.location },
          voice: { ...DEFAULT_SETTINGS.voice, ...raw.voice },
          alwaysAllowTools: raw.alwaysAllowTools ?? []
        }
        // migrate: remember the active model for its provider if not already
        if (raw.model && !raw.providerModels?.[merged.provider]) {
          merged.providerModels[merged.provider] = raw.model
        }
        // migrate the old hard-coded Ollama default → the new one
        if (merged.providerModels.ollama === 'llama3.1') merged.providerModels.ollama = 'llama3.2'
        if (merged.provider === 'ollama' && merged.model === 'llama3.1') merged.model = 'llama3.2'
        this.resolveSecret(merged, 'anthropic', merged.apiKeys.anthropic)
        this.resolveSecret(merged, 'openai', merged.apiKeys.openai)
        this.resolveSecret(merged, 'gemini', merged.apiKeys.gemini)
        this.resolveSecret(merged, 'elevenLabsKey', merged.voice.elevenLabsKey)
        if (this.locked.size > 0) {
          console.warn(
            `[settings] ${this.locked.size} stored key(s) could not be decrypted ` +
              `(profile/key mismatch). They are preserved on disk; re-enter them ` +
              `in Settings if needed. Nothing was deleted.`
          )
        }
        return merged
      }
    } catch (err) {
      console.error('[settings] failed to load, using defaults:', err)
    }
    return structuredClone(DEFAULT_SETTINGS)
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
    else target.apiKeys[key] = value
  }

  /** encrypt a secret for disk, or keep the preserved blob if still locked */
  private secretForDisk(key: SecretKey, plaintext: string): string {
    if (!plaintext && this.locked.has(key)) return this.locked.get(key)!
    return isEncrypted(plaintext) ? plaintext : encryptText(plaintext)
  }

  private persist(): void {
    if (!this.cache) return
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
      }
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(onDisk, null, 2), 'utf-8')
    } catch (err) {
      console.error('[settings] failed to persist:', err)
    }
  }
}
