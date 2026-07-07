// ─────────────────────────────────────────────────────────────────────────────
// Multi-Provider Email Verification System
// ─────────────────────────────────────────────────────────────────────────────
//
// ARCHITECTURE
// ───────────
// SMTP mailbox verification requires outbound port 25, which cloud hosts
// (Render, AWS, GCP) block. Instead of doing SMTP directly, we route each
// verification to one of 10 free-tier third-party APIs. Each provider does
// the real SMTP check from their own infrastructure and returns the result
// over HTTPS (port 443, which Render allows).
//
// The router:
//   1. Checks which providers have remaining quota
//   2. Tries providers in smart priority order (unknown-free providers first)
//   3. Falls back to the next provider on error/exhaustion
//   4. Final fallback: Fly.io proxy (if configured) — for when all free APIs
//      are exhausted
//
// PROVIDERS (all free, all recurring, all do real SMTP)
// ─────────────────────────────────────────────────────────────────────────
// | Provider                | Free/mo  | Reset   | Unknown free? |
// |-------------------------|----------|---------|---------------|
// | BillionVerify           | 3,000    | Daily   | ✅ Yes         |
// | QuickEmailVerification  | 3,000    | Daily   | ✅ Yes         |
// | MyEmailVerifier         | 3,000    | Daily   | ❌ Charged     |
// | EmailAwesome            | 1,000    | Monthly | ✅ Yes         |
// | Verifalia               | 750      | Daily   | ❌ Charged     |
// | Reoon                   | 600      | Monthly | ❌ Charged     |
// | MailboxValidator        | 300      | Monthly | ❌ Charged     |
// | Abstract API            | 100      | Monthly | ❌ Charged     |
// | (ZeroBounce removed — requires business email, blocks Gmail)
// | Hunter.io               | 50       | Monthly | ❌ Charged     |
// | TOTAL                   | ~12,200  |         |               |
//
// With pre-filtering (syntax + DNS + MX + disposable + typo removes ~40%
// before SMTP), this covers ~20,000 raw emails/month for $0.
//
// Fly.io proxy serves as a final fallback (no quota limit, but lower
// reliability due to no rDNS — unknowns become RISKY, not VERIFIED).
//
// ENV VARS (set on Render)
// ─────────────────────────
// Each provider is OPTIONAL. The router only uses providers the user has
// configured with an API key. Set any subset:
//
//   BILLIONVERIFY_API_KEY
//   QUICKEMAILVERIFICATION_API_KEY
//   MYEMAILVERIFIER_API_KEY
//   EMAILAWESOME_API_KEY
//   VERIFALIA_API_KEY
//   REOON_API_KEY
//   MAILBOXVALIDATOR_API_KEY
//   ABSTRACT_API_KEY
//   ZEROBOUNCE_API_KEY
//   HUNTER_API_KEY
//
// Fly.io proxy (final fallback):
//   SMTP_PROXY_URL       — e.g. https://your-proxy.fly.dev
//   SMTP_PROXY_SECRET    — the PROXY_SECRET you set on Fly.io
//
// For per-user API keys (when users configure their own keys via the
// settings page), the router reads from the `Setting` table instead of
// env vars. Env vars are the fallback for self-hosted single-user setups.

import type { SmtpVerifyResult } from './emailVerify'
import { db } from './db'

// ─────────────────────────────────────────────────────────────────────────────
// Provider configuration
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderId =
  | 'billionverify'
  | 'quickemailverification'
  | 'myemailverifier'
  | 'emailawesome'
  | 'verifalia'
  | 'reoon'
  | 'mailboxvalidator'
  | 'abstract'
  | 'hunter'
  | 'flyio'

