import { Hono } from 'hono'
import crypto from 'node:crypto'
import { db } from '../lib/db'
import { getUserId } from '../lib/auth'

const app = new Hono()

// ─────────────────────────────────────────────────────────────────────────────
// CSV EXPORT ENDPOINTS — scoped to current user.
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
  const userId = getUserId(c)
  const campaignId = c.req.query('campaignId')
  const status = c.req.query('status')
  const where: any = { ownerId: userId }
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
  const userId = getUserId(c)
  const sentiment = c.req.query('sentiment')
  const where: any = { lead: { ownerId: userId } }
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
  const userId = getUserId(c)
  const items = await db.suppressionList.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: 'desc' },
  })
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
  const userId = getUserId(c)
  const status = c.req.query('status')
  const campaignId = c.req.query('campaignId')
  const where: any = { ownerId: userId }
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
// BULK LEAD ACTIONS — scoped to current user. All multi-step actions are
// wrapped in transactions for atomicity (no partial writes).
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/extras/leads/bulk — action: suppress | delete | requeue | cancel
app.post('/leads/bulk', async (c) => {
  const userId = getUserId(c)
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
      where: { id: { in: leadIds }, ownerId: userId },
      select: { id: true, email: true },
    })
    await db.$transaction(async (tx) => {
      for (const lead of leads) {
        await tx.suppressionList.upsert({
          where: { email_reason: { email: lead.email.toLowerCase(), reason: 'manual' } },
          create: { ownerId: userId, email: lead.email.toLowerCase(), reason: 'manual', source: 'bulk-action' },
          update: {},
        })
      }
      await tx.lead.updateMany({
        where: { id: { in: leadIds }, ownerId: userId },
        data: { status: 'suppressed' },
      })
      await tx.scheduledEmail.updateMany({
        where: { leadId: { in: leadIds }, ownerId: userId, status: 'queued' },
        data: { status: 'cancelled' },
      })
    })
    affected = leads.length
  } else if (action === 'delete') {
    // Cascade delete handles scheduledEmails + replies
    const result = await db.lead.deleteMany({ where: { id: { in: leadIds }, ownerId: userId } })
    affected = result.count
  } else if (action === 'requeue') {
    // Re-queue step 1 for leads that are pending or had errors.
    // Wrapped in a transaction so we don't end up with stale queued rows + no
    // new ones (or vice versa) if the create fails partway through.
    const leads = await db.lead.findMany({
      where: { id: { in: leadIds }, ownerId: userId },
      include: { campaign: { include: { steps: true } } },
    })
    for (const lead of leads) {
      const step1 = lead.campaign.steps.find((s) => s.stepNumber === 1)
      if (!step1) continue
      await db.$transaction(async (tx) => {
        await tx.scheduledEmail.updateMany({
          where: { leadId: lead.id, ownerId: userId, status: 'queued' },
          data: { status: 'cancelled' },
        })
        await tx.scheduledEmail.create({
          data: {
            campaignId: lead.campaignId,
            leadId: lead.id,
            ownerId: userId,
            stepNumber: 1,
            subject: lead.outreachSubject || step1.subject,
            body: lead.initialOutreach || step1.body,
            scheduledAt: new Date(Date.now() + Math.random() * 60 * 60 * 1000),
            trackingId: crypto.randomUUID(),
          },
        })
        await tx.lead.update({
          where: { id: lead.id },
          data: { status: 'pending', currentStep: 0, lastStepSentAt: null },
        })
      })
      affected++
    }
  } else if (action === 'cancel') {
    const result = await db.scheduledEmail.updateMany({
      where: { leadId: { in: leadIds }, ownerId: userId, status: 'queued' },
      data: { status: 'cancelled' },
    })
    affected = result.count
  }

  return c.json({ ok: true, action, affected })
})

