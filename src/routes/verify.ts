import { Hono } from 'hono'
import { db } from '../lib/db'
import { getUser, getUserId } from '../lib/auth'
import { quickVerify, deepVerify } from '../lib/emailVerify'
import type { VerificationResult } from '../lib/emailVerify'

const app = new Hono()

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL VERIFICATION API
// ─────────────────────────────────────────────────────────────────────────────
//
// Async verification pipeline. Routes enqueue leads for verification, the
// worker processes them in batches and updates verificationResults /
// verificationStatus. BAD leads are auto-suppressed; RISKY leads are left
// for the user to decide.
//
// The dispatcher's claim query refuses to send to any lead whose
// verificationStatus is not 'VERIFIED' (or null/empty for backward compat).
// That is the "no bad emails slip to campaign under any circumstances"
// guarantee.

// In-process verification queue (per-instance). The worker tick drains this.
interface VerifyJob {
  leadId: string
  ownerId: string
  method: 'quick' | 'deep'
  enqueuedAt: number
}
const verifyQueue: VerifyJob[] = []
const VERIFY_BATCH_CONCURRENCY = parseInt(process.env.VERIFY_CONCURRENCY || '10')

export function getQueuedVerificationCount(): number {
  return verifyQueue.length
}

// Drain a batch from the queue and process it. Called by the worker tick.
export async function processVerificationBatch(): Promise<{ processed: number; verified: number; risky: number; bad: number }> {
  if (verifyQueue.length === 0) {
    return { processed: 0, verified: 0, risky: 0, bad: 0 }
  }
  const batch = verifyQueue.splice(0, VERIFY_BATCH_CONCURRENCY)
  let processed = 0
  let verified = 0
  let risky = 0
  let bad = 0

  await Promise.all(
    batch.map(async (job) => {
      try {
        const lead = await db.lead.findUnique({
          where: { id: job.leadId },
          select: { id: true, email: true, ownerId: true, campaignId: true, campaign: { select: { name: true } } },
        })
        if (!lead) return
        // Mark verifying
        await db.lead.update({
          where: { id: lead.id },
          data: { verificationStatus: 'VERIFYING' },
        })

        const result: VerificationResult =
          job.method === 'deep' ? await deepVerify(lead.email) : await quickVerify(lead.email)

        // Map score → status (deepVerify/quickVerify already do this, but
        // we re-check here for safety).
        const status = result.status // 'VERIFIED' | 'RISKY' | 'BAD'
        const reason = result.reason

        await db.lead.update({
          where: { id: lead.id },
          data: {
            verificationStatus: status,
            verificationMode: job.method,
            verificationReason: reason || null,
            verificationResults: result as any,
            verificationChecks: JSON.stringify(result.layers),
            verifiedAt: new Date(result.verifiedAt),
          },
        })

        processed++
        if (status === 'VERIFIED') verified++
        else if (status === 'RISKY') risky++
        else if (status === 'BAD') {
          bad++
          // Auto-suppress BAD leads
          await db.suppressionList
            .upsert({
              where: { email_reason: { email: lead.email.toLowerCase(), reason: 'auto:verification:bad' } },
              create: {
                ownerId: lead.ownerId,
                email: lead.email.toLowerCase(),
                reason: 'auto:verification:bad',
                source: `verify:${job.method} (${reason || 'bad'})`,
              },
              update: {},
            })
            .catch(() => null)
          // Cancel any queued emails for this lead
          await db.scheduledEmail
            .updateMany({
              where: { leadId: lead.id, status: 'queued' },
              data: { status: 'cancelled' },
            })
            .catch(() => null)
        }
      } catch (e: any) {
        console.error('[verify] job failed for lead', job.leadId, e?.message)
        // Mark back to PENDING so the user can retry
        await db.lead
          .update({
            where: { id: job.leadId },
            data: { verificationStatus: 'PENDING', verificationReason: `error: ${e?.message || 'unknown'}` },
          })
          .catch(() => null)
      }
    })
  )
  return { processed, verified, risky, bad }
}

