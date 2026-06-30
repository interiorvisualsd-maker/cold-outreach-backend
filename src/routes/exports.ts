import { Hono } from 'hono'
import { db } from '../lib/db'

const app = new Hono()

// ─────────────────────────────────────────────────────────────────────────────
// CSV EXPORT ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

function toCsv(rows: Record<string, any>[], headers?: string[]): string {
  if (rows.length === 0 && !headers) return ''
  const cols = headers || Object.keys(rows[0] || {})
  const escape = (v: any) => {
    if (v === null || v === undefined) return ''
    const s = String(v).replace(/"/g, '""')
    return /[",\n\r]/.test(s) ? `"${s}"` : s
  }
  const headerLine = cols.join(',')
  const dataLines = rows.map((r) => cols.map((c) => escape(r[c])).join(','))
  return [headerLine, ...dataLines].join('\n')
}

function csvResponse(csv: string, filename: string) {
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

// GET /api/extras/export/leads?campaignId=...&status=...
app.get('/export/leads', async (c) => {
  const campaignId = c.req.query('campaignId')
  const status = c.req.query('status')
  const where: any = {}
  if (campaignId) where.campaignId = campaignId
  if (status) where.status = status
  const leads = await db.lead.findMany({
    where,
    include: { campaign: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  const rows = leads.map((l) => ({
    campaign: l.campaign?.name || '',
    email: l.email,
    company_name: l.companyName || '',
    website: l.website || '',
    state: l.state || '',
    industry: l.industry || '',
    status: l.status,
    current_step: l.currentStep,
    last_step_sent_at: l.lastStepSentAt?.toISOString() || '',
    replied_at: l.repliedAt?.toISOString() || '',
    bounced_at: l.bouncedAt?.toISOString() || '',
    unsubscribed_at: l.unsubscribedAt?.toISOString() || '',
    created_at: l.createdAt.toISOString(),
  }))
  const csv = toCsv(rows)
  return csvResponse(csv, `leads-${new Date().toISOString().slice(0, 10)}.csv`)
})

// GET /api/extras/export/replies?sentiment=...
app.get('/export/replies', async (c) => {
  const sentiment = c.req.query('sentiment')
  const where: any = {}
  if (sentiment) where.sentiment = sentiment
  const replies = await db.reply.findMany({
    where,
    include: { lead: { select: { email: true, companyName: true, campaign: { select: { name: true } } } } },
    orderBy: { receivedAt: 'desc' },
  })
  const rows = replies.map((r) => ({
    received_at: r.receivedAt.toISOString(),
    from_email: r.fromEmail,
    to_email: r.toEmail,
    lead_email: r.lead?.email || '',
    company: r.lead?.companyName || '',
    campaign: r.lead?.campaign?.name || '',
    subject: r.subject,
    body: r.body,
    sentiment: r.sentiment || '',
    is_read: r.isRead ? 'yes' : 'no',
  }))
  const csv = toCsv(rows)
  return csvResponse(csv, `replies-${new Date().toISOString().slice(0, 10)}.csv`)
})

// GET /api/extras/export/suppression
app.get('/export/suppression', async (c) => {
  const items = await db.suppressionList.findMany({ orderBy: { createdAt: 'desc' } })
  const rows = items.map((s) => ({
    email: s.email,
    reason: s.reason,
    source: s.source || '',
    created_at: s.createdAt.toISOString(),
  }))
  const csv = toCsv(rows)
  return csvResponse(csv, `suppression-${new Date().toISOString().slice(0, 10)}.csv`)
})

// GET /api/extras/export/queue?status=...&campaignId=...
app.get('/export/queue', async (c) => {
  const status = c.req.query('status')
  const campaignId = c.req.query('campaignId')
  const where: any = {}
  if (status) where.status = status
  if (campaignId) where.campaignId = campaignId
  const items = await db.scheduledEmail.findMany({
    where,
    include: { lead: { select: { email: true, companyName: true } }, campaign: { select: { name: true } } },
    orderBy: { scheduledAt: 'desc' },
    take: 5000,
  })
  const rows = items.map((q) => ({
    campaign: q.campaign?.name || '',
    lead_email: q.lead?.email || '',
    company: q.lead?.companyName || '',
    step: q.stepNumber,
    subject: q.subject,
    status: q.status,
    scheduled_at: q.scheduledAt.toISOString(),
    sent_at: q.sentAt?.toISOString() || '',
    opened: q.openCount > 0 ? 'yes' : 'no',
    open_count: q.openCount,
    clicked: q.clickCount > 0 ? 'yes' : 'no',
    click_count: q.clickCount,
    error: q.lastError || '',
  }))
  const csv = toCsv(rows)
  return csvResponse(csv, `queue-${new Date().toISOString().slice(0, 10)}.csv`)
})

// ─────────────────────────────────────────────────────────────────────────────
// BULK LEAD ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/extras/leads/bulk — action: suppress | delete | requeue | cancel
app.post('/leads/bulk', async (c) => {
  const body = await c.req.json()
  const { leadIds, action } = body as { leadIds: string[]; action: string }
  if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
    return c.json({ error: 'leadIds array required' }, 400)
  }
  if (!['suppress', 'delete', 'requeue', 'cancel'].includes(action)) {
    return c.json({ error: 'Invalid action. Use: suppress, delete, requeue, cancel' }, 400)
  }

  let affected = 0

  if (action === 'suppress') {
    const leads = await db.lead.findMany({
      where: { id: { in: leadIds } },
      select: { id: true, email: true },
    })
    for (const lead of leads) {
      await db.suppressionList.upsert({
        where: { email_reason: { email: lead.email.toLowerCase(), reason: 'manual' } },
        create: { email: lead.email.toLowerCase(), reason: 'manual', source: 'bulk-action' },
        update: {},
      })
    }
    await db.lead.updateMany({
      where: { id: { in: leadIds } },
      data: { status: 'suppressed' },
    })
    await db.scheduledEmail.updateMany({
      where: { leadId: { in: leadIds }, status: 'queued' },
      data: { status: 'cancelled' },
    })
    affected = leads.length
  } else if (action === 'delete') {
    // Cascade delete handles scheduledEmails + replies
    const result = await db.lead.deleteMany({ where: { id: { in: leadIds } } })
    affected = result.count
  } else if (action === 'requeue') {
    // Re-queue step 1 for leads that are pending or had errors
    const leads = await db.lead.findMany({
      where: { id: { in: leadIds } },
      include: { campaign: { include: { steps: true } } },
    })
    for (const lead of leads) {
      const step1 = lead.campaign.steps.find((s) => s.stepNumber === 1)
      if (!step1) continue
      // Cancel existing queued for this lead
      await db.scheduledEmail.updateMany({
        where: { leadId: lead.id, status: 'queued' },
        data: { status: 'cancelled' },
      })
      await db.scheduledEmail.create({
        data: {
          campaignId: lead.campaignId,
          leadId: lead.id,
          stepNumber: 1,
          subject: lead.outreachSubject || step1.subject,
          body: lead.initialOutreach || step1.body,
          scheduledAt: new Date(Date.now() + Math.random() * 60 * 60 * 1000),
        },
      })
      await db.lead.update({
        where: { id: lead.id },
        data: { status: 'pending', currentStep: 0, lastStepSentAt: null },
      })
      affected++
    }
  } else if (action === 'cancel') {
    const result = await db.scheduledEmail.updateMany({
      where: { leadId: { in: leadIds }, status: 'queued' },
      data: { status: 'cancelled' },
    })
    affected = result.count
  }

  return c.json({ ok: true, action, affected })
})

// ─────────────────────────────────────────────────────────────────────────────
// OPEN / CLICK TRACKING
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/extras/t/o/:trackingId — tracking pixel (1x1 transparent GIF)
app.get('/t/o/:trackingId', async (c) => {
  const trackingId = c.req.param('trackingId')
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
  // 1x1 transparent GIF
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

// GET /api/extras/t/c/:trackingId?url=... — click redirect
app.get('/t/c/:trackingId', async (c) => {
  const trackingId = c.req.param('trackingId')
  const url = c.req.query('url')
  if (!url) return c.json({ error: 'url query param required' }, 400)
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
  return c.redirect(url)
})

// ─────────────────────────────────────────────────────────────────────────────
// PER-ACCOUNT WARMUP HISTORY (30-day trend)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/warmup-history/:accountId', async (c) => {
  const accountId = c.req.param('accountId')
  const account = await db.smtpAccount.findUnique({ where: { id: accountId } })
  if (!account) return c.json({ error: 'Not found' }, 404)

  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const messages = await db.warmupMessage.findMany({
    where: {
      OR: [{ fromAccountId: accountId }, { toAccountId: accountId }],
      sentAt: { gte: thirtyDaysAgo },
    },
    select: { sentAt: true, status: true, fromAccountId: true, toAccountId: true, rescuedAt: true },
  })

  // Build 30-day series
  const series: { date: string; sent: number; received: number; rescued: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now)
    day.setHours(0, 0, 0, 0)
    day.setDate(day.getDate() - i)
    const nextDay = new Date(day)
    nextDay.setDate(nextDay.getDate() + 1)
    const dayMsgs = messages.filter((m) => m.sentAt && m.sentAt >= day && m.sentAt < nextDay)
    series.push({
      date: day.toISOString().slice(0, 10),
      sent: dayMsgs.filter((m) => m.fromAccountId === accountId).length,
      received: dayMsgs.filter((m) => m.toAccountId === accountId).length,
      rescued: dayMsgs.filter((m) => m.toAccountId === accountId && m.rescuedAt).length,
    })
  }

  const totalSent = series.reduce((s, d) => s + d.sent, 0)
  const totalReceived = series.reduce((s, d) => s + d.received, 0)
  const totalRescued = series.reduce((s, d) => s + d.rescued, 0)

  return c.json({
    account: { id: account.id, label: account.label, emailAddress: account.emailAddress },
    series,
    summary: { totalSent, totalReceived, totalRescued, avgPerDay: Math.round(totalSent / 30 * 10) / 10 },
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN ANALYTICS (per-campaign detailed stats)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/campaign-analytics/:id', async (c) => {
  const campaignId = c.req.param('id')
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    include: { steps: true },
  })
  if (!campaign) return c.json({ error: 'Not found' }, 404)

  const [leads, emails, replies] = await Promise.all([
    db.lead.findMany({ where: { campaignId }, select: { status: true } }),
    db.scheduledEmail.findMany({
      where: { campaignId },
      select: { status: true, sentAt: true, openCount: true, clickCount: true, openedAt: true, clickedAt: true },
    }),
    db.reply.findMany({
      where: { lead: { campaignId } },
      select: { sentiment: true, receivedAt: true },
    }),
  ])

  const leadStatusBreakdown = leads.reduce((acc, l) => {
    acc[l.status] = (acc[l.status] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  const sentCount = emails.filter((e) => e.status === 'sent').length
  const openedCount = emails.filter((e) => e.openCount > 0).length
  const clickedCount = emails.filter((e) => e.clickCount > 0).length
  const openRate = sentCount > 0 ? Math.round((openedCount / sentCount) * 1000) / 10 : 0
  const clickRate = sentCount > 0 ? Math.round((clickedCount / sentCount) * 1000) / 10 : 0
  const replyRate = sentCount > 0 ? Math.round((replies.length / sentCount) * 1000) / 10 : 0

  const sentimentBreakdown = replies.reduce((acc, r) => {
    const k = r.sentiment || 'untagged'
    acc[k] = (acc[k] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  // 7-day trend for this campaign
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const recentSent = emails.filter((e) => e.sentAt && e.sentAt >= sevenDaysAgo)
  const trend: { date: string; sent: number; opened: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const day = new Date()
    day.setHours(0, 0, 0, 0)
    day.setDate(day.getDate() - i)
    const nextDay = new Date(day)
    nextDay.setDate(nextDay.getDate() + 1)
    const dayEmails = recentSent.filter((e) => e.sentAt! >= day && e.sentAt! < nextDay)
    trend.push({
      date: day.toISOString().slice(0, 10),
      sent: dayEmails.length,
      opened: dayEmails.filter((e) => e.openCount > 0).length,
    })
  }

  return c.json({
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status, totalLeads: campaign.totalLeads },
    leadStatusBreakdown,
    funnel: {
      totalLeads: leads.length,
      sent: sentCount,
      opened: openedCount,
      clicked: clickedCount,
      replied: replies.length,
      openRate,
      clickRate,
      replyRate,
    },
    sentimentBreakdown,
    trend,
    stepCount: campaign.steps.length,
  })
})

export default app
