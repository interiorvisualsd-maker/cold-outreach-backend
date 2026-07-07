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
// | BillionVerify            | (removed — requires credit card)
// | QuickEmailVerification   | (removed — requires credit card for credits)
// | Verifalia                | (removed — per user request)
// | MyEmailVerifier          | 3,000    | Daily   | ❌ Charged     |
// | EmailAwesome            | 1,000    | Monthly | ✅ Yes         |
// | Reoon                   | 600      | Monthly | ❌ Charged     |
// | MailboxValidator        | 300      | Monthly | ❌ Charged     |
// | TOTAL                   | ~4,900   |         |               |
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
  | 'myemailverifier'
  | 'emailawesome'
  | 'reoon'
  | 'mailboxvalidator'
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
  emailawesome: {
    id: 'emailawesome',
    label: 'EmailAwesome',
    freeLimit: 1000, // monthly
    quotaType: 'MONTHLY',
    unknownFree: true,
    priority: 1,
    maxConcurrency: 5,
    envVarName: 'EMAILAWESOME_API_KEY',
    signupUrl: 'https://emailawesome.com',
    docsUrl: 'https://developers.emailawesome.com/docs/validation-api',
  },
  myemailverifier: {
    id: 'myemailverifier',
    label: 'MyEmailVerifier',
    freeLimit: 3000, // 100/day
    quotaType: 'DAILY',
    unknownFree: false,
    priority: 2,
    maxConcurrency: 5,
    envVarName: 'MYEMAILVERIFIER_API_KEY',
    signupUrl: 'https://myemailverifier.com',
    docsUrl: 'https://myemailverifier.com/real-time-email-verification',
  },
  reoon: {
    id: 'reoon',
    label: 'Reoon',
    freeLimit: 600, // monthly
    quotaType: 'MONTHLY',
    unknownFree: false,
    priority: 3,
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
    priority: 4,
    maxConcurrency: 3,
    envVarName: 'MAILBOXVALIDATOR_API_KEY',
    signupUrl: 'https://www.mailboxvalidator.com',
    docsUrl: 'https://www.mailboxvalidator.com/api-single-validation',
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

async function verifyMyEmailVerifier(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  // MyEmailVerifier API — using the recommended api.myemailverifier.com endpoint
  // Docs: https://myemailverifier.com/real-time-email-verification
  // Response: { Status: "Valid"|"Invalid"|"Unknown"|"Catch All"|"Grey-listed", catch_all: "true"|"false", ... }
  // Note: values are STRINGS ("true"/"false"), not booleans
  const url = `https://api.myemailverifier.com/api/validate_single.php?apikey=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`MyEmailVerifier ${res.status}: ${text}`)
  }
  const data: any = await res.json()
  // MEV returns PascalCase fields. Status values: "Valid"|"Invalid"|"Unknown"|"Catch All"|"Grey-listed"
  const status = (data.Status || data.status || '').toLowerCase()
  if (status === 'valid') {
    return { status: 'valid', response: data.Diagnosis || data.Reason, details: `MyEmailVerifier: valid` }
  } else if (status === 'invalid') {
    return { status: 'invalid', response: data.Diagnosis || data.Reason, details: `MyEmailVerifier: invalid` }
  } else if (status === 'catch all' || status === 'catchall' || status === 'catch_all' || status === 'catch-all') {
    return { status: 'catch-all', response: data.Diagnosis || data.Reason, details: `MyEmailVerifier: catch-all` }
  } else if (status === 'grey-listed' || status === 'greylisted') {
    return { status: 'unknown', response: data.Diagnosis || data.Reason, details: `MyEmailVerifier: greylisted` }
  } else {
    return { status: 'unknown', response: data.Diagnosis || data.Reason, details: `MyEmailVerifier: ${status || 'unknown'}` }
  }
}

async function verifyEmailAwesome(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  // EmailAwesome uses an ASYNC 2-step API (create validation → poll for result)
  // Docs: https://developers.emailawesome.com/docs/validation-api
  // Auth: x-api-key header (NOT Bearer)
  // Step 1: POST /api/validations/email_validation → returns { id, status: "PENDING" }
  // Step 2: GET /api/validations/email_validation/{id} → poll until status == "COMPLETE"
  //   email_address_status: "VALID"|"INVALID"|"UNKNOWN"|"CATCH_ALL"

  // Step 1 — create validation
  const createRes = await fetch('https://api.emailawesome.com/api/validations/email_validation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ email }),
    signal,
  })
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '')
    throw new Error(`EmailAwesome create ${createRes.status}: ${text}`)
  }
  const createData: any = await createRes.json()
  const validationId = createData.id
  if (!validationId) {
    throw new Error('EmailAwesome: no validation ID returned')
  }

  // Step 2 — poll for result (max 8 attempts × 3s = 24s)
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const pollRes = await fetch(`https://api.emailawesome.com/api/validations/email_validation/${validationId}`, {
      headers: {
        'Accept': 'application/json',
        'x-api-key': apiKey,
      },
      signal,
    })
    if (!pollRes.ok) continue
    const pollData: any = await pollRes.json()
    if (pollData.status === 'COMPLETE') {
      const emailStatus = (pollData.email_address_status || '').toUpperCase()
      if (emailStatus === 'VALID') {
        return { status: 'valid', response: pollData.status, details: `EmailAwesome: VALID` }
      } else if (emailStatus === 'INVALID') {
        return { status: 'invalid', response: pollData.status, details: `EmailAwesome: INVALID` }
      } else if (emailStatus === 'CATCH_ALL' || emailStatus === 'CATCH-ALL') {
        return { status: 'catch-all', response: pollData.status, details: `EmailAwesome: CATCH_ALL` }
      } else {
        return { status: 'unknown', response: pollData.status, details: `EmailAwesome: ${emailStatus || 'UNKNOWN'}` }
      }
    }
    if (pollData.status === 'FAILED') {
      return { status: 'unknown', response: pollData.status, details: `EmailAwesome: FAILED` }
    }
    // Still PENDING or IN-PROGRESS — keep polling
  }
  return { status: 'unknown', details: 'EmailAwesome: timed out waiting for result' }
}

