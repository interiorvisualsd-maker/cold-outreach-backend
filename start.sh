#!/bin/sh
# Startup script

# Try to add /etc/hosts entries (may fail on non-root containers)
echo "172.65.255.143 smtp.hostinger.com" >> /etc/hosts 2>/dev/null || true
echo "172.65.188.64 imap.hostinger.com" >> /etc/hosts 2>/dev/null || true
echo "172.65.188.64 pop.hostinger.com" >> /etc/hosts 2>/dev/null || true

echo "[startup] Pushing database schema to Neon..."
cd /app
bunx prisma db push --accept-data-loss 2>&1 || echo "[startup] prisma db push failed"

echo "[startup] Starting API server..."
exec bun src/server.ts
