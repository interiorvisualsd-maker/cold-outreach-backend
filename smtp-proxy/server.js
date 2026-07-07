// ─────────────────────────────────────────────────────────────────────────────
// SMTP Verification Proxy — 100% free, runs on Fly.io
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS:
// Render (and AWS/GCP/Azure/Vercel/Cloudflare Workers) block outbound port 25,
// making direct SMTP mailbox verification impossible. Fly.io ALLOWS outbound
// port 25 and has a generous free tier (3 shared-cpu-1x VMs, 256MB RAM each).
//
// This proxy is a tiny HTTP server that:
//   1. Receives POST /verify { email, secret } over HTTPS (port 443)
//   2. Does the real SMTP RCPT TO mailbox check on port 25
//   3. Returns { status: 'valid'|'invalid'|'unknown', details: '...' }
//
// The main backend (on Render) calls this proxy via HTTPS. The proxy runs on
// Fly.io where port 25 is allowed. No cost, no terminal, no third-party API.
//
// DEPLOYMENT:
//   - Fly.io auto-deploys via GitHub Actions on every push to main
//   - See .github/workflows/deploy-proxy.yml and README.md for setup
//
// FREE TIER LIMITS:
//   - Fly.io: 3 shared-cpu-1x VMs free forever (this proxy uses 1)
//   - No bandwidth limits on the free tier
//   - Effective rate limit is SMTP server rate limits (~1-2 req/sec per MX host)
//   - For 1,000 leads: ~10-15 minutes. For 10,000 leads: ~2 hours.
// ─────────────────────────────────────────────────────────────────────────────

const http = require('node:http')
const net = require('node:net')
const dns = require('node:dns/promises')

const PORT = process.env.PORT || 8080
const SHARED_SECRET = process.env.PROXY_SECRET || ''

// ─── SMTP mailbox verification (port 25, direct connect) ──────────────────
// Same logic as the main backend's trySmtpRcpt — extracted here so the proxy
// is self-contained with zero npm dependencies.

function getMailFrom() {
  const v = process.env.VERIFICATION_DOMAIN
  if (v && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return `verify@${v.toLowerCase()}`
  return '' // empty MAIL FROM (RFC 5321 § 4.5.5 — bounce-compliant)
}

function getHeloDomain() {
  const v = process.env.VERIFICATION_DOMAIN
  if (v && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return v.toLowerCase()
  return 'verify.local'
}

async function getMxHosts(domain) {
  try {
    const records = await dns.resolveMx(domain)
    return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange)
  } catch {
    return []
  }
}

function trySmtpRcpt(mxHost, targetEmail, mailFrom, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let buffer = ''
    let step = 'connect'
    let smtpResponse = ''
    let lastCode
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ status: 'unknown', code: lastCode, response: smtpResponse, details: 'Timeout' })
    }, timeoutMs)

    socket.connect(25, mxHost)
    socket.setEncoding('utf-8')
    socket.setTimeout(timeoutMs)

    const send = (cmd) => socket.write(cmd + '\r\n')
    const finish = (r) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(r)
    }

    socket.on('data', (data) => {
      buffer += data.toString()
      const lastLineMatch = buffer.match(/\r?\n(\d{3})[ ].*\r?\n$/)
      if (!lastLineMatch) return
      const code = parseInt(lastLineMatch[1], 10)
      lastCode = code
      smtpResponse = buffer.split(/\r?\n/).filter(Boolean).slice(-1)[0] || ''
      buffer = ''

      if (step === 'connect') {
        if (code === 220) {
          step = 'helo'
          send(`EHLO ${getHeloDomain()}`)
        } else {
          finish({ status: 'unknown', code, response: smtpResponse, details: `Unexpected greeting: ${code}` })
        }
      } else if (step === 'helo') {
        if (code >= 200 && code < 300) {
          step = 'mail'
          send(`MAIL FROM:<${mailFrom}>`)
        } else {
          finish({ status: 'unknown', code, response: smtpResponse, details: `EHLO rejected: ${code}` })
        }
      } else if (step === 'mail') {
        if (code >= 200 && code < 300) {
          step = 'rcpt'
          send(`RCPT TO:<${targetEmail}>`)
        } else {
          finish({ status: 'unknown', code, response: smtpResponse, details: `MAIL FROM rejected: ${code}` })
        }
      } else if (step === 'rcpt') {
        if (code === 250 || code === 251) {
          finish({ status: 'valid', code, response: smtpResponse, details: 'RCPT TO accepted' })
        } else if (code === 550 || code === 551 || code === 553) {
          finish({ status: 'invalid', code, response: smtpResponse, details: 'Mailbox does not exist' })
        } else if (code === 252) {
          finish({ status: 'unknown', code, response: smtpResponse, details: 'Server cannot verify' })
        } else if (code >= 400 && code < 500) {
          finish({ status: 'unknown', code, response: smtpResponse, details: `Temporary failure: ${code}` })
        } else {
          finish({ status: 'unknown', code, response: smtpResponse, details: `Unexpected RCPT response: ${code}` })
        }
      }
    })

    socket.on('error', (err) => {
      clearTimeout(timer)
      finish({ status: 'unknown', details: `Connection error: ${err.message}` })
    })
    socket.on('timeout', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ status: 'unknown', code: lastCode, response: smtpResponse, details: 'Socket timeout' })
    })
    socket.on('close', () => {
      clearTimeout(timer)
      if (step !== 'done') {
        resolve({ status: 'unknown', details: 'Connection closed early' })
      }
    })
  })
}

