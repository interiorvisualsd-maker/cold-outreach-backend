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
bunx prisma generate 2>&1 || echo "[startup] prisma generate failed"

echo "[startup] Applying Prisma migrations (migrate deploy)..."
bunx prisma migrate deploy 2>&1 || echo "[startup] prisma migrate deploy failed (continuing)"

echo "[startup] Starting API server..."
exec bun src/server.ts
