import { ImapFlow } from 'imapflow'
import type { SmtpAccount } from '@prisma/client'
import { decrypt } from './crypto'
import { lookup as dnsLookup } from 'node:dns/promises'

async function resolveIPv4(hostname: string): Promise<string> {
  try {
    const result = await dnsLookup(hostname, { family: 4, all: false })
    return result.address
  } catch {
    return hostname
  }
}

const SPAM_FOLDERS: Record<string, string[]> = {
  gmail: ['[Gmail]/Spam', '[Gmail]/Junk', 'Spam'],
  outlook: ['Junk', 'Junk Email', 'Spam'],
  yahoo: ['Bulk Mail', 'Spam'],
  custom: ['Spam', 'Junk', 'Junk Email', 'Bulk Mail'],
}

export function getSpamFolders(provider: string): string[] {
  return SPAM_FOLDERS[provider] || SPAM_FOLDERS.custom
}

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

export async function getImapClient(account: SmtpAccount): Promise<ImapFlow> {
  const password = decrypt(account.imapPassEnc)
  const imapIp = await resolveIPv4(account.imapHost)
  console.log(`[imap] Resolved ${account.imapHost} → ${imapIp}`)
  
  const client = new ImapFlow({
    host: imapIp, // Use IP directly
    port: account.imapPort,
    secure: account.imapSecure,
    auth: {
      user: account.imapUser,
      pass: password,
    },
    logger: false,
    socketTimeout: 8000,
    connectTimeout: 5000,
    tls: {
      servername: account.imapHost, // Use original hostname for TLS
      rejectUnauthorized: false,
    },
  })
  await client.connect()
  return client
}

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
        continue
      }
    }
  } finally {
    await client.logout()
  }
  return messages
}

export async function rescueFromSpam(
  account: SmtpAccount,
  folder: string,
  uid: number
): Promise<boolean> {
  const client = await getImapClient(account)
  try {
    const lock = await client.getMailboxLock(folder)
    try {
      await client.messageMove(uid, 'INBOX', { uid: true })
    } finally {
      lock.release()
    }
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

async function parseMessageBody(source: Buffer): Promise<string> {
  try {
    const raw = source.toString('utf-8')
    const parts = raw.split(/\r?\n\r?\n/)
    if (parts.length < 2) return raw.slice(0, 2000)
    let body = parts.slice(1).join('\n\n')
    body = body.replace(/^On .* wrote:.*$/m, '').trim()
    body = body.replace(/<[^>]*>/g, '')
    body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    return body.slice(0, 5000)
  } catch {
    return ''
  }
}
