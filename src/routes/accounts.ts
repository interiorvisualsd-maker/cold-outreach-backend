import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../lib/db'
import { getUserId } from '../lib/auth'
import { encrypt, decrypt } from '../lib/crypto'
import { verifySmtp, clearTransportCache } from '../lib/smtp'
import { getImapClient } from '../lib/imap'

const app = new Hono()

const createSchema = z.object({
  label: z.string().min(1),
  emailAddress: z.string().email(),
  fromName: z.string().min(1),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpUser: z.string().min(1),
  smtpPass: z.string().min(1),
  smtpSecure: z.boolean().default(true),
  imapHost: z.string().min(1),
  imapPort: z.number().int().min(1).max(65535),
  imapUser: z.string().min(1),
  imapPass: z.string().min(1),
  imapSecure: z.boolean().default(true),
  dailyCap: z.number().int().min(1).max(500).default(50),
  hourlyCap: z.number().int().min(1).max(100).default(10),
  provider: z.enum(['gmail', 'outlook', 'yahoo', 'custom']).default('custom'),
  warmupEnabled: z.boolean().default(true),
  warmupStartQty: z.number().int().min(1).max(20).default(2),
  warmupIncrement: z.number().int().min(1).max(10).default(2),
  warmupTargetMax: z.number().int().min(5).max(50).default(20),
})

// GET /api/accounts — list all (scoped to current user)
app.get('/', async (c) => {
  const userId = getUserId(c)
  const accounts = await db.smtpAccount.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: 'desc' },
  })
  const safe = accounts.map((a) => ({
    ...a,
    smtpPassEnc: undefined,
    imapPassEnc: undefined,
    hasCredentials: true,
  }))
  return c.json({ accounts: safe })
})

// GET /api/accounts/:id
app.get('/:id', async (c) => {
  const userId = getUserId(c)
  const account = await db.smtpAccount.findUnique({ where: { id: c.req.param('id') } })
  if (!account || account.ownerId !== userId) return c.json({ error: 'Not found' }, 404)
  const { smtpPassEnc, imapPassEnc, ...safe } = account
  return c.json({ account: safe })
})

// POST /api/accounts — create (auto-verifies SMTP + IMAP before saving)
app.post('/', async (c) => {
  const userId = getUserId(c)
  const body = await c.req.json()
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'Invalid input' }, 400)
  }
  const d = parsed.data

  // Create a temporary account object for testing (not saved to DB yet)
  const tempAccount = {
    id: 'temp-' + Date.now(),
    ownerId: userId,
    label: d.label,
    emailAddress: d.emailAddress,
    fromName: d.fromName,
    smtpHost: d.smtpHost,
    smtpPort: d.smtpPort,
    smtpUser: d.smtpUser,
    smtpPassEnc: encrypt(d.smtpPass),
    smtpSecure: d.smtpSecure,
    imapHost: d.imapHost,
    imapPort: d.imapPort,
    imapUser: d.imapUser,
    imapPassEnc: encrypt(d.imapPass),
    imapSecure: d.imapSecure,
    provider: d.provider,
    dailyCap: d.dailyCap,
    hourlyCap: d.hourlyCap,
    warmupEnabled: d.warmupEnabled,
    warmupState: 'cold',
    warmupDay: 0,
    warmupTargetMax: d.warmupTargetMax,
    warmupStartQty: d.warmupStartQty,
    warmupIncrement: d.warmupIncrement,
    warmupSentToday: 0,
    sentToday: 0,
    failureStreak: 0,
    lastResetAt: new Date(),
    lastDailyResetAt: new Date(),
    lastSentAt: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any

  // Test SMTP connection
  const smtpResult = await verifySmtp(tempAccount)
  if (!smtpResult.ok) {
    return c.json({
      error: `SMTP verification failed: ${smtpResult.error}`,
      field: 'smtp',
      smtpError: smtpResult.error,
    }, 400)
  }

  // Test IMAP connection
  let imapOk = false
  let imapError: string | undefined
  try {
    const client = await getImapClient(tempAccount)
    await client.logout()
    imapOk = true
  } catch (e: any) {
    imapError = e?.message
  }
  if (!imapOk) {
    return c.json({
      error: `IMAP verification failed: ${imapError}`,
      field: 'imap',
      imapError,
    }, 400)
  }

  // Both passed — save the account (ownerId scoping)
  const account = await db.smtpAccount.create({
    data: {
      ownerId: userId,
      label: d.label,
      emailAddress: d.emailAddress.toLowerCase(),
      fromName: d.fromName,
      smtpHost: d.smtpHost,
      smtpPort: d.smtpPort,
      smtpUser: d.smtpUser,
      smtpPassEnc: encrypt(d.smtpPass),
      smtpSecure: d.smtpSecure,
      imapHost: d.imapHost,
      imapPort: d.imapPort,
      imapUser: d.imapUser,
      imapPassEnc: encrypt(d.imapPass),
      imapSecure: d.imapSecure,
      dailyCap: d.dailyCap,
      hourlyCap: d.hourlyCap,
      provider: d.provider,
      warmupEnabled: d.warmupEnabled,
      warmupStartQty: d.warmupStartQty,
      warmupIncrement: d.warmupIncrement,
      warmupTargetMax: d.warmupTargetMax,
      lastDailyResetAt: new Date(),
    },
  })
  return c.json({ account: { ...account, smtpPassEnc: undefined, imapPassEnc: undefined }, verified: true })
})

