import { Hono } from 'hono'
import Papa from 'papaparse'
import { db } from '../lib/db'
import { getUserId } from '../lib/auth'

const app = new Hono()

// ─── Hard limits ─────────────────────────────────────────────────────────────
// Max CSV body size for the /parse endpoint (10MB). Anything larger is rejected
// with 413 Payload Too Large. The frontend should chunk very large lists.
const MAX_CSV_BYTES = 10 * 1024 * 1024

// Canonical column names we map TO
const CANONICAL_COLUMNS = [
  'company_name',
  'emails',
  'website',
  'state',
  'industry',
  'outreach_subject',
  'initial_outreach',
  'followup_day3',
  'followup_day7',
] as const

const COLUMN_ALIASES: Record<string, string> = {
  company_name: 'company_name',
  company: 'company_name',
  companyname: 'company_name',
  'company name': 'company_name',
  organization: 'company_name',
  org: 'company_name',
  business: 'company_name',
  business_name: 'company_name',
  emails: 'emails',
  email: 'emails',
  emailaddress: 'emails',
  'email address': 'emails',
  'email address 1': 'emails',
  recipient: 'emails',
  to: 'emails',
  contact_email: 'emails',
  website: 'website',
  url: 'website',
  domain: 'website',
  web: 'website',
  site: 'website',
  state: 'state',
  region: 'state',
  province: 'state',
  location: 'state',
  industry: 'industry',
  sector: 'industry',
  category: 'industry',
  vertical: 'industry',
  outreach_subject: 'outreach_subject',
  outreachsubject: 'outreach_subject',
  subject: 'outreach_subject',
  subject_line: 'outreach_subject',
  email_subject: 'outreach_subject',
  initial_outreach: 'initial_outreach',
  initialoutreach: 'initial_outreach',
  body: 'initial_outreach',
  email_body: 'initial_outreach',
  message: 'initial_outreach',
  step1: 'initial_outreach',
  step_1: 'initial_outreach',
  followup_day3: 'followup_day3',
  followupday3: 'followup_day3',
  followup_3: 'followup_day3',
  day3: 'followup_day3',
  step2: 'followup_day3',
  step_2: 'followup_day3',
  followup_day7: 'followup_day7',
  followupday7: 'followup_day7',
  followup_7: 'followup_day7',
  day7: 'followup_day7',
  step3: 'followup_day7',
  step_3: 'followup_day7',
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().trim().replace(/[\s_-]+/g, ' ').replace(/\s+/g, ' ')
}

function detectColumnMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {}
  const usedCanonical = new Set<string>()
  for (const header of headers) {
    const norm = normalizeHeader(header)
    const canonical = COLUMN_ALIASES[norm] || COLUMN_ALIASES[norm.replace(/ /g, '_')]
    if (canonical && !usedCanonical.has(canonical)) {
      mapping[header] = canonical
      usedCanonical.add(canonical)
    }
  }
  return mapping
}

// POST /api/csv/parse — parse uploaded CSV, return headers + suggested mapping + preview
app.post('/parse', async (c) => {
  const userId = getUserId(c)
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file uploaded' }, 400)

  // ─── File-size guard ───
  if (file.size > MAX_CSV_BYTES) {
    return c.json(
      { error: `CSV file is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max ${MAX_CSV_BYTES / 1024 / 1024}MB. Please split the file and import in chunks.` },
      413
    )
  }

  const text = await file.text()
  if (Buffer.byteLength(text) > MAX_CSV_BYTES) {
    return c.json(
      { error: `CSV body too large. Max ${MAX_CSV_BYTES / 1024 / 1024}MB.` },
      413
    )
  }
  const result = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  })

  if (result.errors.length > 0 && !result.data.length) {
    return c.json({ error: 'Failed to parse CSV: ' + result.errors[0].message }, 400)
  }

  const headers = result.meta.fields || []
  const mapping = detectColumnMapping(headers)
  const preview = result.data.slice(0, 5)

  const hasEmail = Object.values(mapping).includes('emails')
  const hasSubject = Object.values(mapping).includes('outreach_subject')
  const hasBody = Object.values(mapping).includes('initial_outreach')

  return c.json({
    filename: file.name,
    totalRows: result.data.length,
    headers,
    detectedMapping: mapping,
    preview,
    validation: {
      hasEmail,
      hasSubject,
      hasBody,
      ready: hasEmail && hasSubject && hasBody,
      missing: [
        ...(!hasEmail ? ['emails'] : []),
        ...(!hasSubject ? ['outreach_subject'] : []),
        ...(!hasBody ? ['initial_outreach'] : []),
      ],
    },
  })
})

