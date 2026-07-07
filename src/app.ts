import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authMiddleware } from './lib/auth'
import authRoutes from './routes/auth'
import accountRoutes from './routes/accounts'
import campaignRoutes from './routes/campaigns'
import csvRoutes from './routes/csv'
import dispatcherRoutes from './routes/dispatcher'
import warmupRoutes from './routes/warmup'
import uniboxRoutes from './routes/unibox'
import extrasRoutes from './routes/extras'
import exportsRoutes from './routes/exports'
import verifyRoutes from './routes/verify'

// ─── Process-level crash protection ───
process.on('uncaughtException', (err) => {
  console.error('[backend] uncaughtException (non-fatal):', err?.message || err)
})
process.on('unhandledRejection', (err) => {
  console.error('[backend] unhandledRejection (non-fatal):', err)
})

const app = new Hono()

// CORS — allows Vercel frontend to call Cloud Run backend in production
app.use('*', cors({
  origin: (origin) => {
    const allowed = (process.env.FRONTEND_URL || '').split(',').filter(Boolean)
    if (!origin || allowed.length === 0) return origin || '*'
    return allowed.includes(origin) ? origin : null
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}))

// ─── Request logger ───────────────────────────────────────────────────────
// Logs all mutating requests (POST/PUT/DELETE) + all verification-related
// requests (including GETs) so the user can see test/verify activity in
// the Render logs.
app.use('*', async (c, next) => {
  await next()
  const method = c.req.method
  const path = c.req.path
  const status = c.res.status
  const ts = new Date().toISOString()
  if (path === '/api/health') return
  // Log all mutating requests
  if (method !== 'GET' && method !== 'OPTIONS' && method !== 'HEAD') {
    console.log(`[${ts}] ${method} ${path} → ${status}`)
    return
  }
  // Also log verification-related GETs (test, providers, job-status, campaigns)
  if (method === 'GET' && path.startsWith('/api/verify/')) {
    console.log(`[${ts}] ${method} ${path} → ${status}`)
  }
})

// Health check (public)
app.get('/api/health', (c) => c.json({ ok: true, service: 'lead-dispatcher-backend', ts: Date.now() }))

// Public cron endpoint — called by Cloud Scheduler every 5 minutes.
// Protected by a secret in the URL path (CRON_SECRET env var).
app.all('/api/cron/:secret', async (c) => {
  const secret = c.req.param('secret')
  const expectedSecret = process.env.CRON_SECRET
  if (!expectedSecret || secret !== expectedSecret) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  try {
    const { processSendBatch } = await import('./modules/dispatcher')
    const { processWarmupBatch, processWarmupInbound } = await import('./modules/warmup')
    const { processInboundReplies } = await import('./modules/unibox')
    const { processVerificationBatch } = await import('./routes/verify')

    const sendResult = await processSendBatch(3).catch((e: any) => ({ error: e?.message }))
    const warmupResult = await processWarmupBatch(15).catch((e: any) => ({ error: e?.message }))
    const warmupInboundResult = await processWarmupInbound().catch((e: any) => ({ error: e?.message }))
    const replyResult = await processInboundReplies().catch((e: any) => ({ error: e?.message }))
    const verifyResult = await processVerificationBatch().catch((e: any) => ({ error: e?.message }))

    return c.json({
      ok: true,
      timestamp: new Date().toISOString(),
      results: {
        sends: sendResult,
        warmup: warmupResult,
        warmupInbound: warmupInboundResult,
        replies: replyResult,
        verification: verifyResult,
      },
    })
  } catch (e: any) {
    console.error('[cron] tick error:', e?.message)
    return c.json({ ok: false, error: e?.message }, 500)
  }
})

// Public auth routes (login, register) — no token required
app.route('/api/auth', authRoutes)

// ─── URL validation helper for click tracking ───────────────────────────────
// Blocks open-redirect / phishing vectors. Only allows http/https absolute
// URLs. Optionally restricts to the campaign's allowedClickDomains if the
// tracked ScheduledEmail's campaign has that field set.
function isSafeRedirectUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false
  // Reject obviously dangerous schemes
  if (/^(data:|javascript:|file:|vbscript:|about:|blob:|chrome:|chrome-extension:)/i.test(rawUrl)) {
    return false
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  // Must be http or https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  // Must have a hostname (no protocol-relative URLs)
  if (!parsed.hostname) return false
  // Reject localhost / private IPs / metadata endpoints (SSRF + phishing)
  const host = parsed.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '169.254.169.254' || // cloud metadata
    host.endsWith('.metadata.google.internal')
  ) {
    return false
  }
  return true
}

