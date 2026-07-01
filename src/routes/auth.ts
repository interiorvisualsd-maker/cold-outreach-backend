import { Hono } from 'hono'
import { db } from '../lib/db'
import { signToken, verifyToken } from '../lib/auth'
import { hashPassword, verifyPassword } from '../lib/crypto'

const app = new Hono()

// POST /api/auth/register — create internal user (first user becomes admin)
app.post('/register', async (c) => {
  const body = await c.req.json()
  const { email, name, password } = body
  if (!email || !name || !password) {
    return c.json({ error: 'email, name, password required' }, 400)
  }
  const existing = await db.user.findUnique({ where: { email } })
  if (existing) return c.json({ error: 'Email already registered' }, 409)
  const passwordHash = await hashPassword(password)
  const userCount = await db.user.count()
  const user = await db.user.create({
    data: {
      email,
      name,
      passwordHash,
      role: userCount === 0 ? 'admin' : 'member',
    },
  })
  const token = signToken({ userId: user.id, email: user.email, role: user.role })
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
})

// POST /api/auth/login
app.post('/login', async (c) => {
  const body = await c.req.json()
  const { email, password } = body
  if (!email || !password) return c.json({ error: 'email and password required' }, 400)
  const user = await db.user.findUnique({ where: { email } })
  if (!user) return c.json({ error: 'Invalid credentials' }, 401)
  const ok = await verifyPassword(password, user.passwordHash)
  if (!ok) return c.json({ error: 'Invalid credentials' }, 401)
  const token = signToken({ userId: user.id, email: user.email, role: user.role })
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
})

// GET /api/auth/me — verify token manually (this route is public, so we check the header ourselves)
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

// POST /api/auth/seed-admin — bootstrap first admin if no users exist (convenience)
app.post('/seed-admin', async (c) => {
  const count = await db.user.count()
  if (count > 0) return c.json({ error: 'Users already exist — use /register' }, 400)
  const body = await c.req.json()
  const { email, name, password } = body
  if (!email || !name || !password) return c.json({ error: 'email, name, password required' }, 400)
  const passwordHash = await hashPassword(password)
  const user = await db.user.create({
    data: { email, name, passwordHash, role: 'admin' },
  })
  const token = signToken({ userId: user.id, email: user.email, role: user.role })
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
})

export default app