interface ProviderConfig {
  id: ProviderId
  label: string
  /** Free tier limit per period */
  freeLimit: number
  /** DAILY (resets at midnight UTC) or MONTHLY (resets on 1st of month UTC) */
  quotaType: 'DAILY' | 'MONTHLY'
  /** If true, "unknown" results don't consume quota — try these first */
  unknownFree: boolean
  /** Priority order (lower = tried first) */
  priority: number
  /** Max concurrent requests to this provider */
  maxConcurrency: number
  /** Where the API key comes from (env var name) */
  envVarName: string
  /** Sign-up URL shown in the settings UI */
  signupUrl: string
  /** Documentation URL */
  docsUrl: string
}

export const PROVIDER_CONFIG: Record<ProviderId, ProviderConfig> = {
  billionverify: {
    id: 'billionverify',
    label: 'BillionVerify',
    freeLimit: 3000, // 100/day
    quotaType: 'DAILY',
    unknownFree: true,
    priority: 1,
    maxConcurrency: 10,
    envVarName: 'BILLIONVERIFY_API_KEY',
    signupUrl: 'https://billionverify.com',
    docsUrl: 'https://billionverify.com/docs/api-reference',
  },
  quickemailverification: {
    id: 'quickemailverification',
    label: 'QuickEmailVerification',
    freeLimit: 3000, // 100/day
    quotaType: 'DAILY',
    unknownFree: true,
    priority: 2,
    maxConcurrency: 5,
    envVarName: 'QUICKEMAILVERIFICATION_API_KEY',
    signupUrl: 'https://quickemailverification.com',
    docsUrl: 'https://quickemailverification.com/email-verification-api',
  },
  emailawesome: {
    id: 'emailawesome',
    label: 'EmailAwesome',
    freeLimit: 1000, // monthly
    quotaType: 'MONTHLY',
    unknownFree: true,
    priority: 3,
    maxConcurrency: 5,
    envVarName: 'EMAILAWESOME_API_KEY',
    signupUrl: 'https://emailawesome.com',
    docsUrl: 'https://emailawesome.com/docs',
  },
  myemailverifier: {
    id: 'myemailverifier',
    label: 'MyEmailVerifier',
    freeLimit: 3000, // 100/day
    quotaType: 'DAILY',
    unknownFree: false,
    priority: 4,
    maxConcurrency: 5,
    envVarName: 'MYEMAILVERIFIER_API_KEY',
    signupUrl: 'https://myemailverifier.com',
    docsUrl: 'https://myemailverifier.com/real-time-email-verification',
  },
  verifalia: {
    id: 'verifalia',
    label: 'Verifalia',
    freeLimit: 750, // 25/day
    quotaType: 'DAILY',
    unknownFree: false,
    priority: 5,
    maxConcurrency: 1,
    envVarName: 'VERIFALIA_API_KEY',
    signupUrl: 'https://verifalia.com',
    docsUrl: 'https://verifalia.com/api',
  },
  reoon: {
    id: 'reoon',
    label: 'Reoon',
    freeLimit: 600, // monthly
    quotaType: 'MONTHLY',
    unknownFree: false,
    priority: 6,
    maxConcurrency: 5,
    envVarName: 'REOON_API_KEY',
    signupUrl: 'https://emailverifier.reoon.com',
    docsUrl: 'https://www.reoon.com/articles/api-documentation-of-reoon-email-verifier',
  },
  mailboxvalidator: {
    id: 'mailboxvalidator',
    label: 'MailboxValidator',
    freeLimit: 300, // monthly
    quotaType: 'MONTHLY',
    unknownFree: false,
    priority: 7,
    maxConcurrency: 3,
    envVarName: 'MAILBOXVALIDATOR_API_KEY',
    signupUrl: 'https://www.mailboxvalidator.com',
    docsUrl: 'https://www.mailboxvalidator.com/api-email-validation',
  },
  abstract: {
    id: 'abstract',
    label: 'Abstract API',
    freeLimit: 100, // monthly
    quotaType: 'MONTHLY',
    unknownFree: false,
    priority: 8,
    maxConcurrency: 1, // 1 req/sec
    envVarName: 'ABSTRACT_API_KEY',
    signupUrl: 'https://www.abstractapi.com/api/email-validation',
    docsUrl: 'https://app.abstractapi.com/api/email-validation/documentation',
  },
  hunter: {
    id: 'hunter',
    label: 'Hunter.io',
    freeLimit: 50, // monthly
    quotaType: 'MONTHLY',
    unknownFree: false,
    priority: 9, // renumbered after ZeroBounce removal
    maxConcurrency: 2,
    envVarName: 'HUNTER_API_KEY',
    signupUrl: 'https://hunter.io',
    docsUrl: 'https://hunter.io/api-documentation/v2#email-verifier',
  },
  flyio: {
    id: 'flyio',
    label: 'Fly.io Proxy (Fallback)',
    freeLimit: 999999, // unlimited
    quotaType: 'MONTHLY',
    unknownFree: true, // unknowns don't matter — Fly.io doesn't charge per-call
    priority: 99, // last resort
    maxConcurrency: 10,
    envVarName: 'SMTP_PROXY_URL', // special — uses URL + secret
    signupUrl: 'https://fly.io',
    docsUrl: '',
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// API key resolution: per-user Setting table → env var fallback
// ─────────────────────────────────────────────────────────────────────────────

// In-memory cache of API keys per user (refreshed every 60s)
const apiKeyCache = new Map<string, { keys: Record<string, string>; fetchedAt: number }>()
const API_KEY_CACHE_TTL = 60_000

/** Get all configured API keys for a user (from DB Setting table, then env vars). */
async function getUserApiKeys(userId: string): Promise<Record<string, string>> {
  const cached = apiKeyCache.get(userId)
  if (cached && Date.now() - cached.fetchedAt < API_KEY_CACHE_TTL) {
    return cached.keys
  }

  const keys: Record<string, string> = {}

  // 1. Try DB Setting table (per-user keys set via the settings page)
  try {
    const settings = await db.setting.findMany({
      where: {
        key: { startsWith: 'verify_key_' },
      },
    })
    for (const s of settings) {
      // Keys stored as: verify_key_<providerId> = <apiKey>
      const providerId = s.key.replace('verify_key_', '')
      keys[providerId] = s.value
    }
  } catch {
    // DB not available — fall through to env vars
  }

  // 2. Fall back to env vars (self-hosted single-user setups)
  for (const [id, config] of Object.entries(PROVIDER_CONFIG)) {
    if (!keys[id]) {
      const envValue = process.env[config.envVarName]?.trim()
      if (envValue) keys[id] = envValue
    }
  }

  // 3. Fly.io proxy uses URL + secret (special case)
  if (!keys['flyio']) {
    const proxyUrl = process.env.SMTP_PROXY_URL?.trim()
    const proxySecret = process.env.SMTP_PROXY_SECRET?.trim()
    if (proxyUrl && proxySecret) {
      keys['flyio'] = `${proxyUrl}|${proxySecret}` // encode both in one value
    }
  }

  apiKeyCache.set(userId, { keys, fetchedAt: Date.now() })
  return keys
}

/** Invalidate the API key cache for a user (call when they update their keys). */
export function invalidateApiKeyCache(userId: string) {
  apiKeyCache.delete(userId)
}

/** Check if at least one provider is configured. */
export async function hasApiProvider(userId?: string): Promise<boolean> {
  if (!userId) {
    // No user context — check env vars only
    return Object.values(PROVIDER_CONFIG).some(
      (c) => process.env[c.envVarName]?.trim()
    )
  }
  const keys = await getUserApiKeys(userId)
  return Object.keys(keys).length > 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Quota tracking
// ─────────────────────────────────────────────────────────────────────────────

/** Get the start of the current quota period for a provider. */
function getCurrentPeriodStart(quotaType: 'DAILY' | 'MONTHLY'): Date {
  const now = new Date()
  if (quotaType === 'DAILY') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  }
  // MONTHLY — first day of current month
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** Get the current quota usage for a provider (0 if no record exists). */
async function getQuotaUsed(
  userId: string,
  provider: ProviderId
): Promise<{ used: number; limit: number; remaining: number; periodStart: Date }> {
  const config = PROVIDER_CONFIG[provider]
  const periodStart = getCurrentPeriodStart(config.quotaType)

  try {
    const record = await db.providerQuota.findUnique({
      where: {
        ownerId_provider_quotaType_periodStart: {
          ownerId: userId,
          provider,
          quotaType: config.quotaType,
          periodStart,
        },
      },
    })
    const used = record?.used ?? 0
    return {
      used,
      limit: config.freeLimit,
      remaining: Math.max(0, config.freeLimit - used),
      periodStart,
    }
  } catch {
    // DB error — assume unlimited (don't block verification)
    return { used: 0, limit: config.freeLimit, remaining: config.freeLimit, periodStart }
  }
}

/** Increment the quota usage for a provider (called after each verification). */
async function incrementQuota(
  userId: string,
  provider: ProviderId,
  consumed: number = 1
): Promise<void> {
  const config = PROVIDER_CONFIG[provider]
  const periodStart = getCurrentPeriodStart(config.quotaType)

  try {
    await db.providerQuota.upsert({
      where: {
        ownerId_provider_quotaType_periodStart: {
          ownerId: userId,
          provider,
          quotaType: config.quotaType,
          periodStart,
        },
      },
      create: {
        ownerId: userId,
        provider,
        quotaType: config.quotaType,
        periodStart,
        used: consumed,
      },
      update: {
        used: { increment: consumed },
      },
    })
  } catch (e: any) {
    console.error(`[quota] failed to increment ${provider}:`, e?.message)
  }
}

/** Record an error for a provider (shown in the UI as "provider X is having issues"). */
async function recordProviderError(
  userId: string,
  provider: ProviderId,
  error: string
): Promise<void> {
  const config = PROVIDER_CONFIG[provider]
  const periodStart = getCurrentPeriodStart(config.quotaType)

  try {
    await db.providerQuota.upsert({
      where: {
        ownerId_provider_quotaType_periodStart: {
          ownerId: userId,
          provider,
          quotaType: config.quotaType,
          periodStart,
        },
      },
      create: {
        ownerId: userId,
        provider,
        quotaType: config.quotaType,
        periodStart,
        used: 0,
        lastError: error,
        lastErrorAt: new Date(),
      },
      update: {
        lastError: error,
        lastErrorAt: new Date(),
      },
    })
  } catch {
    // ignore
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-provider verification adapters
// ─────────────────────────────────────────────────────────────────────────────
// Each adapter: (email, apiKey, signal) => Promise<SmtpVerifyResult>
// Returns our canonical SmtpVerifyResult shape so the caller doesn't care
// which provider was used.

async function verifyBillionVerify(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const res = await fetch('https://api.billionverify.com/v1/verify/single', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'BV-API-KEY': apiKey,
    },
    body: JSON.stringify({ email, check_smtp: true }),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`BillionVerify ${res.status}: ${text}`)
  }
  const data: any = await res.json()
  // BV returns: { status: "valid"|"invalid"|"unknown"|"catch_all", ... }
  const status = data.status?.toLowerCase()
  return {
    status: status === 'catch_all' ? 'catch-all' : status,
    response: data.reason || data.smtp_response,
    details: `BillionVerify: ${data.status}${data.smtp_response ? ` (${data.smtp_response})` : ''}`,
  }
}

async function verifyQuickEmailVerification(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const url = `https://api.quickemailverification.com/v1/verify?email=${encodeURIComponent(email)}&apikey=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`QuickEmailVerification ${res.status}: ${text}`)
  }
  const data: any = await res.json()
  // QEV returns: { safe_to_send: "true"|"false", accept_all: "true"|"false", result: "valid"|"invalid"|"unknown", ... }
  if (data.result === 'valid') {
    return {
      status: data.accept_all === 'true' ? 'catch-all' : 'valid',
      response: data.reason,
      details: `QuickEmailVerification: valid${data.reason ? ` (${data.reason})` : ''}`,
    }
  } else if (data.result === 'invalid') {
    return {
      status: 'invalid',
      response: data.reason,
      details: `QuickEmailVerification: invalid${data.reason ? ` (${data.reason})` : ''}`,
    }
  } else {
    return {
      status: 'unknown',
      response: data.reason,
      details: `QuickEmailVerification: ${data.result || 'unknown'}`,
    }
  }
}

async function verifyMyEmailVerifier(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const url = `https://client.myemailverifier.com/verifier/validate_single/${encodeURIComponent(email)}/${encodeURIComponent(apiKey)}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`MyEmailVerifier ${res.status}: ${text}`)
  }
  const data: any = await res.json()
  // MEV returns: { Status: "Valid"|"Invalid"|"Unknown"|"CatchAll", ... } (PascalCase)
  const status = (data.Status || data.status || '').toLowerCase()
  if (status === 'valid') {
    return { status: 'valid', response: data.Reason, details: `MyEmailVerifier: valid` }
  } else if (status === 'invalid') {
    return { status: 'invalid', response: data.Reason, details: `MyEmailVerifier: invalid` }
  } else if (status === 'catchall' || status === 'catch_all' || status === 'catch-all') {
    return { status: 'catch-all', response: data.Reason, details: `MyEmailVerifier: catch-all` }
  } else {
    return { status: 'unknown', response: data.Reason, details: `MyEmailVerifier: ${status || 'unknown'}` }
  }
}

async function verifyEmailAwesome(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  // EmailAwesome uses an async API — submit + poll. We use a simplified sync
  // endpoint if available, otherwise poll with a timeout.
  const res = await fetch('https://api.emailawesome.com/v1/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ email }),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`EmailAwesome ${res.status}: ${text}`)
  }
  const data: any = await res.json()
  // EmailAwesome returns: { status: "valid"|"invalid"|"unknown"|"catch_all", ... }
  const status = (data.status || data.result || '').toLowerCase()
  if (status === 'valid' || status === 'deliverable') {
    return { status: data.catch_all ? 'catch-all' : 'valid', response: data.reason, details: `EmailAwesome: valid` }
  } else if (status === 'invalid' || status === 'undeliverable') {
    return { status: 'invalid', response: data.reason, details: `EmailAwesome: invalid` }
  } else if (status === 'catch_all' || status === 'catch-all') {
    return { status: 'catch-all', response: data.reason, details: `EmailAwesome: catch-all` }
  } else {
    return { status: 'unknown', response: data.reason, details: `EmailAwesome: ${status || 'unknown'}` }
  }
}

async function verifyVerifalia(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  // Verifalia is async: submit job → poll until done. We use a 30s overall timeout.
  // Auth: Verifalia uses basic auth with username = API key, password = empty.
  const authHeader = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64')

  // Submit
  const submitRes = await fetch('https://api.verifalia.com/v2/email-validations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    body: JSON.stringify({ entries: [{ inputData: email }], quality: 'Standard' }),
    signal,
  })
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '')
    throw new Error(`Verifalia submit ${submitRes.status}: ${text}`)
  }
  const submitData: any = await submitRes.json()
  const jobId = submitData.id
  if (!jobId) throw new Error('Verifalia: no job ID returned')

  // Poll (max 6 attempts × 5s = 30s)
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const pollRes = await fetch(`https://api.verifalia.com/v2/email-validations/${jobId}`, {
      headers: { 'Authorization': authHeader },
      signal,
    })
    if (!pollRes.ok) continue
    const pollData: any = await pollRes.json()
    if (pollData.status === 'completed') {
      const entry = pollData.entries?.[0]
      if (!entry) return { status: 'unknown', details: 'Verifalia: no entry' }
      const classification = (entry.classification || '').toLowerCase()
      if (classification === 'delivered') {
        return { status: entry.isCatchAll ? 'catch-all' : 'valid', response: entry.status, details: `Verifalia: delivered` }
      } else if (classification === 'undeliverable') {
        return { status: 'invalid', response: entry.status, details: `Verifalia: undeliverable` }
      } else if (classification === 'risky') {
        return { status: entry.isCatchAll ? 'catch-all' : 'unknown', response: entry.status, details: `Verifalia: risky` }
      } else {
        return { status: 'unknown', response: entry.status, details: `Verifalia: ${classification}` }
      }
    }
    // Still pending — keep polling
  }
  return { status: 'unknown', details: 'Verifalia: timed out waiting for result' }
}

