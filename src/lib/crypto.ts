import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'

// AES-256-GCM encryption for SMTP/IMAP credentials
const ALGO = 'aes-256-gcm'
const IV_LEN = 12 // GCM standard IV length

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY
  if (!secret) {
    // Dev fallback — MUST set ENCRYPTION_KEY in production
    const fallback = 'lead-dispatcher-dev-key-change-me-32b!'
    return crypto.createHash('sha256').update(fallback).digest()
  }
  // Derive a 32-byte key from arbitrary-length secret
  return crypto.createHash('sha256').update(secret).digest()
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
