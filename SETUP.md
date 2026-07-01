# 🚀 No-Terminal Setup Guide — Lead Dispatcher

**You will NOT use the terminal/command line at all. Everything is done through websites.**

---

## 📋 What You Need
- A Google account (Gmail)
- Your GitHub repos already exist:
  - Frontend: https://github.com/interiorvisualsd-maker/cold-outreach-frontend
  - Backend: https://github.com/interiorvisualsd-maker/cold-outreach-backend
- 30-45 minutes
- A phone or computer with internet

---

## 🗺️ What We're Building (3 Websites)

| Step | Website | What It Does | Cost |
|------|---------|-------------|------|
| 1 | **Neon** | Stores your data (database) | $0 |
| 2 | **Google Cloud** | Runs the backend (sends emails) | $0 (90-day $300 credit) |
| 3 | **Vercel** | Hosts the website (what you log into) | $0 |

---

## STEP 1: Create Your Database — 5 minutes

### What is this?
Your app needs a place to store leads, emails, and replies. Neon gives you a free database.

### Steps:

1. Open **https://neon.tech** in your browser
2. Click **"Sign up"** (top right corner)
3. Click **"Continue with Google"**
4. Pick your Google account
5. On the "Create your first project" page:
   - **Project name**: type `lead-dispatcher`
   - **Database name**: leave as `neondb`
   - **Region**: pick the closest to you (if unsure, pick `US East (Ohio)`)
   - **Postgres version**: leave default
6. Click **"Create project"**

### Copy your database link:

After creating, you'll see a page with a long link that looks like this:

```
postgresql://lead_dispatcher_owner:AbCdEf123456@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
```

⚠️ **COPY THIS ENTIRE LINK** and paste it into a Notes app on your phone or computer. You'll need it 2 more times. This is your **DATABASE LINK**.

> 💡 Lost it? Go to neon.tech → your project → "Connection Details" → copy it again.

---

## STEP 2: Set Up Google Cloud — 10 minutes

### What is this?
Google Cloud will run your backend — the "brain" that sends emails and checks for replies.

### 2A. Create a Google Cloud project

1. Open **https://console.cloud.google.com**
2. Sign in with your Google account
3. At the top, click the project dropdown (says "Select a project")
4. Click **"New Project"** (top right of popup)
5. **Project name**: type `lead-dispatcher`
6. Click **"Create"**
7. Wait 10 seconds, then click the 🔔 bell icon (top right) → **"Select project"**

> 💡 You automatically get $300 free credit (valid 90 days). You won't be charged.

### 2B. Turn on 4 services

