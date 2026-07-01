import { db } from '../lib/db'
import { sendMail } from '../lib/smtp'
import { fetchUnreadMessages, rescueFromSpam, markMessageRead, getImapClient } from '../lib/imap'
import type { SmtpAccount } from '@prisma/client'

// ─────────────────────────────────────────────────────────────────────────────
// WARM-UP PHRASE LIBRARY — short, natural, varied
// ─────────────────────────────────────────────────────────────────────────────
const WARMUP_SUBJECTS = [
  'Quick question', 'Following up', 'Lunch next week?', 'Re: our chat',
  'Tuesday update', 'Notes from yesterday', 'Quick thought', 'Re: project',
  'Coffee soon?', 'Status check', 'Re: draft', 'Hello!', 'Thinking ahead',
  'Re: feedback', 'Quick sync', 'Hope you\'re well', 'Friday note', 'Idea',
  'Re: timeline', 'Checking in', 'Re: numbers', 'Tomorrow?', 'Catch up?',
  'Re: proposal', 'FYI', 'Status?', 'Re: agenda', 'When free?',
]

const WARMUP_BODIES = [
  'Hey, just wanted to check in. How\'s everything going?',
  'Got a minute this week? Would love to catch up.',
  'Saw your last message — makes sense. Let\'s touch base tomorrow.',
  'Quick one: are we still on for the call? Let me know.',
  'Thanks for the heads up. I\'ll review and get back by EOD.',
  'Hey, just looping back. Did you get a chance to look at it?',
  'Sounds good. I\'ll move forward and share updates as we go.',
  'Appreciate it. Let\'s revisit next week once things settle.',
  'Got it. Will do. Talk soon.',
  'Just following up — no rush. Whenever you have a moment.',
  'Perfect, that works for me. Thanks!',
  'Quick update on my end — all on track. Will share more tomorrow.',
  'Got your note. I\'ll think it over and circle back.',
  'Sounds like a plan. I\'ll prepare the rest and send over.',
  'Hey, hope you\'re having a good week. Anything new on your side?',
  'Just a heads up — I\'ll be offline Friday afternoon.',
  'Got it, thanks! Will incorporate and resend.',
  'Quick question — do we have the latest numbers somewhere?',
  'All set on my end. Let me know if you need anything else.',
  'Thanks for the update. I\'ll adjust the plan accordingly.',
]

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ─────────────────────────────────────────────────────────────────────────────
// WARM-UP SCHEDULER — create peer-to-peer warm-up messages for today
// ─────────────────────────────────────────────────────────────────────────────

export async function scheduleWarmupMessages(): Promise<{ scheduled: number }> {
  const now = new Date()
  const accounts = await db.smtpAccount.findMany({
    where: {
      warmupEnabled: true,
      status: { in: ['active', 'error'] }, // keep warming even if send errored
      warmupState: { not: 'suspended' },
    },
  })

  if (accounts.length < 2) {
    return { scheduled: 0 } // need at least 2 accounts to warm each other
  }

  let scheduled = 0

  for (const account of accounts) {
    // Calculate today's target based on ramp-up
    const day = account.warmupDay + 1
    const target = Math.min(
      account.warmupStartQty + (day - 1) * account.warmupIncrement,
      account.warmupTargetMax
    )
    const remaining = Math.max(0, target - account.warmupSentToday)
    if (remaining <= 0) continue

    for (let i = 0; i < remaining; i++) {
      // Pick a different account to send TO
      const others = accounts.filter((a) => a.id !== account.id)
      if (others.length === 0) break
      const toAccount = randomItem(others)

      // 30% chance to continue an existing thread (if any)
      const existingThread = await db.warmupMessage.findFirst({
        where: {
          fromAccountId: account.id,
          toAccountId: toAccount.id,
          threadId: { not: null },
          status: { in: ['sent', 'received', 'replied'] },
        },
        orderBy: { createdAt: 'desc' },
      })

      const isThreadReply = existingThread && Math.random() < 0.3
      const subject = isThreadReply
        ? `Re: ${WARMUP_SUBJECTS[0]}` // simplified
        : randomItem(WARMUP_SUBJECTS)
      const body = randomItem(WARMUP_BODIES)

      // Stagger send times across the day with jitter
      const hourOfDay = Math.floor(Math.random() * 12) + 7 // 7 AM - 7 PM
      const scheduledAt = new Date(now)
      scheduledAt.setHours(hourOfDay, Math.floor(Math.random() * 60), 0, 0)
      if (scheduledAt <= now) scheduledAt.setHours(scheduledAt.getHours() + 1)

      await db.warmupMessage.create({
        data: {
          fromAccountId: account.id,
          toAccountId: toAccount.id,
          subject,
          body,
          threadId: isThreadReply ? existingThread!.threadId : null,
          status: 'queued',
          scheduledAt,
        },
      })
      scheduled++
    }
  }

  return { scheduled }
}

// ─────────────────────────────────────────────────────────────────────────────
// WARM-UP SENDER — send due warm-up messages
// ─────────────────────────────────────────────────────────────────────────────

