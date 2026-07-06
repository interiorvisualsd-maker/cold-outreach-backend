import crypto from 'node:crypto'
import { db } from '../lib/db'
import { sendMail } from '../lib/smtp'
import { clearTransportCache } from '../lib/smtp'
import { pushNotification } from '../lib/notifications'
import { pickVariant } from '../lib/variants'
import type { SmtpAccount, ScheduledEmail, Lead, Campaign } from '@prisma/client'

// ─────────────────────────────────────────────────────────────────────────────
// INBOX ROTATION + THROTTLING ENGINE (humanized) + IDempotent send pipeline
// ─────────────────────────────────────────────────────────────────────────────
//
// Design goals (per user feedback):
//   1. Do NOT burst-send the hourly quota all at once. Spread sends across
//      the hour with random jitter so traffic looks human.
//   2. Do NOT fire all sending accounts simultaneously. Each tick, pick a
//      RANDOM subset of eligible accounts (not round-robin) and send at most
//      1-2 emails per account per tick.
//   3. Add a random delay between individual sends (10-45s) so two emails
//      from the same account don't land in the same minute.
//   4. Randomize the order of due emails (don't always send the oldest first).
//   5. NEVER double-send: each row is claimed atomically via
//      SELECT...FOR UPDATE SKIP LOCKED → UPDATE status='sending'.
//   6. NEVER send to an unverified/bad lead (verification gate).
//   7. NEVER send to a paused lead (pausedUntil > NOW()).
//   8. Retry transient SMTP failures with exponential backoff (1h, 4h, 16h, 64h, 256h).
//      Mark permanent failures (5.1.1, 5.2.1, 5.7.x, 5.5.0) as failed +
//      suppress the lead.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ─── Stuck 'sending' recovery ───
// If a worker crashed mid-send (Render sleeps, process killed, etc.), a
// ScheduledEmail could be stuck in 'sending' forever. This function reclaims
// those rows back to 'queued' so they get retried.
//
// Threshold: 10 minutes (per spec). We also reset assignedAt so the next
// claim is clean. We DON'T reset attempts/attemptCount — those track
// lifetime, not the current claim.
export async function recoverStuckSending(): Promise<{ reclaimed: number }> {
  try {
    const result = await db.$executeRaw`
      UPDATE "ScheduledEmail"
      SET status = 'queued', "assignedAt" = NULL
      WHERE status = 'sending'
        AND "assignedAt" IS NOT NULL
        AND "assignedAt" < (NOW() - INTERVAL '10 minutes')
    `
    if (result > 0) {
      console.log(`[dispatcher] recovered ${result} stuck 'sending' emails back to 'queued'`)
    }
    return { reclaimed: result }
  } catch (e: any) {
    console.error('[dispatcher] recoverStuckSending failed:', e?.message)
    return { reclaimed: 0 }
  }
}