async function verifyReoon(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(apiKey)}&mode=power`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Reoon ${res.status}: ${text}`)
  }
  const data: any = await res.json()
  // Reoon Power Mode returns: { status: "valid"|"invalid"|"catch_all"|"unknown"|"risky", ... }
  const status = (data.status || '').toLowerCase()
  if (status === 'valid' || status === 'safe') {
    return { status: data.is_catch_all ? 'catch-all' : 'valid', response: data.smtp_response, details: `Reoon: valid` }
  } else if (status === 'invalid' || status === 'disabled') {
    return { status: 'invalid', response: data.smtp_response, details: `Reoon: invalid` }
  } else if (status === 'catch_all' || status === 'catch-all') {
    return { status: 'catch-all', response: data.smtp_response, details: `Reoon: catch-all` }
  } else {
    return { status: 'unknown', response: data.smtp_response, details: `Reoon: ${status || 'unknown'}` }
  }
}

async function verifyMailboxValidator(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const url = `https://api.mailboxvalidator.com/v2/validation?email=${encodeURIComponent(email)}&key=${encodeURIComponent(apiKey)}&format=json`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`MailboxValidator ${res.status}: ${text}`)
  }
  const data: any = await res.json()
  // MBV returns: { status: "True"|"False"|"Unknown", is_catch_all: "True"|"False", ... } (string booleans)
  if (data.status === 'True') {
    return { status: data.is_catch_all === 'True' ? 'catch-all' : 'valid', response: data.error_message, details: `MailboxValidator: valid` }
  } else if (data.status === 'False') {
    return { status: 'invalid', response: data.error_message, details: `MailboxValidator: invalid` }
  } else {
    return { status: 'unknown', response: data.error_message, details: `MailboxValidator: unknown` }
  }
}