// Public tracking routes (email clients fetch these — no auth)
// GET /api/extras/t/o/:trackingId — open-tracking pixel
// GET /api/extras/t/c/:trackingId?url=... — click redirect (validated URL only)
app.get('/api/extras/t/o/:trackingId', async (c) => {
  const { db } = await import('./lib/db')
  const trackingId = c.req.param('trackingId')
  try {
    const email = await db.scheduledEmail.findUnique({ where: { trackingId } })
    if (email) {
      await db.scheduledEmail.update({
        where: { id: email.id },
        data: {
          openCount: { increment: 1 },
          openedAt: email.openedAt || new Date(),
        },
      })
    }
  } catch (e: any) {
    console.error('[tracking] open error:', e?.message)
  }
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  return new Response(gif, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  })
})

app.get('/api/extras/t/c/:trackingId', async (c) => {
  const { db } = await import('./lib/db')
  const trackingId = c.req.param('trackingId')
  const url = c.req.query('url')
  if (!url) return c.json({ error: 'url query param required' }, 400)

  // ─── Open-redirect defense ───
  // Only allow http/https absolute URLs. Block data:, javascript:, file:,
  // etc. Optionally restrict to campaign's allowedClickDomains if set.
  if (!isSafeRedirectUrl(url)) {
    return c.json({ error: 'Invalid or unsafe redirect URL' }, 400)
  }

  try {
    const email = await db.scheduledEmail.findUnique({
      where: { trackingId },
      include: { campaign: { select: { allowedClickDomains: true } } },
    })
    if (email) {
      // Optional: per-campaign allowlist
      const allow = email.campaign?.allowedClickDomains
      if (allow) {
        const allowed = allow.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        const targetHost = new URL(url).hostname.toLowerCase()
        const matchesAllow = allowed.some((d) => targetHost === d || targetHost.endsWith('.' + d))
        if (!matchesAllow) {
          return c.json({ error: 'URL not in campaign allowlist' }, 400)
        }
      }
      await db.scheduledEmail.update({
        where: { id: email.id },
        data: {
          clickCount: { increment: 1 },
          clickedAt: email.clickedAt || new Date(),
        },
      })
    }
  } catch (e: any) {
    console.error('[tracking] click error:', e?.message)
  }
  return c.redirect(url, 302)
})

// Public unsubscribe routes (lead clicks link in email — no auth)
app.get('/api/extras/unsubscribe/:leadId', async (c) => {
  const { db } = await import('./lib/db')
  const leadId = c.req.param('leadId')
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { id: true, email: true, companyName: true, status: true },
  })
  if (!lead) return c.json({ error: 'Invalid unsubscribe link' }, 404)
  return c.json({
    lead: {
      id: lead.id,
      email: lead.email.replace(/(.{2}).*(@.*)/, '$1***$2'),
      companyName: lead.companyName,
      alreadyUnsubscribed: lead.status === 'unsubscribed',
    },
  })
})
app.post('/api/extras/unsubscribe/:leadId', async (c) => {
  const { db } = await import('./lib/db')
  const leadId = c.req.param('leadId')
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { id: true, email: true, ownerId: true, campaignId: true, campaign: { select: { name: true } } },
  })
  if (!lead) return c.json({ error: 'Invalid unsubscribe link' }, 404)
  if (lead.email) {
    await db.suppressionList.upsert({
      where: { email_reason: { email: lead.email.toLowerCase(), reason: 'unsubscribe' } },
      create: { ownerId: lead.ownerId, email: lead.email.toLowerCase(), reason: 'unsubscribe', source: lead.campaign?.name || 'unsubscribe-link' },
      update: {},
    })
  }
  await db.lead.update({ where: { id: leadId }, data: { status: 'unsubscribed', unsubscribedAt: new Date() } })
  await db.scheduledEmail.updateMany({ where: { leadId, status: 'queued' }, data: { status: 'cancelled' } })
  return c.json({ ok: true, message: 'Unsubscribed successfully' })
})

// Protected routes — require Bearer token
const protectedApi = new Hono()
protectedApi.use('*', authMiddleware)
protectedApi.route('/accounts', accountRoutes)
protectedApi.route('/campaigns', campaignRoutes)
protectedApi.route('/csv', csvRoutes)
protectedApi.route('/dispatcher', dispatcherRoutes)
protectedApi.route('/warmup', warmupRoutes)
protectedApi.route('/unibox', uniboxRoutes)
protectedApi.route('/extras', extrasRoutes)
protectedApi.route('/exports', exportsRoutes)
protectedApi.route('/verify', verifyRoutes)
app.route('/api', protectedApi)

// 404
app.notFound((c) => c.json({ error: 'Not found' }, 404))

// ─── Error handler ───
// In production, strip internal error detail to avoid leaking stack traces
// and implementation hints to attackers. In dev, keep the detail for
// debugging. Always log the full error server-side.
app.onError((err, c) => {
  console.error('[backend] Unhandled error:', err)
  if (process.env.NODE_ENV === 'production') {
    return c.json({ error: 'Internal server error' }, 500)
  }
  return c.json({ error: 'Internal server error', detail: err?.message || String(err) }, 500)
})

export default app
