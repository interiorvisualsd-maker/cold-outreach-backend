import jwt from 'jsonwebtoken'
import type { Context, Next } from 'hono'

// ─────────────────────────────────────────────────────────────────────────────
// JWT SECRET — no dev fallback. Misconfigured deploys must fail loudly.
// ─────────────────────────────────────────────────────────────────────────────
const JWT_SECRET_RAW = process.env.JWT_SECRET
if (!JWT_SECRET_RAW || JWT_SECRET_RAW.length < 16) {
  // Fail fast at module load — better than silently signing tokens with a
  // weak/guessable secret. Generate with: openssl rand -hex 32
  throw new Error(
    'FATAL: JWT_SECRET environment variable is missing or too short (min 16 chars). ' +
      'Generate one with `openssl rand -hex 32` and set it before starting the server.'
  )
}
const JWT_SECRET: string = JWT_SECRET_RAW
const JWT_EXPIRES_IN = '7d'

export interface JwtPayload {
  userId: string
  email: string
  role: string
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload
  } catch {
    return null
  }
}

// Hono middleware: extracts Bearer token, attaches user to context.
// Also exposes a typed `userId` getter via `getUser(c)`.
export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }
  const token = authHeader.slice(7)
  const payload = verifyToken(token)
  if (!payload) {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }
  c.set('user', payload as any)
  c.set('userId', payload.userId)
  await next()
}

// Optional-auth middleware: attaches user if a valid token is present,
// but does not reject the request if absent. Used for public-but-aware routes.
export async function optionalAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    const payload = verifyToken(token)
    if (payload) {
      c.set('user', payload as any)
      c.set('userId', payload.userId)
    }
  }
  await next()
}

// Helper to get current user from context (in route handlers)
export function getUser(c: Context): JwtPayload {
  return c.get('user') as JwtPayload
}

// Helper to get the authenticated user's id (multi-tenant scoping)
export function getUserId(c: Context): string {
  return c.get('userId') as string
}

// Admin-only guard — call inside a protected route handler
export async function requireAdmin(c: Context, next: Next) {
  const user = getUser(c)
  if (user.role !== 'admin') {
    return c.json({ error: 'Admin privileges required' }, 403)
  }
  await next()
}
