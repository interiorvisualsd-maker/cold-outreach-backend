import { Hono } from 'hono'
import Papa from 'papaparse'
import { db } from '../lib/db'
import { getUserId } from '../lib/auth'
import { quickVerify } from '../lib/emailVerify'

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

  const campaign = await db.campaign.findUnique({ where: { id: campaignId } })
  if (!campaign || campaign.ownerId !== userId) {
    return c.json({ error: 'Campaign not found' }, 404)
  }

  // Build reverse mapping
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
  const skipped: any[] = []
  let duplicateCount = 0
  let suppressedCount = 0
  let invalidCount = 0
  const verificationBreakdown: Record<string, number> = {}

  for (const row of rows) {
    const email = (row[reverse.emails] || '').toString().toLowerCase().trim()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      invalidCount++
      skipped.push({ row, reason: 'invalid_email' })
      continue
    }
    // ─── Quick verification (format + disposable + role + MX + typo) ───
    // We do NOT auto-suppress on quick-verify failure here — instead we
    // skip the row and let the user re-import after fixing. (Suppression
    // is reserved for the deep verify route.)
    try {
      const verifyResult = await quickVerify(email)
      if (verifyResult.status === 'BAD') {
        invalidCount++
        const reason = verifyResult.reason || 'verification_failed'
        verificationBreakdown[reason] = (verificationBreakdown[reason] || 0) + 1
        skipped.push({ row, reason })
        continue
      }
    } catch {
      // DNS timeout etc — let the email through; deep verifier catches later
    }
    if (existingSet.has(email)) {
      duplicateCount++
      skipped.push({ row, reason: 'duplicate' })
      continue
    }
    if (suppressedSet.has(email)) {
      suppressedCount++
      skipped.push({ row, reason: 'suppressed' })
      continue
    }
    existingSet.add(email) // prevent intra-batch dupes
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
      verificationStatus: 'PENDING', // new imports start PENDING
    })
  }

  // ─── Transaction: insert + update campaign total ───
  // Any error rolls back the whole import — no partial inserts.
  let created = 0
  try {
    const result = await db.$transaction(async (tx) => {
      let count = 0
      if (toCreate.length > 0) {
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
    return c.json(
      { error: 'Import failed and was rolled back: ' + (e?.message || 'unknown error') },
      500
    )
  }

  return c.json({
    imported: created,
    duplicates: duplicateCount,
    suppressed: suppressedCount,
    invalid: invalidCount,
    verificationBreakdown,
    skipped: skipped.slice(0, 50),
  })
})

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
