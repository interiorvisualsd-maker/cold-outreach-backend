// ─────────────────────────────────────────────────────────────────────────────
// Third-party email verification API integration
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS:
// Cloud hosts (Render, AWS, GCP, Azure, Heroku, Railway) block outbound
// port 25 to prevent spam. Direct SMTP mailbox verification (RCPT TO probe)
// requires port 25, so it's impossible from these hosts.
//
// SOLUTIONS SUPPORTED (pick one — all configured via env vars):
//
//   1. SELF-HOSTED PROXY (100% FREE) — recommended for open-source users
//      Deploy the smtp-proxy/ service on Fly.io (free tier, port 25 allowed).
//      The main backend calls your proxy via HTTPS.
//      Env vars: SMTP_PROXY_URL + SMTP_PROXY_SECRET
//      See smtp-proxy/README.md for setup.
//
//   2. THIRD-PARTY API (paid) — for users who don't want to self-host
//      Kickbox ($0.005/email)     → EMAIL_VERIFY_PROVIDER=kickbox
//      ZeroBounce ($0.006/email)  → EMAIL_VERIFY_PROVIDER=zerobounce
//      Abstract API ($0.009/email)→ EMAIL_VERIFY_PROVIDER=abstract
//      Env vars: EMAIL_VERIFY_PROVIDER + EMAIL_VERIFY_API_KEY
//
// PRIORITY ORDER (when multiple are configured):
//   1. SMTP_PROXY_URL (self-hosted, free) — checked first
//   2. EMAIL_VERIFY_PROVIDER (third-party, paid) — fallback
//   3. Direct SMTP (only works on hosts that allow port 25 — NOT Render)
//
// If nothing is configured, the caller falls back to direct SMTP which will
// fail on Render — leads will be marked RISKY because SMTP can't run.

import type { SmtpVerifyResult } from './emailVerify'

function getProxyConfig(): { url: string; secret: string } | null {
  const url = process.env.SMTP_PROXY_URL?.trim()
  const secret = process.env.SMTP_PROXY_SECRET?.trim()
  if (!url || !secret) return null
  return { url: url.replace(/\/$/, ''), secret } // trim trailing slash
}

function getProvider(): string | null {
  const p = process.env.EMAIL_VERIFY_PROVIDER?.toLowerCase().trim()
  const key = process.env.EMAIL_VERIFY_API_KEY?.trim()
  if (!p || !key || p === 'none' || p === 'direct') return null
  return p
}

/**
 * Check if ANY verification provider is configured (proxy OR third-party API).
 * Use this to decide whether to call verifyViaApi() or fall back to direct SMTP.
 */
export function hasApiProvider(): boolean {
  return getProxyConfig() !== null || getProvider() !== null
}

/**
 * Verify an email address via the configured provider (proxy or third-party API).
 * Returns a SmtpVerifyResult matching the shape of the direct SMTP verifier
 * so the caller can use either interchangeably.
 *
 * Throws on network/auth errors — caller should catch and treat as 'unknown'.
 */
export async function verifyViaApi(email: string): Promise<SmtpVerifyResult> {
  // ─── Priority 1: Self-hosted proxy (free) ───
  const proxy = getProxyConfig()
  if (proxy) {
    try {
      return await verifyViaProxy(email, proxy.url, proxy.secret)
    } catch (e: any) {
      console.error('[verify] proxy error:', e?.message)
      // Fall through to third-party API if proxy fails
      if (!getProvider()) throw e
    }
  }

  // ─── Priority 2: Third-party API (paid) ───
  const provider = getProvider()
  if (provider) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
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

  throw new Error('No verification provider configured (set SMTP_PROXY_URL or EMAIL_VERIFY_PROVIDER)')
}

// ─── Self-hosted proxy (Fly.io) ──────────────────────────────────────────────
// Calls your own SMTP proxy running on Fly.io. The proxy does the real SMTP
// RCPT TO check on port 25 (Fly.io allows it; Render doesn't).
//
// Request:  POST {proxyUrl}/verify
//           Headers: { X-Proxy-Secret: <secret>, Content-Type: application/json }
//           Body: { email: "...", checkCatchAll: true }
//
// Response: { status: "valid"|"invalid"|"unknown"|"catch-all", details: "...", catchAll: bool }
async function verifyViaProxy(email: string, proxyUrl: string, secret: string): Promise<SmtpVerifyResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000) // 20s — proxy does its own SMTP check

  try {
    const res = await fetch(`${proxyUrl}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Secret': secret,
      },
      body: JSON.stringify({ email, checkCatchAll: true }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (res.status === 401) {
        throw new Error(`Proxy auth failed — check SMTP_PROXY_SECRET matches the PROXY_SECRET set on Fly.io`)
      }
      throw new Error(`Proxy returned ${res.status}: ${text}`)
    }

    const data: any = await res.json()
    // Proxy returns status: 'valid' | 'invalid' | 'unknown' | 'catch-all'
    // Map to our SmtpVerifyResult shape
    return {
      status: data.status, // already matches our union type
      response: data.response,
      details: data.details || `Proxy: ${data.status}`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Kickbox (paid) ──────────────────────────────────────────────────────────
// Docs: https://docs.kickbox.com/v2.0/reference#verify-an-email
async function verifyKickbox(email: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const apiKey = process.env.EMAIL_VERIFY_API_KEY!
  const url = `https://api.kickbox.com/v2/verify?email=${encodeURIComponent(email)}&apikey=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Kickbox API ${res.status}: ${text}`)
  }
  const data: any = await res.json()

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

// ─── ZeroBounce (paid) ───────────────────────────────────────────────────────
async function verifyZeroBounce(email: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const apiKey = process.env.EMAIL_VERIFY_API_KEY!
  const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`ZeroBounce API ${res.status}: ${text}`)
  }
  const data: any = await res.json()

  if (data.status === 'valid') {
    return { status: 'valid', response: data.sub_status, details: `ZeroBounce: valid` }
  } else if (data.status === 'invalid') {
    return { status: 'invalid', response: data.sub_status, details: `ZeroBounce: invalid` }
  } else if (data.status === 'catch-all') {
    return { status: 'catch-all', response: data.sub_status, details: `ZeroBounce: catch-all` }
  } else if (data.status === 'spamtrap' || data.status === 'abuse' || data.status === 'do_not_mail') {
    return { status: 'invalid', response: data.sub_status, details: `ZeroBounce: ${data.status}` }
  } else {
    return { status: 'unknown', response: data.sub_status, details: `ZeroBounce: ${data.status}` }
  }
}

// ─── Abstract API (paid) ─────────────────────────────────────────────────────
async function verifyAbstract(email: string, signal: AbortSignal): Promise<SmtpVerifyResult> {
  const apiKey = process.env.EMAIL_VERIFY_API_KEY!
  const url = `https://emails.abstractapi.com/v1/?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`
  const res = await fetch(url, { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Abstract API ${res.status}: ${text}`)
  }
  const data: any = await res.json()

  if (data.is_smtp_valid === true) {
    return {
      status: data.is_catchall_email ? 'catch-all' : 'valid',
      response: data.deliverability,
      details: `Abstract: ${data.deliverability}`,
    }
  } else if (data.is_smtp_valid === false) {
    return { status: 'invalid', response: data.deliverability, details: `Abstract: ${data.deliverability}` }
  } else {
    return { status: 'unknown', response: data.deliverability, details: `Abstract: ${data.deliverability || 'unknown'}` }
  }
}

