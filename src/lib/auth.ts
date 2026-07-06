import jwt from 'jsonwebtoken'
import type { Context, Next } from 'hono'
import { db } from './db'

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

// ─── User-existence cache ───────────────────────────────────────────────
// The auth middleware verifies the JWT signature, but a valid JWT can still
// reference a user that no longer exists in the DB (e.g. after a `DROP SCHEMA`
// reset, or if the user was deleted). Without this check, any create operation
// fails with a confusing P2003 foreign-key violation on `ownerId`.
//
// We cache "does this user exist?" for 60 seconds per user ID to avoid hitting
// the DB on every single request. The cache is in-memory and per-instance —
// if a user is deleted, the cache entry naturally expires within 60s.
const userExistsCache = new Map<string, { exists: boolean; checkedAt: number }>()
const USER_CACHE_TTL_MS = 60 * 1000 // 60 seconds

async function userExistsInDb(userId: string): Promise<boolean> {
  const cached = userExistsCache.get(userId)
  if (cached && Date.now() - cached.checkedAt < USER_CACHE_TTL_MS) {
    return cached.exists
  }
  try {
    const count = await db.user.count({ where: { id: userId } })
    const exists = count > 0
    userExistsCache.set(userId, { exists, checkedAt: Date.now() })
    return exists
  } catch {
    // DB error — fail open (don't block the request) but don't cache
    return true
  }
}

/** Invalidate the cache for a specific user (call when a user is deleted). */
export function invalidateUserCache(userId: string) {
  userExistsCache.delete(userId)
}

// Hono middleware: extracts Bearer token, attaches user to context.
// Also verifies the user still exists in the DB (cached 60s) so that a
// stale JWT from before a DB reset doesn't cause FK violations.
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
  // Verify the user still exists in the DB — a valid JWT that references a
  // deleted/non-existent user is treated as unauthorized. This triggers the
  // frontend's 401 handler (clear token + redirect to login) so the user
  // can re-register after a DB reset.
  const exists = await userExistsInDb(payload.userId)
  if (!exists) {
    invalidateUserCache(payload.userId)
    return c.json({ error: 'User account no longer exists — please log in again' }, 401)
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