export async function processWarmupBatch(batchSize = 20): Promise<{
  processed: number
  sent: number
  failed: number
  errors: string[]
}> {
  const now = new Date()
  const errors: string[] = []
  let sent = 0
  let failed = 0

  const due = await db.warmupMessage.findMany({
    where: { status: 'queued', scheduledAt: { lte: now } },
    take: batchSize,
    orderBy: { scheduledAt: 'asc' },
  })

  for (const msg of due) {
    const fromAccount = await db.smtpAccount.findUnique({ where: { id: msg.fromAccountId } })
    const toAccount = await db.smtpAccount.findUnique({ where: { id: msg.toAccountId } })
    if (!fromAccount || !toAccount) {
      await db.warmupMessage.update({ where: { id: msg.id }, data: { status: 'failed' } })
      failed++
      continue
    }

    try {
      const { messageId } = await sendMail(fromAccount, {
        to: toAccount.emailAddress,
        subject: msg.subject,
        text: msg.body,
        fromName: fromAccount.fromName,
      })

      await db.warmupMessage.update({
        where: { id: msg.id },
        data: { status: 'sent', sentAt: now },
      })
      await db.smtpAccount.update({
        where: { id: fromAccount.id },
        data: { warmupSentToday: { increment: 1 }, lastSentAt: now, failureStreak: 0 },
      })
      await db.emailLog.create({
        data: {
          direction: 'outbound',
          smtpAccountId: fromAccount.id,
          toEmail: toAccount.emailAddress,
          fromEmail: fromAccount.emailAddress,
          subject: msg.subject,
          body: msg.body,
          messageId,
          isWarmup: true,
          sentAt: now,
        },
      })
      sent++
    } catch (e: any) {
      failed++
      errors.push(`${fromAccount.emailAddress}→${toAccount.emailAddress}: ${e?.message}`)
      await db.warmupMessage.update({
        where: { id: msg.id },
        data: { status: 'failed', lastError: e?.message },
      })
      // Bump failure streak — dispatcher's auto-pause handles 3 strikes
      await db.smtpAccount.update({
        where: { id: fromAccount.id },
        data: { failureStreak: { increment: 1 } },
      })
    }
  }

  return { processed: due.length, sent, failed, errors }
}

// ─────────────────────────────────────────────────────────────────────────────
// WARM-UP INBOUND PROCESSOR — check IMAP for warm-up emails, rescue from spam,
// mark important + read, auto-reply to simulate thread depth
// ─────────────────────────────────────────────────────────────────────────────

export async function processWarmupInbound(): Promise<{
  checked: number
  rescued: number
  replied: number
  errors: string[]
}> {
  const errors: string[] = []
  let checked = 0
  let rescued = 0
  let replied = 0

  // Get all accounts that should receive warm-up emails
  const accounts = await db.smtpAccount.findMany({
    where: { warmupEnabled: true, status: { not: 'suspended' } },
  })

  // Only check messages from the last 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

  for (const account of accounts) {
    try {
      const messages = await fetchUnreadMessages(account, since, 30)
      checked += messages.length

      // Filter: only process messages from our other warm-up accounts
      const peerEmails = accounts
        .filter((a) => a.id !== account.id)
        .map((a) => a.emailAddress.toLowerCase())
      const peerSet = new Set(peerEmails)

      for (const msg of messages) {
        const fromEmail = msg.from.toLowerCase()
        if (!peerSet.has(fromEmail)) continue // not a warm-up message

        // Find the corresponding WarmupMessage record by sender + subject + recent timeframe
        const senderAccount = accounts.find((a) => a.emailAddress.toLowerCase() === fromEmail)
        if (!senderAccount) continue

        const warmupMsg = await db.warmupMessage.findFirst({
          where: {
            fromAccountId: senderAccount.id,
            toAccountId: account.id,
            subject: msg.subject,
            status: 'sent',
            sentAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) },
          },
          orderBy: { sentAt: 'desc' },
        })
        if (!warmupMsg) continue

        // If in spam folder, rescue it
        const wasInSpam = msg.folder.toLowerCase().includes('spam') ||
          msg.folder.toLowerCase().includes('junk') ||
          msg.folder.toLowerCase().includes('bulk')
        if (wasInSpam) {
          const ok = await rescueFromSpam(account, msg.folder, msg.uid)
          if (ok) rescued++
        } else {
          // Already in inbox — just mark important + read
          await markMessageRead(account, msg.folder, msg.uid)
        }

        await db.warmupMessage.update({
          where: { id: warmupMsg.id },
          data: {
            status: 'rescued',
            receivedAt: new Date(),
            rescuedAt: wasInSpam ? new Date() : null,
          },
        })

        // Auto-reply to simulate thread depth (70% of the time)
        if (Math.random() < 0.7) {
          try {
            const replySubject = msg.subject.startsWith('Re:') ? msg.subject : `Re: ${msg.subject}`
            const replyBody = randomItem(WARMUP_BODIES)
            const { messageId } = await sendMail(account, {
              to: senderAccount.emailAddress,
              subject: replySubject,
              text: replyBody,
              fromName: account.fromName,
              inReplyTo: msg.messageId,
            })
            await db.warmupMessage.update({
              where: { id: warmupMsg.id },
              data: { status: 'replied', repliedAt: new Date() },
            })
            await db.emailLog.create({
              data: {
                direction: 'outbound',
                smtpAccountId: account.id,
                toEmail: senderAccount.emailAddress,
                fromEmail: account.emailAddress,
                subject: replySubject,
                body: replyBody,
                messageId,
                inReplyTo: msg.messageId,
                isWarmup: true,
                isReply: true,
                sentAt: new Date(),
              },
            })
            replied++
          } catch (e: any) {
            errors.push(`Auto-reply from ${account.emailAddress}: ${e?.message}`)
          }
        } else {
          await db.warmupMessage.update({
            where: { id: warmupMsg.id },
            data: { status: 'completed' },
          })
        }
      }
    } catch (e: any) {
      errors.push(`${account.emailAddress}: ${e?.message}`)
    }
  }

  return { checked, rescued, replied, errors }
}
