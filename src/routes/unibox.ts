import { Hono } from 'hono'
import { db } from '../lib/db'
import { markMessageRead } from '../lib/imap'

const app = new Hono()

// GET /api/unibox/replies — paginated list of inbound replies
app.get('/replies', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const unreadOnly = c.req.query('unread') === 'true'

  const where: any = {}
  if (unreadOnly) where.isRead = false

  const [replies, total] = await Promise.all([
    db.reply.findMany({
      where,
      include: {
        lead: {
          select: { id: true, email: true, companyName: true, campaignId: true, status: true, campaign: { select: { name: true } } },
        },
      },
      orderBy: { receivedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.reply.count({ where }),
  ])

  return c.json({ replies, total, page, limit, pages: Math.ceil(total / limit) })
})

// GET /api/unibox/replies/:id — single reply with full thread context
app.get('/replies/:id', async (c) => {
  const reply = await db.reply.findUnique({
    where: { id: c.req.param('id') },
    include: {
      lead: {
        include: {
          campaign: { select: { name: true } },
          scheduledEmails: {
            where: { status: 'sent' },
            select: { subject: true, body: true, sentAt: true, stepNumber: true },
            orderBy: { sentAt: 'asc' },
          },
          replies: { orderBy: { receivedAt: 'asc' } },
        },
      },
    },
  })
  if (!reply) return c.json({ error: 'Not found' }, 404)

  // Mark as read
  if (!reply.isRead) {
    await db.reply.update({ where: { id: reply.id }, data: { isRead: true } })
  }

  return c.json({ reply: { ...reply, isRead: true } })
})

// POST /api/unibox/replies/:id/reply — send a manual reply from Unibox
app.post('/replies/:id/reply', async (c) => {
  const replyId = c.req.param('id')
  const body = await c.req.json()
  const { fromAccountId, subject, text } = body
  if (!fromAccountId || !subject || !text) {
    return c.json({ error: 'fromAccountId, subject, text required' }, 400)
  }

  const reply = await db.reply.findUnique({
    where: { id: replyId },
    include: { lead: true },
  })
  if (!reply) return c.json({ error: 'Reply not found' }, 404)

  const account = await db.smtpAccount.findUnique({ where: { id: fromAccountId } })
  if (!account) return c.json({ error: 'Account not found' }, 404)

  const { sendMail } = await import('../lib/smtp')
  const { messageId } = await sendMail(account, {
    to: reply.fromEmail,
    subject,
    text,
    inReplyTo: reply.messageId || undefined,
  })

  // Log outbound reply
  await db.emailLog.create({
    data: {
      direction: 'outbound',
      smtpAccountId: account.id,
      leadId: reply.leadId,
      toEmail: reply.fromEmail,
      fromEmail: account.emailAddress,
      subject,
      body: text,
      messageId,
      inReplyTo: reply.messageId,
      isReply: true,
      sentAt: new Date(),
    },
  })

  return c.json({ ok: true, messageId })
})

// POST /api/unibox/check-inbound — poll all accounts for new replies
app.post('/check-inbound', async (c) => {
  const { processInboundReplies } = await import('../modules/unibox')
  const result = await processInboundReplies()
  return c.json(result)
})

// GET /api/unibox/stats
app.get('/stats', async (c) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [totalReplies, unreadReplies, repliedToday, suppressedCount] = await Promise.all([
    db.reply.count(),
    db.reply.count({ where: { isRead: false } }),
    db.reply.count({ where: { receivedAt: { gte: today } } }),
    db.suppressionList.count(),
  ])

  return c.json({ totalReplies, unreadReplies, repliedToday, suppressedCount })
})

export default app
