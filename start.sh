#!/bin/sh
# Startup script — creates database tables then starts the server

# Force IPv4 for Hostinger SMTP/IMAP by adding /etc/hosts entries
# This bypasses DNS entirely and prevents IPv6 connections to Cloudflare
echo "172.65.255.143 smtp.hostinger.com" >> /etc/hosts
echo "172.65.188.64 imap.hostinger.com" >> /etc/hosts
echo "172.65.188.64 pop.hostinger.com" >> /etc/hosts
echo "[startup] Added IPv4 /etc/hosts entries for Hostinger"

echo "[startup] Pushing database schema to Neon..."
cd /app
bunx prisma db push --accept-data-loss 2>&1 || echo "[startup] prisma db push failed (tables may already exist)"

echo "[startup] Starting API server..."
exec bun src/server.ts
