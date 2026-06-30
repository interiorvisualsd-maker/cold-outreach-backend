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

// Protected routes — require Bearer token
const protectedApi = new Hono()
protectedApi.use('*', authMiddleware)
protectedApi.route('/accounts', accountRoutes)
protectedApi.route('/campaigns', campaignRoutes)
protectedApi.route('/csv', csvRoutes)
protectedApi.route('/dispatcher', dispatcherRoutes)
protectedApi.route('/warmup', warmupRoutes)
protectedApi.route('/unibox', uniboxRoutes)
app.route('/api', protectedApi)

// 404
app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  console.error('[backend] Unhandled error:', err)
  return c.json({ error: 'Internal server error', detail: err.message }, 500)
})

export default app
