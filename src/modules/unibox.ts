import { db } from '../lib/db'
import { fetchUnreadMessages, markMessageRead } from '../lib/imap'
import { pushNotification } from '../lib/notifications'

// ─────────────────────────────────────────────────────────────────────────────
// UNIBOX INBOUND POLLER — fetch replies from all accounts, match to leads,
// trigger sequence-breaker, detect unsubscribe/bounce/OOO
// ─────────────────────────────────────────────────────────────────────────────

const UNSUBSCRIBE_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\bopt[\s-]?out\b/i,
  /\bstop sending\b/i,
  /\btake me off\b/i,
  /\bno longer\b.{0,20}\bemail/i,
]

const BOUNCE_PATTERNS = [
  /delivery (status notification|failure)/i,
  /undeliverable/i,
  /mailbox (is )?full/i,
  /user (not )?found/i,
  /no such (user|address)/i,
  /address rejected/i,
  /550 /,
  /address not found/i,
  /email is a catch/i,
  /recipient (address )?rejected/i,
  /does not exist/i,
  /invalid recipient/i,
  /permanent error/i,
  /5\.1\.[0-9]/, // SMTP permanent failure codes
  /5\.2\.[0-9]/,
  /5\.4\.[0-9]/,
]

// Extract the original recipient email from a bounce message body.
// Bounce emails come FROM postmaster@... so we can't use msg.from to find the lead.
// Instead, parse the bounce body for the failed recipient address.
function extractBouncedRecipient(subject: string, body: string): string | null {
  const text = `${subject}\n${body}`.slice(0, 8000)

  // Common patterns in bounce messages:
  // "Original-Recipient: rfc822;user@example.com"
  // "Final-Recipient: rfc822;user@example.com"
  // "failed to deliver to user@example.com"
  // "delivery to user@example.com failed"
  // "user@example.com: mailbox full"
  // "Could not deliver message to <user@example.com>"
  // "Recipient: <user@example.com>"
  const patterns = [
    /Original-Recipient:\s*(?:rfc822;)?\s*([^\s<>]+@[^\s<>]+)/i,
    /Final-Recipient:\s*(?:rfc822;)?\s*([^\s<>]+@[^\s<>]+)/i,
    /deliver(?:ed|y)?\s+(?:to|message to)\s*[<?\s"']*([^\s<>@"']+@[^\s<>"'\s)]+)/i,
    /delivery\s+to\s+([^\s<>@"']+@[^\s<>"'\s)]+)\s+(?:failed|was|has)/i,
    /could not (?:deliver|send).*?\b([^\s<>@"']+@[^\s<>"'\s)]+)\b/i,
    /failed\s+(?:to|delivery).*?\b([^\s<>@"']+@[^\s<>"'\s)]+)\b/i,
    /recipient(?:\s+address)?:\s*[<?\s]*([^\s<>@"']+@[^\s<>"'\s)]+)/i,
    /\b([^\s<>@"']+@[^\s<>"'\s)]+)\b\s*[:\-]\s*(?:mailbox|user|address|delivery|recipient|does|not|reject|failed)/i,
    /\bto:\s*([^\s<>@"']+@[^\s<>"'\s)]+)/i,
  ]

  for (const p of patterns) {
    const m = text.match(p)
    if (m && m[1]) {
      const email = m[1].toLowerCase().trim().replace(/[>;.,)]+$/, '')
      // Sanity check — must look like an email
      if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
        return email
      }
    }
  }

  // Fallback: find the first email address in the body that's NOT a postmaster/mailer-daemon
  const allEmails = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []
  for (const e of allEmails) {
    const lower = e.toLowerCase()
    if (
      !lower.startsWith('postmaster@') &&
      !lower.startsWith('mailer-daemon@') &&
      !lower.startsWith('mail-daemon@') &&
      !lower.includes('hostinger.com') &&
      !lower.includes('noreply') &&
      !lower.includes('no-reply')
    ) {
      return lower
    }
  }

  return null
}

const OOO_PATTERNS = [
  /\bout of (the )?office\b/i,
  /\bOOO\b/,
  /\baway from (my )?email\b/i,
  /\bon vacation\b/i,
  /\breturning on\b/i,
  /\bauto[\s-]?reply\b/i,
  /\bautomatic reply\b/i,
]

function detectReplyType(subject: string, body: string): 'unsubscribe' | 'bounce' | 'ooo' | 'normal' {
  const text = `${subject}\n${body}`.slice(0, 3000)
  if (UNSUBSCRIBE_PATTERNS.some((p) => p.test(text))) return 'unsubscribe'
  if (BOUNCE_PATTERNS.some((p) => p.test(text))) return 'bounce'
  if (OOO_PATTERNS.some((p) => p.test(text))) return 'ooo'
  return 'normal'
}

export async function processInboundReplies(): Promise<{
  checked: number
  newReplies: number
  sequencesBroken: number
  suppressed: number
  errors: string[]
}> {
  const errors: string[] = []
  let checked = 0
  let newReplies = 0
  let sequencesBroken = 0
  let suppressed = 0

  const accounts = await db.smtpAccount.findMany({
    where: { status: { not: 'suspended' } },
  })

  // Look back 7 days (was 24h) — bounces/replies can arrive late, and since
  // we now fetch read messages too, we need a wider window to catch anything
  // the user saw on their phone before the app polled.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  // Pre-load all EmailLog messageIds for these accounts in the window, so we
  // can skip messages we've already processed (since we now fetch read + unread).
  const recentLogs = await db.emailLog.findMany({
    where: {
      direction: 'inbound',
      receivedAt: { gte: since },
      messageId: { not: null },
    },
    select: { messageId: true },
  })
  const processedMessageIds = new Set(
    recentLogs.map((l) => l.messageId).filter(Boolean) as string[]
  )

  for (const account of accounts) {
    try {
      const messages = await fetchUnreadMessages(account, since, 80)
      checked += messages.length

      for (const msg of messages) {
        // Skip messages from our own warm-up accounts
        const isFromPeer = accounts.some(
          (a) => a.emailAddress.toLowerCase() === msg.from.toLowerCase()
        )
        if (isFromPeer) continue

        // ─── DEDUPE: skip messages we've already processed ───
        // Since we now fetch ALL messages (read + unread) over a 7-day window,
        // we MUST dedupe by messageId to avoid re-processing bounces/replies
        // on every tick. EmailLog.messageId is our processed-message ledger.
        if (msg.messageId && processedMessageIds.has(msg.messageId)) {
          continue
        }
        // Track this messageId so we don't process it again in this same tick
        // (in case two accounts received the same forwarded message)
        if (msg.messageId) processedMessageIds.add(msg.messageId)

        const replyType = detectReplyType(msg.subject, msg.text)

        // ─── BOUNCE-SPECIFIC LEAD LOOKUP ───
        // Bounce emails come FROM postmaster@hostinger.com (or similar) — NOT from
        // the lead. So matching msg.from to a lead.email fails, and previously
        // bounces were silently dropped (lead status never updated, SuppressionList
        // never updated). Fix: extract the original recipient from the bounce body
        // and look up the lead by THAT email.
        let lead: any = null
        let bouncedRecipientEmail: string | null = null

        if (replyType === 'bounce') {
          bouncedRecipientEmail = extractBouncedRecipient(msg.subject || '', msg.text || '')
          if (bouncedRecipientEmail) {
            lead = await db.lead.findFirst({
              where: { email: { equals: bouncedRecipientEmail, mode: 'insensitive' } },
              include: { campaign: true },
            })
          }
        } else {
          // Normal reply / unsubscribe / OOO — match by msg.from (the replier's email)
          lead = await db.lead.findFirst({
            where: { email: { equals: msg.from, mode: 'insensitive' } },
            include: { campaign: true },
          })
        }

        // ─── HANDLE UNMATCHED BOUNCE: log + suppress by recipient email ───
        if (replyType === 'bounce' && !lead) {
          // Even if we couldn't match a lead, we should still:
          // 1. Add the bounced recipient to SuppressionList so future sends are blocked
          // 2. Log the bounce as an EmailLog (for visibility / debugging)
          if (bouncedRecipientEmail) {
            await db.suppressionList.upsert({
              where: { email_reason: { email: bouncedRecipientEmail, reason: 'bounce' } },
              create: {
                email: bouncedRecipientEmail,
                reason: 'bounce',
                source: `unmatched-bounce (${account.emailAddress})`,
              },
              update: {},
            }).catch(() => null)
            suppressed++
          }
          await db.emailLog.create({
            data: {
              direction: 'inbound',
              smtpAccountId: account.id,
              leadId: null,
              campaignId: null,
              toEmail: account.emailAddress,
              fromEmail: msg.from,
              subject: msg.subject,
              body: msg.text,
              messageId: msg.messageId,
              inReplyTo: msg.inReplyTo,
              isReply: true,
              receivedAt: msg.date,
            },
          }).catch(() => null)
          await markMessageRead(account, msg.folder, msg.uid)
          await pushNotification({
            type: 'bounce',
            severity: 'warning',
            title: 'Email bounced (unmatched)',
            message: `${bouncedRecipientEmail || 'Unknown recipient'} — ${msg.subject?.slice(0, 50) || 'delivery failed'}${bouncedRecipientEmail ? '. Added to suppression list.' : ''}`,
          }).catch(() => {})
          continue
        }

        // For non-bounce unmatched messages, log them and skip (no lead to act on)
        if (!lead) {
          await db.emailLog.create({
            data: {
              direction: 'inbound',
              smtpAccountId: account.id,
              leadId: null,
              campaignId: null,
              toEmail: account.emailAddress,
              fromEmail: msg.from,
              subject: msg.subject,
              body: msg.text,
              messageId: msg.messageId,
              inReplyTo: msg.inReplyTo,
              isReply: true,
              receivedAt: msg.date,
            },
          }).catch(() => null)
          await markMessageRead(account, msg.folder, msg.uid)
          continue // unmatched inbound — logged but no sequence to break
        }

        // Create Reply record (now that we know we have a real lead)
        await db.reply.create({
          data: {
            leadId: lead.id,
            fromEmail: msg.from,
            toEmail: account.emailAddress,
            subject: msg.subject,
            body: msg.text,
            messageId: msg.messageId,
            inReplyTo: msg.inReplyTo,
            receivedAt: msg.date,
            sentiment: replyType === 'normal' ? null : replyType,
          },
        }).catch(() => null)

        newReplies++

        // Push notification for new reply
        const sentimentLabel = replyType !== 'normal' ? ` · ${replyType}` : ''
        await pushNotification({
          type: 'reply',
          severity: replyType === 'unsubscribe' ? 'warning' : replyType === 'bounce' ? 'warning' : 'info',
          title: `New reply${sentimentLabel}`,
          message: `${msg.from} replied: "${msg.subject?.slice(0, 60) || '(no subject)'}"`,
        }).catch(() => {})

        // Mark IMAP message as read
        await markMessageRead(account, msg.folder, msg.uid)

        // ─── SEQUENCE BREAKER ───
        if (replyType === 'normal' || replyType === 'ooo') {
          // Cancel all pending follow-ups for this lead
          const cancelled = await db.scheduledEmail.updateMany({
            where: {
              leadId: lead.id,
              status: 'queued',
              stepNumber: { gt: 0 },
            },
            data: { status: 'cancelled' },
          })
          if (cancelled.count > 0) sequencesBroken++

          if (replyType === 'normal') {
            // Mark lead as replied
            await db.lead.update({
              where: { id: lead.id },
              data: { status: 'replied', repliedAt: new Date() },
            })
          }
          // OOO: keep lead in current state (don't mark replied), but follow-ups are cancelled.
          // A future enhancement could re-schedule after the detected return date.
        }

        // ─── UNSUBSCRIBE → SUPPRESS ───
        if (replyType === 'unsubscribe') {
          await db.suppressionList.upsert({
            where: { email_reason: { email: lead.email.toLowerCase(), reason: 'unsubscribe' } },
            create: { email: lead.email.toLowerCase(), reason: 'unsubscribe', source: lead.campaign?.name },
            update: {},
          })
          await db.lead.update({
            where: { id: lead.id },
            data: { status: 'unsubscribed', unsubscribedAt: new Date() },
          })
          // Cancel queued
          await db.scheduledEmail.updateMany({
            where: { leadId: lead.id, status: 'queued' },
            data: { status: 'cancelled' },
          })
          suppressed++
          await pushNotification({
            type: 'unsubscribe',
            severity: 'warning',
            title: 'Unsubscribe request',
            message: `${lead.email} unsubscribed. Added to suppression list.`,
          }).catch(() => {})
        }

        // ─── BOUNCE → SUPPRESS + MARK EMAIL INVALID ───
        if (replyType === 'bounce') {
          await db.suppressionList.upsert({
            where: { email_reason: { email: lead.email.toLowerCase(), reason: 'bounce' } },
            create: { email: lead.email.toLowerCase(), reason: 'bounce', source: lead.campaign?.name },
            update: {},
          })
          await db.lead.update({
            where: { id: lead.id },
            data: { status: 'bounced', bouncedAt: new Date() },
          })
          await db.scheduledEmail.updateMany({
            where: { leadId: lead.id, status: 'queued' },
            data: { status: 'cancelled' },
          })
          suppressed++
          await pushNotification({
            type: 'bounce',
            severity: 'warning',
            title: 'Email bounced',
            message: `${lead.email} — ${msg.subject?.slice(0, 40) || 'delivery failed'}. Lead auto-suppressed.`,
          }).catch(() => {})
        }

        // Log inbound
        await db.emailLog.create({
          data: {
            direction: 'inbound',
            smtpAccountId: account.id,
            leadId: lead.id,
            campaignId: lead.campaignId,
            toEmail: account.emailAddress,
            fromEmail: msg.from,
            subject: msg.subject,
            body: msg.text,
            messageId: msg.messageId,
            inReplyTo: msg.inReplyTo,
            isReply: true,
            receivedAt: msg.date,
          },
        })
      }
    } catch (e: any) {
      errors.push(`${account.emailAddress}: ${e?.message}`)
    }
  }

  return { checked, newReplies, sequencesBroken, suppressed, errors }
}
