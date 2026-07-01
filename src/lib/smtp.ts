import nodemailer from 'nodemailer'
import type { SmtpAccount } from '@prisma/client'
import { decrypt } from './crypto'

// Cache of SMTP transports keyed by account ID — recreated if older than 10 min
interface CachedTransport {
  transporter: nodemailer.Transporter
  createdAt: number
}
const transportCache = new Map<string, CachedTransport>()
const CACHE_TTL = 10 * 60 * 1000

export function getTransporter(account: SmtpAccount): nodemailer.Transporter {
  const cached = transportCache.get(account.id)
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
    return cached.transporter
  }
  const password = decrypt(account.smtpPassEnc)
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    auth: {
      user: account.smtpUser,
      pass: password,
    },
    // Soft fail on first connection errors so we can log + auto-pause
    connectionTimeout: 8000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  })
  transportCache.set(account.id, { transporter, createdAt: Date.now() })
  return transporter
}

export function clearTransportCache(accountId?: string) {
  if (accountId) transportCache.delete(accountId)
  else transportCache.clear()
}

export interface SendMailOptions {
  to: string
  subject: string
  text: string
  html?: string
  replyTo?: string
  fromName?: string
  fromEmail?: string
  messageId?: string
  inReplyTo?: string
  references?: string
  headers?: Record<string, string>
}

export async function sendMail(account: SmtpAccount, opts: SendMailOptions): Promise<{ messageId: string }> {
  const transporter = getTransporter(account)
  const from = `"${opts.fromName || account.fromName}" <${opts.fromEmail || account.emailAddress}>`
  const info = await transporter.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    replyTo: opts.replyTo || account.emailAddress,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
    messageId: opts.messageId,
    headers: opts.headers,
  })
  return { messageId: info.messageId }
}

// Verify SMTP credentials (used in account setup)
export async function verifySmtp(account: SmtpAccount): Promise<{ ok: boolean; error?: string }> {
  try {
    const transporter = getTransporter(account)
    await transporter.verify()
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'SMTP verification failed' }
  }
}
