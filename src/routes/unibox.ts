import { Hono } from 'hono'
import { db } from '../lib/db'
import { getUserId } from '../lib/auth'
import { markMessageRead } from '../lib/imap'

const app = new Hono()

// ─────────────────────────────────────────────────────────────────────────────
// UNIBOX — unified inbox for inbound replies + outbound sent emails.
// Two folders: /inbox (inbound) and /sent (outbound).
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/unibox/inbox — paginated inbound replies (scoped to current user).
// Also exposed as /api/unibox/replies for backwards compat.
async function handleInbox(c: any) {
  const userId = getUserId(c)
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const unreadOnly = c.req.query('unread') === 'true'

  const where: any = { lead: { ownerId: userId } }
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
}
app.get('/replies', handleInbox)
app.get('/inbox', handleInbox)

// GET /api/unibox/replies/:id — single reply with full thread context
app.get('/replies/:id', async (c) => {
  const userId = getUserId(c)
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
  if (!reply || reply.lead.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  if (!reply.isRead) {
    await db.reply.update({ where: { id: reply.id }, data: { isRead: true } })
  }

  return c.json({ reply: { ...reply, isRead: true } })
})

// POST /api/unibox/replies/:id/reply — send a manual reply from Unibox
app.post('/replies/:id/reply', async (c) => {
  const userId = getUserId(c)
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
  if (!reply || reply.lead.ownerId !== userId) return c.json({ error: 'Reply not found' }, 404)

  const account = await db.smtpAccount.findUnique({ where: { id: fromAccountId } })
  if (!account || account.ownerId !== userId) return c.json({ error: 'Account not found' }, 404)

  const { sendMail } = await import('../lib/smtp')
  const { messageId } = await sendMail(account, {
    to: reply.fromEmail,
    subject,
    text,
    inReplyTo: reply.messageId || undefined,
  })

  await db.emailLog.create({
    data: {
      ownerId: userId,
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

// ─────────────────────────────────────────────────────────────────────────────
// SENT FOLDER — outbound emails we've sent.
// Data model: ScheduledEmail already records outbound emails. We expose them
// here as the "Sent" folder. Filter by status='sent' (or 'failed'/'bounced'
// to show all attempted sends).
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/unibox/sent — paginated list of outbound emails
// Query params:
//   page, limit          — pagination
//   accountId            — filter by sending account
//   campaignId           — filter by campaign
//   status               — sent | failed | bounced | all (default: sent)
//   q                    — search subject / recipient
app.get('/sent', async (c) => {
  const userId = getUserId(c)
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const accountId = c.req.query('accountId')
  const campaignId = c.req.query('campaignId')
  const status = c.req.query('status') || 'sent'
  const q = c.req.query('q')

  const where: any = { ownerId: userId }
  if (accountId) where.smtpAccountId = accountId
  if (campaignId) where.campaignId = campaignId
  if (status && status !== 'all') {
    where.status = status
  } else if (status === 'all') {
    where.status = { in: ['sent', 'failed'] }
  } else {
    where.status = 'sent'
  }
  if (q) {
    where.OR = [
      { subject: { contains: q, mode: 'insensitive' } },
      { lead: { email: { contains: q, mode: 'insensitive' } } },
    ]
  }

  const [items, total] = await Promise.all([
    db.scheduledEmail.findMany({
      where,
      orderBy: { sentAt: 'desc' },
      skip: Math.max(0, (page - 1) * limit),
      take: limit,
      select: {
        id: true,
        subject: true,
        body: true,
        status: true,
        sentAt: true,
        scheduledAt: true,
        stepNumber: true,
        campaignId: true,
        leadId: true,
        smtpAccountId: true,
        messageId: true,
        openCount: true,
        openedAt: true,
        clickCount: true,
        clickedAt: true,
        lastError: true,
        failureReason: true,
        lead: { select: { id: true, email: true, companyName: true, campaign: { select: { name: true } } } },
        campaign: { select: { name: true } },
      },
    }),
    db.scheduledEmail.count({ where }),
  ])

  // Add fromEmail (denormalized) + preview (first 200 chars of body)
  const enriched = items.map((it) => {
    const preview = (it.body || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    return {
      id: it.id,
      subject: it.subject,
      preview,
      body: undefined, // omit full body in list view
      status: it.status,
      sentAt: it.sentAt,
      scheduledAt: it.scheduledAt,
      stepNumber: it.stepNumber,
      campaignId: it.campaignId,
      campaignName: it.campaign?.name,
      leadId: it.leadId,
      leadEmail: it.lead?.email,
      leadCompany: it.lead?.companyName,
      smtpAccountId: it.smtpAccountId,
      messageId: it.messageId,
      openCount: it.openCount,
      openedAt: it.openedAt,
      clickCount: it.clickCount,
      clickedAt: it.clickedAt,
      lastError: it.lastError,
      failureReason: it.failureReason,
    }
  })

  return c.json({ items: enriched, total, page, limit, pages: Math.ceil(total / limit) || 0 })
})

// GET /api/unibox/sent/:id — full outbound email body + tracking stats + lead timeline
app.get('/sent/:id', async (c) => {
  const userId = getUserId(c)
  const email = await db.scheduledEmail.findUnique({
    where: { id: c.req.param('id') },
    include: {
      lead: {
        select: {
          id: true, email: true, companyName: true, status: true,
          campaign: { select: { name: true } },
          scheduledEmails: {
            where: { status: 'sent' },
            select: { id: true, subject: true, body: true, sentAt: true, stepNumber: true, openCount: true, clickCount: true },
            orderBy: { sentAt: 'asc' },
          },
          replies: {
            orderBy: { receivedAt: 'asc' },
            select: { id: true, fromEmail: true, subject: true, body: true, receivedAt: true, sentiment: true, isRead: true },
          },
        },
      },
      campaign: { select: { name: true } },
    },
  })
  if (!email || email.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  // Fetch the fromEmail (account email) — we use the smtpAccountId from the row
  let fromEmail: string | null = null
  if (email.smtpAccountId) {
    const acc = await db.smtpAccount.findUnique({
      where: { id: email.smtpAccountId },
      select: { emailAddress: true },
    })
    fromEmail = acc?.emailAddress || null
  }

  return c.json({
    email: {
      id: email.id,
      subject: email.subject,
      body: email.body,
      status: email.status,
      sentAt: email.sentAt,
      scheduledAt: email.scheduledAt,
      stepNumber: email.stepNumber,
      campaignId: email.campaignId,
      campaignName: email.campaign?.name,
      leadId: email.leadId,
      lead: email.lead,
      fromEmail,
      messageId: email.messageId,
      openCount: email.openCount,
      openedAt: email.openedAt,
      clickCount: email.clickCount,
      clickedAt: email.clickedAt,
      lastError: email.lastError,
      failureReason: email.failureReason,
      attemptCount: email.attemptCount,
    },
  })
})

// GET /api/unibox/stats — extends the legacy /stats to include sent count
app.get('/stats', async (c) => {
  const userId = getUserId(c)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [totalReplies, unreadReplies, repliedToday, suppressedCount, totalSent, sentToday] = await Promise.all([
    db.reply.count({ where: { lead: { ownerId: userId } } }),
    db.reply.count({ where: { lead: { ownerId: userId }, isRead: false } }),
    db.reply.count({ where: { lead: { ownerId: userId }, receivedAt: { gte: today } } }),
    db.suppressionList.count({ where: { ownerId: userId } }),
    db.scheduledEmail.count({ where: { ownerId: userId, status: 'sent' } }),
    db.scheduledEmail.count({
      where: { ownerId: userId, status: 'sent', sentAt: { gte: today } },
    }),
  ])

  return c.json({
    totalReplies,
    unreadReplies,
    repliedToday,
    suppressedCount,
    totalSent,
    sentToday,
  })
})

export default app
