# SMTP Verification Proxy — Self-Hosted on Fly.io

This is a tiny SMTP verification proxy that runs on **Fly.io**. It solves the problem of Render blocking outbound port 25 (which makes direct SMTP mailbox verification impossible from Render).

## ⚠️ Pricing Update (read first)

Fly.io **no longer offers a true free tier**. Their current model is "Pay As You Go":
- **$5 free credit** for new accounts (covers ~2-3 months of proxy usage)
- After that: **~$2/month** for a tiny VM (shared-cpu-1x, 256MB RAM)
- They require a credit card to verify you're human (won't be charged within the credit)

This is still very cheap (~$24/year) and gives you **unlimited** SMTP verifications.

**If you want truly free**: use the **Reoon API** option instead (set `EMAIL_VERIFY_PROVIDER=reoon` on Render). Reoon gives 100 verifications/day free forever (~3,000/month) with no credit card. See the main `.env.example` for details.

**This proxy remains useful if:**
- You verify more than 3,000 leads/month regularly
- You want zero dependency on third-party APIs
- You're comfortable with ~$2/month for unlimited verifications

## How it works

```
Your app (Render)  ──HTTPS──►  SMTP Proxy (Fly.io)  ──port 25──►  Recipient's mail server
                     port 443                          (allowed!)
```

The proxy is a ~200-line Node.js server with zero npm dependencies. It receives HTTPS requests from your main backend, does the real SMTP RCPT TO check on port 25, and returns the result.

## Cost: ~$2/month (after $5 free credit)

