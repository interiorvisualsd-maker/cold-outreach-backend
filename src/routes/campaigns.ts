import { Hono } from 'hono'
import { db } from '../lib/db'
import { getUserId } from '../lib/auth'
import { pickVariant } from '../lib/variants'
import crypto from 'node:crypto'

const app = new Hono()

// GET /api/campaigns — scoped to current user
app.get('/', async (c) => {
  const userId = getUserId(c)
  const campaigns = await db.campaign.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: {
        select: { leads: true, steps: true, scheduledEmails: true },
      },
    },
  })
  return c.json({ campaigns })
})

// GET /api/campaigns/:id
app.get('/:id', async (c) => {
  const userId = getUserId(c)
  const campaign = await db.campaign.findUnique({
    where: { id: c.req.param('id') },
    include: {
      steps: { orderBy: { stepNumber: 'asc' } },
      _count: { select: { leads: true, scheduledEmails: true } },
    },
  })
  if (!campaign || campaign.ownerId !== userId) return c.json({ error: 'Not found' }, 404)
  return c.json({ campaign })
})

// POST /api/campaigns — create campaign
app.post('/', async (c) => {
  const userId = getUserId(c)
  const body = await c.req.json()
  const { name, sendingWindowStart, sendingWindowEnd, timezone, fromNameOverride, allowedClickDomains } = body
  if (!name) return c.json({ error: 'name required' }, 400)
  const campaign = await db.campaign.create({
    data: {
      ownerId: userId,
      name,
      sendingWindowStart: sendingWindowStart ?? 9,
      sendingWindowEnd: sendingWindowEnd ?? 17,
      timezone: timezone ?? 'America/New_York',
      fromNameOverride: fromNameOverride ?? null,
      allowedClickDomains: allowedClickDomains ?? null,
    },
  })
  return c.json({ campaign })
})

// PUT /api/campaigns/:id
app.put('/:id', async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const existing = await db.campaign.findUnique({ where: { id } })
  if (!existing || existing.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json()
  const { name, status, sendingWindowStart, sendingWindowEnd, timezone, fromNameOverride, allowedClickDomains } = body
  const campaign = await db.campaign.update({
    where: { id },
    data: {
      ...(name !== undefined && { name }),
      ...(status !== undefined && { status }),
      ...(sendingWindowStart !== undefined && { sendingWindowStart }),
      ...(sendingWindowEnd !== undefined && { sendingWindowEnd }),
      ...(timezone !== undefined && { timezone }),
      ...(fromNameOverride !== undefined && { fromNameOverride }),
      ...(allowedClickDomains !== undefined && { allowedClickDomains }),
    },
  })
  return c.json({ campaign })
})

// DELETE /api/campaigns/:id
app.delete('/:id', async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const existing = await db.campaign.findUnique({ where: { id } })
  if (!existing || existing.ownerId !== userId) return c.json({ error: 'Not found' }, 404)
  await db.campaign.delete({ where: { id } }).catch(() => null)
  return c.json({ ok: true })
})