Your app needs 4 Google services. For each one:
1. Click the search bar at the top
2. Type the name
3. Click the result
4. Click **"Enable"** (if it says "Manage" instead, it's already on ✅)

**Turn on these 4:**
1. Search `Cloud Run API` → Enable
2. Search `Cloud Build API` → Enable
3. Search `Cloud Scheduler API` → Enable
4. Search `Artifact Registry API` → Enable

### 2C. Generate a secret for your cron worker

1. Go to **https://www.random.org/strings**
2. Set: Length = `32`, Strings = `1`, Character set = `Alphanumeric`
3. Click **"Get Strings"**
4. Copy the generated string — this is your **CRON SECRET**

Save this somewhere. It's like a password that lets Google's scheduler trigger your worker.

### 2D. Generate two more secret keys

1. Go to **https://www.allkeysgenerator.com/Random/Security-Encryption-Key-Generator.aspx**
2. Set key size to `256-bit` and click **"Generate"**
3. Copy the hex string — this is your **JWT SECRET** (used for passwords)
4. Click Generate again
5. Copy the new hex string — this is your **ENCRYPTION KEY** (used to encrypt email passwords)

Save both of these. You'll need them in the next step.

---

## STEP 3: Deploy Your Backend — 15 minutes

### What is this?
This puts your backend code on Google's servers so it can send emails.

### 3A. Open Cloud Run

1. Go to **https://console.cloud.google.com**
2. Make sure "lead-dispatcher" is selected as your project (top bar)
3. Search `Cloud Run` in the top search bar → click it
4. Click **"Create Service"** (or "Deploy to Cloud Run")

### 3B. Connect your GitHub repo

1. Under **"Source"**, select **"Deploy from source"** (NOT "Deploy existing container")
2. Click **"Connect to GitHub"** (or "Set up with Cloud Build")
3. Authorize Google Cloud Build to access your GitHub
4. Select your GitHub account
5. Find and select **`cold-outreach-backend`** repository
6. Click **"Next"**

### 3C. Configure the build

1. **Branch**: `main`
2. **Build type**: should auto-detect the Dockerfile — leave as is
3. Click **"Next"**

### 3D. Configure the service

1. **Service name**: `cold-outreach-api`
2. **Region**: `us-central1` (or closest to you)
3. **Authentication**: Select **"Allow unauthenticated invocations"** (IMPORTANT — otherwise the website can't talk to it)
4. Under **"Container, Variables & Secrets, Networking, Security"** click to expand:
   - **Container port**: `8080`
   - **Memory**: `512 MiB`
   - **CPU**: `1`

5. Click **"VARIABLES & SECRETS"** tab → **"Add Variable"** for each of these:

| Variable name | Value |
|---------------|-------|
| `DATABASE_URL` | Paste your **DATABASE LINK** from Step 1 |
| `JWT_SECRET` | Paste your **JWT SECRET** from Step 2D |
| `ENCRYPTION_KEY` | Paste your **ENCRYPTION KEY** from Step 2D |
| `CRON_SECRET` | Paste your **CRON SECRET** from Step 2C |
| `FRONTEND_URL` | `https://cold-outreach-frontend.vercel.app` (we'll fix this later) |
| `PUBLIC_BASE_URL` | `https://cold-outreach-frontend.vercel.app` (same as above) |

6. Under **"Autoscaling"**:
   - **Minimum instances**: `0` (saves money — scales to zero when idle)
   - **Maximum instances**: `3`

7. Click **"Create"** or **"Deploy"**

### 3E. Wait for deployment

- Google will build your code (takes 3-5 minutes)
- You'll see a log stream — don't worry, just wait
- When done, you'll see a green checkmark ✅
- At the top, you'll see a URL like:
  ```
  https://cold-outreach-api-1234567-uc.a.run.app
  ```

⚠️ **COPY THIS URL** — this is your **BACKEND URL**. You'll need it!

---

## STEP 4: Set Up the Email Sender (Worker) — 5 minutes

### What is this?
Your app needs to check every 5 minutes: "Are there emails to send? Any new replies?" Google Cloud Scheduler does this automatically.

### 4A. Create a Cloud Scheduler job

1. In Google Cloud Console, search `Cloud Scheduler` → click it
2. Click **"Create Job"**
3. Fill in:
   - **Name**: `lead-dispatcher-worker`
   - **Description**: `Sends emails and checks replies every 5 minutes`
   - **Frequency**: type `*/5 * * * *` (this means "every 5 minutes")
   - **Timezone**: pick your timezone
4. Click **"Continue"**

5. Under **"Configure the execution"**:
   - **Target type**: select **"HTTP"**
   - **URL**: type your backend URL + `/api/cron/` + your CRON SECRET
     - Example: `https://cold-outreach-api-1234567-uc.a.run.app/api/cron/AbCdEf123456`
     - (Replace with your actual BACKEND URL and CRON SECRET)
   - **HTTP method**: **POST**
   - **Headers**: click "Add header"
     - Key: `Content-Type`
     - Value: `application/json`
   - **Body**: type `{}`

6. Click **"Create"**

### 4B. Test it

1. You'll see your job in the list
2. Click the **three dots** (⋮) on the right → **"Run now"**
3. Wait 10 seconds
4. Click the job → look at the "Last run result" — should say "Success" ✅

> If it fails, check:
> - Is the URL correct? (should end with `/api/cron/YOUR_SECRET`)
> - Is the method POST?
> - Did you include the CRON_SECRET in the URL?

---

## STEP 5: Deploy Your Frontend (Website) — 5 minutes

### What is this?
This is the actual website you'll log into to manage your campaigns.

### 5A. Import to Vercel

1. Open **https://vercel.com**
2. Click **"Sign Up"** (top right)
3. Click **"Continue with GitHub"**
4. Authorize Vercel

### 5B. Import your repo

1. Click **"Add New..."** → **"Project"**
2. Find `cold-outreach-frontend` in the list
3. Click **"Import"**

### 5C. Configure

1. **Framework Preset**: should auto-detect "Next.js" ✅
2. Don't touch Build/Output settings
3. **IMPORTANT** — expand **"Environment Variables"**:

   Click "Add" and enter:
   | Name | Value |
   |------|-------|
   | `NEXT_PUBLIC_API_URL` | Paste your **BACKEND URL** from Step 3E (like `https://cold-outreach-api-1234567-uc.a.run.app`) |

4. Click **"Deploy"**

### 5D. Wait + copy URL

- Watch the cool animation (takes 2-3 minutes)
- When done, you'll see confetti 🎉
- Click **"Visit"** to see your site
- Your URL looks like: `https://cold-outreach-frontend-abc123.vercel.app`

⚠️ **COPY THIS URL** — this is your **WEBSITE URL**.

---

## STEP 6: Connect Frontend and Backend — 2 minutes

### What is this?
Right now your website can't talk to your backend (security rule called CORS). Let's fix it.

### Steps:

1. Go back to **Google Cloud Console** → **Cloud Run**
2. Click your `cold-outreach-api` service
3. Click **"Edit & Deploy New Revision"** (top right)
4. Scroll to **"Variables & Secrets"** section
5. Update these two variables to your actual Vercel URL:
   - `FRONTEND_URL` = `https://cold-outreach-frontend-abc123.vercel.app` (your WEBSITE URL)
   - `PUBLIC_BASE_URL` = `https://cold-outreach-frontend-abc123.vercel.app` (same)
6. Click **"Deploy"** at the bottom
7. Wait 2 minutes for redeployment

---

## STEP 7: Create Your Account — 1 minute

1. Open your **WEBSITE URL** in your browser
2. You'll see a beautiful login page
3. Click **"Sign up"** (bottom link)
4. Fill in:
   - **Full Name**: your name
   - **Email**: your email
   - **Password**: at least 6 characters
5. Click **"Create account"**

🎉 **You're in!** You're the admin.

---

## STEP 8: Add Demo Data — 30 seconds

To see how the app looks with real data:

1. On the dashboard, find the **"Seed Demo Data"** button (top right, violet color)
2. Click it
3. Wait 2 seconds

You'll now see:
- 4 sending accounts (Gmail + Outlook)
- 2 campaigns with 48 leads
- 40 warmup messages
- 12 replies
- 5 notifications

Explore around! Click different tabs on the left sidebar to see everything.

---

## STEP 9: Connect Real Email Accounts — When You're Ready

### For Gmail:

1. First, create an **App Password** (NOT your regular Gmail password):
   - Go to **https://myaccount.google.com**
   - Click **"Security"** (left sidebar)
   - Make sure **2-Step Verification** is turned ON
   - Click **"2-Step Verification"** → scroll down → **"App passwords"**
   - App name: type `Lead Dispatcher`
   - Click **"Create"**
   - Copy the 16-character password it gives you

2. In your Lead Dispatcher app:
   - Go to **"Sending Accounts"** (left sidebar)
   - Click **"Add Account"**
   - Fill in:
     - **Label**: `Gmail - yourname@gmail.com`
     - **Email Address**: your Gmail
     - **From Name**: your name
     - **Provider**: select **"Gmail"** (this auto-fills SMTP/IMAP settings!)
     - **SMTP Password**: paste the App Password from step 1
     - **IMAP Password**: same App Password
     - **Daily Cap**: start with `50`
   - Click **"Create Account"**

3. Click **"Test"** to verify it works

> ⚠️ Start with daily cap = 50. Increase to 100 only after the account is warmed up (1-2 weeks).

---

## STEP 10: Import Your Leads — When You're Ready

1. Go to **"Import Leads"** (left sidebar)
2. **Select a campaign** from the dropdown (or create one in Campaigns first)
3. **Drag your CSV file** into the upload area
   - Any filename works! The app auto-detects columns
4. Review the column mapping (it's usually correct — if not, use the dropdowns)
5. Click **"Import"**
6. See how many leads were imported, skipped (duplicates), or suppressed

> 💡 Download the template from the Import page to see the expected format

---

## STEP 11: Optional — Enable AI Reply Tagging

If you want the app to automatically label replies as "interested", "not interested", etc:

### Get a DeepSeek API key:
1. Go to **https://platform.deepseek.com** → sign up
2. Add $5 credit (very cheap, lasts months)
3. Copy your API key (starts with `sk-`)

### Add it to your backend:
1. Go to **Google Cloud Console** → **Cloud Run**
2. Click `cold-outreach-api` → **"Edit & Deploy New Revision"**
3. Under **"Variables & Secrets"** → Add Variable:
   | Name | Value |
   |------|-------|
   | `DEEPSEEK_API_KEY` | `sk-your-key-here` |
4. Click **"Deploy"**

### Test it:
1. In your app: **Settings → Integrations → DeepSeek LLM → Test Connection**

---

## STEP 12: Optional — Slack/Discord Alerts

Get notified in Slack or Discord when someone replies, bounces, or unsubscribes:

### Get your webhook URL:

**For Slack:**
1. Go to https://api.slack.com/messaging/webhooks → "Create your app"
2. Pick your workspace → create app
3. Go to "Incoming Webhooks" → turn ON
4. Click "Add New Webhook to Workspace"
5. Pick a channel (like #alerts) → copy the URL
   - Looks like: `https://hooks.slack.com/services/T000/B000/XXXX`

**For Discord:**
1. Open Discord → your server
2. Right-click a channel → **"Edit Channel"**
3. Click **"Integrations"** → **"Webhooks"** → **"New Webhook"**
4. Copy the URL

### Add it to your app:
1. Go to **Settings → Integrations** (in your Lead Dispatcher app)
2. Scroll to **"Webhooks"** section
3. Click **"Add Webhook"**
4. Fill in:
   - **Type**: Slack or Discord
   - **URL**: paste your webhook URL
   - **Events**: check which events to forward (replies, bounces, etc.)
5. Click **"Add Webhook"**
6. Click **"Test"** — check your Slack/Discord for a test message!

---

## 🎯 You're Done! What Now?

| Want to... | Go to... |
|-----------|----------|
| See your analytics | **Dashboard** |
| Add more email accounts | **Sending Accounts** |
| Create a new campaign | **Campaigns** → New Campaign |
| Upload more leads | **Import Leads** |
| Check the email queue | **Dispatcher** |
| See warm-up progress | **Warm-up** |
| Read and reply to emails | **Unibox** |
| See blocked emails | **Suppression** |
| Create email templates | **Templates** |
| Add team members | **Team** (they sign up at the login page) |
| Change settings | **Settings** |

### 💡 Pro Tips:
- **Press Cmd+K (Mac) or Ctrl+K (Windows)** to open a search bar — search leads, jump to any page
- **Click any lead's email** to see their full activity timeline
- **Set daily caps to 50** for new accounts — increase after warm-up
- **Check the bell icon** (top right) for alerts
- **Notification preferences**: Settings → Integrations → toggle which events notify you

---

## 🆘 Troubleshooting

### "Failed to fetch" or blank page
Your website can't reach your backend. Check:
1. In Vercel: is `NEXT_PUBLIC_API_URL` set to your BACKEND URL? (Settings → Environment Variables)
2. In Cloud Run: is `FRONTEND_URL` set to your Vercel URL?
3. Did you redeploy after changing them?

### "Unauthorized" errors
Your login expired. Just log out and log back in.

### Database won't connect
Your Neon link needs `?sslmode=require` at the end:
```
postgresql://user:pass@host/db?sslmode=require
```

### Cloud Run deployment fails
1. Make sure all 4 APIs are enabled (Step 2B)
2. Make sure you selected "Allow unauthenticated invocations"
3. Make sure your GitHub repo is connected properly

### Worker doesn't seem to run
1. Go to Google Cloud Console → Cloud Scheduler
2. Click your `lead-dispatcher-worker` job
3. Click "Run now" to test
4. Check the logs for errors
5. Verify the URL is correct: `https://YOUR-BACKEND-URL/api/cron/YOUR-CRON-SECRET`

### Email sending fails
1. **Gmail**: You MUST use an App Password, not your regular password
2. **Daily cap too high**: Start with 50, not 100
3. **Account needs warm-up**: New accounts should warm up for 1-2 weeks before sending

### Can't find the "Seed Demo Data" button
It's on the **Dashboard** page, top right corner, next to the "Refresh" button. It has a sparkle ✨ icon.

---

## 💰 How Much Does This Cost?

| Service | Free Amount | What You Use | Cost |
|---------|------------|-------------|------|
| **Vercel** (website) | Free forever | Small site | $0 |
| **Google Cloud Run** (backend) | 240k vCPU-sec/month free | ~5% of free tier | $0 |
| **Google Cloud Scheduler** (worker) | 3 jobs free | 1 job | $0 |
| **Neon** (database) | 0.5GB free | <100MB | $0 |
| **Total** | | | **$0/month** |

After 90 days: Google's $300 credit expires, but the always-free tier still covers your usage. Expected: **$0-8/month**.

Optional: Add Cloud NAT (~$33/month) for a fixed IP address — improves email deliverability but not required.

---

## 📞 Quick Reference — All Your Important Links

Fill this in as you go, then save it:

```
DATABASE LINK:     postgresql://...     (from Neon, Step 1)
JWT SECRET:        __________________   (from Step 2D)
ENCRYPTION KEY:    __________________   (from Step 2D)
CRON SECRET:       __________________   (from Step 2C)
BACKEND URL:       https://cold-outreach-api-______.a.run.app  (from Step 3E)
WEBSITE URL:       https://cold-outreach-frontend-______.vercel.app  (from Step 5D)
```

---

**🎉 Congratulations! You've built your own cold email platform without touching a terminal. Now go send some emails!**
