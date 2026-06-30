# 🚀 Complete Setup Guide — Lead Dispatcher

**This guide will walk you through setting up your cold email automation app from scratch. Follow each step in order. Don't skip ahead!**

---

## 📋 What You're Building

A cold email app that:
- Sends thousands of personalized emails per day
- Rotates between multiple sending accounts automatically
- Warms up new email accounts to protect reputation
- Shows all replies in one unified inbox
- Auto-stops follow-ups when someone replies
- Sends you Slack/Discord alerts when stuff happens

**Total cost: $0** (everything runs on free tiers)

---

## 🛠️ What You Need Before Starting

1. **A computer** with internet (you're reading this, so ✅)
2. **A Google account** (Gmail works) — for Google Cloud + Vercel login
3. **A GitHub account** — your code repos are already there:
   - Frontend: https://github.com/interiorvisualsd-maker/cold-outreach-frontend
   - Backend: https://github.com/interiorvisualsd-maker/cold-outreach-backend
4. **30-45 minutes** of focused time

---

## 🗺️ The Big Picture (How It All Works)

```
┌─────────────────────────────────────────────┐
│  1. Neon (Database)                         │
│  Stores all your data: leads, emails,       │
│  accounts, replies                          │
│  → https://neon.tech (FREE)                 │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  2. Google Cloud Run (Backend)              │
│  The "brain" — sends emails, checks replies │
│  → https://console.cloud.google.com ($300   │
│    free credit for 90 days, then $0-8/mo)   │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  3. Vercel (Frontend)                       │
│  The website you log into                   │
│  → https://vercel.com (FREE)                │
└─────────────────────────────────────────────┘
```

**Think of it like a restaurant:**
- **Neon** = the pantry (stores ingredients/data)
- **Cloud Run** = the kitchen (does the cooking/processing)
- **Vercel** = the dining room (where you sit and interact)

---

## STEP 1: Create Your Database (Neon) — 5 minutes

Neon is a free database service. Think of it as a spreadsheet in the cloud that your app uses to remember everything.

### 1.1 Sign up
1. Open **https://neon.tech** in your browser
2. Click **"Sign up"** (top right)
3. Click **"Continue with Google"**
4. Pick your Google account
5. Fill in your name if asked

### 1.2 Create a project
1. You'll see a page asking to create your first project
2. **Project name**: type `lead-dispatcher`
3. **Database name**: leave it as `neondb` (default)
4. **Region**: pick the one closest to you (if unsure, pick `US East (Ohio)`)
5. **Postgres version**: leave default (17)
6. Click **"Create project"**

### 1.3 Copy your connection string
After creating, you'll see a page with a connection string. It looks like this:

```
postgresql://lead_dispatcher_owner:AbCdEf123456@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
```

⚠️ **IMPORTANT**: Copy this ENTIRE string and paste it into a notepad. You'll need it 3 more times. This is your **DATABASE_URL**.

> 💡 If you lose it, go to your Neon dashboard → click your project → "Connection Details" tab → copy the connection string.

---

## STEP 2: Set Up Google Cloud — 10 minutes

This is where your backend (the "brain") will live.

### 2.1 Create a Google Cloud project
1. Open **https://console.cloud.google.com**
2. Sign in with your Google account
3. Click the project dropdown at the top (it might say "Select a project")
4. Click **"New Project"** (top right of the popup)
5. **Project name**: type `lead-dispatcher`
6. Click **"Create"**
7. Wait 10 seconds, then click the notification bell (🔔 top right) → "Select project"

> 💡 You automatically get **$300 free credit** valid for 90 days. You won't be charged.

### 2.2 Enable the services you need
Your app needs 4 Google services turned on. Do this for each one:

1. In the top search bar, type `Cloud Run API` and click the result
2. Click **"Enable"** (if it says "Manage" instead, it's already on ✅)
3. Go back, search `Cloud Build API` → Enable
4. Search `Cloud Scheduler API` → Enable
5. Search `Artifact Registry API` → Enable

### 2.3 Install the Google Cloud CLI (command line tool)

You need this to deploy your code. Pick your operating system:

**If you're on Mac:**
1. Open **https://cloud.google.com/sdk/docs/install**
2. Scroll to "macOS (64-bit)" → download the `.tar.gz` file
3. Double-click to extract it
4. Open the extracted folder in Terminal
5. Run: `./install.sh`
6. Restart your Terminal

**If you're on Windows:**
1. Open **https://cloud.google.com/sdk/docs/install**
2. Scroll to "Windows (64-bit)" → download the `.exe` installer
3. Run the installer, click Next through all steps
4. A black command window will pop up — follow the prompts

**If you're on Linux:**
```bash
curl https://sdk.cloud.google.com | bash
exec -l $SHELL
gcloud init
```

### 2.4 Log in to Google Cloud from your terminal
Open your terminal (Mac: Terminal app, Windows: search "cmd") and run:

```bash
gcloud auth login
```

A browser window will open. Pick your Google account. Click "Allow".

Then run:

```bash
gcloud config set project lead-dispatcher
```

> ✅ If you see a success message, you're logged in!

---

## STEP 3: Deploy Your Backend to Cloud Run — 15 minutes

### 3.1 Download your backend code

Open your terminal and run these commands one at a time:

```bash
# Go to your home folder
cd ~

# Download the backend code
git clone https://github.com/interiorvisualsd-maker/cold-outreach-backend.git

# Go into the folder
cd cold-outreach-backend
```

### 3.2 Set up the database

Run these commands (replace `PASTE_YOUR_NEON_STRING_HERE` with your actual Neon connection string from Step 1.3):

```bash
# Tell the app where your database is
export DATABASE_URL="PASTE_YOUR_NEON_STRING_HERE"

# Install dependencies (this takes 30-60 seconds)
npm install

# Create all the database tables
npx prisma db push

# Generate the database client
npx prisma generate
```

> ✅ If you see "🚀 Your database is now in sync", it worked!

### 3.3 Generate secret keys

Your app needs two secret keys to keep passwords and data safe. Run these two commands and **save the outputs** — you'll need them:

```bash
# Generate key #1 (for passwords)
openssl rand -hex 32
```

Copy the output (64 characters of random letters/numbers). This is your **JWT_SECRET**.

```bash
# Generate key #2 (for encrypting email passwords)
openssl rand -hex 32
```

Copy the output. This is your **ENCRYPTION_KEY**.

### 3.4 Deploy to Cloud Run

Now the big moment! Run this command (replace ALL the placeholder values):

```bash
gcloud run deploy cold-outreach-api \
  --source . \
  --region us-central1 \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --allow-unauthenticated \
  --set-env-vars "DATABASE_URL=PASTE_YOUR_NEON_STRING_HERE" \
  --set-env-vars "JWT_SECRET=PASTE_YOUR_JWT_SECRET" \
  --set-env-vars "ENCRYPTION_KEY=PASTE_YOUR_ENCRYPTION_KEY" \
  --set-env-vars "FRONTEND_URL=https://cold-outreach-frontend.vercel.app" \
  --set-env-vars "PUBLIC_BASE_URL=https://cold-outreach-frontend.vercel.app"
```

**What to replace:**
- `PASTE_YOUR_NEON_STRING_HERE` → your Neon connection string from Step 1.3
- `PASTE_YOUR_JWT_SECRET` → the first key you generated
- `PASTE_YOUR_ENCRYPTION_KEY` → the second key you generated

**What happens next:**
- Google will build your code (takes 3-5 minutes)
- You'll see a progress bar with percentages
- When done, you'll see a URL like:
  ```
  https://cold-outreach-api-1234567-uc.a.run.app
  ```

⚠️ **IMPORTANT**: Copy this URL! This is your **BACKEND_URL**. You'll need it in Step 4.

### 3.5 Set up the background worker (sends emails automatically)

Your app needs a "worker" that runs every 5 minutes to send queued emails and check for replies. Run these commands:

```bash
# Create the worker job
gcloud run jobs create cold-outreach-worker \
  --source . \
  --region us-central1 \
  --command "bun" --args "src/worker-job.ts" \
  --set-env-vars "DATABASE_URL=PASTE_YOUR_NEON_STRING_HERE" \
  --set-env-vars "JWT_SECRET=PASTE_YOUR_JWT_SECRET" \
  --set-env-vars "ENCRYPTION_KEY=PASTE_YOUR_ENCRYPTION_KEY"

# Schedule it to run every 5 minutes
gcloud scheduler jobs create http cold-outreach-worker-trigger \
  --schedule "*/5 * * * *" \
  --uri "PASTE_YOUR_BACKEND_URL/api/dispatcher/process" \
  --http-method POST \
  --oauth-service-account-email $(gcloud projects describe lead-dispatcher --format="value(projectNumber)")@cloudbuild.gserviceaccount.com
```

**Replace:**
- `PASTE_YOUR_NEON_STRING_HERE` → your Neon string
- `PASTE_YOUR_JWT_SECRET` → your JWT secret
- `PASTE_YOUR_ENCRYPTION_KEY` → your encryption key
- `PASTE_YOUR_BACKEND_URL` → the URL from Step 3.4 (like `https://cold-outreach-api-1234567-uc.a.run.app`)

> ✅ If you see "Created [cold-outreach-worker-trigger]", you're done with the backend!

---

## STEP 4: Deploy Your Frontend to Vercel — 5 minutes

### 4.1 Go to Vercel
1. Open **https://vercel.com**
2. Click **"Sign Up"** (top right)
3. Click **"Continue with GitHub"**
4. Authorize Vercel to access your GitHub

### 4.2 Import your frontend repo
1. Click **"Add New..."** → **"Project"**
2. You'll see a list of your GitHub repos
3. Find `cold-outreach-frontend` → click **"Import"**

### 4.3 Configure the deployment
1. **Framework Preset**: Should auto-detect "Next.js" ✅
2. Don't touch the Build & Output Settings
3. **IMPORTANT — Environment Variables**: Click the dropdown and add these one by one:

   | Name | Value |
   |------|-------|
   | `NEXT_PUBLIC_API_URL` | `PASTE_YOUR_BACKEND_URL` (from Step 3.4) |

   **Example value**: `https://cold-outreach-api-1234567-uc.a.run.app`

4. Click **"Deploy"**

### 4.4 Wait for deployment
- You'll see a cool animation while it builds
- Takes 2-3 minutes
- When done, you'll see **"Congratulations!"** with confetti 🎉
- Click **"Visit"** to see your live site

> ⚠️ The URL looks like `cold-outreach-frontend-abc123.vercel.app`. Copy this — it's your **FRONTEND_URL**.

---

## STEP 5: Connect Frontend and Backend — 2 minutes

Right now your frontend can't talk to your backend because of a security rule called CORS. Let's fix that.

### 5.1 Update backend environment variables
1. Go back to **Google Cloud Console** → **Cloud Run**
2. Click your `cold-outreach-api` service
3. Click **"Edit & Deploy New Revision"** (top right)
4. Scroll down to **"Variables & Secrets"**
5. Update `FRONTEND_URL` to your Vercel URL:
   ```
   FRONTEND_URL=https://cold-outreach-frontend-abc123.vercel.app
   ```
6. Also update `PUBLIC_BASE_URL` to the same Vercel URL
7. Click **"Deploy"** at the bottom

> ✅ Takes about 2 minutes to redeploy.

---

## STEP 6: Create Your Account — 1 minute

1. Open your Vercel URL in your browser
2. You'll see a login page with a violet gradient on the left
3. Click **"Sign up"** (bottom link)
4. Fill in:
   - **Full Name**: your name
   - **Email**: your email
   - **Password**: pick something strong (6+ characters)
5. Click **"Create account"**
6. You're in! 🎉

> The first person to sign up automatically becomes the admin.

---

## STEP 7: Add Demo Data (Optional but Recommended) — 30 seconds

To see how the app looks with real data:

1. On the dashboard, click **"Seed Demo Data"** (violet button, top right)
2. Wait 2 seconds
3. You'll now see:
   - 4 sending accounts
   - 2 campaigns with 48 leads
   - 40 warmup messages
   - 12 replies
   - 5 notifications

---

## STEP 8: Connect Real Email Accounts — When You're Ready

When you want to send real emails (not just demo):

1. Go to **Sending Accounts** (left sidebar)
2. Click **"Add Account"**
3. Fill in your SMTP/IMAP details:
   - **For Gmail**: use an "App Password" (not your regular password)
     - Go to https://myaccount.google.com → Security → 2-Step Verification → App passwords
     - Create a password for "Mail"
     - SMTP host: `smtp.gmail.com`, port: `465`
     - IMAP host: `imap.gmail.com`, port: `993`
4. Click **"Create Account"**
5. Click **"Test"** to verify the connection works

> ⚠️ Start with the daily cap at 50, not 100. You can increase it later once the account is warmed up.

---

## STEP 9: Import Your Leads — When You're Ready

1. Go to **Import Leads** (left sidebar)
2. Select a campaign (or create one first)
3. Drag your CSV file into the upload area
   - **Any filename works** — the app auto-detects columns
4. Review the column mapping (it's usually correct)
5. Click **"Import"**
6. You'll see how many leads were imported, skipped (duplicates), etc.

---

## STEP 10: Optional — Enable AI Reply Tagging (DeepSeek)

If you want the app to automatically classify replies as "interested", "not interested", etc:

1. Go to **https://platform.deepseek.com** → sign up
2. Add some credits ($5 is plenty — it's very cheap)
3. Copy your API key (starts with `sk-`)
4. In Google Cloud Run, edit your `cold-outreach-api` service
5. Add environment variable:
   ```
   DEEPSEEK_API_KEY=sk-your-key-here
   ```
6. Deploy

Now replies get auto-tagged! You can also test it in **Settings → Integrations → DeepSeek LLM → Test Connection**.

---

## STEP 11: Optional — Set Up Slack/Discord Alerts

Get notified in Slack or Discord when someone replies, bounces, or unsubscribes:

1. **For Slack**:
   - Go to your Slack workspace → Settings → Integrations → Incoming Webhooks
   - Create a webhook for a channel (like #alerts)
   - Copy the URL (looks like `https://hooks.slack.com/services/...`)

2. **For Discord**:
   - Go to your server → Channel Settings → Integrations → Webhooks
   - New Webhook → Copy URL

3. In your app: **Settings → Integrations → Webhooks → Add Webhook**
4. Paste the URL, pick the type (Slack/Discord), select events
5. Click **"Add Webhook"**
6. Click **"Test"** to verify

---

## 🎯 You're Done! Here's What You Can Do Now

| Feature | Where to find it |
|---------|-----------------|
| View analytics | Dashboard |
| Add email accounts | Sending Accounts |
| Create campaigns | Campaigns |
| Upload leads | Import Leads |
| Check the send queue | Dispatcher |
| See warm-up progress | Warm-up |
| Read and reply to emails | Unibox |
| Manage blocked emails | Suppression |
| Create email templates | Templates |
| Add team members | Team |
| Configure settings | Settings |

### Pro Tips:
- **Press Cmd+K (Mac) or Ctrl+K (Windows)** anywhere to open the command palette — search leads, navigate views, and more
- **Click any lead email** in the campaigns table or unibox to see their full activity timeline
- **Set daily caps to 50** for new accounts — increase to 100 only after warm-up
- **Check the notification bell** (top right) for alerts about replies, bounces, and failures

---

## 🆘 Troubleshooting

### "Failed to fetch" on the website
→ Your frontend can't reach the backend. Check:
1. Is `NEXT_PUBLIC_API_URL` set correctly in Vercel? (should be your Cloud Run URL)
2. Is `FRONTEND_URL` set correctly in Cloud Run? (should be your Vercel URL)
3. Did you redeploy after changing env vars?

### "Unauthorized" when using the app
→ Your login token expired. Just log out and log back in.

### Database connection errors
→ Your Neon string needs `?sslmode=require` at the end. Check:
```
postgresql://user:pass@host/db?sslmode=require
```

### Cloud Run deployment fails
→ Make sure you:
1. Enabled all 4 APIs (Cloud Run, Cloud Build, Cloud Scheduler, Artifact Registry)
2. Ran `gcloud auth login` successfully
3. Are in the `cold-outreach-backend` folder when deploying

### Worker not running
→ Check:
1. Go to Cloud Console → Cloud Scheduler
2. Is the `cold-outreach-worker-trigger` job there?
3. Click it → "Run now" to test manually
4. Check the logs for errors

### SMTP sending fails
→ Common causes:
1. **Gmail**: Use App Password, not your regular password
2. **Less secure apps**: Some providers block SMTP by default
3. **Wrong port**: Try 587 (TLS) instead of 465 (SSL)

---

## 💰 Cost Breakdown

| Service | Free Tier | Your Usage | Monthly Cost |
|---------|-----------|------------|--------------|
| Vercel | Hobby (free) | Static site | $0 |
| Cloud Run API | 240k vCPU-sec/mo free | ~5% of free tier | $0 |
| Cloud Run Worker | Same free tier | ~10% | $0 |
| Cloud Scheduler | 3 jobs free | 1 job | $0 |
| Neon Postgres | 0.5GB free | <100MB | $0 |
| **Total** | | | **$0/month** |

After 90 days, the GCP $300 credit expires but you stay on the always-free tier. Expected cost: **$0-8/month**.

Optional: Cloud NAT for a static sending IP (~$33/month) — recommended for serious cold email deliverability.

---

## 📞 Need Help?

- **Code**: https://github.com/interiorvisualsd-maker/cold-outreach-frontend + cold-outreach-backend
- **Worklog**: See `worklog.md` in the repo for full development history
- **Setup video**: The steps above are all you need — take it one step at a time!

---

**🎉 Congratulations! You now have your own cold email automation platform running for $0/month.**