// POST /api/campaigns/:id/steps — define or update a step
app.post('/:id/steps', async (c) => {
  const userId = getUserId(c)
  const campaignId = c.req.param('id')
  const existing = await db.campaign.findUnique({ where: { id: campaignId } })
  if (!existing || existing.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json()
  const { stepNumber, delayDays, subject, body: stepBody } = body
  if (!stepNumber || !subject || !stepBody) {
    return c.json({ error: 'stepNumber, subject, body required' }, 400)
  }
  const step = await db.emailStep.upsert({
    where: { campaignId_stepNumber: { campaignId, stepNumber } },
    create: { campaignId, stepNumber, delayDays: delayDays ?? 0, subject, body: stepBody },
    update: { delayDays: delayDays ?? 0, subject, body: stepBody },
  })
  return c.json({ step })
})

// POST /api/campaigns/:id/start — queue all pending leads for step 1.
//
// GUARD: refuses to start a campaign where any leads have verificationStatus
// in ('PENDING', 'VERIFYING', 'BAD'). This is the "no bad emails slip to
// campaign under any circumstances" guarantee at the campaign-start layer.
// The dispatcher's claim query ALSO enforces this — belt and suspenders.
app.post('/:id/start', async (c) => {
  const userId = getUserId(c)
  const campaignId = c.req.param('id')
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    include: { steps: true },
  })
  if (!campaign || campaign.ownerId !== userId) return c.json({ error: 'Campaign not found' }, 404)
  if (campaign.steps.length === 0) return c.json({ error: 'No steps defined — add at least one sequence step before starting.' }, 400)

  const step1 = campaign.steps.find((s) => s.stepNumber === 1)
  if (!step1) return c.json({ error: 'Step 1 not defined' }, 400)

  const totalLeadsInCampaign = await db.lead.count({ where: { campaignId } })
  if (totalLeadsInCampaign === 0) {
    return c.json({
      error: 'This campaign has no leads yet. Import a CSV lead list before starting.',
    }, 400)
  }

  // ─── Verification gate ───
  const badLeads = await db.lead.count({
    where: {
      campaignId,
      verificationStatus: { in: ['PENDING', 'VERIFYING', 'BAD'] },
    },
  })
  // PENDING + null count too
  const pendingOrUnverified = await db.lead.count({
    where: {
      campaignId,
      OR: [
        { verificationStatus: 'PENDING' },
        { verificationStatus: null },
        { verificationStatus: '' },
        { verificationStatus: 'VERIFYING' },
        { verificationStatus: 'BAD' },
      ],
    },
  })
  if (pendingOrUnverified > 0) {
    return c.json({
      error:
        `Cannot start: ${pendingOrUnverified} leads are not yet VERIFIED ` +
        `(PENDING, VERIFYING, or BAD). Run email verification first via the ` +
        `Verify tab. (bad=${badLeads})`,
      code: 'verification_required',
      pendingOrUnverified,
      badLeads,
    }, 400)
  }

  // Get all pending leads
  const leads = await db.lead.findMany({
    where: { campaignId, status: 'pending' },
  })

  const isResume = campaign.status === 'paused'
  const now = new Date()

  // Build the scheduled email rows. Set trackingId on each.
  const scheduled: any[] = []
  for (const lead of leads) {
    const subject = lead.outreachSubject || pickVariant(step1.subject)
    const body = lead.initialOutreach || pickVariant(step1.body)
    const offset = Math.floor(Math.random() * 60 * 60 * 1000) // random within 1h
    const scheduledAt = new Date(now.getTime() + offset)
    scheduled.push({
      campaignId,
      leadId: lead.id,
      ownerId: userId,
      stepNumber: 1,
      subject,
      body,
      scheduledAt,
      trackingId: crypto.randomUUID(),
    })
  }

  // ─── Transaction: bulk-insert + status update ───
  await db.$transaction(async (tx) => {
    if (scheduled.length > 0) {
      await tx.scheduledEmail.createMany({ data: scheduled })
    }
    await tx.campaign.update({
      where: { id: campaignId },
      data: { status: 'active' },
    })
  })

  console.log(
    `[campaign] ${isResume ? 'RESUME' : 'START'} ${campaignId} → 200 · queued ${scheduled.length} step-1 emails · ${totalLeadsInCampaign} total leads`
  )

  return c.json({ queued: scheduled.length, campaign: { ...campaign, status: 'active' } })
})

// POST /api/campaigns/:id/pause
app.post('/:id/pause', async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const existing = await db.campaign.findUnique({ where: { id } })
  if (!existing || existing.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  // ─── Transaction: mark paused + cancel queued emails ───
  const campaign = await db.$transaction(async (tx) => {
    const updated = await tx.campaign.update({
      where: { id },
      data: { status: 'paused' },
    })
    await tx.scheduledEmail.updateMany({
      where: { campaignId: id, status: 'queued' },
      data: { status: 'cancelled' },
    })
    return updated
  })
  return c.json({ campaign })
})

// GET /api/campaigns/:id/leads — paginated leads
app.get('/:id/leads', async (c) => {
  const userId = getUserId(c)
  const campaignId = c.req.param('id')
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } })
  if (!campaign || campaign.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const status = c.req.query('status')

  const where: any = { campaignId }
  if (status && status !== 'all' && status !== 'undefined' && status !== '') {
    where.status = status
  }

  const [leads, total] = await Promise.all([
    db.lead.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: Math.max(0, (page - 1) * limit),
      take: limit,
    }),
    db.lead.count({ where }),
  ])

  return c.json({ leads, total, page, limit, pages: Math.ceil(total / limit) })
})

export default app
