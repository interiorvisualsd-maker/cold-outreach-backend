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

// In-memory tracking of the most recent verification job per owner.
// Used by GET /api/verify/job-status so the frontend can show a progress
// bar while verification is running. This is intentionally per-owner (not
// global) so each user only sees their own jobs.
interface JobTracker {
  ownerId: string
  running: boolean
  campaignId: string | null
  campaignName: string | null
  method: 'quick' | 'deep' | null
  total: number
  processed: number
  startedAt: string
  finishedAt?: string
}
const jobTrackers = new Map<string, JobTracker>() // keyed by ownerId

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

  // Set the per-owner job tracker so the frontend can show a progress bar
  jobTrackers.set(userId, {
    ownerId: userId,
    running: leads.length > 0,
    campaignId,
    campaignName: campaign.name,
    method,
    total: leads.length,
    processed: 0,
    startedAt: new Date().toISOString(),
  })

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

// GET /api/verify/job-status — returns the current verification job state for
// the authenticated user. Used by the frontend to show a progress bar while
// verification is running. Returns {running: false, ...} when no job is
// active.
app.get('/job-status', async (c) => {
  const userId = getUserId(c)
  const tracker = jobTrackers.get(userId)
  if (!tracker) {
    return c.json({
      running: false,
      campaignId: null,
      campaignName: null,
      method: null,
      total: 0,
      processed: 0,
      startedAt: null,
    })
  }
  // Update processed count from DB (count of leads no longer in VERIFYING
  // state for this campaign since the job started). Cheaper than tracking
  // per-lead in memory.
  if (tracker.running && tracker.campaignId) {
    try {
      const stillVerifying = await db.lead.count({
        where: {
          campaignId: tracker.campaignId,
          verificationStatus: 'VERIFYING',
        },
      })
      tracker.processed = Math.max(0, tracker.total - stillVerifying)
      // If queue is empty AND no leads are still VERIFYING, mark job done
      if (verifyQueue.filter((j) => j.ownerId === userId).length === 0 && stillVerifying === 0) {
        tracker.running = false
        tracker.finishedAt = new Date().toISOString()
      }
    } catch {
      // ignore — best-effort progress
    }
  }
  return c.json({
    running: tracker.running,
    campaignId: tracker.campaignId,
    campaignName: tracker.campaignName,
    method: tracker.method,
    total: tracker.total,
    processed: tracker.processed,
    startedAt: tracker.startedAt,
    finishedAt: tracker.finishedAt || null,
  })
})

