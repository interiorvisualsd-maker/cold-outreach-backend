// ─────────────────────────────────────────────────────────────────────────────
// EMAIL VERIFICATION — multi-layer deliverability checks (10 layers)
// ─────────────────────────────────────────────────────────────────────────────
//
// Layers (fast → slow):
//   1.  Syntax (RFC 5322 regex)                       — instant
//   2.  Domain (DNS A/AAAA records exist)             — ~50-200ms
//   3.  MX record (domain accepts mail)               — ~50-200ms
//   4.  SMTP mailbox verification (RCPT TO)           — 500ms-5s
//   5.  Disposable / temp email domain                — instant
//   6.  Role-based account (info@, sales@, etc.)      — instant
//   7.  Free email provider (gmail, yahoo, etc.)      — instant
//   8.  Catch-all detection (random UUID RCPT)        — adds 1-3s
//   9.  Typo detection (gnail.com → gmail.com)        — instant
//   10. Deliverability score (composite 0-100)        — computed
//
// Two top-level entrypoints:
//   quickVerify(email)    → layers 1, 2, 3, 5, 6, 7, 9  (safe to run on import)
//   deepVerify(email)     → quickVerify + layers 4, 8     (slow, on-demand)
//
// Result shape (VerificationResult) is shared by both, plus deepVerify adds
// smtp + catchAll fields. The Lead.verificationResults JSON column stores
// the full result; Lead.verificationStatus stores PENDING/VERIFYING/VERIFIED/RISKY/BAD.

import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import net from 'node:net'

// Force IPv4-first DNS resolution (avoids Cloudflare IPv6 issues for SMTP)
dns.setDefaultResultOrder('ipv4first')

// ─── Layer 1: Syntax (RFC 5322-ish, well-tested) ───
// Pragmatic RFC 5322 regex. Permits dots, plus-tags, hyphens, etc. Rejects
// the obvious junk (no spaces, must have @ and a dotted domain).
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STRICT_EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/

export function checkFormat(email: string): { valid: boolean; reason?: string } {
  if (!email || typeof email !== 'string') return { valid: false, reason: 'empty' }
  const e = email.trim().toLowerCase()
  if (!EMAIL_REGEX.test(e)) return { valid: false, reason: 'invalid_format' }
  if (e.length > 254) return { valid: false, reason: 'too_long' }
  const [local, domain] = e.split('@')
  if (!local || local.length > 64) return { valid: false, reason: 'local_part_too_long' }
  if (!domain || domain.length > 253) return { valid: false, reason: 'domain_too_long' }
  if (!STRICT_EMAIL_REGEX.test(e)) return { valid: false, reason: 'invalid_characters' }
  // Reject consecutive dots in local part
  if (/\.\./.test(local)) return { valid: false, reason: 'consecutive_dots' }
  return { valid: true }
}

// ─── Layer 2: Domain (A/AAAA records) ───
// Cache DNS lookups for 1 hour to avoid hammering resolvers.
const dnsCache = new Map<string, { expires: number; value: any }>()
const DNS_CACHE_TTL = 60 * 60 * 1000

export async function checkDomainA(domain: string): Promise<{ ok: boolean; reason?: string }> {
  const now = Date.now()
  const cached = dnsCache.get('A:' + domain)
  if (cached && cached.expires > now) return cached.value
  let value: { ok: boolean; reason?: string }
  try {
    const [a4, a6] = await Promise.allSettled([
      dnsPromises.resolve4(domain),
      dnsPromises.resolve6(domain),
    ])
    const has4 = a4.status === 'fulfilled' && a4.value.length > 0
    const has6 = a6.status === 'fulfilled' && a6.value.length > 0
    value = has4 || has6 ? { ok: true } : { ok: false, reason: 'no_a_records' }
  } catch {
    value = { ok: false, reason: 'dns_lookup_failed' }
  }
  dnsCache.set('A:' + domain, { expires: now + DNS_CACHE_TTL, value })
  return value
}

// ─── Layer 3: MX record ───
export async function getMxRecords(domain: string): Promise<string[]> {
  const now = Date.now()
  const cached = dnsCache.get('MX:' + domain)
  if (cached && cached.expires > now) return cached.value
  let value: string[]
  try {
    const addresses = await dnsPromises.resolveMx(domain)
    if (!addresses || addresses.length === 0) value = []
    else
      value = addresses
        .sort((a, b) => a.priority - b.priority)
        .map((a) => a.exchange.toLowerCase())
  } catch {
    value = []
  }
  dnsCache.set('MX:' + domain, { expires: now + DNS_CACHE_TTL, value })
  return value
}

