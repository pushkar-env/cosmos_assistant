import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { SecretCategory, SecretInput, SecretMeta } from '@shared/types'
import { SECRET_CATEGORIES } from '@shared/types'
import { useUIStore } from '@/core/stores/useUIStore'
import { useNotificationStore } from '@/core/stores/useNotificationStore'
import { Glass } from '@/shared/ui/Glass'

/** Per-category accent — themed vars only, so it tracks the active palette. */
const CATEGORY_COLOR: Record<SecretCategory, string> = {
  'api-key': 'var(--accent)',
  token: 'var(--accent-bright)',
  password: 'var(--danger)',
  'ssh-key': 'var(--success)',
  database: 'var(--accent-bright)',
  card: 'var(--accent)',
  note: 'var(--text-dim)',
  other: 'var(--text-dim)'
}

const GLYPH: Record<SecretCategory, string> = Object.fromEntries(
  SECRET_CATEGORIES.map((c) => [c.id, c.glyph])
) as Record<SecretCategory, string>

const LABEL: Record<SecretCategory, string> = Object.fromEntries(
  SECRET_CATEGORIES.map((c) => [c.id, c.label])
) as Record<SecretCategory, string>

/** How long a revealed value stays on screen before auto-masking again. */
const REVEAL_MS = 20_000

interface FormState {
  id: number | null
  label: string
  category: SecretCategory
  service: string
  value: string
  notes: string
}

const EMPTY_FORM: FormState = {
  id: null,
  label: '',
  category: 'api-key',
  service: '',
  value: '',
  notes: ''
}

const inputClass =
  'w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-ui text-sm text-body placeholder:text-dim focus:border-[var(--accent)] focus:outline-none'

/**
 * The Secrets Vault: a premium, encrypted store for API keys, tokens,
 * passwords and secure notes. Values are held encrypted in the main
 * process — only masked previews are listed; the plaintext is fetched on
 * demand when the user reveals or copies it.
 */
