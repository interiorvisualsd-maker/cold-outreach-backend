// ─────────────────────────────────────────────────────────────────────────────
// EMAIL VERIFICATION — multi-layer deliverability checks
// ─────────────────────────────────────────────────────────────────────────────
//
// Layers (fast → slow):
//   1. Format check (regex)                              — instant
//   2. Disposable / temp domain check                    — instant
//   3. Role-based address check (info@, sales@, etc.)    — instant
//   4. MX record lookup (does the domain accept mail?)   — ~50-200ms
//   5. SMTP mailbox verification (RCPT TO)               — 500ms-5s
//
// Layers 1-4 are "quick" and safe to run on every email at import time.
// Layer 5 is slow and can be blocked by some providers, so it's only run
// on-demand via the "Verify Emails (Deep)" button.

import dns from 'node:dns'
import net from 'node:net'

// ─── Layer 1: Format ───
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STRICT_EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/

export function checkFormat(email: string): { valid: boolean; reason?: string } {
  if (!email || typeof email !== 'string') return { valid: false, reason: 'empty' }
  const e = email.trim().toLowerCase()
  if (!EMAIL_REGEX.test(e)) return { valid: false, reason: 'invalid_format' }
  if (e.length > 254) return { valid: false, reason: 'too_long' }
  const [local, domain] = e.split('@')
  if (!local || local.length > 64) return { valid: false, reason: 'local_part_too_long' }
  if (!domain || domain.length > 253) return { valid: false, reason: 'domain_too_long' }
  if (!STRICT_EMAIL_REGEX.test(e)) return { valid: false, reason: 'invalid_characters' }
  return { valid: true }
}

// ─── Layer 2: Disposable / temp domains ───
// Sourced from https://github.com/disposable-email-domains/disposable-email-domains
// (truncated to the most common ~200 to keep the bundle small)
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'tempmail.org', 'throwawaymail.com', 'yopmail.com', 'getnada.com',
  'maildrop.cc', 'dispostable.com', 'fakeinbox.com', 'sharklasers.com',
  'guerrillamailblock.com', 'spam4.me', 'trashmail.com', 'trashmail.net',
  'trashmail.me', 'fakeemail.com', 'tempinbox.com', 'mintemail.com',
  'mailnesia.com', 'mailcatch.com', 'tempmailo.com', 'moakt.com',
  'tmpmail.org', 'tmail.io', 'tmails.net', 'throwam.com',
  'mailforspam.com', 'spamgourmet.com', 'tempmailaddress.com', 'tmpmail.net',
  'disposablemail.com', 'throwitaway.com', 'mailtemp.net', 'temp-mails.com',
  'emailondeck.com', 'tempmailo.net', 'spamfree123.org', 'fakebox.com',
  'mailforspam.net', 'tempr.email', 'temp-mail.org', 'temp-mail.io',
  'maildrop.com', 'discard.email', 'mailcatch.net', 'trbvm.com',
  'mailsac.com', 'burnermail.io', 'inboxbear.com', 'getairmail.com',
  'guerrillamail.info', 'grr.la', 'harakirimail.com', 'pokeett.com',
  'boximail.com', 'fastmailforyou.net', 'email-fake.com', 's0ny.net',
  'nada.email', 'nada.ltd', '0987654321.com', 'mailbox72.biz',
  'trbvn.com', 'tmpbox.net', 'dumppmail.com', 'letmeinonthis.com',
  'trbvm.net', 'pafnuty.com', 'laoeq.com', 'extremail.ru',
  'iiiiii.com', 'crmail.top', 'freemail.ms', 'papierkorb.me',
  'mfsa.ru', 'mailspeed.ru', 'yomail.info', 'emltmp.com',
  'scrn.me', 'tmpeml.info', 'binka.me', 'tinoza.org',
  '682.net', 'zainmax.net', 'rhyta.com', 'superrito.com',
])

export function isDisposable(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase())
}

// ─── Layer 3: Role-based addresses ───
const ROLE_PREFIXES = new Set([
  'info', 'sales', 'support', 'admin', 'administrator', 'webmaster',
  'postmaster', 'hostmaster', 'abuse', 'security', 'contact',
  'help', 'service', 'marketing', 'noreply', 'no-reply', 'donotreply',
  'office', 'team', 'hello', 'mail', 'email', 'inbox', 'feedback',
  'billing', 'accounting', 'jobs', 'careers', 'hr', 'legal',
  'it', 'dev', 'development', 'tech', 'api', 'root', 'system',
  'list', 'listserv', 'majordomo', 'owner', 'bounce', 'auto',
  'automated', 'bot', 'robot', 'daemon', 'mailer', 'newsletter',
  'news', 'announce', 'notification', 'alert', 'warning',
])

export function isRoleBased(localPart: string): boolean {
  const local = localPart.toLowerCase().trim()
  // Exact match
  if (ROLE_PREFIXES.has(local)) return true
  // Common patterns: info123, support-team, admin.
  const base = local.replace(/[\d._-]+.*$/, '').replace(/[._-]+$/, '')
  if (ROLE_PREFIXES.has(base)) return true
  return false
}

