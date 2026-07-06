// Background worker — runs periodic tasks:
// - Send campaign emails (inbox rotation, atomically claimed via SKIP LOCKED)
// - Send warm-up emails (counts against dailyCap)
// - Process warm-up inbound (spam rescue + auto-reply)
// - Process lead replies (sequence breaker + LLM sentiment)
// - Recover stuck 'sending' emails (crashed worker reclaim)
// - Daily reset catch-up (Render sleep-safe — never stuck at cap)
// - Drain email-verification queue (quick + deep)
//
// In standalone mode (Render / Cloud Run): started by server.ts
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
      const { processSendBatch, recoverStuckSending, dailyResetCatchUp } = await import('./modules/dispatcher')
      const { processWarmupBatch, processWarmupInbound, scheduleWarmupMessages } = await import('./modules/warmup')
      const { processInboundReplies } = await import('./modules/unibox')
      const { processVerificationBatch } = await import('./routes/verify')

      // ─── Step 0: recover stuck 'sending' emails + daily reset catch-up ───
      // These MUST run before the send batch so the queue is in a clean state.
      // recoverStuckSending is also called inside processSendBatch — this is
      // belt-and-suspenders in case the send batch is skipped.
      await recoverStuckSending().catch((e) => console.error('[worker] recoverStuck err:', e?.message))
      await dailyResetCatchUp().catch((e) => console.error('[worker] dailyResetCatchUp err:', e?.message))

      // ─── Step 1: drain verification queue (10 concurrent) ───
      // Run BEFORE the send batch so newly-VERIFIED leads can be picked up
      // in the same tick, and so BAD leads are auto-suppressed before any
      // send attempt.
      await processVerificationBatch().catch((e) => console.error('[worker] verify err:', e?.message))

      // ─── Step 2: send campaign emails (atomically claimed) ───
      await processSendBatch(3).catch((e) => console.error('[worker] send batch err:', e?.message))

      // ─── Step 3: warm-up ───
      await processWarmupBatch(15).catch((e) => console.error('[worker] warmup send err:', e?.message))
      await processWarmupInbound().catch((e) => console.error('[worker] warmup inbound err:', e?.message))

      // ─── Step 4: inbound replies + sequence breaker ───
      await processInboundReplies().catch((e) => console.error('[worker] unibox err:', e?.message))

      // ─── Step 5: midnight tasks (also handled by dailyResetCatchUp) ───
      // scheduleWarmupMessages is still midnight-only (cheap to run, doesn't
      // need catch-up — it just creates warmup rows for the day ahead).
      const hour = new Date().getHours()
      if (hour === 0) {
        await scheduleWarmupMessages().catch((e) => console.error('[worker] warmup sched err:', e?.message))
      }
    } catch (e: any) {
      console.error('[worker] tick error:', e?.message)
    }
  }

  // Run worker every 5 minutes.
  setInterval(workerTick, 5 * 60 * 1000)
  // First tick after 30 seconds startup (give server time to settle).
  setTimeout(workerTick, 30 * 1000)
  console.log('[worker] Background worker started (tick every 5 min, first tick in 30s)')
}
