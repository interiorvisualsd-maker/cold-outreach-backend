import { db } from '../lib/db'
import { fetchUnreadMessages, markMessageRead } from '../lib/imap'

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
]

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

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

  for (const account of accounts) {
    try {
      const messages = await fetchUnreadMessages(account, since, 50)
      checked += messages.length

      for (const msg of messages) {
        // Skip messages from our own warm-up accounts
        const isFromPeer = accounts.some(
          (a) => a.emailAddress.toLowerCase() === msg.from.toLowerCase()
        )
        if (isFromPeer) continue

        // Match to a lead by recipient (account) + sender email
        const lead = await db.lead.findFirst({
          where: { email: { equals: msg.from, mode: 'insensitive' } },
          include: { campaign: true },
        })

        const replyType = detectReplyType(msg.subject, msg.text)

        // Create Reply record (linked to lead if found)
        const reply = await db.reply.create({
          data: {
            leadId: lead?.id || 'unknown', // will skip if no lead
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

        if (!lead) continue // unmatched inbound — logged but no sequence to break

        // Re-create reply with proper leadId
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
