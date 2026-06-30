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

// Health check (public)
app.get('/api/health', (c) => c.json({ ok: true, service: 'lead-dispatcher-backend', ts: Date.now() }))

// Public auth routes (login, register) — no token required
app.route('/api/auth', authRoutes)

// Public tracking routes (email clients fetch these — no auth)
// GET /api/extras/t/o/:trackingId — open tracking pixel (1x1 GIF)
// GET /api/extras/t/c/:trackingId?url=... — click redirect
app.get('/api/extras/t/o/:trackingId', async (c) => {
  const { default: exportsRoutes } = await import('./routes/exports')
  // Delegate to the exports route handler — but it's defined as a sub-app.
  // Simpler: handle inline here.
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
  try {
    const email = await db.scheduledEmail.findUnique({ where: { trackingId } })
    if (email) {
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
  return c.redirect(url)
})

// Public unsubscribe routes (lead clicks link in email — no auth)
// GET /api/extras/unsubscribe/:leadId — check if lead exists (for landing page)
// POST /api/extras/unsubscribe/:leadId — actually unsubscribe
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
    select: { id: true, email: true, campaignId: true, campaign: { select: { name: true } } },
  })
  if (!lead) return c.json({ error: 'Invalid unsubscribe link' }, 404)
  if (lead.email) {
    await db.suppressionList.upsert({
      where: { email_reason: { email: lead.email.toLowerCase(), reason: 'unsubscribe' } },
      create: { email: lead.email.toLowerCase(), reason: 'unsubscribe', source: lead.campaign?.name || 'unsubscribe-link' },
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
app.route('/api', protectedApi)

// 404
app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  console.error('[backend] Unhandled error:', err)
  return c.json({ error: 'Internal server error', detail: err.message }, 500)
})

export default app