// GET /api/verify/campaigns — list all campaigns with verification stats
// (total leads, by status pending/verifying/verified/risky/bad).
//
// Returns the exact shape the frontend VerificationView expects:
//   { campaigns: [{ campaignId, campaignName, totalLeads, verifiedCount,
//                   verifyingCount, riskyCount, badCount, lastVerifiedAt }],
//     totals: { totalLeads, verified, verifying, risky, bad } }
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
        select: { verificationStatus: true, verifiedAt: true },
        orderBy: { verifiedAt: 'desc' },
        take: 1, // we only need the most recent verifiedAt for lastVerifiedAt
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  // Also fetch full lead counts per campaign for accurate totals (the `take:1`
  // above is only for lastVerifiedAt).
  const campaignIds = campaigns.map((c) => c.id)
  const counts = await db.lead.groupBy({
    by: ['campaignId', 'verificationStatus'],
    where: { campaignId: { in: campaignIds } },
    _count: { _all: true },
  })

  // Build a lookup: { [campaignId]: { PENDING: n, VERIFIED: n, ... } }
  const countMap: Record<string, Record<string, number>> = {}
  for (const c of campaigns) countMap[c.id] = { PENDING: 0, VERIFYING: 0, VERIFIED: 0, RISKY: 0, BAD: 0 }
  for (const row of counts) {
    const status = row.verificationStatus || 'PENDING'
    if (!countMap[row.campaignId]) countMap[row.campaignId] = { PENDING: 0, VERIFYING: 0, VERIFIED: 0, RISKY: 0, BAD: 0 }
    countMap[row.campaignId][status] = row._count._all
  }

  const totals = { totalLeads: 0, verified: 0, verifying: 0, risky: 0, bad: 0 }
  const result = campaigns.map((camp) => {
    const stats = countMap[camp.id] || { PENDING: 0, VERIFYING: 0, VERIFIED: 0, RISKY: 0, BAD: 0 }
    const verified = stats.VERIFIED || 0
    const verifying = stats.VERIFYING || 0
    const risky = stats.RISKY || 0
    const bad = stats.BAD || 0
    const totalLeads = camp.totalLeads || (verified + verifying + risky + bad + (stats.PENDING || 0))

    totals.totalLeads += totalLeads
    totals.verified += verified
    totals.verifying += verifying
    totals.risky += risky
    totals.bad += bad

    const lastVerifiedAt = camp.leads[0]?.verifiedAt || null

    return {
      campaignId: camp.id,
      campaignName: camp.name,
      totalLeads,
      verifiedCount: verified,
      verifyingCount: verifying,
      riskyCount: risky,
      badCount: bad,
      lastVerifiedAt: lastVerifiedAt ? lastVerifiedAt.toISOString() : null,
    }
  })

  return c.json({ campaigns: result, totals })
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

  // ─── Map raw DB rows to the frontend's expected VerifyLeadRow shape ───
  // The frontend expects a flat `checks` object with boolean fields and a
  // top-level `verificationScore`. The DB stores `verificationResults` as a
  // raw JSON object (the full VerificationResult from emailVerify.ts) which
  // has a nested `layers` structure. We normalize here so the frontend
  // doesn't have to know about the internal shape and can't crash on
  // unverified leads (where verificationResults is null).
  type RawLayer = { ok?: boolean; detected?: boolean; status?: string }
  type RawVerificationResults = {
    score?: number
    method?: string
    layers?: {
      syntax?: RawLayer
      domain?: RawLayer
      mx?: RawLayer & { hosts?: string[] }
      smtp?: RawLayer
      disposable?: boolean
      role?: boolean
      free?: boolean
      catchAll?: boolean
      typo?: RawLayer
    }
    reason?: string
  } | null

  const mappedLeads = leads.map((lead) => {
    const vr = (lead.verificationResults as RawVerificationResults) || null
    const layers = vr?.layers
    const lowerStatus = (lead.verificationStatus || 'PENDING').toLowerCase()
    return {
      id: lead.id,
      email: lead.email,
      companyName: lead.companyName,
      status: lead.status,
      // Normalize status to lowercase to match the frontend's VerificationStatus union
      verificationStatus: lowerStatus,
      verificationMethod: lead.verificationMode || vr?.method || null,
      verificationScore: typeof vr?.score === 'number' ? vr.score : null,
      verifiedAt: lead.verifiedAt ? lead.verifiedAt.toISOString() : null,
      checks: {
        syntax: layers?.syntax?.ok,
        domain: layers?.domain?.ok,
        mx: layers?.mx?.ok,
        smtp: layers?.smtp?.ok,
        disposable: layers?.disposable === true ? true : layers?.disposable === false ? false : undefined,
        role: layers?.role === true ? true : layers?.role === false ? false : undefined,
        free: layers?.free === true ? true : layers?.free === false ? false : undefined,
        catchAll: layers?.catchAll === true ? true : layers?.catchAll === false ? false : undefined,
        typo: layers?.typo?.detected === true ? true : layers?.typo?.detected === false ? false : undefined,
      },
      failureReason: lead.verificationReason || vr?.reason || null,
    }
  })

  return c.json({
    campaign: { id: campaign.id, name: campaign.name },
    leads: mappedLeads,
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