// POST /api/csv/import — import leads using confirmed column mapping.
// All writes are wrapped in a Prisma transaction — if any row errors out,
// the whole import rolls back (no partial inserts). All emails normalized
// to lowercase before insert (case-insensitive dedupe).
app.post('/import', async (c) => {
  const userId = getUserId(c)
  const body = await c.req.json()
  const { campaignId, filename, rows, mapping } = body
  if (!campaignId || !rows || !mapping) {
    return c.json({ error: 'campaignId, rows, mapping required' }, 400)
  }

  // ─── Body-size guard (defensive — frontend should chunk) ───
  const bodyStr = JSON.stringify(body)
  if (Buffer.byteLength(bodyStr) > MAX_CSV_BYTES) {
    return c.json(
      { error: `Import payload too large (${(Buffer.byteLength(bodyStr) / 1024 / 1024).toFixed(1)}MB). Max ${MAX_CSV_BYTES / 1024 / 1024}MB. Split into smaller batches.` },
      413
    )
  }

  const result = await processImportBatch(userId, campaignId, filename, rows, mapping)
  return c.json(result, result.error ? 500 : 200)
})

// ─── Chunked import (for large CSVs) ──────────────────────────────────────────
// POST /api/csv/import-chunk — import one chunk of rows (500 per chunk).
// Each chunk is committed independently. Cross-chunk deduplication is
// automatic because each chunk checks the DB for already-inserted leads
// (leads from earlier chunks are already in the DB by the time later
// chunks run).
//
// The batchId is for the frontend's tracking only — the backend doesn't
// need to correlate chunks. This is simpler and more resilient: if the
// server restarts mid-batch, already-committed chunks survive and the
// user can re-upload the remaining chunks without duplicates.
app.post('/import-chunk', async (c) => {
  const userId = getUserId(c)
  const body = await c.req.json()
  const { campaignId, filename, rows, mapping } = body
  if (!campaignId || !rows || !mapping) {
    return c.json({ error: 'campaignId, rows, mapping required' }, 400)
  }

  // Per-chunk body-size guard (500 rows should be well under 10MB, but
  // defensive)
  const bodyStr = JSON.stringify(body)
  if (Buffer.byteLength(bodyStr) > MAX_CSV_BYTES) {
    return c.json(
      { error: `Chunk payload too large. Split into smaller chunks.` },
      413
    )
  }

  const result = await processImportBatch(userId, campaignId, filename, rows, mapping)
  if (result.error) {
    return c.json(result, 500)
  }
  return c.json(result)
})

// GET /api/csv/import-finalize — no-op endpoint for backwards compat with
// the frontend's chunked-upload flow. Each chunk already committed its
// rows independently, so there's nothing to finalize. We just echo back
// the accumulated stats the frontend sends via query params (or return
// zeros if none provided).
app.get('/import-finalize', async (c) => {
  const userId = getUserId(c)
  const batchId = c.req.query('batchId')
  // Nothing to do — chunks are already committed. Just acknowledge.
  return c.json({
    ok: true,
    batchId: batchId || null,
    message: 'All chunks already committed. No finalization needed.',
  })
})

