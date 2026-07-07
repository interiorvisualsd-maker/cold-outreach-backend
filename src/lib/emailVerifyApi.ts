// ─────────────────────────────────────────────────────────────────────────────
// Third-party email verification API integration
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS:
// Cloud hosts (Render, AWS, GCP, Azure, Heroku, Railway) block outbound
// port 25 to prevent spam. Direct SMTP mailbox verification (RCPT TO probe)
// requires port 25, so it's impossible from these hosts.
//
// SOLUTION:
// Use a third-party email verification API. These services run their own
// infrastructure with port 25 unblocked, perform the real SMTP mailbox
// check, and return the result via HTTPS. Cost is ~$5-9 per 1,000 emails.
//
// SUPPORTED PROVIDERS:
//   1. Kickbox     — $0.005/email, free 100/month  → EMAIL_VERIFY_PROVIDER=kickbox
//   2. ZeroBounce  — $0.006/email, free 100/month  → EMAIL_VERIFY_PROVIDER=zerobounce
//   3. Abstract API — $0.009/email, free 100/month → EMAIL_VERIFY_PROVIDER=abstract
//
// ENV VARS:
//   EMAIL_VERIFY_PROVIDER  = kickbox | zerobounce | abstract | (empty for direct SMTP)
//   EMAIL_VERIFY_API_KEY   = your API key from the provider
//
// If EMAIL_VERIFY_PROVIDER is empty/unset, the caller falls back to direct
// SMTP (only works on hosts that allow port 25 — Render does NOT).

import type { SmtpVerifyResult } from './emailVerify'

function getProvider(): string | null {
  const p = process.env.EMAIL_VERIFY_PROVIDER?.toLowerCase().trim()
  const key = process.env.EMAIL_VERIFY_API_KEY?.trim()
  if (!p || !key || p === 'none' || p === 'direct') return null
  return p
}

/**
 * Check if a third-party verification provider is configured.
 * Use this to decide whether to call verifyViaApi() or fall back to direct SMTP.
 */
export function hasApiProvider(): boolean {
  return getProvider() !== null
}

/**
 * Verify an email address via the configured third-party API.
 * Returns a SmtpVerifyResult matching the shape of the direct SMTP verifier
 * so the caller can use either interchangeably.
 *
 * Throws on network/auth errors — caller should catch and treat as 'unknown'.
 */
