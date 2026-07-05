import crypto from 'node:crypto'
import { db } from '../lib/db'
import { sendMail } from '../lib/smtp'
import { clearTransportCache } from '../lib/smtp'
import { pushNotification } from '../lib/notifications'
import { pickVariant } from '../lib/variants'
import type { SmtpAccount } from '@prisma/client'

// ─────────────────────────────────────────────────────────────────────────────
// INBOX ROTATION + THROTTLING ENGINE (humanized)
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
//
// The cron worker calls processSendBatch() every 5 minutes. Each call sends
// a SMALL random batch (1-3 emails total across all accounts), not 30-50.

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

// Get all eligible accounts (within daily + hourly caps, warmed up).
// Does NOT pick one — returns the full eligible pool so the caller can
// randomly select a subset.
async function getEligibleAccounts(now: Date): Promise<SmtpAccount[]> {
  const accounts = await db.smtpAccount.findMany({
    where: { status: 'active' },
  })

  const eligible: SmtpAccount[] = []
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

  for (const account of accounts) {
    // Warmup gate — warming accounts don't send campaign emails
    if (account.warmupEnabled && account.warmupState !== 'warm') continue

    // Daily cap check
    if (account.sentToday >= account.dailyCap) continue

    // Hourly cap check — count sends in the last hour
    const sentLastHour = await db.scheduledEmail.count({
      where: {
        smtpAccountId: account.id,
        sentAt: { gte: oneHourAgo },
        status: 'sent',
      },
    })
    if (sentLastHour >= account.hourlyCap) continue

    // Per-account recent-send throttle: if this account sent in the last
    // 90 seconds, skip it this tick (so the same account doesn't fire twice
    // in quick succession across consecutive cron ticks).
    if (account.lastSentAt) {
      const secsSinceLastSend = (now.getTime() - account.lastSentAt.getTime()) / 1000
      if (secsSinceLastSend < 90) continue
    }

    eligible.push(account)
  }

  return eligible
}

// Pick a RANDOM subset of eligible accounts for this tick.
// We never use more than ~40% of the eligible pool in a single tick, so
// traffic is spread across many accounts over time rather than all-at-once.
function pickRandomAccountSubset(accounts: SmtpAccount[]): SmtpAccount[] {
  if (accounts.length === 0) return []
  // Send from 1 to min(3, ceil(eligible * 0.4)) accounts this tick.
  // With 10 eligible accounts → 1-3 accounts per tick.
  // With 3 eligible accounts → 1-2 accounts per tick.
  // With 1 eligible account → always that 1.
  const maxThisTick = Math.max(1, Math.min(3, Math.ceil(accounts.length * 0.4)))
  const count = randInt(1, maxThisTick)
  return shuffle(accounts).slice(0, count)
}

// Fetch the next batch of scheduled emails to send (only within sending window)
function isWithinSendingWindow(startHour: number, endHour: number, now: Date, timezone: string): boolean {
  // Use the campaign's timezone to compute the local hour.
  // Falls back to server local time if the timezone is invalid.
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
    // Window wraps midnight (e.g. 22 to 6)
    return localHour >= startHour || localHour < endHour
  } catch {
    // Bad timezone — fall back to server local
    const hour = now.getHours()
    if (startHour <= endHour) {
      return hour >= startHour && hour < endHour
    }
    return hour >= startHour || hour < endHour
  }
}