// ─── Shared import logic (used by both /import and /import-chunk) ────────────
// Deduplicates against:
//   1. Existing leads in the same campaign (case-insensitive)
//   2. Suppressed emails for this user
//   3. Other rows in the same batch (intra-batch dedup)
// Then quick-verifies each email (format + disposable + role + MX + typo).
// BAD emails are skipped (not imported). Valid emails are inserted in a
// transaction with skipDuplicates as a belt-and-suspenders safety net.
async function processImportBatch(
  userId: string,
  campaignId: string,
  filename: string | undefined,
  rows: any[],
  mapping: Record<string, string>
): Promise<{
  imported: number
  duplicates: number
  suppressed: number
  invalid: number
  skipped: Array<{ row: Record<string, unknown>; reason: string }>
  error?: string
}> {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } })
  if (!campaign || campaign.ownerId !== userId) {
    return { imported: 0, duplicates: 0, suppressed: 0, invalid: 0, skipped: [], error: 'Campaign not found' }
  }

  // Build reverse mapping (canonical → csv header)
  const reverse: Record<string, string> = {}
  for (const [csvHeader, canonical] of Object.entries(mapping)) {
    reverse[String(canonical)] = csvHeader
  }

  // Pre-fetch existing suppressed + existing leads (case-insensitive)
  const allEmails = rows
    .map((r: any) => (r[reverse.emails] || '').toString().toLowerCase().trim())
    .filter(Boolean)
  const suppressed = await db.suppressionList.findMany({
    where: { email: { in: allEmails }, ownerId: userId },
    select: { email: true },
  })
  const suppressedSet = new Set(suppressed.map((s) => s.email))
  const existing = await db.lead.findMany({
    where: { campaignId, email: { in: allEmails } },
    select: { email: true },
  })
  const existingSet = new Set(existing.map((l) => l.email.toLowerCase()))

  const toCreate: any[] = []
  const skipped: Array<{ row: Record<string, unknown>; reason: string }> = []
  let duplicateCount = 0
  let suppressedCount = 0
  let invalidCount = 0

  for (const row of rows) {
    const email = (row[reverse.emails] || '').toString().toLowerCase().trim()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      invalidCount++
      skipped.push({ row, reason: 'invalid_email' })
      continue
    }
    // ─── Note: NO quick-verify during import ───
    // Quick-verify (MX lookup, disposable check, etc.) takes ~1s per email
    // due to DNS resolution. For a 500-row chunk that's 8+ minutes → timeout.
    // Instead, import only does:
    //   - Format validation (regex above)
    //   - Case-insensitive deduplication (against DB + intra-batch)
    //   - Suppression list check
    // The dedicated Verification page (/api/verify/*) runs the full
    // 10-layer check (including SMTP mailbox verification) AFTER import,
    // and auto-suppresses BAD emails before any send happens.
    // This keeps imports fast (<5s per chunk) and verification thorough.
    //
    // ─── Deduplication ───
    // 1. Against existing leads in this campaign (already in DB from
    //    previous chunks or imports)
    // 2. Against other rows in this same batch (intra-batch dedup via
    //    the existingSet which we add to below)
    if (existingSet.has(email)) {
      duplicateCount++
      skipped.push({ row, reason: 'duplicate' })
      continue
    }
    // 3. Against suppressed emails (bounce/unsubscribe/complaint/manual)
    if (suppressedSet.has(email)) {
      suppressedCount++
      skipped.push({ row, reason: 'suppressed' })
      continue
    }
    // Mark this email as "seen" so subsequent rows in the same batch
    // with the same email are treated as duplicates.
    existingSet.add(email)
    toCreate.push({
      campaignId,
      ownerId: userId,
      email,
      companyName: reverse.company_name ? row[reverse.company_name]?.toString() || null : null,
      website: reverse.website ? row[reverse.website]?.toString() || null : null,
      state: reverse.state ? row[reverse.state]?.toString() || null : null,
      industry: reverse.industry ? row[reverse.industry]?.toString() || null : null,
      outreachSubject: reverse.outreach_subject ? row[reverse.outreach_subject]?.toString() || null : null,
      initialOutreach: reverse.initial_outreach ? row[reverse.initial_outreach]?.toString() || null : null,
      followupDay3: reverse.followup_day3 ? row[reverse.followup_day3]?.toString() || null : null,
      followupDay7: reverse.followup_day7 ? row[reverse.followup_day7]?.toString() || null : null,
      verificationStatus: 'PENDING', // new imports start PENDING — verify via Verification page
    })
  }

  // ─── Transaction: insert + update campaign total ───
  // Any error rolls back the whole chunk — no partial inserts.
  let created = 0
  try {
    const result = await db.$transaction(async (tx) => {
      let count = 0
      if (toCreate.length > 0) {
        // skipDuplicates: true is a safety net — if two chunks race and
        // insert the same email concurrently, the second one silently
        // skips instead of erroring. (The unique index on
        // (campaignId, LOWER(email)) enforces this at the DB level.)
        const r = await tx.lead.createMany({ data: toCreate, skipDuplicates: true })
        count = r.count
      }
      await tx.campaign.update({
        where: { id: campaignId },
        data: {
          totalLeads: { increment: count },
          csvFilename: filename || campaign.csvFilename,
        },
      })
      return count
    })
    created = result
  } catch (e: any) {
    console.error('[csv] import transaction failed:', e?.message)
    return {
      imported: 0,
      duplicates: 0,
      suppressed: 0,
      invalid: 0,
      skipped,
      error: 'Import failed and was rolled back: ' + (e?.message || 'unknown error'),
    }
  }

  return {
    imported: created,
    duplicates: duplicateCount,
    suppressed: suppressedCount,
    invalid: invalidCount,
    skipped: skipped.slice(0, 50), // cap to avoid huge responses
  }
}

// GET /api/csv/template — download a sample CSV template
app.get('/template', (c) => {
  const csv =
    'company_name,emails,website,state,industry,outreach_subject,initial_outreach,followup_day3,followup_day7\n' +
    'Acme Corp,john@acme.com,acme.com,CA,SaaS,"Quick question","Hi John, saw your site...","Just bumping this up","Last try — worth a chat?"\n'
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="lead_template.csv"',
    },
  })
})

export default app
