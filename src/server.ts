// Standalone entry — runs the backend as a Bun server on port 3001.
// Used in production (Cloud Run) and for local development testing.
// In the sandbox, the backend runs INSIDE the Next.js process via
// src/app/api/[...path]/route.ts — this file is not used there.
import dns from 'node:dns'
// Force IPv4 for all DNS resolution — prevents SMTP/IMAP connecting to
// Cloudflare IPv6 addresses that don't handle email protocols
dns.setDefaultResultOrder('ipv4first')

import app from './app'
import { startWorker } from './worker'

const PORT = parseInt(process.env.PORT || '3001')
console.log(`🚀 Lead Dispatcher backend running on http://localhost:${PORT}`)
Bun.serve({ fetch: app.fetch, port: PORT })

// Start the background worker (send queue, warmup, IMAP polling)
startWorker()
