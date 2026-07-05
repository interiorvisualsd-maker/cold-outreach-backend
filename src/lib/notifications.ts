// Lightweight notification pusher — used by dispatcher, warmup, and unibox modules
// to create in-app notifications when events occur.
//
// Notifications are stored in the Setting table as JSON (key: 'notifications').
// Webhooks (Slack/Discord) are stored as JSON (key: 'webhooks').
//
// PUB/SUB: In addition to persisting to the DB, pushNotification() also emits
// the notification to a standalone socket.io realtime service (port 3003) which
// broadcasts to all connected frontend clients. This gives real-time delivery
// without polling. The helper is safe to call from any module — it never throws.

import { db } from './db'
import http from 'node:http'
import https from 'node:https'

// ─── Realtime pub/sub publisher ───
// The backend publishes notifications via a simple HTTP/HTTPS POST to the
// realtime service's /emit endpoint. The realtime service then broadcasts to
// all connected frontend subscribers via socket.io.
//
// In sandbox: REALTIME_PUBLISHER_URL defaults to http://localhost:3003
// In production: set REALTIME_PUBLISHER_URL to the realtime service's public URL
//   e.g. https://cold-outreach-realtime.onrender.com
//
// We use Node's native http/https module (not fetch) because Next.js patches
// fetch with caching/interception that can prevent real HTTP requests.
const REALTIME_PUBLISHER_URL = process.env.REALTIME_PUBLISHER_URL || 'http://localhost:3003'

// Parse the URL once at startup
let parsedUrl: URL
try {
  parsedUrl = new URL(REALTIME_PUBLISHER_URL)
} catch {
  parsedUrl = new URL('http://localhost:3003')
}
const isHttps = parsedUrl.protocol === 'https:'

// Emit a notification to the realtime pub/sub service (fire-and-forget).
// If the realtime service is down, this is a no-op (DB persistence still works).
function emitToRealtime(notif: Notification) {
  try {
    const body = JSON.stringify(notif)
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: '/emit',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 3000,
    }
    const req = (isHttps ? https : http).request(options, (res) => {
      res.resume()
    })
    req.on('error', () => {
      // Silent — realtime service may be down. DB persistence still works.
    })
    req.on('timeout', () => {
      req.destroy()
    })
    req.write(body)
    req.end()
  } catch {
    // Never let pub/sub failure crash the notification system
  }
}

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

  const deliveryLogs: DeliveryLog[] = []

  await Promise.all(
    activeWebhooks.map(async (webhook) => {
      // Check if this webhook should receive this event type
      if (webhook.events.length > 0 && !webhook.events.includes(notif.type)) return

      const log: DeliveryLog = {
        webhookId: webhook.id,
        webhookLabel: webhook.label || webhook.type,
        webhookType: webhook.type,
        eventType: notif.type,
        title: notif.title,
        success: false,
        timestamp: new Date().toISOString(),
      }

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

        const res = await fetch(webhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000), // 10s timeout
        })

        log.success = res.ok
        log.statusCode = res.status
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          log.error = text.slice(0, 200) || `HTTP ${res.status}`
        }
      } catch (e: any) {
        log.error = e?.message || 'fetch failed'
      }

      deliveryLogs.push(log)
    }),
  )

  // Persist delivery logs (fire and forget)
  if (deliveryLogs.length > 0) {
    persistDeliveryLogs(deliveryLogs).catch(() => {})
  }
}

interface DeliveryLog {
  webhookId: string
  webhookLabel: string
  webhookType: string
  eventType: string
  title: string
  success: boolean
  statusCode?: number
  error?: string
  timestamp: string
}

let deliveryCache: DeliveryLog[] | null = null

async function loadDeliveryLogs(): Promise<DeliveryLog[]> {
  if (deliveryCache) return deliveryCache
  try {
    const setting = await db.setting.findUnique({ where: { key: 'webhook_deliveries' } })
    if (!setting) return []
    deliveryCache = JSON.parse(setting.value)
    return deliveryCache!
  } catch {
    return []
  }
}

async function persistDeliveryLogs(newLogs: DeliveryLog[]) {
  try {
    const existing = await loadDeliveryLogs()
    const combined = [...newLogs, ...existing].slice(0, 200) // keep last 200
    deliveryCache = combined
    await db.setting.upsert({
      where: { key: 'webhook_deliveries' },
      create: { key: 'webhook_deliveries', value: JSON.stringify(combined) },
      update: { value: JSON.stringify(combined) },
    })
  } catch (e: any) {
    console.error('[webhooks] delivery log persist failed:', e?.message)
  }
}

export async function getDeliveryLogs(): Promise<DeliveryLog[]> {
  return loadDeliveryLogs()
}

export async function pushNotification(params: {
  type: 'reply' | 'bounce' | 'unsubscribe' | 'failure' | 'warmup' | 'system'
  severity: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
}): Promise<void> {
  try {
    // Check preferences — if this event type is explicitly disabled, skip entirely
    const prefs = await loadPrefs()
    if (prefs[params.type] === false) {
      return // notification type disabled by user
    }

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

    // ─── PUB/SUB: emit to realtime service for instant delivery ───
    // This pushes the notification to all connected frontend clients via
    // socket.io, eliminating the 60s polling delay.
    emitToRealtime(newNotif)

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

// ─── Notification Preferences ─────────────────────────────────────────
// Stored in Setting table as JSON (key: 'notification_prefs')
// Maps event type → boolean (enabled/disabled)
interface NotificationPrefs {
  reply?: boolean
  bounce?: boolean
  unsubscribe?: boolean
  failure?: boolean
  warmup?: boolean
  system?: boolean
}

let prefsCache: NotificationPrefs | null = null

async function loadPrefs(): Promise<NotificationPrefs> {
  if (prefsCache) return prefsCache
  try {
    const setting = await db.setting.findUnique({ where: { key: 'notification_prefs' } })
    if (!setting) return {}
    prefsCache = JSON.parse(setting.value)
    return prefsCache!
  } catch {
    return {}
  }
}

async function savePrefs(prefs: NotificationPrefs) {
  prefsCache = prefs
  try {
    await db.setting.upsert({
      where: { key: 'notification_prefs' },
      create: { key: 'notification_prefs', value: JSON.stringify(prefs) },
      update: { value: JSON.stringify(prefs) },
    })
  } catch (e: any) {
    console.error('[notifications] prefs persist failed:', e?.message)
  }
}

export async function getNotificationPrefs(): Promise<NotificationPrefs> {
  return loadPrefs()
}

export async function setNotificationPrefs(prefs: NotificationPrefs): Promise<NotificationPrefs> {
  await savePrefs(prefs)
  return prefs
}

export function invalidatePrefsCache() {
  prefsCache = null
}