export async function verifyViaApi(email: string): Promise<SmtpVerifyResult> {
  const provider = getProvider()
  if (!provider) {
    throw new Error('No EMAIL_VERIFY_PROVIDER configured')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000) // 15s hard limit

  try {
    if (provider === 'kickbox') {
      return await verifyKickbox(email, controller.signal)
    } else if (provider === 'zerobounce') {
      return await verifyZeroBounce(email, controller.signal)
    } else if (provider === 'abstract') {
      return await verifyAbstract(email, controller.signal)
    } else {
      throw new Error(`Unknown EMAIL_VERIFY_PROVIDER: ${provider}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Kickbox ─────────────────────────────────────────────────────────────────
// Docs: https://docs.kickbox.com/v2.0/reference#verify-an-email
// Response:
//   {
//     "result": "deliverable" | "undeliverable" | "risky" | "unknown",
//     "reason": "accepted_email" | "invalid_domain" | "invalid_email" | ...,
//     "role": true/false,
//     "free": true/false,
//     "disposable": true/false,
//     "accept_all": true/false  ← catch-all detection
//   }
async function verifyKickbox(email: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const apiKey = process.env.EMAIL_VERIFY_API_KEY!
  const url = `https://api.kickbox.com/v2/verify?email=${encodeURIComponent(email)}&apikey=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Kickbox API ${res.status}: ${text}`)
  }
  const data: any = await res.json()

  // Map Kickbox result → our SmtpVerifyResult
  //   deliverable   → valid    (SMTP 250 + not catch-all)
  //   undeliverable → invalid  (SMTP 550 — mailbox doesn't exist)
  //   risky         → catch-all if accept_all=true, else unknown
  //   unknown       → unknown  (couldn't verify)
  if (data.result === 'deliverable') {
    return {
      status: data.accept_all ? 'catch-all' : 'valid',
      response: data.reason,
      details: `Kickbox: ${data.reason || 'deliverable'}`,
    }
  } else if (data.result === 'undeliverable') {
    return {
      status: 'invalid',
      response: data.reason,
      details: `Kickbox: ${data.reason || 'undeliverable'}`,
    }
  } else if (data.result === 'risky') {
    return {
      status: data.accept_all ? 'catch-all' : 'unknown',
      response: data.reason,
      details: `Kickbox: ${data.reason || 'risky'}`,
    }
  } else {
    return {
      status: 'unknown',
      response: data.reason,
      details: `Kickbox: ${data.reason || 'unknown'}`,
    }
  }
}

// ─── ZeroBounce ──────────────────────────────────────────────────────────────
// Docs: https://www.zerobounce.net/docs/
// Response:
//   {
//     "status": "valid" | "invalid" | "catch-all" | "unknown" | "spamtrap" | "abuse" | "do_not_mail",
//     "sub_status": "role_based" | "free_email" | "disposable_email" | ...,
//     ...
//   }
async function verifyZeroBounce(email: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const apiKey = process.env.EMAIL_VERIFY_API_KEY!
  const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`ZeroBounce API ${res.status}: ${text}`)
  }
  const data: any = await res.json()

  // Map ZeroBounce status → our SmtpVerifyResult
  if (data.status === 'valid') {
    return {
      status: 'valid',
      response: data.sub_status,
      details: `ZeroBounce: valid (${data.sub_status || 'none'})`,
    }
  } else if (data.status === 'invalid') {
    return {
      status: 'invalid',
      response: data.sub_status,
      details: `ZeroBounce: invalid (${data.sub_status || 'none'})`,
    }
  } else if (data.status === 'catch-all') {
    return {
      status: 'catch-all',
      response: data.sub_status,
      details: `ZeroBounce: catch-all`,
    }
  } else if (data.status === 'spamtrap' || data.status === 'abuse') {
    // Spam traps and abuse emails are effectively invalid — never send to them
    return {
      status: 'invalid',
      response: data.sub_status,
      details: `ZeroBounce: ${data.status} (${data.sub_status || 'none'})`,
    }
  } else if (data.status === 'do_not_mail') {
    return {
      status: 'invalid',
      response: data.sub_status,
      details: `ZeroBounce: do_not_mail (${data.sub_status || 'none'})`,
    }
  } else {
    return {
      status: 'unknown',
      response: data.sub_status,
      details: `ZeroBounce: ${data.status} (${data.sub_status || 'none'})`,
    }
  }
}

// ─── Abstract API ────────────────────────────────────────────────────────────
// Docs: https://app.abstractapi.com/api/email-validation/documentation
// Response:
//   {
//     "email": "...",
//     "autocorrect": "",
//     "deliverability": "DELIVERABLE" | "UNDELIVERABLE" | "RISKY" | "UNKNOWN",
//     "quality_score": "0.95",
//     "is_valid_format": true,
//     "is_free_email": true,
//     "is_disposable_email": false,
//     "is_role_email": false,
//     "is_catchall_email": false,
//     "is_mx_found": true,
//     "is_smtp_valid": true   ← this is the key field for SMTP mailbox check
//   }
async function verifyAbstract(email: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const apiKey = process.env.EMAIL_VERIFY_API_KEY!
  const url = `https://emails.abstractapi.com/v1/?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Abstract API ${res.status}: ${text}`)
  }
  const data: any = await res.json()

  // Abstract gives us is_smtp_valid directly — this is the SMTP mailbox check
  if (data.is_smtp_valid === true) {
    return {
      status: data.is_catchall_email ? 'catch-all' : 'valid',
      response: data.deliverability,
      details: `Abstract: ${data.deliverability} (smtp_valid=true)`,
    }
  } else if (data.is_smtp_valid === false) {
    return {
      status: 'invalid',
      response: data.deliverability,
      details: `Abstract: ${data.deliverability} (smtp_valid=false)`,
    }
  } else {
    // is_smtp_valid is null/undefined — couldn't verify
    return {
      status: 'unknown',
      response: data.deliverability,
      details: `Abstract: ${data.deliverability || 'unknown'} (smtp_valid=null)`,
    }
  }
}
