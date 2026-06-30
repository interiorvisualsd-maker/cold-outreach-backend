import { db } from '../lib/db'
import { sendMail } from '../lib/smtp'
import { clearTransportCache } from '../lib/smtp'
import type { SmtpAccount } from '@prisma/client'

// ─────────────────────────────────────────────────────────────────────────────
// INBOX ROTATION + THROTTLING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

// Pick the next available account using round-robin with capacity checks.
// Returns null if no account can accept more sends right now.
export async function pickAccountForSend(now: Date = new Date()): Promise<SmtpAccount | null> {
  const accounts = await db.smtpAccount.findMany({
    where: { status: 'active' },
    orderBy: { lastSentAt: 'asc' }, // round-robin: least recently used first
  })

  for (const account of accounts) {
    // Daily cap check
    if (account.sentToday >= account.dailyCap) continue
    // Hourly cap check — count sends in the last hour
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)
    const sentLastHour = await db.scheduledEmail.count({
      where: {
        smtpAccountId: account.id,
        sentAt: { gte: oneHourAgo },
        status: 'sent',
      },
    })
    if (sentLastHour >= account.hourlyCap) continue

    // Sending window check (only for campaign emails, warmup is 24/7)
    // The dispatcher only sends campaign emails here.
    return account
  }
  return null
}

// Fetch the next batch of emails to send (only within sending window)
function isWithinSendingWindow(startHour: number, endHour: number, now: Date, timezone: string): boolean {
  // Simple hour-based check in local time. Production should use a tz library.
  const hour = now.getHours()
  if (startHour <= endHour) {
    return hour >= startHour && hour < endHour
  }
  // Window wraps midnight (e.g. 22 to 6)
  return hour >= startHour || hour < endHour
}

// Process a batch of scheduled emails
export async function processSendBatch(batchSize = 50): Promise<{
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

  // Fetch due queued emails
  const due = await db.scheduledEmail.findMany({
    where: {
      status: 'queued',
      scheduledAt: { lte: now },
    },
    include: { lead: true, campaign: true },
    orderBy: { scheduledAt: 'asc' },
    take: batchSize,
  })

  for (const item of due) {
    // Check sending window for this campaign
    if (!isWithinSendingWindow(item.campaign.sendingWindowStart, item.campaign.sendingWindowEnd, now, item.campaign.timezone)) {
      // Reschedule to next window start
      const next = new Date(now)
      next.setHours(item.campaign.sendingWindowStart, 0, 0, 0)
      if (next <= now) next.setDate(next.getDate() + 1)
      // Add small jitter
      next.setMinutes(next.getMinutes() + Math.floor(Math.random() * 30))
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

    // Pick an account
    const account = await pickAccountForSend(now)
    if (!account) {
      // No account available — push schedule forward by 15 min and stop
      const later = new Date(now.getTime() + 15 * 60 * 1000)
      await db.scheduledEmail.updateMany({
        where: { id: { in: due.map((d) => d.id) }, status: 'queued' },
        data: { scheduledAt: later },
      })
      skipped += due.length - (sent + failed + skipped)
      break
    }

    // Mark as sending
    await db.scheduledEmail.update({
      where: { id: item.id },
      data: { status: 'sending', smtpAccountId: account.id, assignedAt: now, attempts: { increment: 1 } },
    })

    try {
      // Append unsubscribe footer (CAN-SPAM compliance)
      const unsubLink = `https://${process.env.PUBLIC_BASE_URL || 'localhost'}/u/${item.leadId}`
      const footer = `\n\n---\nTo unsubscribe, reply with "unsubscribe" or visit ${unsubLink}`
      const bodyWithFooter = item.body + footer

      const { messageId } = await sendMail(account, {
        to: item.lead.email,
        subject: item.subject,
        text: bodyWithFooter,
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
      // Log
      await db.emailLog.create({
        data: {
          direction: 'outbound',
          smtpAccountId: account.id,
          leadId: item.leadId,
          campaignId: item.campaignId,
          toEmail: item.lead.email,
          fromEmail: account.emailAddress,
          subject: item.subject,
          body: bodyWithFooter,
          messageId,
          sentAt: now,
        },
      })

      // Schedule next step if exists
      await scheduleNextStep(item.leadId, item.campaignId, item.stepNumber, now)

      sent++
    } catch (e: any) {
      failed++
      const errMsg = e?.message || 'Unknown send error'
      errors.push(`${item.lead.email}: ${errMsg}`)
      await db.scheduledEmail.update({
        where: { id: item.id },
        data: {
          status: 'queued', // retry later
          lastError: errMsg,
          scheduledAt: new Date(now.getTime() + 30 * 60 * 1000), // retry in 30 min
        },
      })
      // Increment failure streak; auto-pause after 3 consecutive
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
      }
    }
  }

  return { processed: due.length, sent, failed, skipped, errors }
}

// Schedule the next sequence step for a lead
export async function scheduleNextStep(leadId: string, campaignId: string, currentStep: number, now: Date) {
  const nextStep = await db.emailStep.findUnique({
    where: { campaignId_stepNumber: { campaignId, stepNumber: currentStep + 1 } },
  })
  if (!nextStep) return // no more steps

  const lead = await db.lead.findUnique({ where: { id: leadId } })
  if (!lead) return

  const scheduledAt = new Date(now.getTime() + nextStep.delayDays * 24 * 60 * 60 * 1000)
  const subject = nextStep.stepNumber === 2 && lead.followupDay3
    ? lead.followupDay3.split('\n')[0] // first line as subject fallback
    : nextStep.subject
  const body = nextStep.stepNumber === 2 ? (lead.followupDay3 || nextStep.body)
    : nextStep.stepNumber === 3 ? (lead.followupDay7 || nextStep.body)
    : nextStep.body

  // For followups, prefer the pre-generated body. Subject is shared.
  await db.scheduledEmail.create({
    data: {
      campaignId,
      leadId,
      stepNumber: nextStep.stepNumber,
      subject: nextStep.subject,
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
    await db.smtpAccount.update({
      where: { id: account.id },
      data: { warmupDay: newDay, warmupState: newState },
    })
  }
}