// PUT /api/accounts/:id — update (credentials optional)
app.put('/:id', async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const existing = await db.smtpAccount.findUnique({ where: { id } })
  if (!existing || existing.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json()

  if (body.smtpPass || body.imapPass || body.smtpHost || body.imapHost || body.smtpPort || body.imapPort) {
    const testAccount = {
      ...existing,
      smtpPassEnc: body.smtpPass ? encrypt(body.smtpPass) : existing.smtpPassEnc,
      imapPassEnc: body.imapPass ? encrypt(body.imapPass) : existing.imapPassEnc,
      smtpHost: body.smtpHost || existing.smtpHost,
      smtpPort: body.smtpPort || existing.smtpPort,
      imapHost: body.imapHost || existing.imapHost,
      imapPort: body.imapPort || existing.imapPort,
    } as any

    const smtpResult = await verifySmtp(testAccount)
    if (!smtpResult.ok) {
      return c.json({ error: `SMTP verification failed: ${smtpResult.error}`, field: 'smtp' }, 400)
    }
    try {
      const client = await getImapClient(testAccount)
      await client.logout()
    } catch (e: any) {
      return c.json({ error: `IMAP verification failed: ${e?.message}`, field: 'imap' }, 400)
    }
  }

  const data: any = {
    label: body.label,
    emailAddress: body.emailAddress ? String(body.emailAddress).toLowerCase() : undefined,
    fromName: body.fromName,
    smtpHost: body.smtpHost,
    smtpPort: body.smtpPort,
    smtpUser: body.smtpUser,
    smtpSecure: body.smtpSecure,
    imapHost: body.imapHost,
    imapPort: body.imapPort,
    imapUser: body.imapUser,
    imapSecure: body.imapSecure,
    dailyCap: body.dailyCap,
    hourlyCap: body.hourlyCap,
    provider: body.provider,
    warmupEnabled: body.warmupEnabled,
    warmupStartQty: body.warmupStartQty,
    warmupIncrement: body.warmupIncrement,
    warmupTargetMax: body.warmupTargetMax,
  }
  if (body.smtpPass) data.smtpPassEnc = encrypt(body.smtpPass)
  if (body.imapPass) data.imapPassEnc = encrypt(body.imapPass)
  Object.keys(data).forEach((k) => data[k] === undefined && delete data[k])

  const account = await db.smtpAccount.update({ where: { id }, data })
  clearTransportCache(id)
  return c.json({ account: { ...account, smtpPassEnc: undefined, imapPassEnc: undefined } })
})

// DELETE /api/accounts/:id
app.delete('/:id', async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const existing = await db.smtpAccount.findUnique({ where: { id } })
  if (!existing || existing.ownerId !== userId) return c.json({ error: 'Not found' }, 404)
  await db.smtpAccount.delete({ where: { id } }).catch(() => null)
  clearTransportCache(id)
  return c.json({ ok: true })
})

// POST /api/accounts/:id/test
app.post('/:id/test', async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const account = await db.smtpAccount.findUnique({ where: { id } })
  if (!account || account.ownerId !== userId) return c.json({ error: 'Not found' }, 404)

  const smtpResult = await verifySmtp(account)
  let imapOk = false
  let imapError: string | undefined
  try {
    const client = await getImapClient(account)
    await client.logout()
    imapOk = true
  } catch (e: any) {
    imapError = e?.message
  }
  return c.json({
    smtp: { ok: smtpResult.ok, error: smtpResult.error },
    imap: { ok: imapOk, error: imapError },
  })
})

// POST /api/accounts/:id/pause
app.post('/:id/pause', async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const existing = await db.smtpAccount.findUnique({ where: { id } })
  if (!existing || existing.ownerId !== userId) return c.json({ error: 'Not found' }, 404)
  const account = await db.smtpAccount.update({
    where: { id },
    data: { status: 'paused' },
  })
  return c.json({ account: { ...account, smtpPassEnc: undefined, imapPassEnc: undefined } })
})

// POST /api/accounts/:id/resume
app.post('/:id/resume', async (c) => {
  const userId = getUserId(c)
  const id = c.req.param('id')
  const existing = await db.smtpAccount.findUnique({ where: { id } })
  if (!existing || existing.ownerId !== userId) return c.json({ error: 'Not found' }, 404)
  const account = await db.smtpAccount.update({
    where: { id },
    data: { status: 'active', failureStreak: 0 },
  })
  return c.json({ account: { ...account, smtpPassEnc: undefined, imapPassEnc: undefined } })
})

export default app