export async function checkMx(domain: string): Promise<{ valid: boolean; hosts: string[] }> {
  const hosts = await getMxRecords(domain)
  return { valid: hosts.length > 0, hosts }
}

// ─── Layer 4: SMTP mailbox verification (RCPT TO) ───
// Connects to the recipient's MX server, issues EHLO/MAIL FROM/RCPT TO,
// and checks the response code. 250 = mailbox exists; 550 = doesn't exist;
// 252 = cannot verify (risky); 4xx = temporary (risky, retry).
//
// IMPORTANT caveats:
//   - Gmail/Outlook often return 250 for unknown addresses (anti-harvesting).
//     So a 250 is not 100% proof of existence — but a 550 IS proof of absence.
//   - Some providers greylist or rate-limit. We retry once with a short delay.
//   - This is SLOW (500ms-5s per check). Only run on-demand.
//
// MAIL FROM: if VERIFICATION_DOMAIN env var is set, use verify@<that domain>.
// Otherwise use empty MAIL FROM (<>), which is RFC-compliant for bounces and
// reduces the chance of being flagged as a spammer.
export interface SmtpVerifyResult {
  status: 'valid' | 'invalid' | 'unknown' | 'catch-all'
  code?: number
  response?: string
  details?: string
}

function getMailFromAddress(): string {
  const v = process.env.VERIFICATION_DOMAIN
  if (v && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return `verify@${v.toLowerCase()}`
  return '' // empty MAIL FROM (<>)
}

function getHeloDomain(): string {
  const v = process.env.VERIFICATION_DOMAIN
  if (v && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return v.toLowerCase()
  return 'verify.local'
}

export async function verifyMailboxSmtp(
  email: string,
  mxHosts: string[],
  timeoutMs = 10000
): Promise<SmtpVerifyResult> {
  if (mxHosts.length === 0) {
    return { status: 'unknown', details: 'No MX records for domain' }
  }
  const target = email.toLowerCase()
  const mailFrom = getMailFromAddress()

  // Try the top 2 MX hosts (in priority order) in case the first is down
  for (const mxHost of mxHosts.slice(0, 2)) {
    try {
      const result = await trySmtpRcpt(mxHost, target, mailFrom, timeoutMs)
      if (result.status !== 'unknown') return result
    } catch {
      continue
    }
  }
  return { status: 'unknown', details: 'All MX hosts unreachable or timed out' }
}

async function trySmtpRcpt(
  mxHost: string,
  target: string,
  mailFrom: string,
  timeoutMs: number
): Promise<SmtpVerifyResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let buffer = ''
    let step: 'connect' | 'helo' | 'mail' | 'rcpt' | 'done' = 'connect'
    let smtpResponse = ''
    let lastCode: number | undefined
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ status: 'unknown', code: lastCode, response: smtpResponse, details: 'Timeout' })
    }, timeoutMs)

    socket.connect(25, mxHost)
    socket.setEncoding('utf-8')
    socket.setTimeout(timeoutMs)

    const send = (cmd: string) => socket.write(cmd + '\r\n')

    const finish = (r: SmtpVerifyResult) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(r)
    }

    socket.on('data', (data) => {
      buffer += data.toString()
      // SMTP multiline responses end with `<code> <text>\r\n` (space after code).
      // Multiline continuations use `<code>-<text>\r\n` (hyphen).
      const lastLineMatch = buffer.match(/\r?\n(\d{3})[ ].*\r?\n$/)
      if (!lastLineMatch) return
      const code = parseInt(lastLineMatch[1], 10)
      lastCode = code
      smtpResponse = buffer.split(/\r?\n/).filter(Boolean).slice(-1)[0] || ''
      buffer = ''

      if (step === 'connect') {
        if (code === 220) {
          step = 'helo'
          send(`EHLO ${getHeloDomain()}`)
        } else {
          finish({ status: 'unknown', code, response: smtpResponse, details: `Unexpected greeting: ${code}` })
        }
      } else if (step === 'helo') {
        if (code >= 200 && code < 300) {
          step = 'mail'
          // Empty MAIL FROM (RFC 5321 § 4.5.5) when no verification domain is set
          send(mailFrom ? `MAIL FROM:<${mailFrom}>` : 'MAIL FROM:<>')
        } else {
          finish({ status: 'unknown', code, response: smtpResponse, details: `EHLO rejected: ${code}` })
        }
      } else if (step === 'mail') {
        if (code >= 200 && code < 300) {
          step = 'rcpt'
          send(`RCPT TO:<${target}>`)
        } else {
          finish({ status: 'unknown', code, response: smtpResponse, details: `MAIL FROM rejected: ${code}` })
        }
      } else if (step === 'rcpt') {
        if (code >= 250 && code < 260) {
          // 250 = mailbox exists (but could be catch-all — see Layer 8)
          finish({ status: 'valid', code, response: smtpResponse, details: 'RCPT TO accepted' })
        } else if (code === 251) {
          finish({ status: 'valid', code, response: smtpResponse, details: 'User not local, will forward' })
        } else if (code === 252) {
          // 252 = cannot verify but will accept — treat as unknown (risky)
          finish({ status: 'unknown', code, response: smtpResponse, details: 'Server cannot verify' })
        } else if (code >= 550 && code < 560) {
          finish({ status: 'invalid', code, response: smtpResponse, details: 'Mailbox does not exist' })
        } else if (code >= 400 && code < 500) {
          finish({ status: 'unknown', code, response: smtpResponse, details: `Temporary failure: ${code}` })
        } else {
          finish({ status: 'unknown', code, response: smtpResponse, details: `Unexpected RCPT response: ${code}` })
        }
      }
    })

    socket.on('error', () => {
      clearTimeout(timer)
      resolve({ status: 'unknown', details: 'Connection error' })
    })
    socket.on('timeout', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ status: 'unknown', code: lastCode, response: smtpResponse, details: 'Socket timeout' })
    })
    socket.on('close', () => {
      if (step !== 'done') {
        clearTimeout(timer)
        resolve({ status: 'unknown', details: 'Connection closed early' })
      }
    })
  })
}