async function verifyReoon(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  // Reoon Power Mode — real SMTP mailbox verification
  // Docs: https://www.reoon.com/articles/api-documentation-of-reoon-email-verifier
  // Power mode status values: "safe"|"invalid"|"disabled"|"disposable"|"inbox_full"|"catch_all"|"role_account"|"spamtrap"|"unknown"
  // Quick mode status values: "valid"|"invalid"|"disposable"|"spamtrap" (different!)
  const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(apiKey)}&mode=power`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Reoon ${res.status}: ${text}`)
  }
  const data: any = await res.json()
  const status = (data.status || '').toLowerCase()
  // Power mode: "safe" = deliverable, "invalid"/"disabled" = mailbox doesn't exist
  if (status === 'safe' || status === 'valid') {
    return { status: data.is_catch_all ? 'catch-all' : 'valid', response: data.smtp_response, details: `Reoon: safe` }
  } else if (status === 'invalid' || status === 'disabled') {
    return { status: 'invalid', response: data.smtp_response, details: `Reoon: invalid` }
  } else if (status === 'catch_all' || status === 'catch-all') {
    return { status: 'catch-all', response: data.smtp_response, details: `Reoon: catch-all` }
  } else if (status === 'inbox_full') {
    return { status: 'valid', response: data.smtp_response, details: `Reoon: inbox_full (mailbox exists)` }
  } else if (status === 'disposable' || status === 'spamtrap') {
    return { status: 'invalid', response: data.smtp_response, details: `Reoon: ${status}` }
  } else {
    return { status: 'unknown', response: data.smtp_response, details: `Reoon: ${status || 'unknown'}` }
  }
}

async function verifyMailboxValidator(email: string, apiKey: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  // MailboxValidator — CORRECT endpoint is /v2/validation/single (not /v2/validation)
  // Docs: https://www.mailboxvalidator.com/api-single-validation
  // Response: { status: true|false|null, is_catchall: true|false|null, is_verified: true|false|null, ... }
  // Error: { error: { error_code: 10001, error_message: "API key not found." } }
  const url = `https://api.mailboxvalidator.com/v2/validation/single?key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&format=json`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`MailboxValidator ${res.status}: ${text}`)
  }
  const data: any = await res.json()
  // Check for error response
  if (data.error) {
    throw new Error(`MailboxValidator: ${data.error.error_message || 'API error'}`)
  }
  // MBV returns: status (boolean), is_catchall (boolean|null), is_verified (boolean|null)
  if (data.status === true) {
    return { status: data.is_catchall === true ? 'catch-all' : 'valid', response: data.mailboxvalidator_score?.toString(), details: `MailboxValidator: valid` }
  } else if (data.status === false) {
    return { status: 'invalid', response: data.mailboxvalidator_score?.toString(), details: `MailboxValidator: invalid` }
  } else {
    return { status: 'unknown', response: data.mailboxvalidator_score?.toString(), details: `MailboxValidator: unknown` }
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
  myemailverifier: verifyMyEmailVerifier,
  emailawesome: verifyEmailAwesome,
  reoon: verifyReoon,
  mailboxvalidator: verifyMailboxValidator,
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
    // EmailAwesome is slow (async 2-step polling) — give it 45s. Fly.io proxy 20s. Others 15s.
    const timeoutMs = provider === 'emailawesome' ? 45_000 : provider === 'flyio' ? 20_000 : 15_000
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