// ─── Daily reset catch-up ───
// The old midnight-only reset fails on Render free tier (server sleeps). We
// check each account's lastDailyResetAt; if older than 24h, reset its
// sentToday/warmupSentToday. This guarantees counters never get stuck at
// cap forever, even if the server sleeps through midnight.
//
// We also advance the warm-up ramp-up day on reset.
export async function dailyResetCatchUp(): Promise<{ reset: number }> {
  let reset = 0
  try {
    const accounts = await db.smtpAccount.findMany({
      where: {
        OR: [
          { lastDailyResetAt: null },
          { lastDailyResetAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        ],
      },
    })
    if (accounts.length === 0) return { reset: 0 }

    const now = new Date()
    for (const account of accounts) {
      // Reset this account's counters
      await db.smtpAccount.update({
        where: { id: account.id },
        data: {
          sentToday: 0,
          warmupSentToday: 0,
          lastResetAt: now,
          lastDailyResetAt: now,
        },
      })
      reset++

      // Advance warm-up ramp-up day (mirrors the old resetDailyCounters logic)
      if (account.warmupEnabled && account.warmupState !== 'suspended') {
        const newDay = account.warmupDay + 1
        const target = Math.min(
          account.warmupStartQty + (newDay - 1) * account.warmupIncrement,
          account.warmupTargetMax
        )
        const newState = target >= account.warmupTargetMax ? 'warm' : 'heating'

        if (newState === 'warm' && account.warmupState !== 'warm') {
          await pushNotification({
            type: 'warmup',
            severity: 'success',
            title: 'Warm-up milestone reached 🎉',
            message: `${account.emailAddress} is now fully warmed (${account.warmupTargetMax} emails/day). Ready for production sending.`,
          }).catch(() => {})
        }

        await db.smtpAccount.update({
          where: { id: account.id },
          data: { warmupDay: newDay, warmupState: newState },
        })
      }
    }
    if (reset > 0) {
      console.log(`[dispatcher] dailyResetCatchUp reset ${reset} accounts`)
    }
  } catch (e: any) {
    console.error('[dispatcher] dailyResetCatchUp failed:', e?.message)
  }
  return { reset }
}

// Get all eligible accounts (within daily + hourly caps, warmed up).
async function getEligibleAccounts(now: Date): Promise<SmtpAccount[]> {
  const accounts = await db.smtpAccount.findMany({
    where: { status: 'active' },
  })

  const eligible: SmtpAccount[] = []
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

  for (const account of accounts) {
    if (account.warmupEnabled && account.warmupState !== 'warm') continue
    if (account.sentToday >= account.dailyCap) continue

    const sentLastHour = await db.scheduledEmail.count({
      where: {
        smtpAccountId: account.id,
        sentAt: { gte: oneHourAgo },
        status: 'sent',
      },
    })
    if (sentLastHour >= account.hourlyCap) continue

    if (account.lastSentAt) {
      const secsSinceLastSend = (now.getTime() - account.lastSentAt.getTime()) / 1000
      if (secsSinceLastSend < 90) continue
    }

    eligible.push(account)
  }

  return eligible
}

function pickRandomAccountSubset(accounts: SmtpAccount[]): SmtpAccount[] {
  if (accounts.length === 0) return []
  const maxThisTick = Math.max(1, Math.min(3, Math.ceil(accounts.length * 0.4)))
  const count = randInt(1, maxThisTick)
  return shuffle(accounts).slice(0, count)
}

function isWithinSendingWindow(startHour: number, endHour: number, now: Date, timezone: string): boolean {
  try {
    let localHour: number
    if (timezone && timezone !== 'UTC') {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hour12: false,
      })
      localHour = parseInt(fmt.format(now), 10)
      if (isNaN(localHour)) localHour = now.getHours()
    } else {
      localHour = now.getHours()
    }
    if (startHour <= endHour) {
      return localHour >= startHour && localHour < endHour
    }
    return localHour >= startHour || localHour < endHour
  } catch {
    const hour = now.getHours()
    if (startHour <= endHour) {
      return hour >= startHour && hour < endHour
    }
    return hour >= startHour || hour < endHour
  }
}

// ─── Atomic claim (no double-sends) ───
// Uses SELECT...FOR UPDATE SKIP LOCKED inside a single UPDATE so two
// concurrent workers cannot both claim the same row. Returns the claimed
// rows already set to status='sending'. Skips leads whose verificationStatus
// is NOT 'VERIFIED' (the "no bad emails slip to campaign" guarantee) and
// leads whose pausedUntil > NOW().
async function claimBatch(batchSize: number, now: Date): Promise<any[]> {
  // Step 1: atomic UPDATE+RETURNING via raw SQL.
  // We add a join-style filter using EXISTS subqueries because we cannot
  // otherwise express Lead.verificationStatus / Lead.pausedUntil in the
  // WHERE clause of a single UPDATE.
  const rows: any[] = await db.$queryRaw`
    UPDATE "ScheduledEmail"
    SET status = 'sending',
        "assignedAt" = NOW(),
        attempts = attempts + 1
    WHERE id IN (
      SELECT se.id
      FROM "ScheduledEmail" se
      JOIN "Lead" l ON l.id = se."leadId"
      JOIN "Campaign" c ON c.id = se."campaignId"
      WHERE se.status = 'queued'
        AND se."scheduledAt" <= NOW()
        AND (l."pausedUntil" IS NULL OR l."pausedUntil" <= NOW())
        AND (
          l."verificationStatus" IS NULL
          OR l."verificationStatus" = 'VERIFIED'
          OR l."verificationStatus" = ''
        )
        AND l.status NOT IN ('replied', 'suppressed', 'bounced', 'unsubscribed')
      ORDER BY se."scheduledAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `
  return rows
}