async function verifyAbstract(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const url = `https://emailvalidation.abstractapi.com/v1/?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Abstract API ${res.status}: ${text}`)
  }
  const data: any = await res.json()
  // Abstract returns: { deliverability: "DELIVERABLE"|"UNDELIVERABLE"|"RISKY"|"UNKNOWN", is_smtp_valid: true|false|null, is_catchall_email: true|false, ... }
  if (data.is_smtp_valid === true) {
    return { status: data.is_catchall_email ? 'catch-all' : 'valid', response: data.deliverability, details: `Abstract: ${data.deliverability}` }
  } else if (data.is_smtp_valid === false) {
    return { status: 'invalid', response: data.deliverability, details: `Abstract: ${data.deliverability}` }
  } else {
    return { status: 'unknown', response: data.deliverability, details: `Abstract: ${data.deliverability || 'unknown'}` }
  }
}

async function verifyHunter(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const url = `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Hunter.io ${res.status}: ${text}`)
  }
  const data: any = await res.json()
  // Hunter returns: { data: { status: "valid"|"invalid"|"accept_all"|"webmail"|"disposable"|"unknown", ... } }
  const result = data.data || data
  const status = (result.status || '').toLowerCase()
  if (status === 'valid') {
    return { status: 'valid', response: result.result, details: `Hunter: valid` }
  } else if (status === 'invalid') {
    return { status: 'invalid', response: result.result, details: `Hunter: invalid` }
  } else if (status === 'accept_all') {
    return { status: 'catch-all', response: result.result, details: `Hunter: accept-all` }
  } else if (status === 'disposable' || status === 'webmail') {
    return { status: 'invalid', response: result.result, details: `Hunter: ${status}` }
  } else {
    return { status: 'unknown', response: result.result, details: `Hunter: ${status || 'unknown'}` }
  }
}

