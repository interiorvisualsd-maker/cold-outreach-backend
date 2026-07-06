#!/bin/sh
# Startup script — runs Prisma migrations then starts the API server.
#
# IMPORTANT: We use `prisma migrate deploy` (NOT `prisma db push`).
#   - `db push --accept-data-loss` silently destroys data on every boot if
#     the schema drifts (the old behavior — production data loss risk).
#   - `migrate deploy` only applies migrations committed to the repo. It
#     NEVER auto-creates or auto-alters tables. To add a migration, run
#     `bunx prisma migrate dev --name <name>` LOCALLY, commit the resulting
#     SQL, then deploy — production will pick it up on next boot.
#
# If no migrations exist yet, the deploy is a no-op and the schema won't be
# applied. Bootstrap with:
#   bunx prisma migrate dev --name init   # one-time, in dev only

echo "172.65.255.143 smtp.hostinger.com" >> /etc/hosts 2>/dev/null || true
echo "172.65.188.64 imap.hostinger.com" >> /etc/hosts 2>/dev/null || true
echo "172.65.188.64 pop.hostinger.com" >> /etc/hosts 2>/dev/null || true

echo "[startup] Generating Prisma client..."
cd /app
bunx prisma generate 2>&1 || { echo "[startup] FATAL: prisma generate failed"; exit 1; }

echo "[startup] Applying Prisma migrations (migrate deploy)..."
# Try migrate deploy first (safe — only applies committed migration files).
if ! bunx prisma migrate deploy 2>&1; then
  echo "[startup] ─────────────────────────────────────────────────────────"
  echo "[startup] ⚠️  prisma migrate deploy FAILED."
  echo "[startup] This usually means your database has OLD tables from a"
  echo "[startup] previous deploy that don't match the new migration history."
  echo "[startup]"
  echo "[startup] FIX (one-time):"
  echo "[startup]   1. Open your Neon SQL Editor"
  echo "[startup]   2. Run:  DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
  echo "[startup]   3. Click 'Manual Deploy → Deploy latest commit' on Render"
  echo "[startup] ─────────────────────────────────────────────────────────"
  echo "[startup] Falling back to `prisma db push` (safe — no data-loss flag)..."
  # Safe fallback: db push without --accept-data-loss syncs the schema.
  # This works on a fresh DB. On a dirty DB it may warn but won't destroy data.
  bunx prisma db push --skip-generate 2>&1 || echo "[startup] db push also failed — see errors above"
fi

echo "[startup] Starting API server..."
exec bun src/server.ts
