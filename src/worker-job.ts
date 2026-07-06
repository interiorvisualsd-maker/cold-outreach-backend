// Standalone worker-job entry point — runs ONE worker tick and exits.
// Triggered by Cloud Scheduler every 5 minutes (alternative to the
// in-process setInterval worker in server.ts).
//
// Each invocation:
//   0. Recover stuck 'sending' emails (crashed worker reclaim)
//   1. Daily reset catch-up (Render sleep-safe)
//   2. Drain email-verification queue
//   3. Send campaign emails (atomic claim)
//   4. Send warm-up emails (counts against dailyCap)
//   5. Process warm-up inbound (spam rescue + auto-reply)
//   6. Process lead replies (sequence breaker + LLM sentiment)
//   7. At midnight: schedule tomorrow's warm-up

import { processSendBatch, recoverStuckSending, dailyResetCatchUp } from './modules/dispatcher'
import { processWarmupBatch, processWarmupInbound, scheduleWarmupMessages } from './modules/warmup'
import { processInboundReplies } from './modules/unibox'
import { processVerificationBatch } from './routes/verify'

async function main() {
  console.log('[worker-job] Starting tick at', new Date().toISOString())

  // 0. Recover stuck 'sending' emails
  const recovered = await recoverStuckSending().catch((e) => {
    console.error('[worker-job] Recover stuck error:', e?.message)
    return { reclaimed: 0 }
  })
  if (recovered.reclaimed > 0) {
    console.log('[worker-job] Recovered', recovered.reclaimed, 'stuck sending emails')
  }

  // 1. Daily reset catch-up
  const reset = await dailyResetCatchUp().catch((e) => {
    console.error('[worker-job] Daily reset error:', e?.message)
    return { reset: 0 }
  })
  if (reset.reset > 0) {
    console.log('[worker-job] Daily reset:', reset.reset, 'accounts')
  }

  // 2. Drain verification queue (10 concurrent)
  const verifyResult = await processVerificationBatch().catch((e) => {
    console.error('[worker-job] Verify error:', e?.message)
    return { processed: 0, verified: 0, risky: 0, bad: 0 }
  })
  console.log(
    '[worker-job] Verification:',
    verifyResult.processed, 'processed →',
    verifyResult.verified, 'verified,',
    verifyResult.risky, 'risky,',
    verifyResult.bad, 'bad'
  )

  // 3. Send campaign emails
  const sendResult = await processSendBatch(50).catch((e) => {
    console.error('[worker-job] Send batch error:', e?.message)
    return { processed: 0, sent: 0, failed: 0, skipped: 0, errors: [] }
  })
  console.log('[worker-job] Campaign sends:', sendResult.sent, 'sent,', sendResult.failed, 'failed')

  // 4. Send warm-up emails
  const warmupSendResult = await processWarmupBatch(20).catch((e) => {
    console.error('[worker-job] Warmup send error:', e?.message)
    return { processed: 0, sent: 0, failed: 0, errors: [] }
  })
  console.log('[worker-job] Warmup sends:', warmupSendResult.sent, 'sent')

  // 5. Process warm-up inbound (spam rescue + auto-reply)
  const warmupInboundResult = await processWarmupInbound().catch((e) => {
    console.error('[worker-job] Warmup inbound error:', e?.message)
    return { checked: 0, rescued: 0, replied: 0, errors: [] }
  })
  console.log(
    '[worker-job] Warmup inbound:',
    warmupInboundResult.rescued, 'rescued,',
    warmupInboundResult.replied, 'replied'
  )

  // 6. Process lead replies (sequence breaker + LLM sentiment)
  const replyResult = await processInboundReplies().catch((e) => {
    console.error('[worker-job] Reply processing error:', e?.message)
    return { checked: 0, newReplies: 0, sequencesBroken: 0, suppressed: 0, errors: [] }
  })
  console.log(
    '[worker-job] Replies:',
    replyResult.newReplies, 'new,',
    replyResult.sequencesBroken, 'sequences broken'
  )

  // 7. Midnight tasks
  const hour = new Date().getUTCHours()
  if (hour === 0) {
    await scheduleWarmupMessages().catch((e) =>
      console.error('[worker-job] Warmup schedule error:', e?.message)
    )
    console.log('[worker-job] Midnight warmup scheduling completed')
  }

  console.log('[worker-job] Tick complete')
  process.exit(0)
}

main().catch((e) => {
  console.error('[worker-job] Fatal error:', e)
  process.exit(1)
})
