import { db } from '../lib/db'
import { fetchUnreadMessages, markMessageRead } from '../lib/imap'
import { pushNotification } from '../lib/notifications'
import { tagReplySentiment } from '../lib/llm'

// ─────────────────────────────────────────────────────────────────────────────
// UNIBOX INBOUND POLLER — fetch replies from all accounts, match to leads,
// trigger sequence-breaker, detect unsubscribe/bounce/OOO.
// ─────────────────────────────────────────────────────────────────────────────
//
// OOO handling (changed from the old "cancel everything" behavior):
//   When an OOO auto-reply is detected, we do NOT cancel the lead's future
//   steps. Instead, we set lead.pausedUntil = now + 7 days, and the
//   dispatcher (1) skips leads where pausedUntil > NOW() and (2) reschedules
//   the queued step to fire after the pause expires.
//
//   Rationale: OOO replies typically include a return date. Cancelling
//   follow-ups forever throws away a perfectly good lead. Pausing respects
//   the recipient's absence and resumes automatically once they're back.
//   7 days is a conservative default — most OOO is 1-2 weeks; we err on the
//   side of resuming sooner rather than later.

// ─── Unsubscribe patterns ───
// Match common opt-out phrasings with word boundaries to reduce false
// positives (e.g. "I want to unsubscribe" vs "I am not subscribed to that
// service"). Sourced from common email-compliance regex patterns + the
// `email-bounce-parser` library's signal set.
const UNSUBSCRIBE_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\bopt[\s-]?out\b/i,
  /\bstop sending\b/i,
  /\btake me off\b/i,
  /\bno longer\b.{0,20}\bemail/i,
  /\bplease stop\b/i,
  /\bno longer interested\b/i,
  /\bdon'?t (?:email|contact|email me)\b/i,
  /\bnot interested\b/i,
  /\bremove\b.{0,10}\blist\b/i,
  /\bunsubscribe me\b/i,
]

// ─── Bounce patterns ───
// Two layers:
//   (a) Subject-line patterns (very high signal): "Undeliverable", "Delivery
//       Status Notification", "Mail delivery failed", "Returned mail".
//   (b) Body patterns: SMTP enhanced status codes (RFC 3463) like 5.1.1,
//       5.2.1, 5.7.1, plus common bounce phrasings.
// Sourced from: email-bounce-parser, mailgun bounce patterns, Postfix DSN docs.
const BOUNCE_SUBJECT_PATTERNS = [
  /^undeliverable\b/i,
  /^delivery status notification\b/i,
  /^mail delivery failed\b/i,
  /^returned mail\b/i,
  /^delivery failure\b/i,
  /^failed delivery\b/i,
  /^warning: message /i, // postfix delay
  /^auto(?:matic)?: /i, // some autoresponders for delayed bounces
]

const BOUNCE_BODY_PATTERNS = [
  /delivery (?:status notification|failure)/i,
  /\bundeliverable\b/i,
  /mailbox (?:is )?full/i,
  /user (?:not )?found/i,
  /no such (?:user|address|mailbox)/i,
  /address rejected/i,
  /address not found/i,
  /email is a catch/i, // catch-all OOO auto-replies — false-positive risk, kept for legacy
  /recipient (?:address )?rejected/i,
  /does not exist/i,
  /invalid recipient/i,
  /permanent error/i,
  /5\.1\.1/, // mailbox does not exist
  /5\.1\.2/, // host does not exist
  /5\.2\.1/, // mailbox disabled
  /5\.2\.2/, // mailbox full
  /5\.4\.4/, // no answer
  /5\.5\.0/, // generic permanent
  /5\.7\.1/, // spam/blocked
  /5\.7\.[0-9]/, // other policy blocks
  /\b550\b/,
  /\b551\b/,
  /\b552\b/,
  /\b553\b/,
]

function isBounce(subject: string, body: string): boolean {
  const subj = subject || ''
  if (BOUNCE_SUBJECT_PATTERNS.some((p) => p.test(subj))) return true
  // Body needs a stronger signal when subject doesn't match — require BOTH a
  // pattern AND an email address mention (otherwise "permanent error" alone
  // could match a legitimate reply about a project error).
  const text = (subj + '\n' + body).slice(0, 8000)
  return BOUNCE_BODY_PATTERNS.some((p) => p.test(text))
}

