// Standalone entry — runs the backend API server (Cloud Run).
// The background worker runs SEPARATELY as a Cloud Run Job (see worker-job.ts).
// Do NOT start the worker here — Cloud Run instances are ephemeral and scale to zero.
import app from './app'

const PORT = parseInt(process.env.PORT || '3001')
console.log(`🚀 Lead Dispatcher backend API running on port ${PORT}`)
Bun.serve({ fetch: app.fetch, port: PORT })
