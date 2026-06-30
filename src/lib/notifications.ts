// Lightweight notification pusher — used by dispatcher, warmup, and unibox modules
// to create in-app notifications when events occur.
//
// Notifications are stored in the Setting table as JSON (key: 'notifications').
// Webhooks (Slack/Discord) are stored as JSON (key: 'webhooks').
// The helper is safe to call from any module — it never throws.

import { db } from './db'

interface Notification {
  id: string
  type: string
  severity: string
  title: string
  message: string
  read: boolean
  createdAt: string
}

interface WebhookConfig {
  url: string
  type: 'slack' | 'discord' | 'generic'
  enabled: boolean
  events: string[] // which event types to forward (empty = all)
}

let notifCache: Notification[] | null = null
let webhookCache: WebhookConfig[] | null = null

async function loadNotifications(): Promise<Notification[]> {
  if (notifCache) return notifCache
  try {
    const setting = await db.setting.findUnique({ where: { key: 'notifications' } })
    if (!setting) return []
    notifCache = JSON.parse(setting.value)
    return notifCache!
  } catch {
    return []
  }
}

async function persistNotifications(notifs: Notification[]) {
  notifCache = notifs.slice(0, 100)
  try {
    await db.setting.upsert({
      where: { key: 'notifications' },
      create: { key: 'notifications', value: JSON.stringify(notifCache) },
      update: { value: JSON.stringify(notifCache) },
    })
  } catch (e: any) {
    console.error('[notifications] persist failed:', e?.message)
  }
}

async function loadWebhooks(): Promise<WebhookConfig[]> {
  if (webhookCache) return webhookCache
  try {
    const setting = await db.setting.findUnique({ where: { key: 'webhooks' } })
    if (!setting) return []
    webhookCache = JSON.parse(setting.value)
    return webhookCache!
  } catch {
    return []
  }
}

// Send webhook to Slack/Discord/generic endpoint
async function sendWebhooks(notif: Notification) {
  const webhooks = await loadWebhooks()
  const activeWebhooks = webhooks.filter((w) => w.enabled && w.url)
  if (activeWebhooks.length === 0) return

  await Promise.all(
    activeWebhooks.map(async (webhook) => {
      // Check if this webhook should receive this event type
      if (webhook.events.length > 0 && !webhook.events.includes(notif.type)) return

      try {
        let body: Record<string, any>
        if (webhook.type === 'slack') {
          // Slack incoming webhook format
          const color = notif.severity === 'error' ? '#dc2626'
            : notif.severity === 'warning' ? '#d97706'
            : notif.severity === 'success' ? '#059669'
            : '#6366f1'
          body = {
            attachments: [{
              color,
              title: notif.title,
              text: notif.message,
              footer: 'Lead Dispatcher',
              ts: Math.floor(new Date(notif.createdAt).getTime() / 1000),
            }],
          }
        } else if (webhook.type === 'discord') {
          // Discord webhook format
          const color = notif.severity === 'error' ? 0xdc2626
            : notif.severity === 'warning' ? 0xd97706
            : notif.severity === 'success' ? 0x059669
            : 0x6366f1
          body = {
            embeds: [{
              title: notif.title,
              description: notif.message,
              color,
              footer: { text: 'Lead Dispatcher' },
              timestamp: notif.createdAt,
            }],
          }
        } else {
          // Generic JSON payload
          body = { event: notif.type, severity: notif.severity, title: notif.title, message: notif.message, timestamp: notif.createdAt }
        }

        await fetch(webhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000), // 10s timeout
        })
      } catch (e: any) {
        console.error(`[webhook] ${webhook.type} failed:`, e?.message)
      }
    }),
  )
}

export async function pushNotification(params: {
  type: 'reply' | 'bounce' | 'unsubscribe' | 'failure' | 'warmup' | 'system'
  severity: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
}): Promise<void> {
  try {
    const notifs = await loadNotifications()
    const newNotif: Notification = {
      id: `notif_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: params.type,
      severity: params.severity,
      title: params.title,
      message: params.message,
      read: false,
      createdAt: new Date().toISOString(),
    }
    notifs.unshift(newNotif)
    await persistNotifications(notifs)

    // Fire and forget — webhooks run in background
    sendWebhooks(newNotif).catch(() => {})
  } catch (e: any) {
    console.error('[notifications] push failed:', e?.message)
  }
}

// Invalidate webhook cache (call after settings update)
export function invalidateWebhookCache() {
  webhookCache = null
}
