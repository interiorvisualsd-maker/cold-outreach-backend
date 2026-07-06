import { Hono } from 'hono'
import { db } from '../lib/db'
import { getUserId } from '../lib/auth'

const app = new Hono()

// GET /api/dispatcher/stats — current queue + account health summary
// (scoped to current user)
app.get('/stats', async (c) => {
  const userId = getUserId(c)
  const [queued, assigned, sending, sent, failed, cancelled] = await Promise.all([
    db.scheduledEmail.count({ where: { ownerId: userId, status: 'queued' } }),
    db.scheduledEmail.count({ where: { ownerId: userId, status: 'assigned' } }),
    db.scheduledEmail.count({ where: { ownerId: userId, status: 'sending' } }),
    db.scheduledEmail.count({ where: { ownerId: userId, status: 'sent' } }),
    db.scheduledEmail.count({ where: { ownerId: userId, status: 'failed' } }),
    db.scheduledEmail.count({ where: { ownerId: userId, status: 'cancelled' } }),
  ])

  const accounts = await db.smtpAccount.findMany({
    where: { ownerId: userId },
    select: {
      id: true,
      label: true,
      emailAddress: true,
      status: true,
      sentToday: true,
      warmupSentToday: true,
      dailyCap: true,
      warmupState: true,
      failureStreak: true,
      lastSentAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  const totalSentToday = accounts.reduce((s, a) => s + a.sentToday, 0)
  const totalCapacity = accounts.reduce((s, a) => s + (a.status === 'active' ? a.dailyCap : 0), 0)
  const activeAccounts = accounts.filter((a) => a.status === 'active').length

  return c.json({
    queue: { queued, assigned, sending, sent, failed, cancelled },
    accounts,
    summary: {
      totalSentToday,
      totalCapacity,
      activeAccounts,
      totalAccounts: accounts.length,
      utilization: totalCapacity > 0 ? Math.round((totalSentToday / totalCapacity) * 100) : 0,
    },
  })
})

// GET /api/dispatcher/queue — paginated queue view
app.get('/queue', async (c) => {
  const userId = getUserId(c)
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const status = c.req.query('status')

  const where: any = { ownerId: userId }
  if (status) where.status = status

  const [items, total] = await Promise.all([
    db.scheduledEmail.findMany({
      where,
      include: {
        lead: { select: { email: true, companyName: true } },
        campaign: { select: { name: true } },
      },
      orderBy: { scheduledAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.scheduledEmail.count({ where }),
  ])

  return c.json({ items, total, page, limit, pages: Math.ceil(total / limit) })
})

// POST /api/dispatcher/process — manually trigger a send batch
app.post('/process', async (c) => {
  const { processSendBatch } = await import('../modules/dispatcher')
  const result = await processSendBatch(3)
  return c.json(result)
})

// POST /api/dispatcher/reset-daily — reset daily counters
app.post('/reset-daily', async (c) => {
  const userId = getUserId(c)
  await db.smtpAccount.updateMany({
    where: { ownerId: userId },
    data: {
      sentToday: 0,
      warmupSentToday: 0,
      lastResetAt: new Date(),
      lastDailyResetAt: new Date(),
    },
  })
  return c.json({ ok: true })
})

export default app