// Process a SMALL randomized batch of scheduled emails.
//
// Per tick (every 5 min from cron), we send at most 1-3 emails total,
// spread across 1-3 randomly-chosen accounts, with a random 10-45s delay
// between each send. This makes traffic look human instead of bursty.
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

  // Fetch due queued emails (we fetch a few more than batchSize so we can
  // randomly pick from them — random order, not always oldest-first)
  const due = await db.scheduledEmail.findMany({
    where: {
      status: 'queued',
      scheduledAt: { lte: now },
    },
    include: { lead: true, campaign: true },
    orderBy: { scheduledAt: 'asc' },
    take: batchSize * 4,
  })

  if (due.length === 0) {
    return { processed: 0, sent: 0, failed: 0, skipped: 0, errors }
  }

  // Randomize the order of due emails — don't always send the oldest first.
  // This also means two leads scheduled at the same time aren't always sent
  // in the same sequence across ticks.
  const randomizedDue = shuffle(due).slice(0, batchSize)

  // Pick a random subset of eligible accounts for this tick
  const eligibleAccounts = await getEligibleAccounts(now)
  if (eligibleAccounts.length === 0) {
    // No account available — push all due schedules forward by 10-25 min
    // (randomized, not a fixed 15 min) so we don't retry in lockstep.
    const later = new Date(now.getTime() + randInt(10, 25) * 60 * 1000)
    await db.scheduledEmail.updateMany({
      where: { id: { in: randomizedDue.map((d) => d.id) }, status: 'queued' },
      data: { scheduledAt: later },
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
    if (!isWithinSendingWindow(
      item.campaign.sendingWindowStart,
      item.campaign.sendingWindowEnd,
      now,
      item.campaign.timezone,
    )) {
      // Reschedule to next window start with jitter
      const next = new Date(now)
      next.setHours(item.campaign.sendingWindowStart, 0, 0, 0)
      if (next <= now) next.setDate(next.getDate() + 1)
      next.setMinutes(next.getMinutes() + Math.floor(Math.random() * 45))
      await db.scheduledEmail.update({
        where: { id: item.id },
        data: { scheduledAt: next },
      })
      skipped++
      continue
    }

    // Check if lead was replied/suppressed/bounced — skip remaining steps
    if (['replied', 'suppressed', 'bounced', 'unsubscribed'].includes(item.lead.status)) {
      await db.scheduledEmail.update({
        where: { id: item.id },
        data: { status: 'cancelled' },
      })
      skipped++
      continue
    }

    // Pick the next account from our random subset (round-robin within the
    // subset, but the subset itself is randomly chosen each tick)
    const account = accountsThisTick[accountIndex % accountsThisTick.length]
    accountIndex++

    // Re-verify this specific account is still under caps (another tick may
    // have incremented it)
    if (account.sentToday >= account.dailyCap) {
      skipped++
      continue
    }

    // Mark as sending
    await db.scheduledEmail.update({
      where: { id: item.id },
      data: {
        status: 'sending',
        smtpAccountId: account.id,
        assignedAt: now,
        attempts: { increment: 1 },
      },
    })

    try {
      // ─── PLAIN TEXT EMAIL — RAW BODY ONLY, NOTHING ADDED ───
      // Per user request: send ONLY the email text exactly as written in the
      // campaign/CSV. No HTML, no tracking pixel, no unsubscribe link, no
      // footer, no signature, no opt-out line. The body is sent verbatim.
      //
      // We do NOT wrap URLs in click-tracking redirects.
      // We do NOT add an HTML body.
      // We do NOT add a tracking pixel.
      // We do NOT append any footer or signature.
      //
      // Pick a variant (A/B/C) if the step has multiple — frozen per lead.
      const bodyText = pickVariant(item.body)
      const subjectText = pickVariant(item.subject)

      const { messageId } = await sendMail(account, {
        to: item.lead.email,
        subject: subjectText,
        text: bodyText,
        // Explicitly NO html — plain text only, like a phone email
        fromName: item.campaign.fromNameOverride || account.fromName,
      })

      // Success — update everything
      await db.scheduledEmail.update({
        where: { id: item.id },
        data: { status: 'sent', sentAt: now, messageId },
      })
      await db.smtpAccount.update({
        where: { id: account.id },
        data: {
          sentToday: { increment: 1 },
          lastSentAt: now,
          failureStreak: 0,
        },
      })
      await db.lead.update({
        where: { id: item.leadId },
        data: {
          currentStep: item.stepNumber,
          lastStepSentAt: now,
          status: `step${item.stepNumber}_sent` as any,
        },
      })
      await db.emailLog.create({
        data: {
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

      // Schedule next step if exists
      await scheduleNextStep(item.leadId, item.campaignId, item.stepNumber, now)

      sent++

      // ─── HUMANIZING DELAY ───
      // After each successful send, sleep 10-45 seconds before the next send.
      // This prevents two emails from landing in the same minute from the
      // same account and makes traffic look human-paced.
      // (Only sleep if there's another email to send in this batch.)
      if (sent < randomizedDue.length) {
        const delayMs = randInt(10, 45) * 1000
        await sleep(delayMs)
      }
    } catch (e: any) {
      failed++
      const errMsg = e?.message || 'Unknown send error'
      errors.push(`${item.lead.email}: ${errMsg}`)
      await db.scheduledEmail.update({
        where: { id: item.id },
        data: {
          status: 'queued', // retry later
          lastError: errMsg,
          // Randomized retry delay: 25-50 min (was fixed 30 min)
          scheduledAt: new Date(now.getTime() + randInt(25, 50) * 60 * 1000),
        },
      })
      const updated = await db.smtpAccount.update({
        where: { id: account.id },
        data: { failureStreak: { increment: 1 } },
      })
      if (updated.failureStreak >= 3) {
        await db.smtpAccount.update({
          where: { id: account.id },
          data: { status: 'error', warmupState: 'paused' },
        })
        clearTransportCache(account.id)
        errors.push(`Account ${account.emailAddress} auto-paused after 3 failures`)
        await pushNotification({
          type: 'failure',
          severity: 'error',
          title: 'SMTP account auto-paused',
          message: `${account.emailAddress} paused after 3 consecutive send failures.`,
        }).catch(() => {})
      }
    }
  }

  return { processed: randomizedDue.length, sent, failed, skipped, errors }
}

// Schedule the next sequence step for a lead
export async function scheduleNextStep(leadId: string, campaignId: string, currentStep: number, now: Date) {
  const nextStep = await db.emailStep.findUnique({
    where: { campaignId_stepNumber: { campaignId, stepNumber: currentStep + 1 } },
  })
  if (!nextStep) return // no more steps

  const lead = await db.lead.findUnique({ where: { id: leadId } })
  if (!lead) return

  // Schedule the next step a few days out, but add random jitter (0-3 hours)
  // so follow-ups don't all land at the exact same minute of the day as the
  // initial send. This makes the sequence look more human.
  const jitterMs = Math.floor(Math.random() * 3 * 60 * 60 * 1000)
  const scheduledAt = new Date(now.getTime() + nextStep.delayDays * 24 * 60 * 60 * 1000 + jitterMs)

  // Use per-lead CSV overrides if available, otherwise fall back to step
  // defaults. Apply pickVariant() to support A/B/C variants.
  let body = nextStep.body
  let subject = nextStep.subject
  if (nextStep.stepNumber === 2 && lead.followupDay3) {
    body = lead.followupDay3
  } else if (nextStep.stepNumber === 3 && lead.followupDay7) {
    body = lead.followupDay7
  }
  // For follow-ups, use "Re: <original subject>" to create natural threading
  if (nextStep.stepNumber > 1) {
    const originalSubject = lead.outreachSubject || nextStep.subject
    subject = originalSubject.toLowerCase().startsWith('re:') ? originalSubject : `Re: ${originalSubject}`
  }

  await db.scheduledEmail.create({
    data: {
      campaignId,
      leadId,
      stepNumber: nextStep.stepNumber,
      subject,
      body,
      scheduledAt,
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY COUNTER RESET (call via cron at midnight)
// ─────────────────────────────────────────────────────────────────────────────
export async function resetDailyCounters() {
  await db.smtpAccount.updateMany({
    data: { sentToday: 0, warmupSentToday: 0, lastResetAt: new Date() },
  })
  // Advance warm-up ramp-up day
  const warming = await db.smtpAccount.findMany({
    where: { warmupEnabled: true, warmupState: { in: ['cold', 'heating'] } },
  })
  for (const account of warming) {
    const newDay = account.warmupDay + 1
    const target = Math.min(
      account.warmupStartQty + (newDay - 1) * account.warmupIncrement,
      account.warmupTargetMax
    )
    const newState = target >= account.warmupTargetMax ? 'warm' : 'heating'

    // If transitioning to 'warm', push a milestone notification
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
