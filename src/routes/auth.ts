import { Hono } from 'hono'
import { db } from '../lib/db'
import { signToken, verifyToken, getUser, getUserId } from '../lib/auth'
import { hashPassword, verifyPassword } from '../lib/crypto'
import { authRateLimit } from '../lib/rateLimit'
import crypto from 'node:crypto'

const app = new Hono()

// POST /api/auth/register — create internal user.
//
// Two paths:
//   (1) If NO users exist in the DB → first-time setup. Anyone can create
//       the first admin account. (Bootstrap.)
//   (2) Otherwise → registration requires a valid `inviteToken` in the body.
//       Invites are issued by admins via POST /api/auth/invite.
//
// Rate-limited: 10/15min per IP, 5/15min per email.
app.post('/register', authRateLimit(), async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { email, name, password, inviteToken } = body as {
    email: string
    name: string
    password: string
    inviteToken?: string
  }
  if (!email || !name || !password) {
    return c.json({ error: 'email, name, password required' }, 400)
  }
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }
  const normalizedEmail = String(email).toLowerCase().trim()

  const userCount = await db.user.count()
  if (userCount > 0) {
    // Not first-time setup — require invite token
    if (!inviteToken) {
      return c.json(
        { error: 'Registration is invite-only. Ask an admin to generate an invite token.' },
        403
      )
    }
    // Validate invite token
    const invite = await db.inviteToken.findUnique({
      where: { token: inviteToken },
    })
    if (!invite) return c.json({ error: 'Invalid invite token' }, 403)
    if (invite.expiresAt < new Date()) {
      return c.json({ error: 'Invite token has expired' }, 403)
    }
    if (invite.usedById || invite.usedAt) {
      return c.json({ error: 'Invite token has already been used' }, 403)
    }

    const existing = await db.user.findUnique({ where: { email: normalizedEmail } })
    if (existing) return c.json({ error: 'Email already registered' }, 409)

    const passwordHash = await hashPassword(password)
    const user = await db.user.create({
      data: {
        email: normalizedEmail,
        name,
        passwordHash,
        role: 'member', // invited users are members, not admins
      },
    })
    // Mark invite as used
    await db.inviteToken.update({
      where: { id: invite.id },
      data: { usedById: user.id, usedAt: new Date() },
    })
    const token = signToken({ userId: user.id, email: user.email, role: user.role })
    return c.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
  }

  // ─── First-time setup: no users exist → become admin ───
  const existing = await db.user.findUnique({ where: { email: normalizedEmail } })
  if (existing) return c.json({ error: 'Email already registered' }, 409)
  const passwordHash = await hashPassword(password)
  const user = await db.user.create({
    data: {
      email: normalizedEmail,
      name,
      passwordHash,
      role: 'admin', // first user is admin
    },
  })
  const token = signToken({ userId: user.id, email: user.email, role: user.role })
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
})

// POST /api/auth/login — rate-limited (10/15min per IP, 5/15min per email)
app.post('/login', authRateLimit(), async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { email, password } = body
  if (!email || !password) return c.json({ error: 'email and password required' }, 400)
  const normalizedEmail = String(email).toLowerCase().trim()
  const user = await db.user.findUnique({ where: { email: normalizedEmail } })
  if (!user) return c.json({ error: 'Invalid credentials' }, 401)
  const ok = await verifyPassword(password, user.passwordHash)
  if (!ok) return c.json({ error: 'Invalid credentials' }, 401)
  const token = signToken({ userId: user.id, email: user.email, role: user.role })
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
})

// GET /api/auth/me — verify token manually
app.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const token = authHeader.slice(7)
  const payload = verifyToken(token)
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  const dbUser = await db.user.findUnique({ where: { id: payload.userId } })
  if (!dbUser) return c.json({ error: 'User not found' }, 404)
  return c.json({ user: { id: dbUser.id, email: dbUser.email, name: dbUser.name, role: dbUser.role } })
})

// POST /api/auth/seed-admin — bootstrap first admin if no users exist.
// Rate-limited.
app.post('/seed-admin', authRateLimit(), async (c) => {
  const count = await db.user.count()
  if (count > 0) return c.json({ error: 'Users already exist — use /register with an invite token' }, 400)
  const body = await c.req.json().catch(() => ({}))
  const { email, name, password } = body
  if (!email || !name || !password) return c.json({ error: 'email, name, password required' }, 400)
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)
  const normalizedEmail = String(email).toLowerCase().trim()
  const existing = await db.user.findUnique({ where: { email: normalizedEmail } })
  if (existing) return c.json({ error: 'Email already registered' }, 409)
  const passwordHash = await hashPassword(password)
  const user = await db.user.create({
    data: { email: normalizedEmail, name, passwordHash, role: 'admin' },
  })
  const token = signToken({ userId: user.id, email: user.email, role: user.role })
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
})

// ─── Invite token system (admin-only) ──────────────────────────────────────

// POST /api/auth/invite — generate a new invite token (admin only).
// Body: { expiresInSeconds?: number } — default 7 days.
app.post('/invite', async (c) => {
  // Auth middleware has already verified the user; we re-check role here.
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const payload = verifyToken(authHeader.slice(7))
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  if (payload.role !== 'admin') {
    return c.json({ error: 'Admin privileges required to generate invite tokens' }, 403)
  }

  const body = await c.req.json().catch(() => ({}))
  const expiresInSeconds = Math.min(
    Math.max(parseInt(body.expiresInSeconds) || 7 * 24 * 60 * 60, 60),
    30 * 24 * 60 * 60
  ) // clamp: 1min..30days, default 7d

  // Ensure at least one admin exists (otherwise anyone could spam invites)
  const adminCount = await db.user.count({ where: { role: 'admin' } })
  if (adminCount === 0) {
    return c.json({ error: 'No admins exist — use /seed-admin to bootstrap the first admin' }, 400)
  }

  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000)
  const invite = await db.inviteToken.create({
    data: {
      token,
      createdById: payload.userId,
      expiresAt,
    },
  })
  return c.json({
    ok: true,
    invite: {
      id: invite.id,
      token: invite.token,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    },
    // The full URL the admin should share — frontend handles the actual
    // ?token=... param. We just emit the raw token here.
    shareUrl: `${process.env.FRONTEND_URL || ''}/register?token=${token}`,
  })
})

// GET /api/auth/invites — list all invite tokens (admin only)
app.get('/invites', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const payload = verifyToken(authHeader.slice(7))
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  if (payload.role !== 'admin') {
    return c.json({ error: 'Admin privileges required' }, 403)
  }
  const invites = await db.inviteToken.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      createdBy: { select: { id: true, email: true, name: true } },
      usedBy: { select: { id: true, email: true, name: true } },
    },
  })
  return c.json({ invites })
})

// DELETE /api/auth/invites/:id — revoke an invite (admin only)
app.delete('/invites/:id', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const payload = verifyToken(authHeader.slice(7))
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  if (payload.role !== 'admin') {
    return c.json({ error: 'Admin privileges required' }, 403)
  }
  await db.inviteToken.delete({ where: { id: c.req.param('id') } }).catch(() => null)
  return c.json({ ok: true })
})

export default app