// ─── Layer 8: Catch-all detection ───
// After SMTP-checking the real address, also check a random UUID-style
// address at the same domain. If the server returns 250 for that too, the
// domain is catch-all → mark the real address as "risky".
export async function detectCatchAll(
  domain: string,
  mxHosts: string[]
): Promise<{ catchAll: boolean; details?: string }> {
  const probe = `zz-test-${Math.random().toString(36).slice(2, 10)}@${domain.toLowerCase()}`
  try {
    const r = await verifyMailboxSmtp(probe, mxHosts, 8000)
    if (r.status === 'valid') {
      // Server accepted a clearly-fake address → catch-all
      return { catchAll: true, details: 'Server accepts all addresses (catch-all)' }
    }
    return { catchAll: false }
  } catch {
    return { catchAll: false }
  }
}

// ─── Layer 5: Disposable / temp domains ───
// Sourced from https://github.com/disposable-email-domains/disposable-email-domains
// Keep this list updated periodically — new disposable providers appear weekly.
// (Truncated to ~250 of the most common to keep bundle size reasonable.)
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
  'armyspy.com', 'cuvox.de', 'dayrep.com', 'einrot.com', 'fleckens.hu',
  'gustr.com', 'jourrapide.com', 'teleworm.us', 'junk.com', 'spam.com',
  'trash.com', 'dump.com', 'fake.com', 'nonsense.com', 'nothing.com',
  'nobody.com', 'nowhere.com', 'example.com', 'example.org', 'example.net',
  'test.com', 'test.org', 'mailcatch.com', 'guerrillamail.net', 'spamgourmet.net',
  'mailnull.com', 'spambox.us', 'tempinbox.net', 'mytemp.email', 'tempemail.co',
  'incognitomail.com', 'incognitomail.net', 'mailme.gq', 'guerrillamail.biz',
  'guerrillamail.de', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com',
  'mohmal.com', 'mohmal.tech', 'smartradio.com', 'duam.net', 'mail-tech.com',
  'mailed.in', 'maildrop.ga', 'mail-disable.com', 'qpq.email',
  'boxformail.in', 'flemail.in', 'mcache.net', 'mailhazard.com',
  'mailhazard.us', 'mailhero.io', 'nemOz.al', 'vmani.com',
  'airbox.top', 'femailtor.com', 'twkhh.com', 'emailsu.net',
  'tmail.ws', 'mfsa.info', '001zs.com', 'mailbink.com',
])

export function isDisposable(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase())
}