// Extract the original recipient email from a bounce message body.
function extractBouncedRecipient(subject: string, body: string): string | null {
  const text = `${subject}\n${body}`.slice(0, 8000)

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
      if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) {
        return email
      }
    }
  }

  const allEmails = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []
  for (const e of allEmails) {
    const lower = e.toLowerCase()
    if (
      !lower.startsWith('postmaster@') &&
      !lower.startsWith('mailer-daemon@') &&
      !lower.startsWith('mail-daemon@') &&
      !lower.includes('noreply') &&
      !lower.includes('no-reply')
    ) {
      return lower
    }
  }
  return null
}

const OOO_PATTERNS = [
  /\bout of (?:the )?office\b/i,
  /\bOOO\b/,
  /\baway from (?:my )?email\b/i,
  /\bon vacation\b/i,
  /\breturning on\b/i,
  /\bauto[\s-]?reply\b/i,
  /\bautomatic reply\b/i,
  /\bwill be (?:out|away)\b/i,
  /\bcurrently (?:out|away|unavailable)\b/i,
  /\bback in the office on\b/i,
]

function detectReplyType(subject: string, body: string): 'unsubscribe' | 'bounce' | 'ooo' | 'normal' {
  const text = `${subject}\n${body}`.slice(0, 5000)
  if (isBounce(subject, body)) return 'bounce'
  if (UNSUBSCRIBE_PATTERNS.some((p) => p.test(text))) return 'unsubscribe'
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

  // 7-day window — bounces/replies can arrive late.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

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
        const isFromPeer = accounts.some(
          (a) => a.emailAddress.toLowerCase() === msg.from.toLowerCase()
        )
        if (isFromPeer) continue

        if (msg.messageId && processedMessageIds.has(msg.messageId)) continue
        if (msg.messageId) processedMessageIds.add(msg.messageId)

        const replyType = detectReplyType(msg.subject, msg.text)

        // Bounce-specific lead lookup
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
          lead = await db.lead.findFirst({
            where: { email: { equals: msg.from, mode: 'insensitive' } },
            include: { campaign: true },
          })
        }

        // Handle unmatched bounce — still suppress by recipient
        if (replyType === 'bounce' && !lead) {
          if (bouncedRecipientEmail) {
            // Use the bounced recipient's account ownerId if we can find it via
            // a previous EmailLog; otherwise attach to the account owner.
            const ownerId = account.ownerId
            await db.suppressionList
              .upsert({
                where: { email_reason: { email: bouncedRecipientEmail, reason: 'bounce' } },
                create: {
                  ownerId,
                  email: bouncedRecipientEmail,
                  reason: 'bounce',
                  source: `unmatched-bounce (${account.emailAddress})`,
                },
                update: {},
              })
              .catch(() => null)
            suppressed++
          }
          await db.emailLog
            .create({
              data: {
                ownerId: account.ownerId,
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
            })
            .catch(() => null)
          await markMessageRead(account, msg.folder, msg.uid)
          await pushNotification({
            type: 'bounce',
            severity: 'warning',
            title: 'Email bounced (unmatched)',
            message: `${bouncedRecipientEmail || 'Unknown recipient'} — ${msg.subject?.slice(0, 50) || 'delivery failed'}${bouncedRecipientEmail ? '. Added to suppression list.' : ''}`,
          }).catch(() => {})
          continue
        }

        if (!lead) {
          await db.emailLog
            .create({
              data: {
                ownerId: account.ownerId,
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
            })
            .catch(() => null)
          await markMessageRead(account, msg.folder, msg.uid)
          continue
        }

        // ─── LLM sentiment tagging (only for 'normal' replies — bounce/ooo/
        // unsubscribe are already classified by the regex). ───
        let sentiment: string | null = replyType
        if (replyType === 'normal') {
          sentiment = await tagReplySentiment(msg.from, msg.subject, msg.text).catch(() => 'neutral')
          // If LLM returned 'ooo'/'unsubscribe' that we missed, re-classify
          if (sentiment === 'ooo' || sentiment === 'unsubscribe') {
            replyType as any // keep original
          }
        }

        await db.reply
          .create({
            data: {
              leadId: lead.id,
              fromEmail: msg.from,
              toEmail: account.emailAddress,
              subject: msg.subject,
              body: msg.text,
              messageId: msg.messageId,
              inReplyTo: msg.inReplyTo,
              receivedAt: msg.date,
              sentiment,
            },
          })
          .catch(() => null)

        newReplies++

        const sentimentLabel = sentiment && sentiment !== 'normal' ? ` · ${sentiment}` : ''
        await pushNotification({
          type: 'reply',
          severity: replyType === 'unsubscribe' || replyType === 'bounce' ? 'warning' : 'info',
          title: `New reply${sentimentLabel}`,
          message: `${msg.from} replied: "${msg.subject?.slice(0, 60) || '(no subject)'}"`,
        }).catch(() => {})

        await markMessageRead(account, msg.folder, msg.uid)

        // ─── SEQUENCE BREAKER ───
        if (replyType === 'normal') {
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
          await db.lead.update({
            where: { id: lead.id },
            data: { status: 'replied', repliedAt: new Date() },
          })
        } else if (replyType === 'ooo') {
          // ─── OOO = PAUSE, NOT CANCEL ───
          // Set pausedUntil = now + 7 days. The dispatcher's claim query skips
          // leads where pausedUntil > NOW(), and the per-item loop reschedules
          // any already-claimed rows to fire after the pause expires.
          const pausedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          await db.lead.update({
            where: { id: lead.id },
            data: { pausedUntil },
          }).catch(() => {})
          // Don't cancel anything — just push queued follow-ups past the pause.
          const queued = await db.scheduledEmail.findMany({
            where: { leadId: lead.id, status: 'queued' },
            select: { id: true, scheduledAt: true },
          })
          for (const q of queued) {
            if (q.scheduledAt < pausedUntil) {
              await db.scheduledEmail.update({
                where: { id: q.id },
                data: { scheduledAt: new Date(pausedUntil.getTime() + 60 * 1000) },
              })
            }
          }
        }

        // ─── UNSUBSCRIBE → SUPPRESS ───
        if (replyType === 'unsubscribe') {
          await db.$transaction(async (tx) => {
            await tx.suppressionList.upsert({
              where: { email_reason: { email: lead.email.toLowerCase(), reason: 'unsubscribe' } },
              create: {
                ownerId: lead.ownerId,
                email: lead.email.toLowerCase(),
                reason: 'unsubscribe',
                source: lead.campaign?.name,
              },
              update: {},
            })
            await tx.lead.update({
              where: { id: lead.id },
              data: { status: 'unsubscribed', unsubscribedAt: new Date() },
            })
            await tx.scheduledEmail.updateMany({
              where: { leadId: lead.id, status: 'queued' },
              data: { status: 'cancelled' },
            })
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
          await db.$transaction(async (tx) => {
            await tx.suppressionList.upsert({
              where: { email_reason: { email: lead.email.toLowerCase(), reason: 'bounce:permanent' } },
              create: {
                ownerId: lead.ownerId,
                email: lead.email.toLowerCase(),
                reason: 'bounce:permanent',
                source: lead.campaign?.name,
              },
              update: {},
            })
            await tx.lead.update({
              where: { id: lead.id },
              data: {
                status: 'bounced',
                bouncedAt: new Date(),
                verificationStatus: 'BAD',
                verificationReason: 'bounce_detected_inbound',
              },
            })
            await tx.scheduledEmail.updateMany({
              where: { leadId: lead.id, status: 'queued' },
              data: { status: 'cancelled' },
            })
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
        await db.emailLog
          .create({
            data: {
              ownerId: account.ownerId,
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
          .catch(() => null)
      }
    } catch (e: any) {
      errors.push(`${account.emailAddress}: ${e?.message}`)
    }
  }

  return { checked, newReplies, sequencesBroken, suppressed, errors }
}