async function verifyFlyIoProxy(email: string, encodedConfig: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  // Fly.io config is encoded as "url|secret"
  const [proxyUrl, secret] = encodedConfig.split('|')
  if (!proxyUrl || !secret) {
    throw new Error('Fly.io proxy config invalid — expected url|secret')
  }
  const url = proxyUrl.replace(/\/$/, '') + '/verify'
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Secret': secret,
    },
    body: JSON.stringify({ email, checkCatchAll: true }),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Fly.io proxy ${res.status}: ${text}`)
  }
  const data: any = await res.json()
  return {
    status: data.status, // already matches our union
    response: data.response,
    details: data.details || `Fly.io: ${data.status}`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

interface RouterResult extends SmtpVerifyResult {
  providerUsed: ProviderId
  quotaConsumed: boolean // false if "unknown" and provider doesn't charge for unknowns
}

const PROVIDER_ADAPTERS: Record<ProviderId, (email: string, apiKey: string, signal: AbortSignal) => Promise<SmtpVerifyResult>> = {
  billionverify: verifyBillionVerify,
  quickemailverification: verifyQuickEmailVerification,
  myemailverifier: verifyMyEmailVerifier,
  emailawesome: verifyEmailAwesome,
  verifalia: verifyVerifalia,
  reoon: verifyReoon,
  mailboxvalidator: verifyMailboxValidator,
  abstract: verifyAbstract,
  hunter: verifyHunter,
  flyio: verifyFlyIoProxy,
}

/**
 * Verify an email address using the multi-provider router.
 *
 * Strategy:
 *   1. Get all providers the user has configured (API keys set)
 *   2. Sort by priority (unknown-free providers first, then by freeLimit desc)
 *   3. For each provider with remaining quota:
 *      - Call the provider's API
 *      - On success: increment quota, return result
 *      - On error: record error, try next provider
 *   4. If all free providers exhausted: try Fly.io proxy (if configured)
 *   5. If nothing works: return { status: 'unknown', providerUsed: 'none' }
 *
 * @param email The email to verify
 * @param userId The user ID (for per-user API key lookup + quota tracking)
 * @returns RouterResult with status + providerUsed
 */
export async function verifyViaApi(email: string, userId?: string): Promise<RouterResult> {
  const FALLBACK_RESULT: RouterResult = {
    status: 'unknown',
    details: 'No verification provider available',
    providerUsed: 'flyio', // placeholder — will be overridden
    quotaConsumed: false,
  }

  if (!userId) {
    // No user context — can't track quota. Try env-var-configured providers only.
    return { ...FALLBACK_RESULT, details: 'No user context for verification' }
  }

  const apiKeys = await getUserApiKeys(userId)
  const configuredProviders = Object.keys(apiKeys).filter((k) => apiKeys[k]) as ProviderId[]

  if (configuredProviders.length === 0) {
    return { ...FALLBACK_RESULT, details: 'No verification providers configured' }
  }

  // Sort by priority (unknown-free first, then by freeLimit desc)
  const sortedProviders = configuredProviders.sort((a, b) => {
    const configA = PROVIDER_CONFIG[a]
    const configB = PROVIDER_CONFIG[b]
    // Unknown-free providers first
    if (configA.unknownFree !== configB.unknownFree) {
      return configA.unknownFree ? -1 : 1
    }
    // Then by priority (lower = first)
    return configA.priority - configB.priority
  })

  // Try each provider in order
  for (const provider of sortedProviders) {
    const config = PROVIDER_CONFIG[provider]
    const apiKey = apiKeys[provider]
    if (!apiKey) continue

    // Check quota (skip for Fly.io — unlimited)
    if (provider !== 'flyio') {
      const quota = await getQuotaUsed(userId, provider)
      if (quota.remaining <= 0) {
        // Quota exhausted — skip to next provider
        continue
      }
    }

    // Call the provider
    const controller = new AbortController()
    // Verifalia is slow (async polling) — give it 45s. Fly.io proxy 20s. Others 15s.
    const timeoutMs = provider === 'verifalia' ? 45_000 : provider === 'flyio' ? 20_000 : 15_000
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const adapter = PROVIDER_ADAPTERS[provider]
      const result = await adapter(email, apiKey, controller.signal)

      // Determine if quota was consumed
      // "unknown" results don't consume quota for: BillionVerify, QuickEmailVerification, EmailAwesome, Fly.io
      const isUnknown = result.status === 'unknown'
      const quotaConsumed = !(isUnknown && config.unknownFree)

      // Increment quota if consumed
      if (quotaConsumed && provider !== 'flyio') {
        await incrementQuota(userId, provider, 1)
      }

      return {
        ...result,
        providerUsed: provider,
        quotaConsumed,
      }
    } catch (e: any) {
      const errorMsg = e?.name === 'AbortError' ? 'Timeout' : e?.message || 'Unknown error'
      console.error(`[router] ${provider} failed for ${email}: ${errorMsg}`)
      await recordProviderError(userId, provider, errorMsg)
      // Continue to next provider
      continue
    } finally {
      clearTimeout(timeout)
    }
  }

  // All providers failed or exhausted
  return {
    ...FALLBACK_RESULT,
    details: 'All verification providers exhausted or failed',
    providerUsed: 'flyio', // placeholder
    quotaConsumed: false,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Quota reporting (for the settings UI)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderQuotaInfo {
  id: ProviderId
  label: string
  configured: boolean
  freeLimit: number
  used: number
  remaining: number
  quotaType: 'DAILY' | 'MONTHLY'
  unknownFree: boolean
  lastError: string | null
  lastErrorAt: string | null
  signupUrl: string
  docsUrl: string
  envVarName: string
}

/** Get quota info for all providers (for the settings UI). */
export async function getProviderQuotaInfo(userId: string): Promise<ProviderQuotaInfo[]> {
  const apiKeys = await getUserApiKeys(userId)
  const infos: ProviderQuotaInfo[] = []

  for (const [id, config] of Object.entries(PROVIDER_CONFIG)) {
    const providerId = id as ProviderId
    const configured = !!apiKeys[providerId]
    const quota = configured ? await getQuotaUsed(userId, providerId) : { used: 0, remaining: config.freeLimit }

    // Get last error
    let lastError: string | null = null
    let lastErrorAt: string | null = null
    try {
      const periodStart = getCurrentPeriodStart(config.quotaType)
      const record = await db.providerQuota.findUnique({
        where: {
          ownerId_provider_quotaType_periodStart: {
            ownerId: userId,
            provider: providerId,
            quotaType: config.quotaType,
            periodStart,
          },
        },
      })
      lastError = record?.lastError || null
      lastErrorAt = record?.lastErrorAt?.toISOString() || null
    } catch {
      // ignore
    }

    infos.push({
      id: providerId,
      label: config.label,
      configured,
      freeLimit: config.freeLimit,
      used: quota.used,
      remaining: quota.remaining,
      quotaType: config.quotaType,
      unknownFree: config.unknownFree,
      lastError,
      lastErrorAt,
      signupUrl: config.signupUrl,
      docsUrl: config.docsUrl,
      envVarName: config.envVarName,
    })
  }

  return infos
}

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compat: hasApiProvider (sync version for code that doesn't have userId)
// ─────────────────────────────────────────────────────────────────────────────

export function hasApiProviderSync(): boolean {
  return Object.values(PROVIDER_CONFIG).some(
    (c) => process.env[c.envVarName]?.trim()
  ) || !!(process.env.SMTP_PROXY_URL?.trim() && process.env.SMTP_PROXY_SECRET?.trim())
}