// ─── Layer 6: Role-based addresses ───
const ROLE_PREFIXES = new Set([
  'info', 'sales', 'support', 'admin', 'administrator', 'webmaster',
  'postmaster', 'hostmaster', 'abuse', 'security', 'contact',
  'help', 'service', 'marketing', 'noreply', 'no-reply', 'donotreply',
  'office', 'team', 'hello', 'mail', 'email', 'inbox', 'feedback',
  'billing', 'accounting', 'jobs', 'careers', 'hr', 'legal',
  'it', 'dev', 'development', 'tech', 'api', 'root', 'system',
  'list', 'listserv', 'majordomo', 'owner', 'bounce', 'auto',
  'automated', 'bot', 'robot', 'daemon', 'mailer', 'newsletter',
  'news', 'announce', 'notification', 'alert', 'warning', 'enquiries',
])

export function isRoleBased(localPart: string): boolean {
  const local = localPart.toLowerCase().trim()
  if (ROLE_PREFIXES.has(local)) return true
  // Common patterns: info123, support-team, admin.
  const base = local.replace(/[\d._-]+.*$/, '').replace(/[._-]+$/, '')
  return ROLE_PREFIXES.has(base)
}

// ─── Layer 7: Free email provider ───
// These are valid but worth flagging in a B2B context (most B2B leads use
// company domains, not free providers).
const FREE_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com',
  'icloud.com', 'protonmail.com', 'proton.me', 'live.com', 'msn.com',
  'gmx.com', 'gmx.net', 'yandex.com', 'yandex.ru', 'mail.com',
  'zoho.com', 'fastmail.com', 'tutanota.com', 'tuta.io', 'me.com',
  'mac.com', 'facebook.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de',
  'yahoo.it', 'yahoo.es', 'yahoo.ca', 'yahoo.com.au', 'yahoo.co.in',
  'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'live.co.uk', 'live.fr',
  'outlook.co.uk', 'outlook.fr', 'outlook.de',
])

export function isFreeProvider(domain: string): boolean {
  return FREE_DOMAINS.has(domain.toLowerCase())
}

// ─── Layer 9: Typo detection ───
// Small mapping table of the most common typos. If detected, the address is
// flagged BAD with a suggested correction.
const TYPO_MAP: Record<string, string> = {
  'gnail.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gmaill.com': 'gmail.com',
  'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.cm': 'gmail.com',
  'gmail.om': 'gmail.com',
  'gmaiil.com': 'gmail.com',
  'gmail.net': 'gmail.com',
  'yahooo.com': 'yahoo.com',
  'yaho.com': 'yahoo.com',
  'yahoo.co': 'yahoo.com',
  'yahoo.cm': 'yahoo.com',
  'yhaoo.com': 'yahoo.com',
  'yahho.com': 'yahoo.com',
  'hotnail.com': 'hotmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'hotmal.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com',
  'hotmial.co.uk': 'hotmail.co.uk',
  'outlok.com': 'outlook.com',
  'outloook.com': 'outlook.com',
  'outlook.co': 'outlook.com',
  'iclod.com': 'icloud.com',
  'icould.com': 'icloud.com',
  'icloud.co': 'icloud.com',
  'protonmai.com': 'protonmail.com',
  'protonmal.com': 'protonmail.com',
  'aol.cm': 'aol.com',
  'aol.co': 'aol.com',
}

export function detectTypo(domain: string): { detected: boolean; suggestion?: string } {
  const d = domain.toLowerCase()
  if (TYPO_MAP[d]) return { detected: true, suggestion: TYPO_MAP[d] }
  return { detected: false }
}

// ─── Layer 10: Deliverability score ───
// Composite 0-100 score. Formula:
//   Start: 100
//   - Syntax bad           → 0 (hard fail)
//   - Disposable domain    → 0 (hard fail)
//   - Typo detected        → 0 (hard fail, with suggestion)
//   - No A/AAAA records    → 0 (hard fail)
//   - No MX records        → 0 (hard fail)
//   - SMTP 550 invalid     → 0 (hard fail)
//   - Catch-all detected   → -25 (server accepts everything)
//   - Role-based local     → -10 (B2B risk, not invalid)
//   - Free provider        → -5  (B2B context flag)
//   - SMTP unknown/temp    → -10 (greylisting, can't verify)
//   - SMTP valid           → +0  (already at 100 unless other deductions)
// Final score clamped to [0, 100]. 0 = BAD, 1-49 = RISKY, 50-100 = VERIFIED.
export function computeScore(input: {
  syntaxOk: boolean
  hasARecords: boolean
  hasMx: boolean
  smtp?: SmtpVerifyResult
  disposable: boolean
  role: boolean
  free: boolean
  catchAll: boolean
  typo: boolean
}): number {
  if (!input.syntaxOk) return 0
  if (input.disposable) return 0
  if (input.typo) return 0
  if (!input.hasARecords) return 0
  if (!input.hasMx) return 0
  if (input.smtp?.status === 'invalid') return 0
  let score = 100
  if (input.catchAll) score -= 25
  if (input.role) score -= 10
  if (input.free) score -= 5
  if (input.smtp?.status === 'unknown') score -= 10
  return Math.max(0, Math.min(100, score))
}

