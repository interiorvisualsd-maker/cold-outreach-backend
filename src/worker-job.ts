// Cloud Run Job entry point — runs ONE worker tick and exits.
// Triggered by Cloud Scheduler every 5 minutes.
//
// Each invocation:
//   1. Sends due campaign emails (inbox rotation)
//   2. Sends due warm-up emails
//   3. Processes warm-up inbound (spam rescue + auto-reply)
//   4. Processes lead replies (sequence breaker + LLM sentiment tagging)
//   5. At midnight: schedules tomorrow's warm-up + resets daily counters
//
// Deploy as a Cloud Run Job:
//   gcloud run jobs create lead-dispatcher-worker \
//     --image gcr.io/PROJECT/cold-outreach-backend \
//     --command bun --args src/worker-job.ts \
//     --set-env-vars DATABASE_URL=...,JWT_SECRET=...,ENCRYPTION_KEY=...

import { processSendBatch, resetDailyCounters } from './modules/dispatcher'
import { processWarmupBatch, processWarmupInbound, scheduleWarmupMessages } from './modules/warmup'
import { processInboundReplies } from './modules/unibox'

async function main() {
  console.log('[worker-job] Starting tick at', new Date().toISOString())

  // 1. Send campaign emails
  const sendResult = await processSendBatch(50).catch((e) => {
    console.error('[worker-job] Send batch error:', e?.message)
    return { processed: 0, sent: 0, failed: 0, skipped: 0, errors: [] }
  })
  console.log('[worker-job] Campaign sends:', sendResult.sent, 'sent,', sendResult.failed, 'failed')

  // 2. Send warm-up emails
  const warmupSendResult = await processWarmupBatch(20).catch((e) => {
    console.error('[worker-job] Warmup send error:', e?.message)
    return { processed: 0, sent: 0, failed: 0, errors: [] }
  })
  console.log('[worker-job] Warmup sends:', warmupSendResult.sent, 'sent')

  // 3. Process warm-up inbound (spam rescue + auto-reply)
  const warmupInboundResult = await processWarmupInbound().catch((e) => {
    console.error('[worker-job] Warmup inbound error:', e?.message)
    return { checked: 0, rescued: 0, replied: 0, errors: [] }
  })
  console.log('[worker-job] Warmup inbound:', warmupInboundResult.rescued, 'rescued,', warmupInboundResult.replied, 'replied')

  // 4. Process lead replies (sequence breaker + LLM sentiment)
  const replyResult = await processInboundReplies().catch((e) => {
    console.error('[worker-job] Reply processing error:', e?.message)
    return { checked: 0, newReplies: 0, sequencesBroken: 0, suppressed: 0, errors: [] }
  })
  console.log('[worker-job] Replies:', replyResult.newReplies, 'new,', replyResult.sequencesBroken, 'sequences broken')

  // 5. Midnight tasks
  const hour = new Date().getUTCHours()
  if (hour === 0) {
    await scheduleWarmupMessages().catch((e) => console.error('[worker-job] Warmup schedule error:', e?.message))
    await resetDailyCounters().catch((e) => console.error('[worker-job] Reset error:', e?.message))
    console.log('[worker-job] Midnight tasks completed')
  }

  console.log('[worker-job] Tick complete')
  process.exit(0)
}

main().catch((e) => {
  console.error('[worker-job] Fatal error:', e)
  process.exit(1)
})