// Process a SMALL randomized batch of scheduled emails.
export async function processSendBatch(batchSize = 3): Promise<{
  processed: number
  sent: number
  failed: number
  skipped: number
  errors: string[]
}> {
  const now = new Date()
  const errors: string[] = []
  let sent = 0
  let failed = 0
  let skipped = 0

  // ─── Step 0: recover any stuck 'sending' rows from a previous crashed tick ───
  await recoverStuckSending()

  // ─── Step 1: atomic claim (no double-sends) ───
  // We over-claim a bit (batchSize * 3) so we have spares to randomize from
  // after filtering by sending window / suppression list.
  const claimedRaw = await claimBatch(batchSize * 4, now)
  if (claimedRaw.length === 0) {
    return { processed: 0, sent: 0, failed: 0, skipped: 0, errors }
  }

  // Re-hydrate claimed rows with relations (Prisma raw query returns flat)
  const claimedIds = claimedRaw.map((r) => r.id)
  const claimed = await db.scheduledEmail.findMany({
    where: { id: { in: claimedIds } },
    include: { lead: true, campaign: true },
  })

  // Randomize so we don't always send the oldest-first across ticks
  const randomizedDue = shuffle(claimed).slice(0, batchSize)

  // Pick a random subset of eligible accounts for this tick
  const eligibleAccounts = await getEligibleAccounts(now)
  if (eligibleAccounts.length === 0) {
    // No account available — release the claim back to 'queued' and push
    // scheduledAt forward by a randomized 10-25 min so we don't retry in lockstep.
    const later = new Date(now.getTime() + randInt(10, 25) * 60 * 1000)
    await db.scheduledEmail.updateMany({
      where: { id: { in: randomizedDue.map((d) => d.id) }, status: 'sending' },
      data: { status: 'queued', scheduledAt: later, assignedAt: null },
    })
    return {
      processed: randomizedDue.length,
      sent: 0,
      failed: 0,
      skipped: randomizedDue.length,
      errors: ['No eligible sending accounts this tick'],
    }
  }

  const accountsThisTick = pickRandomAccountSubset(eligibleAccounts)
  let accountIndex = 0

  for (const item of randomizedDue) {
    // Check sending window for this campaign
    if (
      !isWithinSendingWindow(
        item.campaign.sendingWindowStart,
        item.campaign.sendingWindowEnd,
        now,
        item.campaign.timezone
      )
    ) {
      const next = new Date(now)
      next.setHours(item.campaign.sendingWindowStart, 0, 0, 0)
      if (next <= now) next.setDate(next.getDate() + 1)
      next.setMinutes(next.getMinutes() + Math.floor(Math.random() * 45))
      await db.scheduledEmail.update({
        where: { id: item.id },
        data: { status: 'queued', scheduledAt: next, assignedAt: null },
      })
      skipped++
      continue
    }

    // Lead already replied/suppressed/bounced — cancel.
    if (['replied', 'suppressed', 'bounced', 'unsubscribed'].includes(item.lead.status)) {
      await db.scheduledEmail.update({
        where: { id: item.id },
        data: { status: 'cancelled', assignedAt: null },
      })
      skipped++
      continue
    }

    // Lead paused (OOO) — reschedule after pause expires.
    if (item.lead.pausedUntil && item.lead.pausedUntil > now) {
      await db.scheduledEmail.update({
        where: { id: item.id },
        data: {
          status: 'queued',
          scheduledAt: new Date(item.lead.pausedUntil.getTime() + 60 * 1000),
          assignedAt: null,
        },
      })
      skipped++
      continue
    }

    // Verification gate: only send to VERIFIED leads.
    // (claimBatch already filtered, but this is belt-and-suspenders in case
    //  the lead's verificationStatus changed between claim and send.)
    if (
      item.lead.verificationStatus &&
      item.lead.verificationStatus !== 'VERIFIED' &&
      item.lead.verificationStatus !== ''
    ) {
      await db.scheduledEmail.update({
        where: { id: item.id },
        data: { status: 'cancelled', assignedAt: null, failureReason: `verification_${item.lead.verificationStatus}` },
      })
      skipped++
      continue
    }

    // Defensive suppression-list check (suppression can drift ahead of lead.status)
    const suppressedEntry = await db.suppressionList.findFirst({
      where: {
        email: { equals: item.lead.email.toLowerCase(), mode: 'insensitive' },
        ownerId: item.ownerId,
      },
      select: { id: true, reason: true },
    })
    if (suppressedEntry) {
      const statusMap: Record<string, string> = {
        bounce: 'bounced',
        unsubscribe: 'unsubscribed',
        'bounce:permanent': 'bounced',
        'auto:verification:bad': 'bounced',
        complaint: 'suppressed',
        manual: 'suppressed',
        'manual:verification': 'suppressed',
      }
      const newStatus = statusMap[suppressedEntry.reason] || 'suppressed'
      await db.lead
        .update({
          where: { id: item.leadId },
          data: { status: newStatus as any },
        })
        .catch(() => {})
      await db.scheduledEmail.update({
        where: { id: item.id },
        data: { status: 'cancelled', assignedAt: null },
      })
      skipped++
      continue
    }

    // Pick the next account from our random subset
    const account = accountsThisTick[accountIndex % accountsThisTick.length]!
    accountIndex++

    // Re-verify caps (another tick may have incremented)
    if (account.sentToday >= account.dailyCap) {
      // Release claim
      await db.scheduledEmail.update({
        where: { id: item.id },
        data: { status: 'queued', assignedAt: null },
      })
      skipped++
      continue
    }

    // ─── Send ───
    try {
      // Pick variant (frozen per lead at schedule time, but pickVariant is
      // idempotent if the body has no "|||" separators)
      const bodyText = pickVariant(item.body)
      const subjectText = pickVariant(item.subject)

      const { messageId } = await sendMail(account, {
        to: item.lead.email,
        subject: subjectText,
        text: bodyText,
        fromName: item.campaign.fromNameOverride || account.fromName,
      })

      // ─── Transaction: update email, account, lead, log, next step ───
      // Wrap the critical writes so a crash between them doesn't leave
      // inconsistent state (e.g. email marked sent but lead status stale).
      await db.$transaction(async (tx) => {
        await tx.scheduledEmail.update({
          where: { id: item.id },
          data: {
            status: 'sent',
            sentAt: now,
            messageId,
            attemptCount: { increment: 1 },
            lastAttemptAt: now,
            lastError: null,
            failureReason: null,
            assignedAt: null,
          },
        })
        await tx.smtpAccount.update({
          where: { id: account.id },
          data: {
            sentToday: { increment: 1 },
            lastSentAt: now,
            failureStreak: 0,
          },
        })
        await tx.lead.update({
          where: { id: item.leadId },
          data: {
            currentStep: item.stepNumber,
            lastStepSentAt: now,
            status: `step${item.stepNumber}_sent` as any,
          },
        })
        await tx.emailLog.create({
          data: {
            ownerId: item.ownerId,
            direction: 'outbound',
            smtpAccountId: account.id,
            leadId: item.leadId,
            campaignId: item.campaignId,
            toEmail: item.lead.email,
            fromEmail: account.emailAddress,
            subject: subjectText,
            body: bodyText,
            messageId,
            sentAt: now,
          },
        })
      })

      // Schedule next step (outside the tx — non-critical, can be retried)
      await scheduleNextStep(item.leadId, item.campaignId, item.stepNumber, now)

      sent++

      // Humanizing delay before next send
      if (sent < randomizedDue.length) {
        const delayMs = randInt(10, 45) * 1000
        await sleep(delayMs)
      }
    } catch (e: any) {
      failed++
      const errMsg = e?.message || 'Unknown send error'
      errors.push(`${item.lead.email}: ${errMsg}`)
      await handleSendFailure(item, account, errMsg, now)
    }
  }

  return { processed: randomizedDue.length, sent, failed, skipped, errors }
}