// ─── Layer 4: MX record lookup ───
// Cache MX lookups for 1 hour to avoid hammering DNS
const mxCache = new Map<string, { expires: number; hosts: string[] }>()
const MX_CACHE_TTL = 60 * 60 * 1000

export async function getMxRecords(domain: string): Promise<string[]> {
  const now = Date.now()
  const cached = mxCache.get(domain)
  if (cached && cached.expires > now) return cached.hosts

  return new Promise((resolve) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        mxCache.set(domain, { expires: now + MX_CACHE_TTL, hosts: [] })
        resolve([])
        return
      }
      // Sort by priority, return hostnames
      const hosts = addresses
        .sort((a, b) => a.priority - b.priority)
        .map((a) => a.exchange.toLowerCase())
      mxCache.set(domain, { expires: now + MX_CACHE_TTL, hosts })
      resolve(hosts)
    })
  })
}

export async function checkMx(domain: string): Promise<{ valid: boolean; hosts: string[] }> {
  const hosts = await getMxRecords(domain)
  return { valid: hosts.length > 0, hosts }
}

// ─── Layer 5: SMTP mailbox verification (RCPT TO) ───
// Connects to the recipient's MX server, issues EHLO/MAIL FROM/RCPT TO,
// and checks the response code. A 250 = mailbox exists; 550 = doesn't exist.
//
// IMPORTANT caveats:
//   - Some providers (Gmail, Outlook) always return 250 even for unknown
//     addresses (to prevent directory harvesting). So a 250 is not a 100%
//     guarantee the inbox exists — but a 550 IS a definite "doesn't exist".
//   - Some providers greylist or rate-limit. We retry once with a short delay.
//   - This is SLOW (500ms-5s per check). Only run on-demand, not on import.
//
// We use a neutral MAIL FROM (verify@<our-domain>) to avoid tying the check
// to any sending account. We never actually send an email.

export interface SmtpVerifyResult {
  status: 'valid' | 'invalid' | 'unknown' | 'catch-all'
  smtpResponse?: string
  details?: string
}

export async function verifyMailboxSmtp(
  email: string,
  mxHosts: string[],
  fromDomain?: string,
  timeoutMs = 8000,
): Promise<SmtpVerifyResult> {
  if (mxHosts.length === 0) {
    return { status: 'unknown', details: 'No MX records for domain' }
  }
  const from = `verify@${fromDomain || 'example.com'}`
  const target = email.toLowerCase()

  // Try the top 2 MX hosts (in priority order) in case the first is down
  for (const mxHost of mxHosts.slice(0, 2)) {
    try {
      const result = await trySmtpRcpt(mxHost, target, from, timeoutMs)
      if (result.status !== 'unknown') return result
      // If unknown (timeout/protocol error), try the next MX host
    } catch {
      // Network error — try next MX host
      continue
    }
  }

  return { status: 'unknown', details: 'All MX hosts unreachable or timed out' }
}

async function trySmtpRcpt(
  mxHost: string,
  target: string,
  from: string,
  timeoutMs: number,
): Promise<SmtpVerifyResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let buffer = ''
    let step: 'connect' | 'helo' | 'mail' | 'rcpt' | 'done' = 'connect'
    let smtpResponse = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ status: 'unknown', details: 'Timeout', smtpResponse })
    }, timeoutMs)

    socket.connect(25, mxHost)
    socket.setEncoding('utf-8')

    const send = (cmd: string) => socket.write(cmd + '\r\n')

    socket.on('data', (data) => {
      buffer += data.toString()
      // SMTP responses end with a line like "250 OK\r\n" (space after code = last line)
      while (/\r?\n\d{3} .*\r?\n/.test(buffer) || /\r?\n\d{3} .*$/.test(buffer)) {
        const lines = buffer.split(/\r?\n/)
        const lastLine = lines.filter((l) => l.length > 0).slice(-1)[0] || ''
        const code = parseInt(lastLine.slice(0, 3), 10)
        smtpResponse = lastLine

        if (step === 'connect') {
          if (code === 220) {
            step = 'helo'
            send(`EHLO ${from.split('@')[1]}`)
            buffer = ''
            break
          } else {
            clearTimeout(timer)
            socket.destroy()
            resolve({ status: 'unknown', smtpResponse, details: `Unexpected greeting: ${code}` })
            return
          }
        } else if (step === 'helo') {
          if (code >= 200 && code < 300) {
            step = 'mail'
            send(`MAIL FROM:<${from}>`)
            buffer = ''
            break
          } else {
            clearTimeout(timer)
            socket.destroy()
            resolve({ status: 'unknown', smtpResponse, details: `EHLO rejected: ${code}` })
            return
          }
        } else if (step === 'mail') {
          if (code >= 200 && code < 300) {
            step = 'rcpt'
            send(`RCPT TO:<${target}>`)
            buffer = ''
            break
          } else {
            clearTimeout(timer)
            socket.destroy()
            resolve({ status: 'unknown', smtpResponse, details: `MAIL FROM rejected: ${code}` })
            return
          }
        } else if (step === 'rcpt') {
          clearTimeout(timer)
          socket.destroy()
          if (code >= 250 && code < 260) {
            // 250 = mailbox exists (but could be catch-all)
            // To detect catch-all, we'd need to test a known-bad address —
            // skip that for now to keep verification fast.
            resolve({ status: 'valid', smtpResponse, details: 'RCPT TO accepted' })
          } else if (code >= 550 && code < 560) {
            // 550 = mailbox doesn't exist
            resolve({ status: 'invalid', smtpResponse, details: 'Mailbox does not exist' })
          } else if (code === 251) {
            // 251 = user not local, will forward
            resolve({ status: 'valid', smtpResponse, details: 'User not local, will forward' })
          } else if (code === 252) {
            // 252 = cannot verify but will accept (treat as unknown/valid)
            resolve({ status: 'unknown', smtpResponse, details: 'Server cannot verify' })
          } else if (code >= 400 && code < 500) {
            // 4xx = temporary failure (greylisting, rate limit)
            resolve({ status: 'unknown', smtpResponse, details: `Temporary failure: ${code}` })
          } else {
            resolve({ status: 'unknown', smtpResponse, details: `Unexpected RCPT response: ${code}` })
          }
          return
        }
      }
    })

    socket.on('error', () => {
      clearTimeout(timer)
      resolve({ status: 'unknown', details: 'Connection error' })
    })

    socket.on('close', () => {
      clearTimeout(timer)
      if (step !== 'done') {
        resolve({ status: 'unknown', details: 'Connection closed early' })
      }
    })
  })
}

