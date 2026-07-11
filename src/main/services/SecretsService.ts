import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs'
import { join } from 'path'
import type { SecretCategory, SecretInput, SecretMeta } from '@shared/types'
import { SECRET_CATEGORIES } from '@shared/types'
import { decryptOrNull, encryptText, isEncrypted } from './secureText'

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
}

/**
 * One secret as persisted. EVERY field is stored encrypted at rest
 * ("enc:<base64>" when safeStorage is available), including the label and
 * notes — the on-disk row reveals nothing without the profile key.
 */
interface StoredSecret {
  id: number
  label: string
  category: SecretCategory
  service: string
  notes: string
  value: string
  createdAt: string
  updatedAt: string
}

/** A secret with its metadata decrypted for use; value stays ciphertext. */
interface DecodedSecret {
  id: number
  label: string
  category: SecretCategory
  service: string
  notes: string
  /** on-disk ciphertext of the value (decrypted only in reveal()) */
  value: string
  createdAt: string
  updatedAt: string
}

interface JsonStore {
  secrets: StoredSecret[]
}

/**
 * The Secrets Vault: an encrypted store for API keys, tokens, passwords
 * and secure notes. Every field is encrypted at rest via safeStorage
 * (DPAPI on Windows); the plaintext secret value is NEVER handed to the
 * renderer during listing — only a masked preview travels up. The full
 * value is decrypted on demand through reveal(), so ciphertext stays off
 * the UI layer until the user explicitly asks to see or copy it.
 *
 * Kept in its own database (cosmos-secrets.db), isolated from chat history
 * and memories, so the most sensitive data has the smallest blast radius.
 * Falls back to a JSON store when node:sqlite is unavailable.
 */
export class SecretsService {
  private db: SqliteDatabase | null = null
  private jsonFile = ''
  private json: JsonStore = { secrets: [] }

  async init(): Promise<void> {
    const dir = app.getPath('userData')
    try {
      const sqlite = (await import('node:sqlite')) as unknown as {
        DatabaseSync: new (path: string) => SqliteDatabase
      }
      this.db = new sqlite.DatabaseSync(join(dir, 'cosmos-secrets.db'))
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS secrets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          label TEXT NOT NULL,
          category TEXT NOT NULL,
          service TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      console.log('[secrets] node:sqlite active')
    } catch (err) {
      console.warn('[secrets] node:sqlite unavailable, using JSON fallback:', err)
      this.jsonFile = join(dir, 'cosmos-secrets.json')
      try {
        if (existsSync(this.jsonFile)) {
          this.json = JSON.parse(readFileSync(this.jsonFile, 'utf-8')) as JsonStore
        }
      } catch {
        /* fresh store */
      }
    }
  }

