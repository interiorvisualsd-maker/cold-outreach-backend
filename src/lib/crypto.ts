import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'

// AES-256-GCM encryption for SMTP/IMAP credentials.
//
// ─────────────────────────────────────────────────────────────────────────────
// ENCRYPTION_KEY — no dev fallback. Misconfigured deploys must fail loudly.
// If this changes after credentials are stored, those credentials become
// unreadable (decryption will throw) and must be re-entered.
// ─────────────────────────────────────────────────────────────────────────────
const ALGO = 'aes-256-gcm'
const IV_LEN = 12 // GCM standard IV length

let _cachedKey: Buffer | null = null
function getKey(): Buffer {
  if (_cachedKey) return _cachedKey
  const secret = process.env.ENCRYPTION_KEY
  if (!secret || secret.length < 16) {
    throw new Error(
      'FATAL: ENCRYPTION_KEY environment variable is missing or too short (min 16 chars). ' +
        'Generate one with `openssl rand -hex 32` and set it before starting the server. ' +
        'WARNING: if this key changes after credentials are stored, those credentials become unreadable.'
    )
  }
  // Derive a 32-byte key from arbitrary-length secret
  _cachedKey = crypto.createHash('sha256').update(secret).digest()
  return _cachedKey
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Format: iv:tag:ciphertext (all base64)
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':')
}

export function decrypt(payload: string): string {
  try {
    const [ivB64, tagB64, dataB64] = payload.split(':')
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid ciphertext format')
    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const data = Buffer.from(dataB64, 'base64')
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv)
    decipher.setAuthTag(tag)
    const dec = Buffer.concat([decipher.update(data), decipher.final()])
    return dec.toString('utf8')
  } catch {
    throw new Error('Failed to decrypt credential — ENCRYPTION_KEY may have changed')
  }
}

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, 10)
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash)
}
