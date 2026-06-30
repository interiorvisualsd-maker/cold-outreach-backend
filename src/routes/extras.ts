import { Hono } from 'hono'
import { db } from '../lib/db'

const app = new Hono()

// ─────────────────────────────────────────────────────────────────────────────
// DEMO DATA SEEDING — populates the database with realistic sample data
// so the UI can be demoed without real SMTP accounts.
// ─────────────────────────────────────────────────────────────────────────────

app.post('/seed', async (c) => {
  // Clear existing demo data (preserve users)
  await db.emailLog.deleteMany()
  await db.reply.deleteMany()
  await db.warmupMessage.deleteMany()
  await db.scheduledEmail.deleteMany()
  await db.emailStep.deleteMany()
  await db.lead.deleteMany()
  await db.campaign.deleteMany()
  await db.suppressionList.deleteMany()
  await db.smtpAccount.deleteMany()

  // ─── 1. Create 4 sending accounts ───
  const accounts = []
  const providers = [
    { provider: 'gmail', host: 'smtp.gmail.com', imapHost: 'imap.gmail.com', label: 'Gmail - alice@acme.com', email: 'alice@acme.com' },
    { provider: 'gmail', host: 'smtp.gmail.com', imapHost: 'imap.gmail.com', label: 'Gmail - bob@acme.com', email: 'bob@acme.com' },
    { provider: 'outlook', host: 'smtp.office365.com', imapHost: 'outlook.office365.com', label: 'Outlook - carol@acme.com', email: 'carol@acme.com' },
    { provider: 'outlook', host: 'smtp.office365.com', imapHost: 'outlook.office365.com', label: 'Outlook - dave@acme.com', email: 'dave@acme.com' },
  ]
  for (const p of providers) {
    const acc = await db.smtpAccount.create({
      data: {
        label: p.label,
        emailAddress: p.email,
        fromName: 'Alice from Acme',
        smtpHost: p.host,
        smtpPort: 465,
        smtpUser: p.email,
        smtpPassEnc: 'demo:encrypted',
        smtpSecure: true,
        imapHost: p.imapHost,
        imapPort: 993,
        imapUser: p.email,
        imapPassEnc: 'demo:encrypted',
        imapSecure: true,
        dailyCap: 80,
        hourlyCap: 12,
        warmupEnabled: true,
        warmupState: p.provider === 'gmail' ? 'warm' : 'heating',
        warmupDay: p.provider === 'gmail' ? 10 : 4,
        warmupStartQty: 2,
        warmupIncrement: 2,
        warmupTargetMax: 20,
        sentToday: Math.floor(Math.random() * 60) + 10,
        warmupSentToday: Math.floor(Math.random() * 18) + 2,
        status: 'active',
        provider: p.provider,
      },
    })
    accounts.push(acc)
  }

  // ─── 2. Create 2 campaigns ───
  const campaign1 = await db.campaign.create({
    data: {
      name: 'Q4 SaaS Founders Outreach',
      status: 'active',
      csvFilename: 'saas_founders_q4.csv',
      totalLeads: 0,
      sendingWindowStart: 9,
      sendingWindowEnd: 17,
      timezone: 'America/New_York',
      fromNameOverride: 'Alice from Acme',
    },
  })
  const campaign2 = await db.campaign.create({
    data: {
      name: 'Agency Owners Follow-up',
      status: 'active',
      csvFilename: 'agency_list.csv',
      totalLeads: 0,
      sendingWindowStart: 10,
      sendingWindowEnd: 16,
      timezone: 'America/Chicago',
    },
  })

  // Create steps for campaign 1
  for (let step = 1; step <= 3; step++) {
    await db.emailStep.create({
      data: {
        campaignId: campaign1.id,
        stepNumber: step,
        delayDays: step === 1 ? 0 : step === 2 ? 3 : 7,
        subject: step === 1 ? 'Quick question about {{company_name}}' : step === 2 ? 'Re: Quick question' : 'Last try — worth a chat?',
        body: step === 1 ? 'Hi {{first_name}}, saw your site at {{website}}...' : step === 2 ? 'Just bumping this up...' : 'Last try, promise...',
      },
    })
    await db.emailStep.create({
      data: {
        campaignId: campaign2.id,
        stepNumber: step,
        delayDays: step === 1 ? 0 : step === 2 ? 3 : 7,
        subject: step === 1 ? 'Helping agencies scale' : step === 2 ? 'Re: Helping agencies scale' : 'Worth 15 min?',
        body: step === 1 ? 'Hi there, I help agencies like yours...' : step === 2 ? 'Following up on my last note...' : 'Final follow up...',
      },
    })
  }

  // ─── 3. Create leads ───
  const companies = [
    { name: 'Stripe', domain: 'stripe.com', industry: 'Fintech', state: 'CA' },
    { name: 'Notion', domain: 'notion.so', industry: 'SaaS', state: 'CA' },
    { name: 'Linear', domain: 'linear.app', industry: 'SaaS', state: 'CA' },
    { name: 'Vercel', domain: 'vercel.com', industry: 'DevTools', state: 'CA' },
    { name: 'Supabase', domain: 'supabase.com', industry: 'DevTools', state: 'CA' },
    { name: 'Figma', domain: 'figma.com', industry: 'Design', state: 'CA' },
    { name: 'Slack', domain: 'slack.com', industry: 'SaaS', state: 'CA' },
    { name: 'Airtable', domain: 'airtable.com', industry: 'SaaS', state: 'CA' },
    { name: 'Webflow', domain: 'webflow.com', industry: 'SaaS', state: 'CA' },
    { name: 'Loom', domain: 'loom.com', industry: 'SaaS', state: 'CA' },
    { name: 'Calendly', domain: 'calendly.com', industry: 'SaaS', state: 'GA' },
    { name: 'Mailchimp', domain: 'mailchimp.com', industry: 'Marketing', state: 'GA' },
  ]
  const firstNames = ['John', 'Sarah', 'Mike', 'Emma', 'David', 'Lisa', 'Alex', 'Jennifer', 'Ryan', 'Maria']
  const statuses = ['step1_sent', 'step2_sent', 'step3_sent', 'replied', 'pending', 'bounced', 'unsubscribed']
  const statusWeights = [25, 20, 15, 15, 15, 5, 5]

  let leadCount = 0
  const usedEmails = new Set<string>()
  for (const company of companies) {
    for (const campaign of [campaign1, campaign2]) {
      // 2 leads per company per campaign
      for (let i = 0; i < 2; i++) {
        const firstName = firstNames[(leadCount + i) % firstNames.length]
        let email = `${firstName.toLowerCase()}@${company.domain}`
        // Ensure uniqueness across campaigns
        let suffix = 1
        while (usedEmails.has(email)) {
          email = `${firstName.toLowerCase()}${suffix}@${company.domain}`
          suffix++
        }
        usedEmails.add(email)
        // Pick weighted status
        let r = Math.random() * 100
        let status = 'pending'
        for (let s = 0; s < statuses.length; s++) {
          r -= statusWeights[s]
          if (r <= 0) { status = statuses[s]; break }
        }
        const lead = await db.lead.create({
          data: {
            campaignId: campaign.id,
            email,
            companyName: company.name,
            website: company.domain,
            state: company.state,
            industry: company.industry,
            outreachSubject: `Quick question about ${company.name}`,
            initialOutreach: `Hi ${firstName}, I noticed ${company.name} is doing great work in ${company.industry}...`,
            followupDay3: `Hi ${firstName}, just bumping this up — would love to chat.`,
            followupDay7: `Hi ${firstName}, last try — worth 15 min next week?`,
            status,
            currentStep: status === 'pending' ? 0 : status === 'step1_sent' ? 1 : status === 'step2_sent' ? 2 : status === 'step3_sent' ? 3 : 0,
            lastStepSentAt: status !== 'pending' ? new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000) : null,
            repliedAt: status === 'replied' ? new Date(Date.now() - Math.random() * 3 * 24 * 60 * 60 * 1000) : null,
            bouncedAt: status === 'bounced' ? new Date(Date.now() - Math.random() * 2 * 24 * 60 * 60 * 1000) : null,
            unsubscribedAt: status === 'unsubscribed' ? new Date(Date.now() - Math.random() * 5 * 24 * 60 * 60 * 1000) : null,
          },
        })
        leadCount++

        // Create some scheduled emails
        if (status === 'step1_sent' || status === 'step2_sent' || status === 'step3_sent' || status === 'replied') {
          for (let step = 1; step <= (status === 'step1_sent' ? 1 : status === 'step2_sent' ? 2 : 3); step++) {
            await db.scheduledEmail.create({
              data: {
                campaignId: campaign.id,
                leadId: lead.id,
                stepNumber: step,
                smtpAccountId: accounts[Math.floor(Math.random() * accounts.length)].id,
                subject: step === 1 ? `Quick question about ${company.name}` : `Re: Quick question`,
                body: step === 1 ? `Hi ${firstName}...` : `Following up...`,
                status: 'sent',
                scheduledAt: new Date(Date.now() - (4 - step) * 24 * 60 * 60 * 1000),
                sentAt: new Date(Date.now() - (4 - step) * 24 * 60 * 60 * 1000),
              },
            })
          }
          // Queue the next step
          if (status !== 'replied' && status !== 'bounced' && status !== 'unsubscribed') {
            const nextStep = status === 'step1_sent' ? 2 : status === 'step2_sent' ? 3 : null
            if (nextStep) {
              await db.scheduledEmail.create({
                data: {
                  campaignId: campaign.id,
                  leadId: lead.id,
                  stepNumber: nextStep,
                  subject: `Re: Quick question`,
                  body: `Following up...`,
                  status: 'queued',
                  scheduledAt: new Date(Date.now() + Math.random() * 3 * 24 * 60 * 60 * 1000),
                },
              })
            }
          }
        }

        // Create replies for 'replied' leads
        if (status === 'replied') {
          const sentiments = ['interested', 'not_interested', 'neutral', 'interested', 'interested']
          await db.reply.create({
            data: {
              leadId: lead.id,
              fromEmail: email,
              toEmail: 'alice@acme.com',
              subject: `Re: Quick question about ${company.name}`,
              body: `Hi Alice, thanks for reaching out. I'd be interested to learn more. Do you have time next Tuesday?`,
              messageId: `demo-${lead.id}@${company.domain}`,
              receivedAt: new Date(Date.now() - Math.random() * 3 * 24 * 60 * 60 * 1000),
              isRead: Math.random() > 0.4,
              sentiment: sentiments[Math.floor(Math.random() * sentiments.length)],
              processed: true,
            },
          })
        }
      }
    }
  }

  await db.campaign.update({ where: { id: campaign1.id }, data: { totalLeads: 24 } })
  await db.campaign.update({ where: { id: campaign2.id }, data: { totalLeads: 24 } })

  // ─── 4. Create warmup messages ───
  for (let i = 0; i < 40; i++) {
    const fromAcc = accounts[Math.floor(Math.random() * accounts.length)]
    let toAcc = accounts[Math.floor(Math.random() * accounts.length)]
    while (toAcc.id === fromAcc.id) toAcc = accounts[Math.floor(Math.random() * accounts.length)]
    const statuses = ['sent', 'received', 'rescued', 'replied', 'completed']
    const st = statuses[Math.floor(Math.random() * statuses.length)]
    await db.warmupMessage.create({
      data: {
        fromAccountId: fromAcc.id,
        toAccountId: toAcc.id,
        subject: ['Quick question', 'Following up', 'Lunch next week?', 'Re: our chat'][Math.floor(Math.random() * 4)],
        body: ['Hey, checking in!', 'Got a minute this week?', 'Thanks for the heads up'][Math.floor(Math.random() * 3)],
        status: st,
        scheduledAt: new Date(Date.now() - Math.random() * 24 * 60 * 60 * 1000),
        sentAt: new Date(Date.now() - Math.random() * 24 * 60 * 60 * 1000),
        receivedAt: st !== 'sent' ? new Date(Date.now() - Math.random() * 20 * 60 * 60 * 1000) : null,
        rescuedAt: st === 'rescued' || st === 'replied' ? new Date(Date.now() - Math.random() * 18 * 60 * 60 * 1000) : null,
        repliedAt: st === 'replied' || st === 'completed' ? new Date(Date.now() - Math.random() * 12 * 60 * 60 * 1000) : null,
      },
    })
  }

  // ─── 5. Create suppression list entries ───
  await db.suppressionList.createMany({
    data: [
      { email: 'bounced1@example.com', reason: 'bounce', source: 'Q4 SaaS Founders Outreach' },
      { email: 'bounced2@example.com', reason: 'bounce', source: 'Q4 SaaS Founders Outreach' },
      { email: 'unsub1@example.com', reason: 'unsubscribe', source: 'Agency Owners Follow-up' },
      { email: 'unsub2@example.com', reason: 'complaint', source: 'Q4 SaaS Founders Outreach' },
    ],
  })

  return c.json({
    ok: true,
    seeded: {
      accounts: accounts.length,
      campaigns: 2,
      leads: leadCount,
      warmupMessages: 40,
      suppressionEntries: 4,
    },
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD ANALYTICS — 7-day trend + deliverability score + activity feed
// ─────────────────────────────────────────────────────────────────────────────
app.get('/analytics', async (c) => {
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  // 7-day send trend
  const sentEmails = await db.scheduledEmail.findMany({
    where: { status: 'sent', sentAt: { gte: sevenDaysAgo } },
    select: { sentAt: true },
  })
  const trend: { date: string; sent: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const day = new Date(now)
    day.setHours(0, 0, 0, 0)
    day.setDate(day.getDate() - i)
    const nextDay = new Date(day)
    nextDay.setDate(nextDay.getDate() + 1)
    const count = sentEmails.filter((e) => e.sentAt && e.sentAt >= day && e.sentAt < nextDay).length
    trend.push({ date: day.toISOString().slice(0, 10), sent: count })
  }

  // Reply stats by sentiment
  const replies = await db.reply.findMany({
    select: { sentiment: true, receivedAt: true },
  })
  const sentimentBreakdown = {
    interested: replies.filter((r) => r.sentiment === 'interested').length,
    not_interested: replies.filter((r) => r.sentiment === 'not_interested').length,
    neutral: replies.filter((r) => r.sentiment === 'neutral').length,
    ooo: replies.filter((r) => r.sentiment === 'ooo').length,
    unsubscribe: replies.filter((r) => r.sentiment === 'unsubscribe').length,
    untagged: replies.filter((r) => !r.sentiment).length,
  }

  // Deliverability score (0-100)
  const totalSent = await db.scheduledEmail.count({ where: { status: 'sent' } })
  const totalBounced = await db.lead.count({ where: { status: 'bounced' } })
  const totalUnsub = await db.suppressionList.count({ where: { reason: 'unsubscribe' } })
  const totalReplies = replies.length
  const replyRate = totalSent > 0 ? (totalReplies / totalSent) * 100 : 0
  const bounceRate = totalSent > 0 ? (totalBounced / totalSent) * 100 : 0
  const unsubRate = totalSent > 0 ? (totalUnsub / totalSent) * 100 : 0
  // Simple score: 100 - bounce*5 - unsub*3, min 0, max 100
  const deliverabilityScore = Math.max(0, Math.min(100, Math.round(100 - bounceRate * 5 - unsubRate * 3)))

  // Recent activity feed (last 15 events)
  const recentSent = await db.scheduledEmail.findMany({
    where: { status: 'sent' },
    include: { lead: { select: { email: true, companyName: true } }, campaign: { select: { name: true } } },
    orderBy: { sentAt: 'desc' },
    take: 8,
  })
  const recentReplies = await db.reply.findMany({
    include: { lead: { select: { email: true, companyName: true } } },
    orderBy: { receivedAt: 'desc' },
    take: 7,
  })
  const activity: { type: string; email: string; company: string | null; campaign: string | null; sentiment?: string | null; timestamp: Date; label: string }[] = []
  for (const s of recentSent) {
    activity.push({
      type: 'sent',
      email: s.lead.email,
      company: s.lead.companyName,
      campaign: s.campaign.name,
      timestamp: s.sentAt || s.scheduledAt,
      label: `Step ${s.stepNumber} sent`,
    })
  }
  for (const r of recentReplies) {
    activity.push({
      type: 'reply',
      email: r.fromEmail,
      company: r.lead?.companyName || null,
      campaign: null,
      sentiment: r.sentiment,
      timestamp: r.receivedAt,
      label: r.sentiment || 'Reply received',
    })
  }
  activity.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())

  return c.json({
    trend,
    sentimentBreakdown,
    deliverabilityScore,
    rates: {
      replyRate: Math.round(replyRate * 10) / 10,
      bounceRate: Math.round(bounceRate * 10) / 10,
      unsubRate: Math.round(unsubRate * 10) / 10,
    },
    totals: { totalSent, totalReplies, totalBounced, totalUnsub },
    activity: activity.slice(0, 15),
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SUPPRESSION LIST — manage unsubscribed / bounced / complained emails
// ─────────────────────────────────────────────────────────────────────────────
app.get('/suppression', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)
  const reason = c.req.query('reason')

  const where: any = {}
  if (reason) where.reason = reason

  const [items, total] = await Promise.all([
    db.suppressionList.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.suppressionList.count({ where }),
  ])

  const byReason = await db.suppressionList.groupBy({
    by: ['reason'],
    _count: true,
  })

  return c.json({ items, total, page, limit, pages: Math.ceil(total / limit), byReason })
})

app.delete('/suppression/:id', async (c) => {
  await db.suppressionList.delete({ where: { id: c.req.param('id') } }).catch(() => null)
  return c.json({ ok: true })
})

app.post('/suppression', async (c) => {
  const body = await c.req.json()
  const { email, reason, source } = body
  if (!email || !reason) return c.json({ error: 'email and reason required' }, 400)
  const entry = await db.suppressionList.upsert({
    where: { email_reason: { email: email.toLowerCase(), reason } },
    create: { email: email.toLowerCase(), reason, source },
    update: {},
  })
  return c.json({ entry })
})

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS — global key/value config
// ─────────────────────────────────────────────────────────────────────────────
app.get('/settings', async (c) => {
  const settings = await db.setting.findMany()
  const map: Record<string, string> = {}
  for (const s of settings) map[s.key] = s.value
  return c.json({ settings: map })
})

app.put('/settings', async (c) => {
  const body = await c.req.json()
  const updates = []
  for (const [key, value] of Object.entries(body)) {
    updates.push(
      db.setting.upsert({
        where: { key },
        create: { key, value: String(value) },
        update: { value: String(value) },
      })
    )
  }
  await Promise.all(updates)
  return c.json({ ok: true })
})

// Test DeepSeek API key validity
app.post('/settings/test-llm', async (c) => {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    return c.json({ ok: false, error: 'DEEPSEEK_API_KEY not set in backend environment' })
  }
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Reply with OK' }],
        max_tokens: 5,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      return c.json({ ok: false, error: `DeepSeek API ${res.status}: ${text.slice(0, 200)}` })
    }
    return c.json({ ok: true, message: 'DeepSeek API key is valid' })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL TEMPLATES — reusable templates with merge fields (stored in Setting table)
// ─────────────────────────────────────────────────────────────────────────────

interface Template {
  id: string
  name: string
  subject: string
  body: string
  category: string
  mergeFields: string[]
  createdAt: string
  updatedAt: string
}

async function getTemplates(): Promise<Template[]> {
  const setting = await db.setting.findUnique({ where: { key: 'templates' } })
  if (!setting) return []
  try { return JSON.parse(setting.value) } catch { return [] }
}

async function saveTemplates(templates: Template[]) {
  await db.setting.upsert({
    where: { key: 'templates' },
    create: { key: 'templates', value: JSON.stringify(templates) },
    update: { value: JSON.stringify(templates) },
  })
}

function extractMergeFields(text: string): string[] {
  const matches = text.match(/\{\{(\w+)\}\}/g) || []
  return [...new Set(matches.map((m) => m.replace(/\{\{|}\}/g, '')))]
}

const AVAILABLE_MERGE_FIELDS = [
  { field: 'first_name', desc: 'Lead first name (from email prefix)' },
  { field: 'last_name', desc: 'Lead last name (from email prefix)' },
  { field: 'company_name', desc: 'Company name' },
  { field: 'website', desc: 'Company website/domain' },
  { field: 'state', desc: 'State/region' },
  { field: 'industry', desc: 'Industry' },
  { field: 'sender_name', desc: 'Your from name' },
  { field: 'sender_email', desc: 'Your sending email' },
]

app.get('/templates', async (c) => {
  const templates = await getTemplates()
  return c.json({ templates, availableMergeFields: AVAILABLE_MERGE_FIELDS })
})

app.post('/templates', async (c) => {
  const body = await c.req.json()
  const { name, subject, body: tplBody, category } = body
  if (!name || !subject || !tplBody) return c.json({ error: 'name, subject, body required' }, 400)
  const templates = await getTemplates()
  const now = new Date().toISOString()
  const template: Template = {
    id: `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name, subject, body: tplBody,
    category: category || 'custom',
    mergeFields: [...new Set([...extractMergeFields(subject), ...extractMergeFields(tplBody)])],
    createdAt: now, updatedAt: now,
  }
  templates.push(template)
  await saveTemplates(templates)
  return c.json({ template })
})

app.put('/templates/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const { name, subject, body: tplBody, category } = body
  const templates = await getTemplates()
  const idx = templates.findIndex((t) => t.id === id)
  if (idx === -1) return c.json({ error: 'Not found' }, 404)
  const updated: Template = {
    ...templates[idx],
    name: name ?? templates[idx].name,
    subject: subject ?? templates[idx].subject,
    body: tplBody ?? templates[idx].body,
    category: category ?? templates[idx].category,
    mergeFields: [...new Set([...extractMergeFields(subject ?? templates[idx].subject), ...extractMergeFields(tplBody ?? templates[idx].body)])],
    updatedAt: new Date().toISOString(),
  }
  templates[idx] = updated
  await saveTemplates(templates)
  return c.json({ template: updated })
})

app.delete('/templates/:id', async (c) => {
  const id = c.req.param('id')
  const templates = await getTemplates()
  const filtered = templates.filter((t) => t.id !== id)
  if (filtered.length === templates.length) return c.json({ error: 'Not found' }, 404)
  await saveTemplates(filtered)
  return c.json({ ok: true })
})

app.post('/templates/:id/preview', async (c) => {
  const id = c.req.param('id')
  const templates = await getTemplates()
  const template = templates.find((t) => t.id === id)
  if (!template) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const sampleData: Record<string, string> = {
    first_name: 'John', last_name: 'Doe', company_name: 'Acme Corp',
    website: 'acme.com', state: 'California', industry: 'SaaS',
    sender_name: 'Alice from Acme', sender_email: 'alice@acme.com', ...body,
  }
  const render = (text: string) => text.replace(/\{\{(\w+)\}\}/g, (_, field) => sampleData[field] || `{{${field}}}`)
  return c.json({ subject: render(template.subject), body: render(template.body) })
})

// ─────────────────────────────────────────────────────────────────────────────
// TEAM MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

app.get('/team', async (c) => {
  const users = await db.user.findMany({
    select: { id: true, email: true, name: true, role: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  return c.json({ users })
})

app.put('/team/:id/role', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const { role } = body
  if (!['admin', 'member'].includes(role)) return c.json({ error: 'role must be admin or member' }, 400)
  const user = await db.user.update({
    where: { id }, data: { role },
    select: { id: true, email: true, name: true, role: true },
  })
  return c.json({ user })
})

app.delete('/team/:id', async (c) => {
  const id = c.req.param('id')
  const count = await db.user.count()
  if (count <= 1) return c.json({ error: 'Cannot delete the last user' }, 400)
  await db.user.delete({ where: { id } }).catch(() => null)
  return c.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS — in-app alert center (stored in Setting table)
// ─────────────────────────────────────────────────────────────────────────────

interface Notification {
  id: string
  type: string
  severity: string
  title: string
  message: string
  read: boolean
  createdAt: string
}

async function getNotifications(): Promise<Notification[]> {
  const setting = await db.setting.findUnique({ where: { key: 'notifications' } })
  if (!setting) return []
  try { return JSON.parse(setting.value) } catch { return [] }
}

async function saveNotifications(notifs: Notification[]) {
  await db.setting.upsert({
    where: { key: 'notifications' },
    create: { key: 'notifications', value: JSON.stringify(notifs.slice(0, 100)) },
    update: { value: JSON.stringify(notifs.slice(0, 100)) },
  })
}

app.get('/notifications', async (c) => {
  const notifs = await getNotifications()
  const unread = notifs.filter((n) => !n.read).length
  return c.json({ notifications: notifs, unreadCount: unread })
})

app.post('/notifications/:id/read', async (c) => {
  const id = c.req.param('id')
  const notifs = await getNotifications()
  const idx = notifs.findIndex((n) => n.id === id)
  if (idx === -1) return c.json({ error: 'Not found' }, 404)
  notifs[idx].read = true
  await saveNotifications(notifs)
  return c.json({ ok: true })
})

app.post('/notifications/read-all', async (c) => {
  const notifs = await getNotifications()
  notifs.forEach((n) => { n.read = true })
  await saveNotifications(notifs)
  return c.json({ ok: true })
})

app.delete('/notifications/:id', async (c) => {
  const id = c.req.param('id')
  const notifs = await getNotifications()
  await saveNotifications(notifs.filter((n) => n.id !== id))
  return c.json({ ok: true })
})

app.post('/notifications/seed-demo', async (c) => {
  const existing = await getNotifications()
  if (existing.length > 0) return c.json({ ok: true, message: 'Already exist' })
  const demo: Notification[] = [
    { id: 'notif_1', type: 'reply', severity: 'success', title: 'New interested reply', message: 'John from Stripe replied: "Interested to learn more"', read: false, createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
    { id: 'notif_2', type: 'bounce', severity: 'warning', title: 'Email bounced', message: 'alex@figma.com — mailbox full. Lead auto-suppressed.', read: false, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    { id: 'notif_3', type: 'warmup', severity: 'info', title: 'Warmup milestone', message: 'alice@acme.com reached 20 warmup emails/day — fully warmed.', read: false, createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() },
    { id: 'notif_4', type: 'unsubscribe', severity: 'warning', title: 'Unsubscribe request', message: 'sarah@notion.so unsubscribed. Added to suppression list.', read: true, createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
    { id: 'notif_5', type: 'failure', severity: 'error', title: 'SMTP account auto-paused', message: 'dave@acme.com paused after 3 consecutive send failures.', read: true, createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() },
  ]
  await saveNotifications(demo)
  return c.json({ ok: true, seeded: demo.length })
})

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL LEAD SEARCH — search by email or company name (for command palette)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/search/leads', async (c) => {
  const q = c.req.query('q') || ''
  if (q.length < 2) return c.json({ results: [] })
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 20)

  // Search by email OR company name OR website
  const results = await db.lead.findMany({
    where: {
      OR: [
        { email: { contains: q } },
        { companyName: { contains: q } },
        { website: { contains: q } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      email: true,
      companyName: true,
      website: true,
      state: true,
      industry: true,
      status: true,
      currentStep: true,
      repliedAt: true,
      bouncedAt: true,
      campaignId: true,
      campaign: { select: { name: true } },
    },
  })

  return c.json({ results })
})

// ─────────────────────────────────────────────────────────────────────────────
// LEAD DETAIL — full timeline of emails sent + replies for a single lead
// ─────────────────────────────────────────────────────────────────────────────

app.get('/leads/:id/detail', async (c) => {
  const id = c.req.param('id')
  const lead = await db.lead.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      companyName: true,
      website: true,
      state: true,
      industry: true,
      status: true,
      currentStep: true,
      lastStepSentAt: true,
      repliedAt: true,
      bouncedAt: true,
      unsubscribedAt: true,
      createdAt: true,
      updatedAt: true,
      outreachSubject: true,
      initialOutreach: true,
      followupDay3: true,
      followupDay7: true,
      campaign: { select: { id: true, name: true, status: true } },
    },
  })
  if (!lead) return c.json({ error: 'Lead not found' }, 404)

  const [emails, replies] = await Promise.all([
    db.scheduledEmail.findMany({
      where: { leadId: id },
      select: {
        id: true,
        stepNumber: true,
        subject: true,
        body: true,
        status: true,
        scheduledAt: true,
        sentAt: true,
        attempts: true,
        lastError: true,
        smtpAccountId: true,
        openCount: true,
        openedAt: true,
        clickCount: true,
        clickedAt: true,
      },
      orderBy: { stepNumber: 'asc' },
    }),
    db.reply.findMany({
      where: { leadId: id },
      select: {
        id: true,
        fromEmail: true,
        toEmail: true,
        subject: true,
        body: true,
        messageId: true,
        receivedAt: true,
        isRead: true,
        sentiment: true,
      },
      orderBy: { receivedAt: 'asc' },
    }),
  ])

  // Build unified timeline
  interface TimelineEvent {
    id: string
    type: 'email_sent' | 'email_queued' | 'email_failed' | 'reply' | 'open' | 'click'
    timestamp: string
    title: string
    description: string
    metadata?: Record<string, any>
  }
  const timeline: TimelineEvent[] = []

  for (const email of emails) {
    if (email.status === 'sent' && email.sentAt) {
      timeline.push({
        id: `email-${email.id}`,
        type: 'email_sent',
        timestamp: email.sentAt.toISOString(),
        title: `Step ${email.stepNumber} sent`,
        description: email.subject,
        metadata: {
          step: email.stepNumber,
          subject: email.subject,
          body: email.body,
          openCount: email.openCount,
          clickCount: email.clickCount,
        },
      })
      // Add open/click events
      if (email.openedAt && email.openCount > 0) {
        timeline.push({
          id: `open-${email.id}`,
          type: 'open',
          timestamp: email.openedAt.toISOString(),
          title: `Step ${email.stepNumber} opened`,
          description: `Email opened ${email.openCount}x`,
        })
      }
      if (email.clickedAt && email.clickCount > 0) {
        timeline.push({
          id: `click-${email.id}`,
          type: 'click',
          timestamp: email.clickedAt.toISOString(),
          title: `Step ${email.stepNumber} link clicked`,
          description: `Link clicked ${email.clickCount}x`,
        })
      }
    } else if (email.status === 'queued') {
      timeline.push({
        id: `email-${email.id}`,
        type: 'email_queued',
        timestamp: email.scheduledAt.toISOString(),
        title: `Step ${email.stepNumber} queued`,
        description: `Scheduled for ${new Date(email.scheduledAt).toLocaleString()}`,
      })
    } else if (email.status === 'failed') {
      timeline.push({
        id: `email-${email.id}`,
        type: 'email_failed',
        timestamp: (email.sentAt || email.scheduledAt).toISOString(),
        title: `Step ${email.stepNumber} failed`,
        description: email.lastError || 'Unknown error',
      })
    }
  }

  for (const reply of replies) {
    timeline.push({
      id: `reply-${reply.id}`,
      type: 'reply',
      timestamp: reply.receivedAt.toISOString(),
      title: `Reply received${reply.sentiment ? ` · ${reply.sentiment}` : ''}`,
      description: reply.subject,
      metadata: {
        from: reply.fromEmail,
        subject: reply.subject,
        body: reply.body,
        sentiment: reply.sentiment,
      },
    })
  }

  // Sort by timestamp descending (most recent first)
  timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  // Summary stats
  const stats = {
    totalEmails: emails.length,
    sentEmails: emails.filter((e) => e.status === 'sent').length,
    queuedEmails: emails.filter((e) => e.status === 'queued').length,
    failedEmails: emails.filter((e) => e.status === 'failed').length,
    totalOpens: emails.reduce((sum, e) => sum + e.openCount, 0),
    totalClicks: emails.reduce((sum, e) => sum + e.clickCount, 0),
    totalReplies: replies.length,
  }

  return c.json({ lead, timeline, stats })
})

// ─────────────────────────────────────────────────────────────────────────────
// UNSUBSCRIBE — public endpoint for /u/:leadId link in email footers
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/extras/unsubscribe/:leadId — check if lead exists (for landing page)
app.get('/unsubscribe/:leadId', async (c) => {
  const leadId = c.req.param('leadId')
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { id: true, email: true, companyName: true, status: true, unsubscribedAt: true },
  })
  if (!lead) return c.json({ error: 'Invalid unsubscribe link' }, 404)
  return c.json({
    lead: {
      id: lead.id,
      email: lead.email.replace(/(.{2}).*(@.*)/, '$1***$2'), // mask for privacy
      companyName: lead.companyName,
      alreadyUnsubscribed: lead.status === 'unsubscribed',
    },
  })
})

// POST /api/extras/unsubscribe/:leadId — actually unsubscribe
app.post('/unsubscribe/:leadId', async (c) => {
  const leadId = c.req.param('leadId')
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { id: true, email: true, campaignId: true, campaign: { select: { name: true } } },
  })
  if (!lead) return c.json({ error: 'Invalid unsubscribe link' }, 404)

  if (lead.email) {
    await db.suppressionList.upsert({
      where: { email_reason: { email: lead.email.toLowerCase(), reason: 'unsubscribe' } },
      create: { email: lead.email.toLowerCase(), reason: 'unsubscribe', source: lead.campaign?.name || 'unsubscribe-link' },
      update: {},
    })
  }
  await db.lead.update({
    where: { id: leadId },
    data: { status: 'unsubscribed', unsubscribedAt: new Date() },
  })
  // Cancel all queued emails for this lead
  await db.scheduledEmail.updateMany({
    where: { leadId, status: 'queued' },
    data: { status: 'cancelled' },
  })

  return c.json({ ok: true, message: 'You have been unsubscribed successfully' })
})

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOKS — Slack/Discord/generic integration management
// ─────────────────────────────────────────────────────────────────────────────

interface WebhookConfig {
  id: string
  url: string
  type: 'slack' | 'discord' | 'generic'
  enabled: boolean
  events: string[]
  label?: string
}

async function getWebhooks(): Promise<WebhookConfig[]> {
  const setting = await db.setting.findUnique({ where: { key: 'webhooks' } })
  if (!setting) return []
  try { return JSON.parse(setting.value) } catch { return [] }
}

async function saveWebhooks(hooks: WebhookConfig[]) {
  await db.setting.upsert({
    where: { key: 'webhooks' },
    create: { key: 'webhooks', value: JSON.stringify(hooks) },
    update: { value: JSON.stringify(hooks) },
  })
  // Invalidate the in-memory cache
  const { invalidateWebhookCache } = await import('../lib/notifications')
  invalidateWebhookCache()
}

app.get('/webhooks', async (c) => {
  const webhooks = await getWebhooks()
  const eventTypes = [
    { type: 'reply', label: 'New replies' },
    { type: 'bounce', label: 'Email bounces' },
    { type: 'unsubscribe', label: 'Unsubscribes' },
    { type: 'failure', label: 'SMTP failures' },
    { type: 'warmup', label: 'Warm-up milestones' },
    { type: 'system', label: 'System alerts' },
  ]
  return c.json({ webhooks, eventTypes })
})

app.post('/webhooks', async (c) => {
  const body = await c.req.json()
  const { url, type, events, label } = body
  if (!url || !type) return c.json({ error: 'url and type required' }, 400)
  if (!['slack', 'discord', 'generic'].includes(type)) return c.json({ error: 'Invalid type' }, 400)

  const webhooks = await getWebhooks()
  const newHook: WebhookConfig = {
    id: `hook_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    url,
    type,
    enabled: true,
    events: events || [],
    label: label || `${type} webhook`,
  }
  webhooks.push(newHook)
  await saveWebhooks(webhooks)
  return c.json({ webhook: newHook })
})

app.put('/webhooks/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const { url, type, events, enabled, label } = body
  const webhooks = await getWebhooks()
  const idx = webhooks.findIndex((w) => w.id === id)
  if (idx === -1) return c.json({ error: 'Not found' }, 404)
  webhooks[idx] = {
    ...webhooks[idx],
    url: url ?? webhooks[idx].url,
    type: type ?? webhooks[idx].type,
    events: events ?? webhooks[idx].events,
    enabled: enabled ?? webhooks[idx].enabled,
    label: label ?? webhooks[idx].label,
  }
  await saveWebhooks(webhooks)
  return c.json({ webhook: webhooks[idx] })
})

app.delete('/webhooks/:id', async (c) => {
  const id = c.req.param('id')
  const webhooks = await getWebhooks()
  const filtered = webhooks.filter((w) => w.id !== id)
  if (filtered.length === webhooks.length) return c.json({ error: 'Not found' }, 404)
  await saveWebhooks(filtered)
  return c.json({ ok: true })
})

// Test webhook — sends a test notification to the specified URL
app.post('/webhooks/test', async (c) => {
  const body = await c.req.json()
  const { url, type } = body
  if (!url || !type) return c.json({ error: 'url and type required' }, 400)

  try {
    let payload: Record<string, any>
    if (type === 'slack') {
      payload = {
        attachments: [{
          color: '#6366f1',
          title: '✅ Lead Dispatcher webhook test',
          text: 'If you see this message, your webhook is configured correctly!',
          footer: 'Lead Dispatcher',
          ts: Math.floor(Date.now() / 1000),
        }],
      }
    } else if (type === 'discord') {
      payload = {
        embeds: [{
          title: '✅ Lead Dispatcher webhook test',
          description: 'If you see this message, your webhook is configured correctly!',
          color: 0x6366f1,
          footer: { text: 'Lead Dispatcher' },
          timestamp: new Date().toISOString(),
        }],
      }
    } else {
      payload = { event: 'test', title: 'Webhook test', message: 'Configuration successful', timestamp: new Date().toISOString() }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return c.json({ ok: false, error: `Webhook returned ${res.status}: ${text.slice(0, 200)}` })
    }
    return c.json({ ok: true, message: 'Test notification sent successfully' })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'Failed to send test' })
  }
})

export default app