// ─── Result type ───
export interface VerificationResult {
  email: string
  // Top-level verdict the dispatcher cares about.
  status: 'VERIFIED' | 'RISKY' | 'BAD'
  score: number
  method: 'quick' | 'deep'
  verifiedAt: string
  // Per-layer details (stored on Lead.verificationResults)
  layers: {
    syntax: { ok: boolean; reason?: string }
    domain: { ok: boolean; reason?: string }
    mx: { ok: boolean; hosts: string[] }
    smtp?: { ok: boolean; status?: string; code?: number; response?: string; details?: string }
    disposable: boolean
    role: boolean
    free: boolean
    catchAll: boolean
    typo: { detected: boolean; suggestion?: string }
  }
  reason?: string
  // Back-compat fields for the legacy /api/extras/leads/verify endpoint
  valid: boolean
  warnings: string[]
  layer?: 'format' | 'disposable' | 'role' | 'mx' | 'ok'
  mxHosts?: string[]
  smtpStatus?: 'valid' | 'invalid' | 'unknown' | 'catch-all'
  smtpDetails?: string
}

// ─── Quick verify (layers 1, 2, 3, 5, 6, 7, 9) ───
export async function quickVerify(email: string): Promise<VerificationResult> {
  const e = (email || '').trim().toLowerCase()
  const verifiedAt = new Date().toISOString()
  const emptyLayers: VerificationResult['layers'] = {
    syntax: { ok: false },
    domain: { ok: false },
    mx: { ok: false, hosts: [] },
    disposable: false,
    role: false,
    free: false,
    catchAll: false,
    typo: { detected: false },
  }

  const fmt = checkFormat(e)
  if (!fmt.valid) {
    return {
      email: e,
      status: 'BAD',
      score: 0,
      method: 'quick',
      verifiedAt,
      layers: { ...emptyLayers, syntax: { ok: false, reason: fmt.reason } },
      reason: fmt.reason,
      valid: false,
      warnings: [],
      layer: 'format',
    }
  }

  const [local, domain] = e.split('@')
  const warnings: string[] = []

  const disposable = isDisposable(domain)
  if (disposable) {
    return {
      email: e,
      status: 'BAD',
      score: 0,
      method: 'quick',
      verifiedAt,
      layers: { ...emptyLayers, syntax: { ok: true }, disposable: true },
      reason: 'disposable_domain',
      valid: false,
      warnings: [],
      layer: 'disposable',
    }
  }

  const typo = detectTypo(domain)
  if (typo.detected) {
    return {
      email: e,
      status: 'BAD',
      score: 0,
      method: 'quick',
      verifiedAt,
      layers: { ...emptyLayers, syntax: { ok: true }, typo: { detected: true, suggestion: typo.suggestion } },
      reason: `typo_detected_suggest_${typo.suggestion}`,
      valid: false,
      warnings: [`Typo? Did you mean ${typo.suggestion}?`],
      layer: 'format',
    }
  }

  const role = isRoleBased(local)
  const free = isFreeProvider(domain)
  if (role) warnings.push('role_based')
  if (free) warnings.push('free_provider')

  const [domainCheck, mxCheck] = await Promise.all([
    checkDomainA(domain),
    checkMx(domain),
  ])
  if (!domainCheck.ok) {
    return {
      email: e,
      status: 'BAD',
      score: 0,
      method: 'quick',
      verifiedAt,
      layers: {
        ...emptyLayers,
        syntax: { ok: true },
        domain: { ok: false, reason: domainCheck.reason },
        role,
        free,
        typo: { detected: false },
      },
      reason: 'no_a_records',
      valid: false,
      warnings,
      layer: 'mx',
    }
  }
  if (!mxCheck.valid) {
    return {
      email: e,
      status: 'BAD',
      score: 0,
      method: 'quick',
      verifiedAt,
      layers: {
        ...emptyLayers,
        syntax: { ok: true },
        domain: { ok: true },
        mx: { ok: false, hosts: [] },
        role,
        free,
        typo: { detected: false },
      },
      reason: 'no_mx_records',
      valid: false,
      warnings,
      layer: 'mx',
    }
  }

  // Compute score
  const score = computeScore({
    syntaxOk: true,
    hasARecords: true,
    hasMx: true,
    disposable: false,
    role,
    free,
    catchAll: false,
    typo: false,
  })
  const status: 'VERIFIED' | 'RISKY' = score >= 50 ? 'VERIFIED' : 'RISKY'

  return {
    email: e,
    status,
    score,
    method: 'quick',
    verifiedAt,
    layers: {
      syntax: { ok: true },
      domain: { ok: true },
      mx: { ok: true, hosts: mxCheck.hosts },
      disposable: false,
      role,
      free,
      catchAll: false,
      typo: { detected: false },
    },
    valid: true,
    warnings,
    layer: 'ok',
    mxHosts: mxCheck.hosts,
  }
}

