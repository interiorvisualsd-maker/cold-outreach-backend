import nodemailer from 'nodemailer'
import type { SmtpAccount } from '@prisma/client'
import { decrypt } from './crypto'
import dns from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'

// Cache of SMTP transports keyed by account ID
interface CachedTransport {
  transporter: nodemailer.Transporter
  createdAt: number
}
const transportCache = new Map<string, CachedTransport>()
const CACHE_TTL = 10 * 60 * 1000

// Force IPv4 for all DNS resolution
dns.setDefaultResultOrder('ipv4first')

// Resolve hostname to IPv4 address using dns.lookup (respects /etc/hosts)
async function resolveIPv4(hostname: string): Promise<string> {
  try {
    const result = await dnsLookup(hostname, { family: 4, all: false })
    return result.address
  } catch {
    // If lookup fails, return the hostname as-is (fallback)
    return hostname
  }
}

export async function getTransporter(account: SmtpAccount): Promise<nodemailer.Transporter> {
  const cached = transportCache.get(account.id)
  if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
    return cached.transporter
  }
  const password = decrypt(account.smtpPassEnc)
  
  // Resolve to IPv4 address — this bypasses IPv6/Cloudflare issues
  const smtpIp = await resolveIPv4(account.smtpHost)
  console.log(`[smtp] Resolved ${account.smtpHost} → ${smtpIp}`)
  
  const transporter = nodemailer.createTransport({
    host: smtpIp, // Use IP directly, not hostname
    port: account.smtpPort,
    secure: account.smtpSecure,
    auth: {
      user: account.smtpUser,
      pass: password,
    },
    family: 4,
    connectionTimeout: 8000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    tls: {
      servername: account.smtpHost, // Use original hostname for TLS cert
      rejectUnauthorized: false,
    },
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
  const transporter = await getTransporter(account)
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

export async function verifySmtp(account: SmtpAccount): Promise<{ ok: boolean; error?: string }> {
  try {
    const transporter = await getTransporter(account)
    await transporter.verify()
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'SMTP verification failed' }
  }
}
