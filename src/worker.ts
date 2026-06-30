// Background worker — runs periodic tasks:
// - Send campaign emails (inbox rotation)
// - Send warm-up emails
// - Process warm-up inbound (spam rescue + auto-reply)
// - Process lead replies (sequence breaker)
// - Reset daily counters at midnight
// - Advance warm-up ramp-up day
//
// In standalone mode (Cloud Run): started by server.ts
// In sandbox (Next.js): started by src/lib/worker-init.ts on first API request

let started = false

export function startWorker() {
  if (started) return
  started = true
  runWorker()
}

// Alias used by the Next.js catch-all route
export function ensureWorkerStarted() {
  if (started) return
  started = true
  runWorker()
}

function runWorker() {
  async function workerTick() {
    try {
      const { processSendBatch } = await import('./modules/dispatcher')
      const { processWarmupBatch, processWarmupInbound, scheduleWarmupMessages } = await import('./modules/warmup')
      const { processInboundReplies } = await import('./modules/unibox')

      await processSendBatch(30).catch((e) => console.error('[worker] send batch err:', e?.message))
      await processWarmupBatch(15).catch((e) => console.error('[worker] warmup send err:', e?.message))
      await processWarmupInbound().catch((e) => console.error('[worker] warmup inbound err:', e?.message))
      await processInboundReplies().catch((e) => console.error('[worker] unibox err:', e?.message))

      const hour = new Date().getHours()
      if (hour === 0) {
        await scheduleWarmupMessages().catch((e) => console.error('[worker] warmup sched err:', e?.message))
        const { resetDailyCounters } = await import('./modules/dispatcher')
        await resetDailyCounters().catch((e) => console.error('[worker] reset err:', e?.message))
      }
    } catch (e: any) {
      console.error('[worker] tick error:', e?.message)
    }
  }

  // Run worker every 2 minutes
  setInterval(workerTick, 2 * 60 * 1000)
  // First tick after 30s startup (give the server time to settle)
  setTimeout(workerTick, 30000)
  console.log('[worker] Background worker started (tick every 2 min, first tick in 30s)')
}