// ─── Deep verify (all 10 layers) ───
export async function deepVerify(email: string): Promise<VerificationResult> {
  const quick = await quickVerify(email)
  if (quick.status === 'BAD') return quick // hard fail — no point probing SMTP

  const [, domain] = quick.email.split('@')
  const mxHosts = quick.mxHosts || []

  // Layer 4: SMTP mailbox verification
  const smtp = await verifyMailboxSmtp(quick.email, mxHosts, 10000)

  // Layer 8: catch-all detection (only if SMTP gave us a usable signal)
  let catchAll = false
  if (smtp.status === 'valid' || smtp.status === 'invalid') {
    const ca = await detectCatchAll(domain, mxHosts)
    catchAll = ca.catchAll
  }

  const score = computeScore({
    syntaxOk: true,
    hasARecords: true,
    hasMx: true,
    smtp,
    disposable: false,
    role: quick.layers.role,
    free: quick.layers.free,
    catchAll,
    typo: false,
  })

  let status: 'VERIFIED' | 'RISKY' | 'BAD'
  let reason: string | undefined
  if (smtp.status === 'invalid') {
    // SMTP 550 = mailbox definitively doesn't exist → BAD
    status = 'BAD'
    reason = 'mailbox_does_not_exist'
  } else if (catchAll) {
    // Catch-all domain accepts everything → can't verify mailbox → RISKY
    status = 'RISKY'
    reason = 'catch_all_domain'
  } else if (score >= 50) {
    // ─── Key fix: SMTP 'unknown' does NOT block VERIFIED ───
    // On cloud hosts (Render, AWS, GCP, etc.) outbound port 25 is blocked,
    // so SMTP mailbox verification often returns 'unknown' (can't connect).
    // That's a NETWORK limitation, not a signal about the email's validity.
    //
    // If the email passed all 9 other layers (syntax, domain, MX, disposable,
    // role, free, typo, score ≥ 50), we mark it VERIFIED. The SMTP layer
    // becomes a "bonus" check that provides extra confidence when the network
    // allows it, not a hard requirement.
    //
    // The lead's verificationResults still record smtp.status='unknown' so the
    // user can see SMTP wasn't checked. And if SMTP returns 'invalid' (550),
    // we already caught that above and marked BAD.
    status = 'VERIFIED'
    if (smtp.status === 'unknown') {
      // Note: still VERIFIED, but flag that SMTP couldn't be verified
      reason = 'verified_smtp_unchecked'
    }
  } else {
    // Score < 50 (role-based -10, free -5, etc. stacked) → RISKY
    status = 'RISKY'
    reason = 'low_score'
  }

  return {
    ...quick,
    status,
    score,
    method: 'deep',
    verifiedAt: new Date().toISOString(),
    layers: {
      ...quick.layers,
      smtp: {
        ok: smtp.status === 'valid',
        status: smtp.status,
        code: smtp.code,
        response: smtp.response,
        details: smtp.details,
      },
      catchAll,
    },
    reason: reason || quick.reason,
    valid: status !== 'BAD',
    smtpStatus: smtp.status,
    smtpDetails: smtp.details,
    warnings: quick.warnings,
  }
}

// ─── Legacy compat ───
// The old /api/extras/leads/verify endpoint (now superseded by
// routes/verify.ts) imported quickVerify/deepVerify directly — both are
// already exported above with their original names. No shim needed.