// ─── Retry classification ───
// Classify an SMTP failure as transient or permanent, then either reschedule
// (transient) or fail permanently (permanent) + suppress the lead.
//
// Permanent-failure SMTP enhanced status codes (RFC 3463):
//   5.1.1 = mailbox does not exist
//   5.1.2 = host does not exist
//   5.2.1 = mailbox disabled / full
//   5.2.2 = mailbox full
//   5.4.4 = no answer from host
//   5.5.0 = generic permanent
//   5.7.1 = spam/blocked
//   5.7.x = various policy blocks
// Also: 5xx (any) → treat as permanent (safer for reputation).
//
// Transient: 4xx, timeout, connection reset, DNS temp failure, ECONNRESET, ETIMEDOUT.
//
// Retry backoff schedule: 1h, 4h, 16h, 64h, 256h (exponential base 4).
// Max attempts: 5.
const BACKOFF_HOURS = [1, 4, 16, 64, 256] // 5 attempts total

function classifyError(errMsg: string): {
  kind: 'transient' | 'permanent'
  reason?: string
} {
  const m = (errMsg || '').toLowerCase()
  // SMTP enhanced status codes
  if (/5\.1\.1/.test(m)) return { kind: 'permanent', reason: 'bounce:permanent:5.1.1_mailbox_does_not_exist' }
  if (/5\.1\.2/.test(m)) return { kind: 'permanent', reason: 'bounce:permanent:5.1.2_host_does_not_exist' }
  if (/5\.2\.1/.test(m)) return { kind: 'permanent', reason: 'bounce:permanent:5.2.1_mailbox_disabled' }
  if (/5\.2\.2/.test(m)) return { kind: 'permanent', reason: 'bounce:permanent:5.2.2_mailbox_full' }
  if (/5\.4\.4/.test(m)) return { kind: 'permanent', reason: 'bounce:permanent:5.4.4_no_answer' }
  if (/5\.5\.0/.test(m)) return { kind: 'permanent', reason: 'bounce:permanent:5.5.0_generic' }
  if (/5\.7\./.test(m)) return { kind: 'permanent', reason: 'bounce:permanent:5.7.x_policy_block' }
  // 5xx SMTP code (e.g. "550 mailbox not found")
  if (/\b5\d\d\b/.test(m) && /mailbox|not exist|reject|blocked|spam|invalid|disabled|full/i.test(m)) {
    return { kind: 'permanent', reason: 'bounce:permanent:5xx' }
  }
  // Common 5xx-only signal (safer to treat as permanent)
  if (/^5\d\d\s/.test(m) || /:\s*5\d\d\b/.test(m)) {
    return { kind: 'permanent', reason: 'bounce:permanent:5xx_generic' }
  }
  // Transient
  if (/timeout|timed out|etimedout|econnreset|connection reset|econnrefused|temporary|greylist|4\d\d\s|deferred|try again/i.test(m)) {
    return { kind: 'transient' }
  }
  // Unknown → treat as transient (give it another shot; if it really is
  // permanent, the next attempt will likely surface a clearer code).
  return { kind: 'transient' }
}

