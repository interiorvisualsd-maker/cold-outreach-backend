import { PrismaClient } from '@prisma/client'

// Backend uses its own PrismaClient instance pointing at the same SQLite DB.
// In production, DATABASE_URL points to Neon Postgres.
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
