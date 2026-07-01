import { Hono } from 'hono'
import { db } from '../lib/db'

const app = new Hono()

// GET /api/warmup/stats — warm-up engine status
app.get('/stats', async (c) => {
  const accounts = await db.smtpAccount.findMany({
    where: { warmupEnabled: true },
    select: {
      id: true,
      label: true,
      emailAddress: true,
      warmupState: true,
      warmupDay: true,
      warmupTargetMax: true,
      warmupStartQty: true,
      warmupIncrement: true,
      warmupSentToday: true,
      status: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [sentToday, completedToday, failedToday, rescuedToday] = await Promise.all([
    db.warmupMessage.count({ where: { sentAt: { gte: today }, status: { in: ['sent', 'received', 'rescued', 'replied', 'completed'] } } }),
    db.warmupMessage.count({ where: { status: 'completed', repliedAt: { gte: today } } }),
    db.warmupMessage.count({ where: { status: 'failed', sentAt: { gte: today } } }),
    db.warmupMessage.count({ where: { rescuedAt: { gte: today } } }),
  ])

  return c.json({
    accounts,
    summary: {
      sentToday,
      completedToday,
      failedToday,
      rescuedToday,
      activeAccounts: accounts.filter((a) => a.warmupState !== 'suspended').length,
    },
  })
})

// POST /api/warmup/process — manually trigger warm-up batch
app.post('/process', async (c) => {
  const { processWarmupBatch } = await import('../modules/warmup')
  const result = await processWarmupBatch(20)
  return c.json(result)
})

// POST /api/warmup/check-inbound — poll IMAP for warm-up replies + rescue from spam
app.post('/check-inbound', async (c) => {
  const { processWarmupInbound } = await import('../modules/warmup')
  const result = await processWarmupInbound()
  return c.json(result)
})

// POST /api/warmup/:id/toggle — enable/disable warmup for an account
app.post('/:id/toggle', async (c) => {
  const id = c.req.param('id')
  const account = await db.smtpAccount.findUnique({ where: { id } })
  if (!account) return c.json({ error: 'Not found' }, 404)
  const updated = await db.smtpAccount.update({
    where: { id },
    data: { warmupEnabled: !account.warmupEnabled },
  })
  return c.json({ account: { ...updated, smtpPassEnc: undefined, imapPassEnc: undefined } })
})

export default app
