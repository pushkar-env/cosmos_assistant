import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { AuditEntry, ChatMessage, MemoryCategory, MemoryItem, Note, NoteMeta } from '@shared/types'
import { decryptText, encryptText } from './secureText'
import { cosine, type EmbeddingService } from './EmbeddingService'

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
}

interface JsonStore {
  messages: ChatMessage[]
  memories: { id: number; content: string; category: MemoryCategory; embedding: number[] | null; createdAt: string }[]
  audit: AuditEntry[]
  notes: Note[]
}

const COSINE_THRESHOLD = 0.28
const AUDIT_KEEP = 500

/**
 * Persistence spine: conversations, long-term memories (with vector
 * recall), and the tool audit log. Content columns are encrypted at rest
 * via safeStorage; embeddings are computed on plaintext before
 * encryption. Prefers `node:sqlite`, JSON fallback if unavailable.
 */
export class MemoryService {
  private db: SqliteDatabase | null = null
  private conversationId = 0
  private jsonFile = ''
  private json: JsonStore = { messages: [], memories: [], audit: [], notes: [] }

  constructor(private readonly embeddings: EmbeddingService) {}

  async init(): Promise<void> {
    const dir = app.getPath('userData')
    try {
      const sqlite = (await import('node:sqlite')) as unknown as {
        DatabaseSync: new (path: string) => SqliteDatabase
      }
      this.db = new sqlite.DatabaseSync(join(dir, 'cosmos-memory.db'))
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id),
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          category TEXT NOT NULL,
          embedding TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          tool TEXT NOT NULL,
          summary TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      const last = this.db
        .prepare('SELECT id FROM conversations ORDER BY id DESC LIMIT 1')
        .get() as { id: number } | undefined
      this.conversationId = last?.id ?? this.createConversation()
      console.log('[memory] node:sqlite active, conversation', this.conversationId)
    } catch (err) {
      console.warn('[memory] node:sqlite unavailable, using JSON fallback:', err)
      this.jsonFile = join(dir, 'cosmos-history.json')
      try {
        if (existsSync(this.jsonFile)) {
          const raw = JSON.parse(readFileSync(this.jsonFile, 'utf-8')) as unknown
          // migrate the phase-3 shape (plain message array)
          const parsed = Array.isArray(raw)
            ? { messages: raw as ChatMessage[], memories: [], audit: [], notes: [] }
            : (raw as JsonStore)
          this.json = { ...parsed, notes: parsed.notes ?? [] }
        }
      } catch {
        /* fresh store */
      }
    }
  }

  // ── conversations ──────────────────────────────────────────────

  history(): ChatMessage[] {
    if (this.db) {
      const rows = this.db
        .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id')
        .all(this.conversationId) as { role: ChatMessage['role']; content: string }[]
      return rows.map((r) => ({ role: r.role, content: decryptText(r.content) }))
    }
    return this.json.messages
  }

  append(role: ChatMessage['role'], content: string): void {
    if (!content.trim()) return
    if (this.db) {
      this.db
        .prepare(
          'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(this.conversationId, role, encryptText(content), new Date().toISOString())
      return
    }
    this.json.messages.push({ role, content })
    this.persistJson()
  }

  newConversation(): void {
    if (this.db) {
      this.conversationId = this.createConversation()
      return
    }
    this.json.messages = []
    this.persistJson()
  }

  /** how many stored conversations have at least one message */
  conversationCount(): number {
    if (this.db) {
      const row = this.db
        .prepare('SELECT COUNT(DISTINCT conversation_id) AS n FROM messages')
        .get() as { n: number }
      return row.n
    }
    return this.json.messages.length > 0 ? 1 : 0
  }

  /** wipe every stored conversation and start a clean one */
  clearAllHistory(): void {
    if (this.db) {
      this.db.exec('DELETE FROM messages; DELETE FROM conversations;')
      this.conversationId = this.createConversation()
      return
    }
    this.json.messages = []
    this.persistJson()
  }

  // ── long-term memories ─────────────────────────────────────────

  async saveMemory(content: string, category: MemoryCategory): Promise<number> {
    const embedding = await this.embeddings.embed(content)
    const createdAt = new Date().toISOString()
    if (this.db) {
      const result = this.db
        .prepare(
          'INSERT INTO memories (content, category, embedding, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(encryptText(content), category, embedding ? JSON.stringify(embedding) : null, createdAt) as {
        lastInsertRowid: number | bigint
      }
      return Number(result.lastInsertRowid)
    }
    const id = (this.json.memories.at(-1)?.id ?? 0) + 1
    this.json.memories.push({ id, content, category, embedding, createdAt })
    this.persistJson()
    return id
  }

  listMemories(): MemoryItem[] {
    return this.rawMemories().map((m) => ({
      id: m.id,
      content: m.content,
      category: m.category,
      createdAt: m.createdAt,
      hasEmbedding: m.embedding != null
    }))
  }

  deleteMemory(id: number): void {
    if (this.db) {
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
      return
    }
    this.json.memories = this.json.memories.filter((m) => m.id !== id)
    this.persistJson()
  }

  /** top-k memories relevant to a query: cosine when possible, keyword fallback */
  async recall(query: string, k: number): Promise<MemoryItem[]> {
    const all = this.rawMemories()
    if (all.length === 0) return []

    const qvec = await this.embeddings.embed(query)
    const scored = all.map((m) => {
      let score = 0
      if (qvec && m.embedding) score = cosine(qvec, m.embedding)
      else score = keywordScore(query, m.content)
      return { m, score, vector: Boolean(qvec && m.embedding) }
    })

    return scored
      .filter((s) => (s.vector ? s.score >= COSINE_THRESHOLD : s.score > 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ m }) => ({
        id: m.id,
        content: m.content,
        category: m.category,
        createdAt: m.createdAt,
        hasEmbedding: m.embedding != null
      }))
  }

  // ── workspace notes ────────────────────────────────────────────

  listNotes(): NoteMeta[] {
    if (this.db) {
      return (
        this.db
          .prepare('SELECT id, title, updated_at FROM notes ORDER BY updated_at DESC')
          .all() as { id: number; title: string; updated_at: string }[]
      ).map((r) => ({ id: r.id, title: decryptText(r.title), updatedAt: r.updated_at }))
    }
    return this.json.notes.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
  }

  getNote(id: number): Note | null {
    if (this.db) {
      const r = this.db
        .prepare('SELECT id, title, content, updated_at FROM notes WHERE id = ?')
        .get(id) as { id: number; title: string; content: string; updated_at: string } | undefined
      if (!r) return null
      return {
        id: r.id,
        title: decryptText(r.title),
        content: decryptText(r.content),
        updatedAt: r.updated_at
      }
    }
    return this.json.notes.find((n) => n.id === id) ?? null
  }

  saveNote(id: number | null, title: string, content: string): number {
    const now = new Date().toISOString()
    if (this.db) {
      if (id != null && this.getNote(id)) {
        this.db
          .prepare('UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?')
          .run(encryptText(title), encryptText(content), now, id)
        return id
      }
      const result = this.db
        .prepare('INSERT INTO notes (title, content, updated_at) VALUES (?, ?, ?)')
        .run(encryptText(title), encryptText(content), now) as { lastInsertRowid: number | bigint }
      return Number(result.lastInsertRowid)
    }
    const existing = id != null ? this.json.notes.find((n) => n.id === id) : undefined
    if (existing) {
      Object.assign(existing, { title, content, updatedAt: now })
      this.persistJson()
      return existing.id
    }
    const newId = (this.json.notes.at(-1)?.id ?? 0) + 1
    this.json.notes.push({ id: newId, title, content, updatedAt: now })
    this.persistJson()
    return newId
  }

  deleteNote(id: number): void {
    if (this.db) {
      this.db.prepare('DELETE FROM notes WHERE id = ?').run(id)
      return
    }
    this.json.notes = this.json.notes.filter((n) => n.id !== id)
    this.persistJson()
  }

  // ── audit log ──────────────────────────────────────────────────

  audit(tool: string, summary: string, status: AuditEntry['status']): void {
    const ts = new Date().toISOString()
    if (this.db) {
      this.db
        .prepare('INSERT INTO audit (ts, tool, summary, status) VALUES (?, ?, ?, ?)')
        .run(ts, tool, summary, status)
      this.db
        .prepare(
          `DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT ${AUDIT_KEEP})`
        )
        .run()
      return
    }
    this.json.audit.push({ id: (this.json.audit.at(-1)?.id ?? 0) + 1, ts, tool, summary, status })
    this.json.audit = this.json.audit.slice(-AUDIT_KEEP)
    this.persistJson()
  }

  listAudit(limit = 100): AuditEntry[] {
    if (this.db) {
      return this.db
        .prepare('SELECT id, ts, tool, summary, status FROM audit ORDER BY id DESC LIMIT ?')
        .all(limit) as AuditEntry[]
    }
    return [...this.json.audit].reverse().slice(0, limit)
  }

  // ── internals ──────────────────────────────────────────────────

  private rawMemories(): {
    id: number
    content: string
    category: MemoryCategory
    embedding: number[] | null
    createdAt: string
  }[] {
    if (this.db) {
      const rows = this.db
        .prepare('SELECT id, content, category, embedding, created_at FROM memories ORDER BY id')
        .all() as { id: number; content: string; category: MemoryCategory; embedding: string | null; created_at: string }[]
      return rows.map((r) => ({
        id: r.id,
        content: decryptText(r.content),
        category: r.category,
        embedding: r.embedding ? (JSON.parse(r.embedding) as number[]) : null,
        createdAt: r.created_at
      }))
    }
    return this.json.memories
  }

  private createConversation(): number {
    const result = this.db!.prepare('INSERT INTO conversations (started_at) VALUES (?)').run(
      new Date().toISOString()
    ) as { lastInsertRowid: number | bigint }
    return Number(result.lastInsertRowid)
  }

  private persistJson(): void {
    try {
      writeFileSync(this.jsonFile, JSON.stringify(this.json), 'utf-8')
    } catch (err) {
      console.error('[memory] persist failed:', err)
    }
  }
}

function keywordScore(query: string, content: string): number {
  const tokens = query.toLowerCase().split(/\W+/).filter((t) => t.length > 3)
  if (tokens.length === 0) return 0
  const haystack = content.toLowerCase()
  return tokens.filter((t) => haystack.includes(t)).length
}