  /** Every secret as safe metadata — no plaintext values, newest first. */
  list(): SecretMeta[] {
    return this.decoded()
      .map((s) => this.toMeta(s))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * Decrypt and return one secret's plaintext value. Returns null when the
   * secret is missing or its ciphertext can't be decrypted with the current
   * profile key (locked). Callers surface null as "can't reveal".
   */
  reveal(id: number): string | null {
    const row = this.stored().find((s) => s.id === id)
    if (!row) return null
    return decryptOrNull(row.value)
  }

  /**
   * Rank stored secrets against a natural-language query like "openai api
   * key" or "my database password" — matching on label, service and
   * category, best first. Only positive-scoring secrets are returned, so an
   * empty result means "nothing matched". Returns metadata only (no values).
   */
  findByQuery(query: string): SecretMeta[] {
    const q = (query ?? '').toLowerCase()
    const tokens = q.split(/[^a-z0-9]+/i).filter((t) => t.length > 1 && !STOPWORDS.has(t))
    if (tokens.length === 0 && !q.trim()) return []
    return this.list()
      .map((m) => {
        const label = m.label.toLowerCase()
        const service = m.service.toLowerCase()
        const catLabel = categoryLabel(m.category)
        const hay = `${label} ${service} ${catLabel} ${m.category}`
        let score = 0
        for (const t of tokens) if (hay.includes(t)) score += 1
        // strong signals: the query names the whole label or service
        if (label && q.includes(label)) score += 4
        if (service && q.includes(service)) score += 3
        return { m, score }
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.m.updatedAt.localeCompare(a.m.updatedAt))
      .map((s) => s.m)
  }

  /** Store a new secret. Returns the created metadata. */
  create(input: SecretInput): SecretMeta {
    const now = new Date().toISOString()
    const clean = this.sanitize(input)
    const encrypted = this.encryptFields(clean)
    if (this.db) {
      const result = this.db
        .prepare(
          `INSERT INTO secrets (label, category, service, notes, value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          encrypted.label,
          encrypted.category,
          encrypted.service,
          encrypted.notes,
          encrypted.value,
          now,
          now
        ) as { lastInsertRowid: number | bigint }
      const id = Number(result.lastInsertRowid)
      return this.toMeta(this.decode({ id, ...encrypted, createdAt: now, updatedAt: now }))
    }
    const id = (this.json.secrets.at(-1)?.id ?? 0) + 1
    const record: StoredSecret = { id, ...encrypted, createdAt: now, updatedAt: now }
    this.json.secrets.push(record)
    this.persistJson()
    return this.toMeta(this.decode(record))
  }

  /**
   * Update a secret. Metadata (label/category/service/notes) is always
   * applied; the value is only rewritten when a non-empty new value is
   * supplied, so "edit label without re-typing the key" works.
   */
  update(id: number, input: SecretInput): SecretMeta | null {
    const existing = this.stored().find((s) => s.id === id)
    if (!existing) return null
    const now = new Date().toISOString()
    const clean = this.sanitize(input)
    const encrypted = this.encryptFields(clean)
    // keep the existing ciphertext value if the user left the value blank
    const value = input.value.trim() ? encrypted.value : existing.value
    const record: StoredSecret = {
      id,
      label: encrypted.label,
      category: clean.category,
      service: encrypted.service,
      notes: encrypted.notes,
      value,
      createdAt: existing.createdAt,
      updatedAt: now
    }
    if (this.db) {
      this.db
        .prepare(
          `UPDATE secrets SET label = ?, category = ?, service = ?, notes = ?, value = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(record.label, record.category, record.service, record.notes, record.value, now, id)
      return this.toMeta(this.decode(record))
    }
    const idx = this.json.secrets.findIndex((s) => s.id === id)
    if (idx >= 0) this.json.secrets[idx] = record
    this.persistJson()
    return this.toMeta(this.decode(record))
  }

  delete(id: number): void {
    if (this.db) {
      this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id)
      return
    }
    this.json.secrets = this.json.secrets.filter((s) => s.id !== id)
    this.persistJson()
  }

  // ── internals ──────────────────────────────────────────────────

  private sanitize(input: SecretInput): {
    label: string
    category: SecretCategory
    service: string
    notes: string
    value: string
  } {
    return {
      label: (input.label ?? '').trim().slice(0, 120) || 'Untitled secret',
      category: input.category,
      service: (input.service ?? '').trim().slice(0, 80),
      notes: (input.notes ?? '').trim().slice(0, 2000),
      value: input.value ?? ''
    }
  }

  /** Encrypt every text field for at-rest storage (category stays plain). */
  private encryptFields(clean: {
    label: string
    category: SecretCategory
    service: string
    notes: string
    value: string
  }): Omit<StoredSecret, 'id' | 'createdAt' | 'updatedAt'> {
    return {
      label: encryptText(clean.label),
      category: clean.category,
      service: encryptText(clean.service),
      notes: encryptText(clean.notes),
      value: encryptText(clean.value)
    }
  }

  /** Raw persisted rows (fields still encrypted), normalized to camelCase. */
  private stored(): StoredSecret[] {
    if (this.db) {
      const rows = this.db
        .prepare('SELECT id, label, category, service, notes, value, created_at, updated_at FROM secrets')
        .all() as {
        id: number
        label: string
        category: SecretCategory
        service: string
        notes: string
        value: string
        created_at: string
        updated_at: string
      }[]
      return rows.map((r) => ({
        id: r.id,
        label: r.label,
        category: r.category,
        service: r.service,
        notes: r.notes,
        value: r.value,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }))
    }
    return this.json.secrets
  }

  /** Decode a stored row: metadata to plaintext, value left as ciphertext. */
  private decode(s: StoredSecret): DecodedSecret {
    return {
      id: s.id,
      label: decryptOrNull(s.label) ?? '⚠ Locked secret',
      category: s.category,
      service: decryptOrNull(s.service) ?? '',
      notes: decryptOrNull(s.notes) ?? '',
      value: s.value,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    }
  }

  private decoded(): DecodedSecret[] {
    return this.stored().map((s) => this.decode(s))
  }

  private toMeta(s: DecodedSecret): SecretMeta {
    const plain = decryptOrNull(s.value)
    const locked = isEncrypted(s.value) && plain === null
    return {
      id: s.id,
      label: s.label,
      category: s.category,
      service: s.service,
      notes: s.notes,
      preview: locked ? '—' : maskValue(plain ?? s.value, s.category),
      locked,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    }
  }

  private persistJson(): void {
    try {
      const tmp = `${this.jsonFile}.tmp`
      writeFileSync(tmp, JSON.stringify(this.json), 'utf-8')
      renameSync(tmp, this.jsonFile)
    } catch (err) {
      console.error('[secrets] persist failed:', err)
    }
  }
}

/** Filler words stripped from a lookup query before matching. */
const STOPWORDS = new Set([
  'my', 'me', 'the', 'please', 'can', 'you', 'give', 'get', 'grab', 'fetch',
  'copy', 'put', 'to', 'for', 'and', 'want', 'need', 'find', 'show', 'paste',
  'clipboard', 'active', 'into', 'from', 'that', 'this', 'what', 'which'
])

function categoryLabel(category: SecretCategory): string {
  return (SECRET_CATEGORIES.find((c) => c.id === category)?.label ?? category).toLowerCase()
}

/** A safe, non-reversible masked hint for the card face. */
function maskValue(value: string, category: SecretCategory): string {
  const v = value ?? ''
  if (!v) return '—'
  if (category === 'card') {
    const last4 = v.replace(/\s+/g, '').slice(-4)
    return `•••• •••• •••• ${last4 || '••••'}`
  }
  if (category === 'password' || category === 'note') {
    return '•'.repeat(Math.min(Math.max(v.length, 6), 14))
  }
  // keys / tokens / db urls: keep a recognisable head + tail, hide the middle
  if (v.length <= 8) return `${v.slice(0, 1)}${'•'.repeat(6)}`
  return `${v.slice(0, 3)}${'•'.repeat(6)}${v.slice(-4)}`
}
