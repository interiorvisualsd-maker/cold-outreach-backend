import { ImapFlow } from 'imapflow'
import type { SmtpAccount } from '@prisma/client'
import { decrypt } from './crypto'

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

const INBOX_FOLDERS = ['INBOX', 'Inbox']

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

// Fetch recent unread messages from inbox + spam folders
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
          // Search for unread or recent messages since the given date
          const uids = await client.search({ seen: false, since }, { uid: true })
          if (!uids || uids.length === 0) continue
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
            const text = await parseMessageBody(msg.source)
            messages.push({
              uid: msg.uid,
              messageId: msg.envelope.messageId || '',
              from: msg.envelope.from?.map((a: any) => a.address || '').join(', ') || '',
              to: msg.envelope.to?.map((a: any) => a.address || '').join(', ') || '',
              subject: msg.envelope.subject || '(no subject)',
              text,
              inReplyTo: msg.envelope.inReplyTo,
              references: (msg.envelope as any).references,
              date: msg.envelope.date || msg.internalDate || new Date(),
              flags: Array.isArray(msg.flags) ? msg.flags.map((f: any) => String(f)) : [],
              folder,
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

// Simple text body extractor from raw message source
async function parseMessageBody(source: Buffer): Promise<string> {
  try {
    const raw = source.toString('utf-8')
    // Very basic extraction — take text after first blank line, strip HTML tags
    const parts = raw.split(/\r?\n\r?\n/)
    if (parts.length < 2) return raw.slice(0, 2000)
    let body = parts.slice(1).join('\n\n')
    // Strip quoted headers
    body = body.replace(/^On .* wrote:.*$/m, '').trim()
    // Strip HTML tags if present
    body = body.replace(/<[^>]*>/g, '')
    // Decode basic quoted-printable
    body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    return body.slice(0, 5000)
  } catch {
    return ''
  }
}