// POST /api/extras/leads/:id/suppress — suppress a single lead
app.post('/leads/:id/suppress', async (c) => {
  const userId = getUserId(c)
  const leadId = c.req.param('id')
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { id: true, ownerId: true, email: true, campaign: { select: { name: true } } },
  })
  if (!lead || lead.ownerId !== userId) return c.json({ error: 'Lead not found' }, 404)
  if (!lead.email) return c.json({ error: 'Lead has no email' }, 400)

  const email = lead.email.toLowerCase()
  await db.$transaction(async (tx) => {
    await tx.suppressionList.upsert({
      where: { email_reason: { email, reason: 'manual' } },
      create: { ownerId: userId, email, reason: 'manual', source: lead.campaign?.name || 'manual-suppress' },
      update: {},
    })
    await tx.lead.update({ where: { id: leadId }, data: { status: 'suppressed' } })
    await tx.scheduledEmail.updateMany({
      where: { leadId, ownerId: userId, status: 'queued' },
      data: { status: 'cancelled' },
    })
  })
  return c.json({ ok: true, leadId, email, status: 'suppressed' })
})

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY verification endpoint — kept for backwards compat with the
// frontend's old "Verify Emails (Deep)" loop. New code should use
// POST /api/verify/campaign/:id (async, queue-based, 10-layer verification).
// ─────────────────────────────────────────────────────────────────────────────

