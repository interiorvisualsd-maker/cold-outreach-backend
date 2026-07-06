// Lightweight in-memory rate limiter for Hono.
//
// We don't pull in `hono-rate-limiter` because its API changed across
// versions and it adds a dependency for something this small. This
// implementation is process-local (not shared across instances), which is
// fine for the worker-on-Render deployment model. For multi-instance
// production, swap the store for Redis.
//
// Two windows:
//   - per-IP+path:    X requests per WINDOW_MS per client IP
//   - per-IP+key:     X requests per WINDOW_MS per (IP, key) — used for
//                     per-email login throttling (key = email address)
//
// On the 4th+ request OVER the limit, return 429 with Retry-After header.

const WINDOW_MS = 15 * 60 * 1000 // 15 minutes

interface Bucket {
  count: number
  firstSeenAt: number
}

// Map<key, Bucket>
const buckets = new Map<string, Bucket>()

// Periodic GC so the map doesn't grow unboundedly.
let lastGc = Date.now()
function gc() {
  const now = Date.now()
  if (now - lastGc < 5 * 60 * 1000) return
  lastGc = now
  for (const [k, b] of buckets) {
    if (now - b.firstSeenAt > WINDOW_MS) buckets.delete(k)
  }
}

interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSec: number
}

function check(key: string, limit: number): RateLimitResult {
  gc()
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || now - b.firstSeenAt > WINDOW_MS) {
    buckets.set(key, { count: 1, firstSeenAt: now })
    return { allowed: true, remaining: limit - 1, retryAfterSec: 0 }
  }
  b.count++
  if (b.count > limit) {
    const retryAfterSec = Math.ceil((b.firstSeenAt + WINDOW_MS - now) / 1000)
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, retryAfterSec) }
  }
  return { allowed: true, remaining: limit - b.count, retryAfterSec: 0 }
}

// Hono middleware factory: limit by client IP (and optionally a per-request
// key extracted from the body, e.g. email address).
//
//   const limiter = rateLimit({ limit: 10, keyFn: (c) => c.req.header('x-forwarded-for') })
//   app.post('/login', limiter, handler)
//
// For login, we use a more complex setup with two limits (per-IP and
// per-IP+email). See `authRateLimit` below.
export function rateLimit(opts: {
  limit: number
  windowMs?: number
  keyFn: (c: any) => string | Promise<string>
}): (c: any, next: any) => Promise<Response | void> {
  return async (c: any, next: any) => {
    const key = await opts.keyFn(c)
    const result = check(key, opts.limit)
    c.header('X-RateLimit-Limit', String(opts.limit))
    c.header('X-RateLimit-Remaining', String(Math.max(0, result.remaining)))
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSec))
      return c.json(
        { error: 'Too many requests. Try again in ' + result.retryAfterSec + ' seconds.' },
        429
      )
    }
    await next()
  }
}

// Extract client IP from common proxy headers (Render uses x-forwarded-for).
export function getClientIp(c: any): string {
  const xff = c.req?.header?.('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  const real = c.req?.header?.('x-real-ip')
  if (real) return real.trim()
  return c.env?.remoteAddr?.toString?.() || '0.0.0.0'
}

// Combined per-IP + per-(IP,email) login limiter. Body must be parsed before
// this runs (we read it lazily; if it fails we just use IP-only).
//
// Limits:
//   - 10 per 15 min per IP
//   - 5  per 15 min per (IP, email)
//
// On 4th failure (i.e. the limit is exceeded), returns 429 with Retry-After.
export function authRateLimit() {
  return async (c: any, next: any) => {
    const ip = getClientIp(c)

    // Try to read email from body without consuming it for the next handler.
    let email = ''
    try {
      const raw = await c.req.text()
      // Re-inject the body so downstream handlers can read it again
      c.req.raw = new Request(c.req.raw, { body: raw, method: c.req.method })
      try {
        const parsed = JSON.parse(raw)
        email = String(parsed?.email || '').toLowerCase().trim()
      } catch {
        /* not JSON — ignore */
      }
    } catch {
      /* read failed — IP-only throttling */
    }

    const ipKey = `auth:ip:${ip}`
    const ipResult = check(ipKey, 10)
    if (!ipResult.allowed) {
      c.header('Retry-After', String(ipResult.retryAfterSec))
      return c.json({ error: 'Too many login attempts from this IP. Try again later.' }, 429)
    }

    if (email) {
      const emailKey = `auth:ipemail:${ip}:${email}`
      const emailResult = check(emailKey, 5)
      if (!emailResult.allowed) {
        c.header('Retry-After', String(emailResult.retryAfterSec))
        return c.json(
          { error: 'Too many login attempts for this email. Try again later.' },
          429
        )
      }
    }

    await next()
  }
}