async function verifyMailbox(email) {
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain) return { status: 'unknown', details: 'Invalid email format' }

  const mxHosts = await getMxHosts(domain)
  if (mxHosts.length === 0) {
    return { status: 'unknown', details: 'No MX records for domain' }
  }

  const mailFrom = getMailFrom()
  // Try top 2 MX hosts in priority order
  for (const mxHost of mxHosts.slice(0, 2)) {
    try {
      const result = await trySmtpRcpt(mxHost, email.toLowerCase(), mailFrom, 10000)
      if (result.status !== 'unknown') return result
    } catch {
      continue
    }
  }
  return { status: 'unknown', details: 'All MX hosts unreachable or timed out' }
}

// ─── Catch-all domain detection ───────────────────────────────────────────
// If a random bogus address at the same domain returns 'valid', the domain
// accepts everything → can't verify individual mailboxes → RISKY.
async function detectCatchAll(domain) {
  const mxHosts = await getMxHosts(domain)
  if (mxHosts.length === 0) return false
  const mailFrom = getMailFrom()
  const bogus = `zz-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}@${domain}`
  for (const mxHost of mxHosts.slice(0, 1)) {
    try {
      const result = await trySmtpRcpt(mxHost, bogus, mailFrom, 8000)
      if (result.status === 'valid') return true
    } catch {
      continue
    }
  }
  return false
}

// ─── HTTP server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS — allow any origin (the secret protects access)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Proxy-Secret')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  // Health check (no auth — used by Fly.io for uptime monitoring)
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, service: 'smtp-proxy', ts: Date.now() }))
  }

  // Verify endpoint
  if (req.method === 'POST' && req.url === '/verify') {
    // Auth check — shared secret prevents abuse
    if (SHARED_SECRET) {
      const providedSecret = req.headers['x-proxy-secret'] || ''
      if (providedSecret !== SHARED_SECRET) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Invalid or missing proxy secret' }))
      }
    }

    let body = ''
    for await (const chunk of req) body += chunk
    let data
    try {
      data = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    }

    const { email, checkCatchAll } = data
    if (!email || typeof email !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'email field required' }))
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ status: 'invalid', details: 'Invalid email format' }))
    }

    try {
      const smtp = await verifyMailbox(email)
      let catchAll = false
      // Only check catch-all if SMTP gave a usable signal (avoid extra SMTP
      // connections when we already know the mailbox is invalid)
      if (checkCatchAll && (smtp.status === 'valid' || smtp.status === 'invalid')) {
        const domain = email.split('@')[1]?.toLowerCase()
        if (domain) catchAll = await detectCatchAll(domain)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        status: catchAll ? 'catch-all' : smtp.status,
        code: smtp.code,
        response: smtp.response,
        details: smtp.details,
        catchAll,
        mxHosts: await getMxHosts(email.split('@')[1]?.toLowerCase() || ''),
      }))
    } catch (err) {
      console.error('[proxy] verify error:', err?.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ status: 'unknown', details: 'Internal proxy error' }))
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found. Use POST /verify or GET /health.' }))
})

server.listen(PORT, () => {
  console.log(`SMTP verification proxy running on port ${PORT}`)
  console.log(`  Auth: ${SHARED_SECRET ? 'enabled (X-Proxy-Secret header required)' : 'DISABLED — set PROXY_SECRET env var!'}`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[proxy] SIGTERM received, shutting down...')
  server.close(() => process.exit(0))
})