Fly.io's Pay-As-You-Go plan includes:
- **$5 free credit** for new accounts (covers ~2-3 months)
- **shared-cpu-1x VM** with 256MB RAM: ~$1.94/month
- **160GB outbound data/month** included (each verify request is ~1KB — negligible)
- **Credit card required** for verification (won't be charged within the credit)

The only effective limit is SMTP server rate limits (~1-2 requests/sec per MX host), not Fly.io.

**For truly free**: use Reoon API instead (`EMAIL_VERIFY_PROVIDER=reoon` on Render — 100/day free forever).

## Setup (browser-only, ~10 minutes, no terminal)

### Step 1 — Sign up for Fly.io

1. Go to **https://fly.io**
2. Click **Sign Up** (top right)
3. Create an account with your GitHub account or email
4. They'll ask for a credit card to verify you're human, but **they won't charge it** as long as you stay within the free tier

### Step 2 — Create the proxy app on Fly.io

1. Go to **https://fly.io/dashboard**
2. Click **"Launch"** or **"Create App"**
3. Fill in:
   - **App name**: `cold-outreach-smtp-proxy` (or any unique name — this becomes your URL)
   - **Region**: `iad` (US East — closest to most email servers)
   - **Framework**: skip (we deploy via GitHub Actions, not the dashboard)
4. Click **"Create App"**
5. **Do NOT deploy from the dashboard** — we'll deploy via GitHub Actions

### Step 3 — Set the proxy's secrets on Fly.io

1. Go to **https://fly.io/app/cold-outreach-smtp-proxy/secrets** (replace with your app name)
2. Add these secrets:

| Key | Value | Notes |
|---|---|---|
| `PROXY_SECRET` | A long random string | Generate at https://www.allkeysgenerator.com (256-bit, Hex). This protects your proxy from abuse. |
| `VERIFICATION_DOMAIN` | (optional) `verify.yourdomain.com` | Used for SMTP HELO/MAIL FROM. Leave empty to use RFC-compliant empty MAIL FROM (`<>`). |

### Step 4 — Get your Fly.io API token

1. Go to **https://fly.io/user/personal_access_tokens**
2. Click **"Create Access Token"**
3. Name it `github-actions-deploy`
4. Copy the token (starts with `FlyV1-` or similar)

### Step 5 — Add the token to GitHub

1. Go to your backend repo on GitHub: `https://github.com/interiorvisualsd-maker/cold-outreach-backend`
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **"New repository secret"**
4. Name: `FLY_API_TOKEN`
5. Value: paste the token from step 4
6. Click **"Add secret"**

### Step 6 — Update fly.toml with your app name

1. Open `smtp-proxy/fly.toml` in GitHub (click the file → edit)
2. Change line 4: `app = "cold-outreach-smtp-proxy"` — replace with your actual app name from step 2
3. Commit the change to main

### Step 7 — Deploy via GitHub Actions

1. Go to your repo's **Actions** tab on GitHub
2. You should see a workflow called **"Deploy SMTP Proxy to Fly.io"**
3. Click it → **"Run workflow"** → **"Run workflow"** (green button)
4. Wait ~2-3 minutes for the deploy to complete
5. The workflow output will show your proxy URL: `https://cold-outreach-smtp-proxy.fly.dev`

### Step 8 — Test the proxy

Open this URL in your browser:
```
https://cold-outreach-smtp-proxy.fly.dev/health
```
(Replace `cold-outreach-smtp-proxy` with your actual app name)

You should see:
```json
{"ok":true,"service":"smtp-proxy","ts":1234567890}
```

If you see that, your proxy is live. ✅

### Step 9 — Connect your main backend to the proxy

1. Go to **https://dashboard.render.com** → your `cold-outreach-api` service → **Environment**
2. Add these env vars:

| Key | Value |
|---|---|
| `SMTP_PROXY_URL` | `https://cold-outreach-smtp-proxy.fly.dev` (your proxy URL from step 7) |
| `SMTP_PROXY_SECRET` | The `PROXY_SECRET` value you set on Fly.io in step 3 |

3. Click **Save Changes**
4. **Manual Deploy** → **Deploy latest commit**
5. Wait ~3 min for `🚀 Lead Dispatcher backend running`

### Step 10 — Re-verify your leads

1. Go to the **Verification** page in your app
2. Click **Start Verification** → **Deep verify**
3. This time, the SMTP check goes through the Fly.io proxy → real mailbox verification happens → leads get marked VERIFIED/RISKY/BAD based on actual SMTP responses

## How to verify it's working

After running verification on a few leads, click into a lead's detail on the Verification page. You should see:
- **SMTP: ✓** (green check) — the proxy successfully checked the mailbox
- **SMTP: ✗** (red X) — the mailbox definitively doesn't exist (SMTP 550)
- **SMTP: —** (dash) — the proxy couldn't verify (timeout, greylisting)

If ALL leads show "—" for SMTP, check:
1. Is the proxy live? (`https://your-proxy.fly.dev/health` → `{"ok":true}`)
2. Did you set `SMTP_PROXY_URL` and `SMTP_PROXY_SECRET` on Render?
3. Check Render logs for `[verify] proxy error:` messages

## Limits

| Resource | Pay-As-You-Go | This proxy uses |
|---|---|---|
| VMs | unlimited (billed per use) | 1 |
| RAM | 256MB (shared-cpu-1x) | ~50MB |
| Outbound data | 160GB/month included | ~1KB per verify (negligible) |
| SMTP rate limit | ~1-2 req/sec per MX host | — |
| Monthly cost | ~$2/month (after $5 free credit) | — |

**Effective capacity**: ~3,000-7,000 verifications per hour. For 10,000 leads, expect ~2-3 hours total.

## For open-source users (when you publish the repo)

Anyone who forks your repo can deploy their own proxy by following these same 10 steps. The GitHub Action is already wired up — they just need to:
1. Create their own Fly.io account
2. Create their own Fly.io app
3. Add their own `FLY_API_TOKEN` to their fork's GitHub secrets
4. Update `fly.toml` with their app name

The proxy is fully self-contained in the `smtp-proxy/` folder — no shared code with the main backend.

## Troubleshooting

### "App not found" when deploying via GitHub Actions
- Make sure the app name in `smtp-proxy/fly.toml` matches the app you created on Fly.io
- Make sure `FLY_API_TOKEN` is set in GitHub repo secrets (not environment variables — must be a secret)

### Proxy returns 401 "Invalid or missing proxy secret"
- The `SMTP_PROXY_SECRET` env var on Render must exactly match the `PROXY_SECRET` secret on Fly.io
- Both are case-sensitive

### All leads still show "—" for SMTP
- Visit `https://your-proxy.fly.dev/health` — if it doesn't return `{"ok":true}`, the proxy isn't running
- Check Fly.io logs: go to your app on Fly.io → "Monitoring" → "Logs"
- Common issue: Fly.io auto-stopped the VM. The `fly.toml` has `min_machines_running = 1` to prevent this, but if you changed it, the VM may sleep

### Fly.io bill unexpectedly
- The free tier covers 3 shared-cpu-1x VMs. If you have other apps on Fly.io, you may exceed the free tier.
- Check usage at https://fly.io/dashboard — the proxy alone should cost $0
- To be safe, set up billing alerts in Fly.io settings

## Files in this folder

| File | Purpose |
|---|---|
| `server.js` | The proxy HTTP server (Node.js, zero deps) |
| `fly.toml` | Fly.io deployment config |
| `Dockerfile` | Container build instructions |
| `README.md` | This file |