// POST /api/verify/lead/:leadId — start verification for a single lead.
// Returns 202 immediately; the worker picks it up on the next tick.
app.post('/lead/:leadId', async (c) => {
  const userId = getUserId(c)
  const leadId = c.req.param('leadId')
  const body = await c.req.json().catch(() => ({}))
  const method: 'quick' | 'deep' = body.method === 'deep' ? 'deep' : 'quick'

  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { id: true, ownerId: true, email: true },
  })
  if (!lead) return c.json({ error: 'Lead not found' }, 404)
  if (lead.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  // Mark VERIFYING immediately so UI can show in-progress state
  await db.lead.update({
    where: { id: lead.id },
    data: { verificationStatus: 'VERIFYING' },
  })
  verifyQueue.push({ leadId: lead.id, ownerId: userId, method, enqueuedAt: Date.now() })

  return c.json({ ok: true, leadId, method, status: 'VERIFYING', queued: verifyQueue.length }, 202)
})

// POST /api/verify/campaign/:campaignId — start verification for all
// unverified leads in a campaign. Returns 202 with a job id (best-effort —
// the queue is in-process; if the server restarts mid-job, the worker will
// re-pick leads still in VERIFYING status).
app.post('/campaign/:campaignId', async (c) => {
  const userId = getUserId(c)
  const campaignId = c.req.param('campaignId')
  const body = await c.req.json().catch(() => ({}))
  const method: 'quick' | 'deep' = body.method === 'deep' ? 'deep' : 'quick'

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, ownerId: true, name: true },
  })
  if (!campaign) return c.json({ error: 'Campaign not found' }, 404)
  if (campaign.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  // Find all leads that need verification: PENDING or null, OR forced re-verify
  const force = !!body.force
  const where = force
    ? { campaignId }
    : {
        campaignId,
        OR: [
          { verificationStatus: 'PENDING' },
          { verificationStatus: null },
          { verificationStatus: '' },
        ],
      }
  const leads = await db.lead.findMany({
    where,
    select: { id: true, ownerId: true },
  })

  // Mark all as VERIFYING and enqueue
  if (leads.length > 0) {
    await db.lead.updateMany({
      where: { id: { in: leads.map((l) => l.id) } },
      data: { verificationStatus: 'VERIFYING' },
    })
    for (const l of leads) {
      verifyQueue.push({
        leadId: l.id,
        ownerId: userId,
        method,
        enqueuedAt: Date.now(),
      })
    }
  }

  const jobId = `verify_${campaignId}_${Date.now()}`
  return c.json(
    {
      ok: true,
      jobId,
      campaignId,
      method,
      enqueued: leads.length,
      queueDepth: verifyQueue.length,
    },
    202
  )
})