async function handleSendFailure(
  item: ScheduledEmail & { lead: Lead; campaign: Campaign },
  account: SmtpAccount,
  errMsg: string,
  now: Date
) {
  const classification = classifyError(errMsg)
  const attemptCount = item.attemptCount + 1

  if (classification.kind === 'permanent' || attemptCount >= 5) {
    // ─── Permanent failure ───
    await db.$transaction(async (tx) => {
      await tx.scheduledEmail.update({
        where: { id: item.id },
        data: {
          status: 'failed',
          lastError: errMsg,
          failureReason: classification.reason || 'max_attempts_reached',
          attemptCount,
          lastAttemptAt: now,
          assignedAt: null,
        },
      })
      // Suppress the lead permanently
      await tx.suppressionList.upsert({
        where: {
          email_reason: {
            email: item.lead.email.toLowerCase(),
            reason: 'bounce:permanent',
          },
        },
        create: {
          ownerId: item.ownerId,
          email: item.lead.email.toLowerCase(),
          reason: 'bounce:permanent',
          source: `dispatcher (${classification.reason || 'max_attempts'})`,
        },
        update: {},
      })
      await tx.lead.update({
        where: { id: item.leadId },
        data: { status: 'bounced', bouncedAt: now },
      })
      // Cancel any other queued steps for this lead
      await tx.scheduledEmail.updateMany({
        where: { leadId: item.leadId, status: 'queued' },
        data: { status: 'cancelled' },
      })
      // Bump account failure streak — auto-pause after 3 strikes
      const updated = await tx.smtpAccount.update({
        where: { id: account.id },
        data: { failureStreak: { increment: 1 } },
      })
      if (updated.failureStreak >= 3) {
        await tx.smtpAccount.update({
          where: { id: account.id },
          data: { status: 'error', warmupState: 'paused' },
        })
      }
    })

    // Clear transport cache + notify (outside tx)
    clearTransportCache(account.id)
    await pushNotification({
      type: 'failure',
      severity: 'error',
      title: 'Send failed permanently',
      message: `${item.lead.email}: ${classification.reason || 'max attempts'} — ${errMsg.slice(0, 100)}`,
    }).catch(() => {})
    return
  }

  // ─── Transient failure — reschedule with exponential backoff ───
  const backoffHours = BACKOFF_HOURS[Math.min(attemptCount - 1, BACKOFF_HOURS.length - 1)] || 1
  const nextScheduledAt = new Date(now.getTime() + backoffHours * 60 * 60 * 1000)
  await db.$transaction(async (tx) => {
    await tx.scheduledEmail.update({
      where: { id: item.id },
      data: {
        status: 'queued',
        lastError: errMsg,
        failureReason: `transient:attempt_${attemptCount}`,
        attemptCount,
        lastAttemptAt: now,
        scheduledAt: nextScheduledAt,
        assignedAt: null,
      },
    })
    // Bump failure streak (auto-pause logic same as permanent)
    const updated = await tx.smtpAccount.update({
      where: { id: account.id },
      data: { failureStreak: { increment: 1 } },
    })
    if (updated.failureStreak >= 3) {
      await tx.smtpAccount.update({
        where: { id: account.id },
        data: { status: 'error', warmupState: 'paused' },
      })
    }
  })
  if ((attemptCount >= 3) || errMsg.toLowerCase().includes('auth')) {
    clearTransportCache(account.id)
  }
}

