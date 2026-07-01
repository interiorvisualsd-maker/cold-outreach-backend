import { Hono } from 'hono'
import Papa from 'papaparse'
import { db } from '../lib/db'

const app = new Hono()

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

// Fuzzy matching: normalize header → check against known variants
const COLUMN_ALIASES: Record<string, string> = {
  // company_name
  company_name: 'company_name',
  company: 'company_name',
  companyname: 'company_name',
  'company name': 'company_name',
  organization: 'company_name',
  org: 'company_name',
  business: 'company_name',
  business_name: 'company_name',
  // emails
  emails: 'emails',
  email: 'emails',
  emailaddress: 'emails',
  'email address': 'emails',
  'email address 1': 'emails',
  recipient: 'emails',
  to: 'emails',
  contact_email: 'emails',
  // website
  website: 'website',
  url: 'website',
  domain: 'website',
  web: 'website',
  site: 'website',
  // state
  state: 'state',
  region: 'state',
  province: 'state',
  location: 'state',
  // industry
  industry: 'industry',
  sector: 'industry',
  category: 'industry',
  vertical: 'industry',
  // outreach_subject
  outreach_subject: 'outreach_subject',
  outreachsubject: 'outreach_subject',
  subject: 'outreach_subject',
  subject_line: 'outreach_subject',
  email_subject: 'outreach_subject',
  // initial_outreach
  initial_outreach: 'initial_outreach',
  initialoutreach: 'initial_outreach',
  body: 'initial_outreach',
  email_body: 'initial_outreach',
  message: 'initial_outreach',
  step1: 'initial_outreach',
  step_1: 'initial_outreach',
  // followup_day3
  followup_day3: 'followup_day3',
  followupday3: 'followup_day3',
  followup_3: 'followup_day3',
  day3: 'followup_day3',
  step2: 'followup_day3',
  step_2: 'followup_day3',
  // followup_day7
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
  // Returns mapping: csvHeader → canonicalColumn
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
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file uploaded' }, 400)

  // Accept any filename — validate by content, not name
  const text = await file.text()
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

  // Identify missing required columns
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

// POST /api/csv/import — import leads using confirmed column mapping
app.post('/import', async (c) => {
  const body = await c.req.json()
  const { campaignId, filename, rows, mapping } = body
  if (!campaignId || !rows || !mapping) {
    return c.json({ error: 'campaignId, rows, mapping required' }, 400)
  }

  const campaign = await db.campaign.findUnique({ where: { id: campaignId } })
  if (!campaign) return c.json({ error: 'Campaign not found' }, 404)

  // Build reverse mapping: canonicalColumn → csvHeader
  const reverse: Record<string, string> = {}
  for (const [csvHeader, canonical] of Object.entries(mapping)) {
    reverse[canonical] = csvHeader
  }

  // Fetch existing suppression list emails for this import batch
  const allEmails = rows.map((r: any) => (r[reverse.emails] || '').toString().toLowerCase().trim()).filter(Boolean)
  const suppressed = await db.suppressionList.findMany({
    where: { email: { in: allEmails } },
    select: { email: true },
  })
  const suppressedSet = new Set(suppressed.map((s) => s.email))

  // Check existing leads in this campaign for dedup
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

  for (const row of rows) {
    const email = (row[reverse.emails] || '').toString().toLowerCase().trim()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      invalidCount++
      skipped.push({ row, reason: 'invalid_email' })
      continue
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
      email,
      companyName: reverse.company_name ? row[reverse.company_name]?.toString() || null : null,
      website: reverse.website ? row[reverse.website]?.toString() || null : null,
      state: reverse.state ? row[reverse.state]?.toString() || null : null,
      industry: reverse.industry ? row[reverse.industry]?.toString() || null : null,
      outreachSubject: reverse.outreach_subject ? row[reverse.outreach_subject]?.toString() || null : null,
      initialOutreach: reverse.initial_outreach ? row[reverse.initial_outreach]?.toString() || null : null,
      followupDay3: reverse.followup_day3 ? row[reverse.followup_day3]?.toString() || null : null,
      followupDay7: reverse.followup_day7 ? row[reverse.followup_day7]?.toString() || null : null,
    })
  }

  let created = 0
  if (toCreate.length > 0) {
    const result = await db.lead.createMany({ data: toCreate, skipDuplicates: true })
    created = result.count
  }

  // Update campaign total
  await db.campaign.update({
    where: { id: campaignId },
    data: {
      totalLeads: { increment: created },
      csvFilename: filename || campaign.csvFilename,
    },
  })

  return c.json({
    imported: created,
    duplicates: duplicateCount,
    suppressed: suppressedCount,
    invalid: invalidCount,
    skipped: skipped.slice(0, 50), // return first 50 skipped for review
  })
})

// GET /api/csv/template — download a sample CSV template
app.get('/template', (c) => {
  const csv = 'company_name,emails,website,state,industry,outreach_subject,initial_outreach,followup_day3,followup_day7\n' +
    'Acme Corp,john@acme.com,acme.com,CA,SaaS,"Quick question","Hi John, saw your site...","Just bumping this up","Last try — worth a chat?"\n'
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="lead_template.csv"',
    },
  })
})

export default app
