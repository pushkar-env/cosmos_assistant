import { safeStorage } from 'electron'

const PREFIX = 'enc:'

/**
 * At-rest encryption helpers backed by Electron safeStorage (DPAPI on
 * Windows). Values are stored as "enc:<base64>"; plaintext values pass
 * through untouched, which gives free migration: anything read as
 * plaintext is re-encrypted the next time it is persisted.
 */
export function encryptText(value: string): string {
  if (!value || value.startsWith(PREFIX)) return value
  try {
    if (!safeStorage.isEncryptionAvailable()) return value
    return PREFIX + safeStorage.encryptString(value).toString('base64')
  } catch {
    return value
  }
}

export function decryptText(value: string): string {
  return decryptOrNull(value) ?? ''
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/**
 * Decrypts a stored value. Returns the plaintext, or `null` when an
 * `enc:` blob cannot be decrypted (wrong profile / rotated key /
 * corruption). Callers MUST treat null as "unreadable, preserve the
 * ciphertext" — never as an empty value to save over.
 */
export function decryptOrNull(value: string): string | null {
  if (!isEncrypted(value)) return value // '' and plaintext pass through
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'))
  } catch {
    return null
  }
}
