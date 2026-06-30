// Lightweight notification pusher — used by dispatcher, warmup, and unibox modules
// to create in-app notifications when events occur.
//
// Notifications are stored in the Setting table as JSON (key: 'notifications').
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

let cache: Notification[] | null = null

async function loadNotifications(): Promise<Notification[]> {
  if (cache) return cache
  try {
    const setting = await db.setting.findUnique({ where: { key: 'notifications' } })
    if (!setting) return []
    cache = JSON.parse(setting.value)
    return cache!
  } catch {
    return []
  }
}

async function persistNotifications(notifs: Notification[]) {
  cache = notifs.slice(0, 100)
  try {
    await db.setting.upsert({
      where: { key: 'notifications' },
      create: { key: 'notifications', value: JSON.stringify(cache) },
      update: { value: JSON.stringify(cache) },
    })
  } catch (e: any) {
    // Silent fail — notifications are non-critical
    console.error('[notifications] persist failed:', e?.message)
  }
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
  } catch (e: any) {
    // Silent fail — notifications are non-critical
    console.error('[notifications] push failed:', e?.message)
  }
}