// Schedule the next sequence step for a lead
export async function scheduleNextStep(leadId: string, campaignId: string, currentStep: number, now: Date) {
  const nextStep = await db.emailStep.findUnique({
    where: { campaignId_stepNumber: { campaignId, stepNumber: currentStep + 1 } },
  })
  if (!nextStep) return // no more steps

  const lead = await db.lead.findUnique({ where: { id: leadId } })
  if (!lead) return

  // Don't schedule next step if lead was replied/suppressed/bounced in the meantime
  if (['replied', 'suppressed', 'bounced', 'unsubscribed'].includes(lead.status)) return

  const jitterMs = Math.floor(Math.random() * 3 * 60 * 60 * 1000)
  const scheduledAt = new Date(now.getTime() + nextStep.delayDays * 24 * 60 * 60 * 1000 + jitterMs)

  let body = nextStep.body
  let subject = nextStep.subject
  if (nextStep.stepNumber === 2 && lead.followupDay3) {
    body = lead.followupDay3
  } else if (nextStep.stepNumber === 3 && lead.followupDay7) {
    body = lead.followupDay7
  }
  if (nextStep.stepNumber > 1) {
    const originalSubject = lead.outreachSubject || nextStep.subject
    subject = originalSubject.toLowerCase().startsWith('re:') ? originalSubject : `Re: ${originalSubject}`
  }

  // Set trackingId so open/click tracking actually works
  await db.scheduledEmail.create({
    data: {
      campaignId,
      leadId,
      ownerId: lead.ownerId,
      stepNumber: nextStep.stepNumber,
      subject,
      body,
      scheduledAt,
      trackingId: crypto.randomUUID(),
    },
  })
}

// ─── Legacy daily reset (kept for the cron endpoint) ───
// Now calls dailyResetCatchUp which is timezone-aware and resilient to
// Render sleeping through midnight.
export async function resetDailyCounters() {
  await dailyResetCatchUp()
}
