import { Hono } from 'hono'
import { db } from '../lib/db'
import { pickVariant } from '../lib/variants'

const app = new Hono()

// GET /api/campaigns
app.get('/', async (c) => {
  const campaigns = await db.campaign.findMany({
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
  const campaign = await db.campaign.findUnique({
    where: { id: c.req.param('id') },
    include: {
      steps: { orderBy: { stepNumber: 'asc' } },
      _count: { select: { leads: true, scheduledEmails: true } },
    },
  })
  if (!campaign) return c.json({ error: 'Not found' }, 404)
  return c.json({ campaign })
})

// POST /api/campaigns — create campaign
app.post('/', async (c) => {
  const body = await c.req.json()
  const { name, sendingWindowStart, sendingWindowEnd, timezone, fromNameOverride } = body
  if (!name) return c.json({ error: 'name required' }, 400)
  const campaign = await db.campaign.create({
    data: {
      name,
      sendingWindowStart: sendingWindowStart ?? 9,
      sendingWindowEnd: sendingWindowEnd ?? 17,
      timezone: timezone ?? 'America/New_York',
      fromNameOverride: fromNameOverride ?? null,
    },
  })
  return c.json({ campaign })
})

// PUT /api/campaigns/:id
app.put('/:id', async (c) => {
  const body = await c.req.json()
  const { name, status, sendingWindowStart, sendingWindowEnd, timezone, fromNameOverride } = body
  const campaign = await db.campaign.update({
    where: { id: c.req.param('id') },
    data: {
      ...(name !== undefined && { name }),
      ...(status !== undefined && { status }),
      ...(sendingWindowStart !== undefined && { sendingWindowStart }),
      ...(sendingWindowEnd !== undefined && { sendingWindowEnd }),
      ...(timezone !== undefined && { timezone }),
      ...(fromNameOverride !== undefined && { fromNameOverride }),
    },
  })
  return c.json({ campaign })
})

// DELETE /api/campaigns/:id
app.delete('/:id', async (c) => {
  await db.campaign.delete({ where: { id: c.req.param('id') } }).catch(() => null)
  return c.json({ ok: true })
})

// POST /api/campaigns/:id/steps — define or update a step
app.post('/:id/steps', async (c) => {
  const campaignId = c.req.param('id')
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
// Also serves as "resume" for paused campaigns: it only queues leads still
// at status 'pending' (leads already at step1_sent/step2_sent are left alone
// for the dispatcher's follow-up tick to handle).
app.post('/:id/start', async (c) => {
  const campaignId = c.req.param('id')
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    include: { steps: true },
  })
  if (!campaign) return c.json({ error: 'Campaign not found' }, 404)
  if (campaign.steps.length === 0) return c.json({ error: 'No steps defined — add at least one sequence step before starting.' }, 400)

  const step1 = campaign.steps.find((s) => s.stepNumber === 1)
  if (!step1) return c.json({ error: 'Step 1 not defined' }, 400)

  // Get all pending leads
  const leads = await db.lead.findMany({
    where: { campaignId, status: 'pending' },
  })

  // Guard: block start if there are no leads at all in the campaign.
  // This prevents the user from starting an empty campaign and then
  // wondering why nothing sends.
  const totalLeadsInCampaign = await db.lead.count({ where: { campaignId } })
  if (totalLeadsInCampaign === 0) {
    return c.json({
      error: 'This campaign has no leads yet. Import a CSV lead list before starting.',
    }, 400)
  }

  // Distinguish "start" (from draft) vs "resume" (from paused) for logging
  const isResume = campaign.status === 'paused'

  const now = new Date()
  // Schedule step 1 within sending window, staggered over next 24h
  const scheduled: any[] = []
  for (const lead of leads) {
    // Use lead's custom CSV message if present, otherwise pick a random
    // variant from the step's `|||`-separated subject/body fields.
    const subject = lead.outreachSubject || pickVariant(step1.subject)
    const body = lead.initialOutreach || pickVariant(step1.body)
    // Stagger: spread leads across the next few sending windows
    const offset = Math.floor(Math.random() * 60 * 60 * 1000) // random within 1h
    const scheduledAt = new Date(now.getTime() + offset)
    scheduled.push({
      campaignId,
      leadId: lead.id,
      stepNumber: 1,
      subject,
      body,
      scheduledAt,
    })
  }

  if (scheduled.length > 0) {
    await db.scheduledEmail.createMany({ data: scheduled })
  }

  await db.campaign.update({
    where: { id: campaignId },
    data: { status: 'active' },
  })

  // Update lead statuses to reflect queueing
  await db.lead.updateMany({
    where: { campaignId, status: 'pending' },
    data: { status: 'pending' }, // stays pending until step 1 actually sends
  })

  console.log(`[campaign] ${isResume ? 'RESUME' : 'START'} ${campaignId} → 200 · queued ${scheduled.length} step-1 emails · ${totalLeadsInCampaign} total leads`)

  return c.json({ queued: scheduled.length, campaign: { ...campaign, status: 'active' } })
})

// POST /api/campaigns/:id/pause
app.post('/:id/pause', async (c) => {
  const campaign = await db.campaign.update({
    where: { id: c.req.param('id') },
    data: { status: 'paused' },
  })
  // Cancel queued emails
  await db.scheduledEmail.updateMany({
    where: { campaignId: campaign.id, status: 'queued' },
    data: { status: 'cancelled' },
  })
  return c.json({ campaign })
})

// GET /api/campaigns/:id/leads — paginated leads
app.get('/:id/leads', async (c) => {
  const campaignId = c.req.param('id')
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const status = c.req.query('status')

  const where: any = { campaignId }
  // Only filter by status if it's a valid status value (not 'undefined', 'all', or empty)
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
