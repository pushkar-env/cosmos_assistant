# 09 · Data & Security

How COSMOS stores things, how it encrypts secrets, and the one data-loss bug
whose fix shaped several services. If you touch settings, secrets, or the
database, read this first.

---

## Where data lives

Everything is under the **`%APPDATA%\COSMOS`** profile (the `userData` path,
pinned in `index.ts` — see below).

| Path | Written by | Contents |
|---|---|---|
| `cosmos-settings.json` (+ `.bak`) | `SettingsService` | The `Settings` document; secret fields `enc:`-prefixed |
| `cosmos-memory.db` | `MemoryService`, `SecretsService` | SQLite: conversations, memory, embeddings, notes, audit, secrets |
| `plugins/` | user (loaded by `PluginService`) | `plugin.json` command packs |
| `tts-cache/` | `TtsService` | Cached synthesized audio (LRU, capped) |
| `Documents/COSMOS Projects` | `WorkspaceService` | Default agent workspace (configurable) |
| `Documents/COSMOS Notes` | `NotesExportService` | `.md` mirror of notes & research reports (configurable) |

---

## The database

COSMOS uses the **built-in `node:sqlite`** module — no native addon, no
`better-sqlite3` rebuild, so `npm install` never needs a compiler and packaging
is trivial. Both `MemoryService` and `SecretsService` declare a tiny local
interface for the `exec`/`prepare` surface they use, and each keeps a **JSON
mirror fallback** for resilience.

`MemoryService` owns the schema (conversations, messages, memories with
embeddings, notes, audit) and performs lightweight migrations with
`addColumnIfMissing(table, column, type)` — add columns forward-compatibly rather
than rewriting tables. Message and memory **content is encrypted at rest**.

---

## Encryption: `safeStorage` (Windows DPAPI)

Secrets never sit in plaintext on disk. The wrapper is
[`services/secureText.ts`](../../src/main/services/secureText.ts):

```ts
encryptText(value)   // → 'enc:' + base64(safeStorage.encrypt(value))
decryptText(value)   // → plaintext, or '' on failure  (legacy)
decryptOrNull(value) // → plaintext, or null on failure  ← use this
isEncrypted(value)   // → starts with 'enc:'
```

`safeStorage` is backed by the OS keychain — **Windows DPAPI**, tied to the OS
user *and* the app's `userData` profile. What's encrypted:

- API keys (Anthropic / OpenAI / Gemini), Groq key, ElevenLabs key, the GitHub
  PAT — all in `SettingsService`.
- Every entry in the `SecretsService` vault.
- Conversation and memory content in `MemoryService`.

Ciphertext **never leaves the main process**. The renderer sees masked previews
(`SecretMeta.preview`) and a `locked` flag; the actual value only crosses the
bridge on an explicit `reveal()`, and the `secret_copy` tool copies to the
clipboard on-device without ever returning the value to the model.

---

## Why identity is pinned in `index.ts`

At module top, before any service constructs:

```ts
app.setName('COSMOS')
app.setPath('userData', join(app.getPath('appData'), 'COSMOS'))
```

**DPAPI encryption is tied to the `userData` profile**, not just the Windows
user. A bare `electron` dev run would otherwise resolve `getName()` → `"Electron"`
and `userData` → `%APPDATA%\Electron`, a *different* profile with a *different*
key — so the installed app's encrypted keys would fail to decrypt and appear
"lost". Pinning forces dev and the packaged `.exe` to share one profile, so you
enter keys once and they survive updates, reinstalls, and dev runs.

The same fact drove the **JARVIS X → COSMOS migration** (`migrateFromJarvisX`):
old `enc:` blobs are tied to the old profile's key and can't be decrypted under
COSMOS, so migration **strips** them (keys must be re-entered) rather than
copying garbage.

---

## The data-loss bug (and the rules it left behind)

A real bug once made API keys silently vanish in dev. Root cause and fixes —
these constraints are load-bearing, don't regress them:

**Root cause:** `SettingsService.get()` called `load()` then `persist()`
unconditionally, and `decryptText()` returned `''` on failure. So any *transient*
`safeStorage` decrypt failure re-saved `encrypt('')` **over** the real keys.
Compounded by app-identity drift (above) causing decrypt failures in the first
place.

**The fixes, now invariants:**

1. **`decryptOrNull` returns `null`, never `''`** on failure — so a failed
   decrypt is distinguishable from an empty value.
2. **`SettingsService` preserves undecryptable `enc:` blobs verbatim** — it never
   clobbers a real (locked) secret with an empty encryption. It persists **only
   on an explicit `set()`** (not on read), logs a warning, and exposes
   `hasLockedSecret()`. It also recovers from the `.bak` file.
3. **App identity is pinned** at module top (above), so dev and packaged builds
   share `%APPDATA%\COSMOS` and decrypt succeeds consistently.

If you modify `SettingsService`, preserve all three. Verify by: launch dev with
existing keys → they decrypt, no warning, keys intact after a `set()`.

---

## Safety guarantees baked into services

- **Destructive file/cleaner ops default to the Recycle Bin** (recoverable).
  `CleanerService.isProtectedPath()` refuses Windows / Program Files / user
  profile roots; only known-safe caches and user-selected files are ever removed.
- **Sensitive tools require approval** and are **audited** — every AI action (ok,
  error, denied) is written to the audit log, reviewable in the Vault, with
  revocable "Always allow" grants. See [Tools](05-tools.md#the-permission-model).
- **The renderer is sandboxed from the OS** — no Node, no fs, no keys; the preload
  bridge is the only surface (see [IPC & Preload](03-ipc-and-preload.md)).
- **External URLs open in the OS browser**, never inside the shell
  (`setWindowOpenHandler` denies in-app navigation), and `APP_OPEN_EXTERNAL`
  refuses non-`http(s)` URLs.

---

Next: [Personality System →](10-personality-system.md)