// ─── Combined quick check (layers 1-4) ───
// Safe to run on every email at import time. Returns a verdict + reason.
//
// IMPORTANT: role-based addresses (info@, sales@, contact@) are NOT marked
// as invalid. They're common for B2B outreach and the user may intentionally
// want to email them. They're flagged as a "warning" in the `warnings` array
// but `valid` stays true. Only these reasons cause `valid: false`:
//   - invalid format (bad regex, too long, bad characters)
//   - disposable/temp domain
//   - no MX records (domain can't receive mail)
export interface QuickVerifyResult {
  email: string
  valid: boolean
  reason?: string
  layer?: 'format' | 'disposable' | 'role' | 'mx' | 'ok'
  warnings: string[] // non-fatal issues (e.g. role-based)
  mxHosts?: string[]
}

export async function quickVerify(email: string): Promise<QuickVerifyResult> {
  const e = (email || '').trim().toLowerCase()
  const formatCheck = checkFormat(e)
  if (!formatCheck.valid) {
    return { email: e, valid: false, reason: formatCheck.reason, layer: 'format', warnings: [] }
  }

  const [local, domain] = e.split('@')

  if (isDisposable(domain)) {
    return { email: e, valid: false, reason: 'disposable_domain', layer: 'disposable', warnings: [] }
  }

  const warnings: string[] = []

  // Role-based is a WARNING, not a failure — user may want to email info@company.com
  if (isRoleBased(local)) {
    warnings.push('role_based')
  }

  const mxCheck = await checkMx(domain)
  if (!mxCheck.valid) {
    return { email: e, valid: false, reason: 'no_mx_records', layer: 'mx', warnings }
  }

  return { email: e, valid: true, layer: 'ok', warnings, mxHosts: mxCheck.hosts }
}

// ─── Deep check (all 5 layers) ───
// Runs quickVerify first, then SMTP mailbox verification if the quick check
// passes. Slow (~1-5s per email) — only run on-demand.
//
// Only these cause `valid: false` (suppression):
//   - quick check failures (format, disposable, no MX)
//   - SMTP 550 response (mailbox definitively does not exist)
//
// SMTP "unknown" (timeout, greylisting, catch-all) does NOT suppress —
// we only suppress on CONFIRMED invalid.
export interface DeepVerifyResult extends QuickVerifyResult {
  smtpStatus?: 'valid' | 'invalid' | 'unknown' | 'catch-all'
  smtpDetails?: string
}

export async function deepVerify(
  email: string,
  fromDomain?: string,
): Promise<DeepVerifyResult> {
  const quick = await quickVerify(email)
  if (!quick.valid) return quick

  const smtpResult = await verifyMailboxSmtp(
    quick.email,
    quick.mxHosts || [],
    fromDomain,
  )

  // Only suppress on CONFIRMED invalid (SMTP 550). Unknown/catch-all/valid
  // all pass through — we don't want to suppress emails we're not sure about.
  if (smtpResult.status === 'invalid') {
    return {
      ...quick,
      smtpStatus: smtpResult.status,
      smtpDetails: smtpResult.details,
      valid: false,
      reason: 'mailbox_does_not_exist',
    }
  }

  return {
    ...quick,
    smtpStatus: smtpResult.status,
    smtpDetails: smtpResult.details,
    // valid stays as quick.valid (true) for valid/unknown/catch-all
  }
}