// GET /api/verify/campaigns — list all campaigns with verification stats
// (total leads, by status pending/verifying/verified/risky/bad).
app.get('/campaigns', async (c) => {
  const userId = getUserId(c)
  const campaigns = await db.campaign.findMany({
    where: { ownerId: userId },
    select: {
      id: true,
      name: true,
      status: true,
      totalLeads: true,
      createdAt: true,
      leads: {
        select: { verificationStatus: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const result = campaigns.map((camp) => {
    const stats = {
      pending: 0,
      verifying: 0,
      verified: 0,
      risky: 0,
      bad: 0,
      total: camp.leads.length,
    }
    for (const l of camp.leads) {
      const s = l.verificationStatus || 'PENDING'
      if (s === 'PENDING' || s === '' || s == null) stats.pending++
      else if (s === 'VERIFYING') stats.verifying++
      else if (s === 'VERIFIED') stats.verified++
      else if (s === 'RISKY') stats.risky++
      else if (s === 'BAD') stats.bad++
      else stats.pending++ // unknown → treat as pending
    }
    return {
      id: camp.id,
      name: camp.name,
      status: camp.status,
      totalLeads: camp.totalLeads,
      createdAt: camp.createdAt,
      verificationStats: stats,
    }
  })

  return c.json({ campaigns: result })
})

// GET /api/verify/campaigns/:campaignId/leads — paginated list of leads in a
// campaign with their verification status and full results. Filter by status.
app.get('/campaigns/:campaignId/leads', async (c) => {
  const userId = getUserId(c)
  const campaignId = c.req.param('campaignId')
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const status = c.req.query('status') // PENDING | VERIFYING | VERIFIED | RISKY | BAD

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, ownerId: true, name: true },
  })
  if (!campaign) return c.json({ error: 'Campaign not found' }, 404)
  if (campaign.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  const where: any = { campaignId }
  if (status && status !== 'all') {
    if (status === 'PENDING') {
      where.OR = [
        { verificationStatus: 'PENDING' },
        { verificationStatus: null },
        { verificationStatus: '' },
      ]
    } else {
      where.verificationStatus = status
    }
  }

  const [leads, total] = await Promise.all([
    db.lead.findMany({
      where,
      select: {
        id: true,
        email: true,
        companyName: true,
        status: true,
        verificationStatus: true,
        verificationMode: true,
        verificationReason: true,
        verificationResults: true,
        verifiedAt: true,
        pausedUntil: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: Math.max(0, (page - 1) * limit),
      take: limit,
    }),
    db.lead.count({ where }),
  ])

  return c.json({
    campaign: { id: campaign.id, name: campaign.name },
    leads,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit) || 0,
  })
})

// POST /api/verify/suppress/:leadId — manually suppress a lead (typically a
// RISKY one). Adds to SuppressionList with reason 'manual:verification'.
app.post('/suppress/:leadId', async (c) => {
  const userId = getUserId(c)
  const leadId = c.req.param('leadId')
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { id: true, ownerId: true, email: true, campaign: { select: { name: true } } },
  })
  if (!lead) return c.json({ error: 'Lead not found' }, 404)
  if (lead.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  await db.$transaction(async (tx) => {
    await tx.suppressionList.upsert({
      where: { email_reason: { email: lead.email.toLowerCase(), reason: 'manual:verification' } },
      create: {
        ownerId: userId,
        email: lead.email.toLowerCase(),
        reason: 'manual:verification',
        source: lead.campaign?.name || 'manual-verify',
      },
      update: {},
    })
    await tx.lead.update({
      where: { id: lead.id },
      data: { status: 'suppressed', verificationStatus: 'BAD', verificationReason: 'manual:verification' },
    })
    await tx.scheduledEmail.updateMany({
      where: { leadId: lead.id, status: 'queued' },
      data: { status: 'cancelled' },
    })
  })
  return c.json({ ok: true, leadId, status: 'suppressed' })
})

// POST /api/verify/suppress/bulk — body: { leadIds: [...], reason?: string }
app.post('/suppress/bulk', async (c) => {
  const userId = getUserId(c)
  const body = await c.req.json()
  const { leadIds, reason } = body as { leadIds: string[]; reason?: string }
  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return c.json({ error: 'leadIds array required' }, 400)
  }
  const finalReason = reason || 'manual:verification'

  const leads = await db.lead.findMany({
    where: { id: { in: leadIds }, ownerId: userId },
    select: { id: true, email: true, campaign: { select: { name: true } } },
  })
  if (leads.length === 0) return c.json({ error: 'No matching leads' }, 404)

  await db.$transaction(async (tx) => {
    for (const lead of leads) {
      await tx.suppressionList.upsert({
        where: { email_reason: { email: lead.email.toLowerCase(), reason: finalReason } },
        create: {
          ownerId: userId,
          email: lead.email.toLowerCase(),
          reason: finalReason,
          source: lead.campaign?.name || 'bulk-verify',
        },
        update: {},
      })
    }
    await tx.lead.updateMany({
      where: { id: { in: leads.map((l) => l.id) } },
      data: { status: 'suppressed', verificationStatus: 'BAD', verificationReason: finalReason },
    })
    await tx.scheduledEmail.updateMany({
      where: { leadId: { in: leads.map((l) => l.id) }, status: 'queued' },
      data: { status: 'cancelled' },
    })
  })
  return c.json({ ok: true, suppressed: leads.length })
})

export default app
