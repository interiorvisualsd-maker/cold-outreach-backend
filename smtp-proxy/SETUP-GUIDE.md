# Fly.io SMTP Proxy — Complete Setup Guide (No Terminal Needed)

This guide walks you through setting up the Fly.io SMTP proxy step by step. The proxy serves as a fallback when all free email verification APIs are exhausted. It runs on Fly.io (which allows outbound port 25) and lets your Render-hosted backend do real SMTP mailbox verification.

**Cost**: ~$2/month (under Fly.io's $5 waiver threshold → $0 for low usage)
**Time**: 15-20 minutes
**Requirements**: A credit/debit card (for Fly.io verification — you won't be charged within the waiver)

---

## Why You Need This

Render blocks outbound port 25, which means your backend can't connect directly to recipient mail servers to verify if an email inbox exists. The free verification APIs (MyEmailVerifier, EmailAwesome, Reoon, MailboxValidator) handle this for you — but they have monthly limits (~4,900/month combined).

The Fly.io proxy is your **unlimited fallback**. When all free APIs are exhausted, your backend calls the Fly.io proxy over HTTPS, and the proxy does the SMTP check on port 25 from Fly.io's infrastructure (where port 25 is allowed).

---

## Step 1 — Sign Up for Fly.io (3 minutes)

1. Open **https://fly.io** in your browser
2. Click **"Sign Up"** (top right corner)
3. Sign up with your GitHub account OR email
4. You'll be asked to enter a credit/debit card for verification
   - **Don't worry** — Fly.io waives invoices under $5/month, so you won't be charged for this proxy
   - The card is just to verify you're a real person (anti-abuse measure)
5. Complete the signup

---

## Step 2 — Create the Proxy App on Fly.io (3 minutes)

1. Go to **https://fly.io/dashboard**
2. Click **"Launch"** or **"Create App"**
3. Fill in:
   - **App name**: `cold-outreach-smtp-proxy` (or any unique name — this becomes your URL)
   - **Region**: `iad` (US East — closest to most email servers)
   - **Framework**: Skip this — we'll deploy from GitHub
4. Click **"Create App"**
5. **Do NOT click "Deploy"** — we'll deploy via GitHub Actions automatically

---

## Step 3 — Set the Proxy's Secrets on Fly.io (2 minutes)

The proxy needs a secret password to prevent random people from using it.

1. Generate a random secret:
   - Go to **https://www.allkeysgenerator.com**
   - Select **256-bit**, **Hex** format
   - Click **Generate**
   - Copy the long string
2. Go to **https://fly.io/app/cold-outreach-smtp-proxy/secrets** (replace `cold-outreach-smtp-proxy` with your actual app name from Step 2)
3. Click **"Add Secret"**
4. **Key**: `PROXY_SECRET`
5. **Value**: paste the random string you generated
6. Click **"Save"**
7. (Optional) Add a second secret:
   - **Key**: `VERIFICATION_DOMAIN`
   - **Value**: a domain you control (e.g., `verify.yourdomain.com`) — leave empty if you don't have one
   - This is used for the SMTP HELO greeting. If empty, the proxy uses a default.

---

## Step 4 — Get Your Fly.io API Token (2 minutes)

1. Go to **https://fly.io/user/personal_access_tokens**
2. Click **"Create Access Token"**
3. **Name**: `github-actions-deploy`
4. Click **"Create"**
5. **Copy the token** immediately (it starts with something like `FlyV1-...`)
   - ⚠️ You won't be able to see it again after you close this page

---

## Step 5 — Add the Token to Your GitHub Repo (2 minutes)

1. Go to your backend repo on GitHub:
   **https://github.com/interiorvisualsd-maker/cold-outreach-backend**
2. Click **"Settings"** (top tab)
3. In the left sidebar, click **"Secrets and variables"** → **"Actions"**
4. Click **"New repository secret"**
5. **Name**: `FLY_API_TOKEN`
6. **Secret**: paste the token from Step 4
7. Click **"Add secret"**

---

## Step 6 — Update fly.toml With Your App Name (1 minute)

1. In your backend repo on GitHub, navigate to:
   **`smtp-proxy/fly.toml`**
2. Click the **pencil icon** (Edit) in the top right
3. On line 3, change:
   ```toml
   app = "cold-outreach-smtp-proxy"
   ```
   to your actual app name from Step 2 (if different)
4. Scroll down and click **"Commit changes"**
5. Commit directly to `main`

---

## Step 7 — Add the GitHub Action Workflow (3 minutes)

Your Git token doesn't have permission to push workflow files, so you need to create this file through GitHub's web UI:

1. In your backend repo, click **"Add file"** → **"Create new file"**
2. In the filename field, type exactly:
   ```
   .github/workflows/deploy-proxy.yml
   ```
   (The `.github/` and `workflows/` folders will be created automatically)
3. Paste this exact content into the file editor:

```yaml
name: Deploy SMTP Proxy to Fly.io

on:
  push:
    branches: [main]
    paths:
      - 'smtp-proxy/**'
      - '.github/workflows/deploy-proxy.yml'
  workflow_dispatch:

jobs:
  deploy:
    name: Deploy proxy
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: smtp-proxy

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Fly CLI
        uses: superfly/flyctl-actions/setup-flyctl@master

      - name: Deploy to Fly.io
        run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}

      - name: Show app status
        run: flyctl status
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

4. Scroll to the bottom and click **"Commit new file"**
5. Commit directly to `main`

---

## Step 8 — Deploy the Proxy (3 minutes)

The GitHub Action will automatically trigger when you commit the workflow file. But let's trigger it manually to be sure:

1. In your backend repo, click the **"Actions"** tab (top)
2. In the left sidebar, click **"Deploy SMTP Proxy to Fly.io"**
3. Click **"Run workflow"** (right side) → **"Run workflow"** (green button)
4. Wait 2-3 minutes
5. Click on the workflow run to see its progress
6. When it says **"✅ Deploy proxy"** with a green checkmark, your proxy is live

---

## Step 9 — Verify the Proxy Is Running (1 minute)

1. Open this URL in your browser (replace `cold-outreach-smtp-proxy` with your actual app name):
   ```
   https://cold-outreach-smtp-proxy.fly.dev/health
   ```
2. You should see:
   ```json
   {"ok":true,"service":"smtp-proxy","ts":1234567890}
   ```
3. If you see that, your proxy is live and working ✅
4. If you see an error or "Not Found", wait 2 more minutes (the VM might still be starting) and try again

---

## Step 10 — Connect Your Render Backend to the Proxy (2 minutes)

Now tell your backend on Render to use the Fly.io proxy as a fallback:

1. Go to **https://dashboard.render.com**
2. Click your **`cold-outreach-api`** service
3. In the left sidebar, click **"Environment"**
4. Add these two environment variables:

| Key | Value |
|---|---|
| `SMTP_PROXY_URL` | `https://cold-outreach-smtp-proxy.fly.dev` (replace with your actual app name from Step 2) |
| `SMTP_PROXY_SECRET` | The `PROXY_SECRET` value you set on Fly.io in Step 3 |

5. Click **"Save Changes"**
6. Click **"Manual Deploy"** → **"Deploy latest commit"**
7. Wait ~3 minutes for the deploy to complete
8. Watch the logs for `🚀 Lead Dispatcher backend running`

---

## Step 11 — Configure the Proxy in Your App (1 minute)

1. Open your app: **https://cold-outreach-frontend-tau.vercel.app/**
2. Hard-refresh (Ctrl+Shift+R or Cmd+Shift+R)
3. Go to **Settings** → **Verification** tab
4. Scroll down to the **"Fly.io Proxy (Fallback)"** card
5. Click **"Add Key"**
6. Fill in:
   - **Proxy URL**: `https://cold-outreach-smtp-proxy.fly.dev` (your proxy URL)
   - **Proxy Secret**: the `PROXY_SECRET` you set on Fly.io
7. Click **"Save"**
8. The Fly.io card should now show a green **"Configured"** badge

---

## Step 12 — Test the Proxy (30 seconds)

1. Still in Settings → Verification → Fly.io Proxy card
2. The Test button is hidden for Fly.io (because it's a fallback, not a regular provider)
3. To test it manually, open a new browser tab and visit:
   ```
   https://cold-outreach-smtp-proxy.fly.dev/health
   ```
   You should see `{"ok":true,...}` ✅

4. To verify the proxy actually does SMTP verification, you can test it with curl (if you have a terminal) OR just trust that if the health check passes, the proxy is working

---

## Step 13 — Run Verification (the moment of truth)

1. Go to the **Verification** page in your app
2. Click **"Start Verification"** → **"Deep verify"**
3. The router will:
   - Try MyEmailVerifier first (100/day free)
   - Then EmailAwesome (1,000/month free)
   - Then Reoon (600/month free)
   - Then MailboxValidator (300/month free)
   - **Finally Fly.io proxy** (unlimited fallback) when all the above are exhausted
4. Watch the Render logs — you should now see entries like:
   ```
   [verify-test] user=abc123 provider=myemailverifier
   [verify-test] myemailverifier result: { ok: true, status: 'valid', ... }
   ```
5. Leads should now be marked VERIFIED (green), RISKY (yellow), or BAD (red) based on real SMTP responses

---

## Troubleshooting

### "App not found" when deploying via GitHub Actions
- Make sure the app name in `smtp-proxy/fly.toml` matches the app you created on Fly.io (Step 2)
- Make sure `FLY_API_TOKEN` is set in GitHub repo secrets (Step 5) — NOT in environment variables, it MUST be a secret

### The proxy health check returns "Not Found" or "Application error"
- Wait 2-3 minutes after deploy — the VM takes time to start
- Check Fly.io logs: go to **https://fly.io/app/cold-outreach-smtp-proxy/monitoring** → "Logs"
- Common issue: the app didn't deploy correctly. Re-run the GitHub Action (Step 8)

### The Test button in the app fails for Fly.io
- Fly.io doesn't have a Test button (it's a fallback, not a regular provider)
- Verify it works by visiting `https://your-proxy.fly.dev/health` in your browser
- If that returns `{"ok":true}`, the proxy is working

### All verifications still fail even with Fly.io configured
- Check Render logs for `[verify-test]` or `[router]` entries
- Make sure `SMTP_PROXY_URL` and `SMTP_PROXY_SECRET` env vars on Render exactly match what you set on Fly.io
- The secret is case-sensitive — copy-paste it, don't type it

### Fly.io bill is higher than expected
- Check usage at **https://fly.io/dashboard**
- The proxy VM (shared-cpu-1x, 256MB) costs ~$1.94/month
- If your bill is over $5, you might have other apps running on Fly.io
- The proxy alone should stay under the $5 waiver → $0

### I want to remove the proxy later
- Go to **https://fly.io/app/cold-outreach-smtp-proxy** → Settings → "Delete app"
- Remove `SMTP_PROXY_URL` and `SMTP_PROXY_SECRET` from Render env vars
- Remove the Fly.io config from Settings → Verification in the app
- Redeploy the backend

---

## Quick Reference

| What | Where |
|---|---|
| Fly.io dashboard | https://fly.io/dashboard |
| Fly.io app secrets | https://fly.io/app/YOUR-APP-NAME/secrets |
| Fly.io API tokens | https://fly.io/user/personal_access_tokens |
| Fly.io app logs | https://fly.io/app/YOUR-APP-NAME/monitoring |
| Fly.io pricing | https://fly.io/docs/about/pricing/ |
| GitHub repo secrets | https://github.com/interiorvisualsd-maker/cold-outreach-backend/settings/secrets/actions |
| GitHub Actions tab | https://github.com/interiorvisualsd-maker/cold-outreach-backend/actions |
| Render env vars | https://dashboard.render.com → your service → Environment |
| Proxy health check | https://YOUR-APP-NAME.fly.dev/health |

---

## Cost Summary

| Component | Monthly cost |
|---|---|
| Fly.io VM (shared-cpu-1x, 256MB, always-on) | $1.94 |
| Bandwidth (a few hundred MB for SMTP probes) | ~$0.01 |
| **Total** | **~$1.95/month** |

Fly.io waives invoices under $5 → **you pay $0** for typical usage.

The only way to exceed $5 is if you also buy a dedicated egress IP ($3.60/month) — we're NOT doing that. The shared IP works fine for SMTP verification (some MX servers may reject it, but those leads just get marked "RISKY" and re-verified later via the free APIs).

---

You're done. The Fly.io proxy is now your unlimited fallback for SMTP verification. Combined with the 4 free API providers (~4,900/month), you have enough capacity for 15,000-18,000+ verifications per month for $0.
