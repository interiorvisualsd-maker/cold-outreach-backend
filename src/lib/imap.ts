import { ImapFlow } from 'imapflow'
import type { SmtpAccount } from '@prisma/client'
import { decrypt } from './crypto'
import { simpleParser } from 'mailparser'

export interface ImapMessage {
  uid: number
  messageId: string
  from: string
  to: string
  subject: string
  text: string
  html?: string
  inReplyTo?: string
  references?: string
  date: Date
  flags: string[]
  folder: string
  // True if this message is a delivery-status notification (DSN / bounce).
  isDeliveryStatus?: boolean
}

// Provider-specific spam folder name mapping
const SPAM_FOLDERS: Record<string, string[]> = {
  gmail: ['[Gmail]/Spam', '[Gmail]/Junk', 'Spam'],
  outlook: ['Junk', 'Junk Email', 'Spam'],
  yahoo: ['Bulk Mail', 'Spam'],
  custom: ['Spam', 'Junk', 'Junk Email', 'Bulk Mail'],
}

export function getSpamFolders(provider: string): string[] {
  return SPAM_FOLDERS[provider] || SPAM_FOLDERS.custom
}

export async function getImapClient(account: SmtpAccount): Promise<ImapFlow> {
  const password = decrypt(account.imapPassEnc)
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: {
      user: account.imapUser,
      pass: password,
    },
    logger: false,
    socketTimeout: 20000,
  })
  await client.connect()
  return client
}

// Fetch recent messages from inbox + spam folders.
//
// IMPORTANT: We fetch ALL messages (read AND unread) since the last poll,
// NOT just unread ones. This is critical because:
//   - Many users read their mail on a phone (BlueMail, Gmail app, etc.)
//   - The phone app marks messages as \Seen when it syncs
//   - If we only fetched unread, bounces/replies that the user already saw
//     on their phone would be invisible to the app → suppression list drift
//
// To avoid re-processing the same message on every tick, the caller should
// dedupe by `messageId` against the EmailLog table.
export async function fetchUnreadMessages(
  account: SmtpAccount,
  since: Date,
  limit = 50
): Promise<ImapMessage[]> {
  const client = await getImapClient(account)
  const messages: ImapMessage[] = []
  try {
    const foldersToCheck = ['INBOX', ...getSpamFolders(account.provider)]
    for (const folder of foldersToCheck) {
      try {
        const lock = await client.getMailboxLock(folder)
        try {
          // Search for ALL messages (seen + unseen) since the given date.
          // We do NOT filter by `seen: false` — see comment above.
          const uids = await client.search({ since }, { uid: true })
          if (!uids || uids.length === 0) continue
          // Take the most recent `limit` messages (highest UIDs = newest)
          const limited = uids.slice(-limit)
          for (const uid of limited) {
            const msg = await client.fetchOne(uid, {
              uid: true,
              envelope: true,
              source: true,
              flags: true,
              internalDate: true,
            }, { uid: true })
            if (!msg || !msg.envelope) continue
            const parsed = await parseMessageBody(msg.source)
            messages.push({
              uid: msg.uid,
              messageId: msg.envelope.messageId || parsed.messageId || '',
              from: msg.envelope.from?.map((a: any) => a.address || '').join(', ') || parsed.from || '',
              to: msg.envelope.to?.map((a: any) => a.address || '').join(', ') || parsed.to || '',
              subject: msg.envelope.subject || '(no subject)',
              text: parsed.text,
              html: parsed.html,
              inReplyTo: msg.envelope.inReplyTo || parsed.inReplyTo,
              references: (msg.envelope as any).references || parsed.references,
              date: msg.envelope.date ? new Date(msg.envelope.date) : (msg.internalDate ? new Date(msg.internalDate) : new Date()),
              flags: Array.isArray(msg.flags) ? msg.flags.map((f: any) => String(f)) : [],
              folder,
              isDeliveryStatus: parsed.isDeliveryStatus,
            })
          }
        } finally {
          lock.release()
        }
      } catch {
        // Folder may not exist for this provider — skip
        continue
      }
    }
  } finally {
    await client.logout()
  }
  return messages
}

// Move a message from spam folder to inbox, mark as important + read
export async function rescueFromSpam(
  account: SmtpAccount,
  folder: string,
  uid: number
): Promise<boolean> {
  const client = await getImapClient(account)
  try {
    const lock = await client.getMailboxLock(folder)
    try {
      // Move to INBOX
      await client.messageMove(uid, 'INBOX', { uid: true })
    } finally {
      lock.release()
    }
    // Now in INBOX — mark important + read
    const inboxLock = await client.getMailboxLock('INBOX')
    try {
      await client.messageFlagsAdd(uid, ['\\Flagged', '\\Seen'], { uid: true })
    } finally {
      inboxLock.release()
    }
    return true
  } catch {
    return false
  } finally {
    await client.logout()
  }
}