app.post('/leads/verify', async (c) => {
  const userId = getUserId(c)
  const body = await c.req.json()
  const { campaignId, mode = 'quick', force = false } = body as {
    campaignId: string
    mode: 'quick' | 'deep'
    force?: boolean
  }

  if (!campaignId) return c.json({ error: 'campaignId required' }, 400)
  if (!['quick', 'deep'].includes(mode)) {
    return c.json({ error: 'mode must be "quick" or "deep"' }, 400)
  }

  // Verify campaign ownership
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } })
  if (!campaign || campaign.ownerId !== userId) {
    return c.json({ error: 'Campaign not found' }, 404)
  }

  const pendingWhere = force
    ? { campaignId, ownerId: userId, status: 'pending' as const }
    : {
        campaignId,
        ownerId: userId,
        status: 'pending' as const,
        verificationStatus: null as string | null,
      }

  const totalPending = await db.lead.count({ where: pendingWhere })
  if (totalPending === 0) {
    return c.json({
      ok: true, mode, scanned: 0, totalPending: 0, remainingPending: 0,
      valid: 0, invalid: 0, warnings: 0, warningReasons: {},
      errors: 0, suppressed: 0, invalidReasons: {},
    })
  }

  const { quickVerify, deepVerify } = await import('../lib/emailVerify')

  let valid = 0
  let invalid = 0
  let errors = 0
  let warningsCount = 0
  const invalidReasons: Record<string, number> = {}
  const warningReasons: Record<string, number> = {}
  const leadUpdates: {
    id: string
    status: 'VERIFIED' | 'RISKY' | 'BAD'
    reason?: string
    checks: Record<string, string>
  }[] = []
  const suppressedEmails: { email: string; reason: string }[] = []

  const BATCH_SIZE = mode === 'deep' ? 50 : 500
  const leads = await db.lead.findMany({
    where: pendingWhere,
    select: { id: true, email: true, campaign: { select: { name: true } } },
    take: BATCH_SIZE,
    orderBy: { id: 'asc' },
  })

  const now = new Date()

  for (const lead of leads) {
    try {
      const result = mode === 'deep'
        ? await deepVerify(lead.email)
        : await quickVerify(lead.email)

      const checks: Record<string, string> = {}
      checks.format = result.layers?.syntax?.ok === false ? 'fail' : 'pass'
      checks.disposable = result.layers?.disposable ? 'fail' : 'pass'
      checks.role = result.layers?.role ? 'warn' : 'pass'
      checks.free = result.layers?.free ? 'warn' : 'pass'
      checks.mx = result.layers?.mx?.ok === false ? 'fail' : 'pass'
      if (mode === 'deep') {
        const smtp = result.layers?.smtp
        if (smtp?.status === 'invalid') checks.smtp = 'fail'
        else if (smtp?.status === 'valid') checks.smtp = 'pass'
        else if (smtp?.status === 'catch-all') checks.smtp = 'warn'
        else checks.smtp = 'skip'
      } else {
        checks.smtp = 'skip'
      }

      const newStatus = result.status // 'VERIFIED' | 'RISKY' | 'BAD'
      leadUpdates.push({ id: lead.id, status: newStatus, reason: result.reason, checks })

      if (newStatus === 'VERIFIED') valid++
      else if (newStatus === 'RISKY') {
        warningsCount++
        const reason = result.reason || 'risky'
        warningReasons[reason] = (warningReasons[reason] || 0) + 1
      } else {
        invalid++
        const reasonKey = result.reason || 'unknown'
        invalidReasons[reasonKey] = (invalidReasons[reasonKey] || 0) + 1
        suppressedEmails.push({
          email: lead.email.toLowerCase(),
          reason: result.reason || 'verification_failed',
        })
      }
    } catch {
      errors++
    }
  }

  for (const u of leadUpdates) {
    try {
      await db.lead.update({
        where: { id: u.id },
        data: {
          verificationStatus: u.status,
          verificationMode: mode,
          verificationReason: u.reason || null,
          verificationChecks: JSON.stringify(u.checks),
          verifiedAt: now,
        },
      })
    } catch {
      // non-fatal
    }
  }

  let suppressed = 0
  for (const entry of suppressedEmails) {
    try {
      await db.suppressionList.upsert({
        where: { email_reason: { email: entry.email, reason: 'auto:verification:bad' } },
        create: {
          ownerId: userId,
          email: entry.email,
          reason: 'auto:verification:bad',
          source: `email-verification (${entry.reason})`,
        },
        update: {},
      })
      await db.lead.updateMany({
        where: { email: { equals: entry.email, mode: 'insensitive' }, ownerId: userId, campaignId },
        data: { status: 'bounced', bouncedAt: new Date() },
      })
      await db.scheduledEmail.updateMany({
        where: {
          lead: { email: { equals: entry.email, mode: 'insensitive' }, ownerId: userId },
          status: 'queued',
        },
        data: { status: 'cancelled' },
      })
      suppressed++
    } catch {
      // continue
    }
  }

  const remainingPending = await db.lead.count({ where: pendingWhere })

  return c.json({
    ok: true,
    mode,
    scanned: leads.length,
    totalPending,
    remainingPending,
    valid,
    invalid,
    warnings: warningsCount,
    warningReasons,
    errors,
    suppressed,
    invalidReasons,
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// OPEN / CLICK TRACKING — duplicated here for backwards compat with the
// frontend's old /api/extras/t/o/:trackingId and /api/extras/t/c/:trackingId
// URLs. The canonical handlers now live in src/app.ts (public, no auth) so
// email clients can fetch them without a Bearer token. These authed routes
// are kept for the frontend's "test tracking" buttons.
// ─────────────────────────────────────────────────────────────────────────────

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

app.get('/t/c/:trackingId', async (c) => {
  const trackingId = c.req.param('trackingId')
  const url = c.req.query('url')
  if (!url) return c.json({ error: 'url query param required' }, 400)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return c.json({ error: 'Invalid URL' }, 400)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return c.json({ error: 'Unsafe redirect URL' }, 400)
  }
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
  return c.redirect(url, 302)
})

// ─────────────────────────────────────────────────────────────────────────────
// PER-ACCOUNT WARMUP HISTORY (30-day trend) — scoped to current user
// ─────────────────────────────────────────────────────────────────────────────

app.get('/warmup-history/:accountId', async (c) => {
  const userId = getUserId(c)
  const accountId = c.req.param('accountId')
  const account = await db.smtpAccount.findUnique({ where: { id: accountId } })
  if (!account || account.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const messages = await db.warmupMessage.findMany({
    where: {
      OR: [{ fromAccountId: accountId }, { toAccountId: accountId }],
      sentAt: { gte: thirtyDaysAgo },
    },
    select: { sentAt: true, status: true, fromAccountId: true, toAccountId: true, rescuedAt: true },
  })

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
    summary: { totalSent, totalReceived, totalRescued, avgPerDay: Math.round((totalSent / 30) * 10) / 10 },
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN ANALYTICS (per-campaign detailed stats) — scoped to current user
// ─────────────────────────────────────────────────────────────────────────────

app.get('/campaign-analytics/:id', async (c) => {
  const userId = getUserId(c)
  const campaignId = c.req.param('id')
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    include: { steps: true },
  })
  if (!campaign || campaign.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  const [leads, emails, replies] = await Promise.all([
    db.lead.findMany({ where: { campaignId, ownerId: userId }, select: { status: true } }),
    db.scheduledEmail.findMany({
      where: { campaignId, ownerId: userId },
      select: { status: true, sentAt: true, openCount: true, clickCount: true, openedAt: true, clickedAt: true },
    }),
    db.reply.findMany({
      where: { lead: { campaignId, ownerId: userId } },
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