export function SecretsPanel(): React.JSX.Element {
  const activePanel = useUIStore((s) => s.activePanel)
  const setPanel = useUIStore((s) => s.setPanel)
  const open = activePanel === 'secrets'
  const notify = useNotificationStore((s) => s.push)

  const [secrets, setSecrets] = useState<SecretMeta[]>([])
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<FormState | null>(null)
  const [showValue, setShowValue] = useState(false)
  const [revealed, setRevealed] = useState<Record<number, string>>({})
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const revealTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  const refresh = async (): Promise<void> => {
    setSecrets(await window.cosmos.secrets.list())
  }

  useEffect(() => {
    if (!open) return
    void refresh()
    // reset transient view state whenever the vault is reopened
    return () => {
      Object.values(revealTimers.current).forEach(clearTimeout)
      revealTimers.current = {}
      setRevealed({})
      setForm(null)
      setConfirmId(null)
      setQuery('')
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return secrets
    return secrets.filter((s) =>
      `${s.label} ${s.service} ${LABEL[s.category]} ${s.notes}`.toLowerCase().includes(q)
    )
  }, [secrets, query])

  const reveal = async (id: number): Promise<string | null> => {
    if (revealed[id] != null) return revealed[id]
    const value = await window.cosmos.secrets.reveal(id)
    if (value == null) {
      notify({
        title: 'Locked secret',
        body: 'This secret was encrypted under a different device profile and can’t be decrypted here.',
        kind: 'error'
      })
      return null
    }
    setRevealed((r) => ({ ...r, [id]: value }))
    clearTimeout(revealTimers.current[id])
    revealTimers.current[id] = setTimeout(() => {
      setRevealed((r) => {
        const next = { ...r }
        delete next[id]
        return next
      })
    }, REVEAL_MS)
    return value
  }

  const hide = (id: number): void => {
    clearTimeout(revealTimers.current[id])
    setRevealed((r) => {
      const next = { ...r }
      delete next[id]
      return next
    })
  }

  const copy = async (id: number): Promise<void> => {
    const value = await reveal(id)
    if (value == null) return
    try {
      await navigator.clipboard.writeText(value)
      setCopiedId(id)
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1600)
    } catch {
      notify({ title: 'Copy failed', body: 'Clipboard access was blocked.', kind: 'error' })
    }
  }

  const startCreate = (): void => {
    setForm({ ...EMPTY_FORM })
    setShowValue(false)
  }

  const startEdit = (s: SecretMeta): void => {
    setForm({ id: s.id, label: s.label, category: s.category, service: s.service, value: '', notes: s.notes })
    setShowValue(false)
  }

  const save = async (): Promise<void> => {
    if (!form) return
    if (!form.label.trim()) {
      notify({ title: 'Name required', body: 'Give this secret a name so you can find it.', kind: 'error' })
      return
    }
    if (form.id == null && !form.value.trim()) {
      notify({ title: 'Secret required', body: 'Enter the value you want to store.', kind: 'error' })
      return
    }
    const input: SecretInput = {
      label: form.label,
      category: form.category,
      service: form.service,
      value: form.value,
      notes: form.notes
    }
    if (form.id == null) await window.cosmos.secrets.create(input)
    else await window.cosmos.secrets.update(form.id, input)
    setForm(null)
    await refresh()
    notify({
      title: form.id == null ? 'Secret stored' : 'Secret updated',
      body: `“${form.label.trim()}” is encrypted and safe.`,
      kind: 'success'
    })
  }

  const remove = async (id: number): Promise<void> => {
    await window.cosmos.secrets.delete(id)
    setConfirmId(null)
    hide(id)
    await refresh()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-30 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)' }}
          onClick={() => setPanel('none')}
        >
          <motion.div
            initial={{ scale: 0.97, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.98, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <Glass brackets className="flex h-[620px] w-[760px] flex-col overflow-hidden">
              {/* header */}
              <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
                <div className="flex items-center gap-3">
                  <ShieldIcon />
                  <div>
                    <h2 className="font-display text-sm font-bold uppercase tracking-[0.3em] text-body">
                      Secrets
                    </h2>
                    <p className="font-mono text-[10px] uppercase tracking-widest text-dim">
                      {secrets.length} stored · encrypted at rest
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={startCreate}
                    className="rounded-lg border border-[var(--accent-dim)] px-3 py-1.5 font-ui text-[10px] font-bold uppercase tracking-widest text-[var(--accent-bright)] transition-colors hover:bg-white/5"
                  >
                    + New Secret
                  </button>
                  <button
                    onClick={() => setPanel('none')}
                    className="rounded-md px-2 py-1 font-mono text-xs text-dim transition-colors hover:bg-white/5 hover:text-body"
                  >
                    ESC
                  </button>
                </div>
              </div>

              {/* search */}
              {secrets.length > 0 && !form && (
                <div className="border-b border-white/5 px-6 py-3">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name, service or category…"
                    className="w-full bg-transparent font-ui text-sm text-body placeholder:text-dim focus:outline-none"
                  />
                </div>
              )}

              {/* body */}
              <div className="smooth-scroll flex-1 overflow-y-auto px-6 py-4">
                <AnimatePresence mode="wait">
                  {form ? (
                    <SecretForm
                      key="form"
                      form={form}
                      setForm={setForm}
                      showValue={showValue}
                      setShowValue={setShowValue}
                      onSave={() => void save()}
                      onCancel={() => setForm(null)}
                    />
                  ) : filtered.length === 0 ? (
                    <motion.div
                      key="empty"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex flex-col items-center justify-center py-20 text-center"
                    >
                      <ShieldIcon large />
                      <p className="mt-4 font-ui text-sm text-body">
                        {secrets.length === 0 ? 'Your vault is empty' : 'No matches'}
                      </p>
                      <p className="mt-1 max-w-sm font-ui text-xs text-dim">
                        {secrets.length === 0
                          ? 'Store API keys, tokens, passwords and secure notes. Everything is encrypted with your device key and never leaves this machine.'
                          : 'Try a different search term.'}
                      </p>
                      {secrets.length === 0 && (
                        <button
                          onClick={startCreate}
                          className="mt-5 rounded-lg border border-[var(--accent-dim)] px-4 py-2 font-ui text-[10px] font-bold uppercase tracking-widest text-[var(--accent-bright)] transition-colors hover:bg-white/5"
                        >
                          + Add your first secret
                        </button>
                      )}
                    </motion.div>
                  ) : (
                    <motion.div
                      key="list"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex flex-col gap-2.5"
                    >
                      {filtered.map((s) => (
                        <SecretCard
                          key={s.id}
                          secret={s}
                          revealed={revealed[s.id]}
                          copied={copiedId === s.id}
                          confirming={confirmId === s.id}
                          onReveal={() => void reveal(s.id)}
                          onHide={() => hide(s.id)}
                          onCopy={() => void copy(s.id)}
                          onEdit={() => startEdit(s)}
                          onAskDelete={() => setConfirmId(s.id)}
                          onCancelDelete={() => setConfirmId(null)}
                          onConfirmDelete={() => void remove(s.id)}
                        />
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* footer */}
              <div className="flex items-center gap-2 border-t border-white/5 px-6 py-2.5">
                <LockIcon />
                <p className="font-mono text-[10px] tracking-wide text-dim">
                  Encrypted with your OS keychain (DPAPI). COSMOS never sends secrets anywhere.
                </p>
              </div>
            </Glass>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ── secret card ──────────────────────────────────────────────────

interface CardProps {
  secret: SecretMeta
  revealed?: string
  copied: boolean
  confirming: boolean
  onReveal: () => void
  onHide: () => void
  onCopy: () => void
  onEdit: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}

function SecretCard({
  secret,
  revealed,
  copied,
  confirming,
  onReveal,
  onHide,
  onCopy,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete
}: CardProps): React.JSX.Element {
  const color = CATEGORY_COLOR[secret.category]
  const isRevealed = revealed != null
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="group rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 transition-colors hover:border-white/10 hover:bg-white/[0.04]"
    >
      <div className="flex items-center gap-3">
        {/* category badge */}
        <div
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg font-mono text-[10px] font-bold tracking-tight"
          style={{
            color,
            background: `color-mix(in srgb, ${color} 12%, transparent)`,
            border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`
          }}
        >
          {GLYPH[secret.category]}
        </div>

        {/* label + service */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-ui text-sm font-semibold text-body">{secret.label}</span>
            {secret.locked && (
              <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-[var(--danger)]" style={{ border: '1px solid color-mix(in srgb, var(--danger) 40%, transparent)' }}>
                Locked
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest" style={{ color }}>
              {LABEL[secret.category]}
            </span>
            {secret.service && (
              <>
                <span className="text-dim">·</span>
                <span className="truncate font-ui text-[11px] text-dim">{secret.service}</span>
              </>
            )}
          </div>
        </div>

        {/* actions */}
        {!confirming ? (
          <div className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
            <IconButton title="Copy" onClick={onCopy} disabled={secret.locked}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </IconButton>
            <IconButton
              title={isRevealed ? 'Hide' : 'Reveal'}
              onClick={isRevealed ? onHide : onReveal}
              disabled={secret.locked}
            >
              {isRevealed ? <EyeOffIcon /> : <EyeIcon />}
            </IconButton>
            <IconButton title="Edit" onClick={onEdit}>
              <EditIcon />
            </IconButton>
            <IconButton title="Delete" danger onClick={onAskDelete}>
              <TrashIcon />
            </IconButton>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <span className="font-ui text-[11px] text-dim">Delete?</span>
            <button
              onClick={onConfirmDelete}
              className="rounded-md border border-[var(--danger)] px-2.5 py-1 font-ui text-[10px] font-bold uppercase tracking-widest text-[var(--danger)] transition-colors hover:bg-[color-mix(in_srgb,var(--danger)_15%,transparent)]"
            >
              Yes
            </button>
            <button
              onClick={onCancelDelete}
              className="rounded-md border border-white/10 px-2.5 py-1 font-ui text-[10px] font-bold uppercase tracking-widest text-dim transition-colors hover:text-body"
            >
              No
            </button>
          </div>
        )}
      </div>

      {/* value row */}
      <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-black/25 px-3 py-2">
        <code
          className={`min-w-0 flex-1 select-text truncate font-mono text-xs ${
            isRevealed ? 'text-[var(--accent-bright)]' : 'text-dim'
          }`}
        >
          {secret.locked ? 'Unavailable on this device' : isRevealed ? revealed : secret.preview}
        </code>
        {isRevealed && (
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-dim">
            auto-hides
          </span>
        )}
      </div>

      {secret.notes && (
        <p className="mt-2 select-text font-ui text-[11px] leading-relaxed text-dim">{secret.notes}</p>
      )}
    </motion.div>
  )
}

// ── add / edit form ──────────────────────────────────────────────

interface FormProps {
  form: FormState
  setForm: (f: FormState) => void
  showValue: boolean
  setShowValue: (v: boolean) => void
  onSave: () => void
  onCancel: () => void
}

function SecretForm({ form, setForm, showValue, setShowValue, onSave, onCancel }: FormProps): React.JSX.Element {
  const editing = form.id != null
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="flex flex-col gap-4"
    >
      <h3 className="font-display text-xs font-bold uppercase tracking-[0.25em] text-body">
        {editing ? 'Edit secret' : 'New secret'}
      </h3>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input
            autoFocus
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            placeholder="e.g. OpenAI Production Key"
            className={inputClass}
          />
        </Field>
        <Field label="Category">
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value as SecretCategory })}
            className={inputClass}
          >
            {SECRET_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id} className="bg-[var(--bg)]">
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Service / Provider" hint="optional">
        <input
          value={form.service}
          onChange={(e) => setForm({ ...form, service: e.target.value })}
          placeholder="e.g. OpenAI, AWS, GitHub"
          className={inputClass}
        />
      </Field>

      <Field label={editing ? 'Secret value' : 'Secret'} hint={editing ? 'leave blank to keep current' : undefined}>
        <div className="relative">
          <input
            type={showValue ? 'text' : 'password'}
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
            placeholder={editing ? '••••••••••••  (unchanged)' : 'Paste the key, token or password'}
            className={`${inputClass} pr-20 font-mono`}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setShowValue(!showValue)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-dim transition-colors hover:text-body"
          >
            {showValue ? 'Hide' : 'Show'}
          </button>
        </div>
      </Field>

      <Field label="Notes" hint="optional">
        <textarea
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="Where it's used, scopes, expiry…"
          rows={2}
          className={`${inputClass} resize-none`}
        />
      </Field>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded-lg border border-white/10 px-4 py-2 font-ui text-[10px] font-bold uppercase tracking-widest text-dim transition-colors hover:text-body"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          className="rounded-lg border border-[var(--accent-dim)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-5 py-2 font-ui text-[10px] font-bold uppercase tracking-widest text-[var(--accent-bright)] transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_22%,transparent)]"
        >
          {editing ? 'Save changes' : 'Encrypt & store'}
        </button>
      </div>
    </motion.div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-dim">
        {label}
        {hint && <span className="text-[9px] normal-case tracking-normal text-dim/70">— {hint}</span>}
      </span>
      {children}
    </label>
  )
}

function IconButton({
  title,
  onClick,
  danger,
  disabled,
  children
}: {
  title: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`grid h-8 w-8 place-items-center rounded-md text-dim transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-30 ${
        danger ? 'hover:text-[var(--danger)]' : 'hover:text-body'
      }`}
    >
      {children}
    </button>
  )
}

// ── icons (inline, currentColor) ─────────────────────────────────

function ShieldIcon({ large }: { large?: boolean }): React.JSX.Element {
  const s = large ? 40 : 22
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: large ? 0.5 : 1 }}>
      <path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5l-8-3Z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  )
}

const iconProps = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

function EyeIcon(): React.JSX.Element {
  return (
    <svg {...iconProps}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon(): React.JSX.Element {
  return (
    <svg {...iconProps}>
      <path d="M9.9 4.2A9.8 9.8 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-2.2 3M6.2 6.2A13.3 13.3 0 0 0 2 11s3.5 7 10 7a9.7 9.7 0 0 0 4.2-.9" />
      <path d="M3 3l18 18" />
    </svg>
  )
}

function CopyIcon(): React.JSX.Element {
  return (
    <svg {...iconProps}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  )
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg {...iconProps} stroke="var(--success)">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function EditIcon(): React.JSX.Element {
  return (
    <svg {...iconProps}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg {...iconProps}>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" />
    </svg>
  )
}

function LockIcon(): React.JSX.Element {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}