// Mark a message as read (used by Unibox when user opens a reply)
export async function markMessageRead(
  account: SmtpAccount,
  folder: string,
  uid: number
): Promise<boolean> {
  const client = await getImapClient(account)
  try {
    const lock = await client.getMailboxLock(folder)
    try {
      await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
      return true
    } finally {
      lock.release()
    }
  } catch {
    return false
  } finally {
    await client.logout()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Proper MIME parser using `mailparser`.
//
// The previous naive parser only looked at the first text block after the
// headers, which meant multipart/alternative and multipart/mixed messages
// (the vast majority of real-world bounces and replies) had their bodies
// silently dropped. mailparser correctly:
//   - Decodes base64 / quoted-printable / 7bit / 8bit
//   - Walks multipart trees (multipart/alternative, multipart/mixed,
//     multipart/related, multipart/report)
//   - Extracts text/plain and text/html parts
//   - Detects message/delivery-status parts (used for bounce DSN parsing)
//   - Handles MIME-encoded-word headers (=?utf-8?B?...?=)
// ─────────────────────────────────────────────────────────────────────────────
export interface ParsedBody {
  text: string
  html?: string
  messageId?: string
  inReplyTo?: string
  references?: string
  from?: string
  to?: string
  isDeliveryStatus: boolean
}

export async function parseMessageBody(source: Buffer | undefined | null): Promise<ParsedBody> {
  if (!source || source.length === 0) {
    return { text: '', isDeliveryStatus: false }
  }
  try {
    const parsed = await simpleParser(source, {
      // Skip heavy HTML-to-text conversion — we want the raw text part.
      skipHtmlToText: true,
      maxHtmlLengthToParse: 1024 * 1024, // 1MB cap
    })

    let text = parsed.text || ''
    // If no text part but we have HTML, do a minimal tag-strip fallback so
    // downstream regex (bounce/unsubscribe detection) still works.
    if (!text && parsed.html) {
      text = parsed.html.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim()
    }
    // Cap body size to keep DB + regex tractable
    if (text.length > 20000) text = text.slice(0, 20000)

    // Detect delivery-status parts (DSN bounces). mailparser exposes these
    // as attachments with contentType 'message/delivery-status'.
    let isDeliveryStatus = false
    const ct = (parsed.headers.get('content-type') as any)?.value || parsed.headers.get('content-type') || ''
    if (typeof ct === 'string' && /message\/delivery-status/i.test(ct)) {
      isDeliveryStatus = true
    }
    if (Array.isArray(parsed.attachments)) {
      for (const a of parsed.attachments as any[]) {
        const act = a.contentType || a.headers?.['content-type'] || ''
        if (/message\/delivery-status/i.test(act)) {
          isDeliveryStatus = true
          break
        }
      }
    }
    // Subject-based DSN heuristic (many providers don't set the MIME part)
    const subj = String(parsed.subject || '')
    if (
      /delivery status notification|undeliverable|mail delivery failed|returned mail|delivery failure/i.test(
        subj
      )
    ) {
      isDeliveryStatus = true
    }

    const fromObj = parsed.from as any
    const toObj = parsed.to as any
    const fromValue: string | undefined = Array.isArray(fromObj?.value)
      ? fromObj.value.map((a: any) => a.address).filter(Boolean).join(', ')
      : fromObj?.text || fromObj?.value?.toString?.() || undefined
    const toValue: string | undefined = Array.isArray(toObj?.value)
      ? toObj.value.map((a: any) => a.address).filter(Boolean).join(', ')
      : toObj?.text || toObj?.value?.toString?.() || undefined

    return {
      text,
      html: parsed.html || undefined,
      messageId: parsed.messageId || undefined,
      inReplyTo: parsed.inReplyTo || undefined,
      references: (parsed.headers.get('references') as string) || undefined,
      from: fromValue || undefined,
      to: toValue || undefined,
      isDeliveryStatus,
    }
  } catch (e: any) {
    console.error('[imap] mailparser failed, falling back to raw text:', e?.message)
    // Last-resort fallback: take everything after the first blank line.
    try {
      const raw = source.toString('utf-8')
      const parts = raw.split(/\r?\n\r?\n/)
      const body = parts.length < 2 ? raw : parts.slice(1).join('\n\n')
      return { text: body.slice(0, 20000), isDeliveryStatus: false }
    } catch {
      return { text: '', isDeliveryStatus: false }
    }
  }
}
