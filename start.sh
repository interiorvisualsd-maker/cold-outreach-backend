#!/bin/sh
# Startup script — creates database tables then starts the server
# This runs on Render (and any Docker host)

echo "[startup] Pushing database schema to Neon..."
cd /app
bunx prisma db push --accept-data-loss 2>&1 || echo "[startup] prisma db push failed (tables may already exist)"

echo "[startup] Starting API server..."
exec bun src/server.ts
