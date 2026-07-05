# Production Setup Guide — Realtime Notifications Service

This guide shows you exactly how to deploy the realtime notifications service alongside your existing backend (Render) and frontend (Vercel). Follow every step in order. Do not skip any.

---

## What You Already Have

- **Backend** on Render: `https://cold-outreach-api.onrender.com`
- **Frontend** on Vercel: `https://cold-outreach-frontend-tau.vercel.app`
- **Database** on Neon Postgres
- **GitHub repos**: `cold-outreach-backend` and `cold-outreach-frontend`

## What You're Adding

A **third service** — the realtime notifications pub/sub broker. It's a tiny Bun app that:
1. Receives notifications from your backend via HTTP POST
2. Broadcasts them to all connected browser tabs via socket.io (instant delivery, no polling)

**Cost: $0** (Render Free tier is enough — this service uses almost no CPU/RAM)

---

## Step 1: Push the Latest Code to GitHub

Before deploying, make sure the latest code is on GitHub.

1. Open your computer's terminal (or ask whoever manages your code to do this).
2. If you've been working in the sandbox, the code is already pushed. Verify by going to:
   - https://github.com/interiorvisualsd-maker/cold-outreach-backend
   - The latest commit message should mention "single port" or "pub/sub"
3. If the code is NOT pushed, the sandbox agent should have already pushed it. If not, ask the agent to push.

**You do NOT need to do anything else in this step.** Just verify the GitHub repo has the `mini-services/realtime/` folder by checking:
`https://github.com/interiorvisualsd-maker/cold-outreach-backend/tree/main/mini-services/realtime`

---

## Step 2: Create a New Render Web Service for the Realtime Service

You already have one Render service (the backend). Now you'll create a SECOND service for realtime.

1. Go to **https://dashboard.render.com**
2. Log in to your Render account.
3. In the top right, click **New +** → **Web Service**
4. You'll see a "Create a New Web Service" page.
5. Under **"Connect a repository"**, find and click on **`cold-outreach-backend`**
   - (The realtime service lives inside the backend repo, in the `mini-services/realtime/` subfolder)
6. If you don't see the repo, click **"Configure account"** and make sure Render has access to the `cold-outreach-backend` repo.

---

## Step 3: Configure the Realtime Service on Render

Fill in these EXACT values on the Render "Create a New Web Service" page:

### Name
```
cold-outreach-realtime
```

### Region
Select the same region as your backend (e.g., **Oregon** or **Frankfurt** — pick whichever is closest to your users).

### Branch
```
main
```

### Root Directory
```
mini-services/realtime
```
**This is CRITICAL.** Render will only look at files inside `mini-services/realtime/`. Without this, it won't find the `index.ts` file.

### Runtime
```
Bun
```
If Bun is not available, select **Node** and use the start command below for Node.

### Build Command
```
bun install
```

### Start Command
```
bun index.ts
```

### Instance Type
```
Free
```
The free tier is enough. This service uses almost no resources — it just passes messages between the backend and browser tabs.

---

## Step 4: Set Environment Variables on the Realtime Service

Scroll down to the **"Environment"** section on the same Render page.

Click **"Add Environment Variable"** and add this ONE variable:

| Key | Value |
|-----|-------|
| `PORT` | `3003` |

**That's the only env var the realtime service needs.** Render will automatically use this port.

(Actually, Render auto-detects the port from the `PORT` env var. But setting it explicitly to `3003` ensures consistency. If Render assigns a different port via its own `PORT` env var, the service will use that instead — the code reads `process.env.PORT`.)

---

## Step 5: Deploy the Realtime Service

1. Scroll to the bottom of the Render page.
2. Click **"Create Web Service"**.
3. Render will now:
   - Pull the code from GitHub
   - Run `bun install`
   - Start `bun index.ts`
4. Wait 2-3 minutes for the build to finish.
5. You'll see a URL at the top of the service page, like:
   ```
   https://cold-outreach-realtime.onrender.com
   ```
   **Copy this URL** — you'll need it in Steps 6 and 7.

6. Verify the service is running by opening this URL in your browser:
   ```
   https://cold-outreach-realtime.onrender.com/health
   ```
   You should see:
   ```json
   {"ok":true,"service":"lead-dispatcher-realtime","port":3003,"connectedSubscribers":0}
   ```
   If you see this, the realtime service is live. ✅

---

## Step 6: Update the Backend's Environment Variables on Render

Now you need to tell the backend where to send notifications.

1. Go to your Render dashboard.
2. Click on your **backend** service (`cold-outreach-api` or whatever you named it).
3. In the left sidebar, click **"Environment"**.
4. Click **"Add Environment Variable"** and add:

| Key | Value |
|-----|-------|
| `REALTIME_PUBLISHER_URL` | `https://cold-outreach-realtime.onrender.com` |

(Replace the URL with the actual URL you copied in Step 5.)

5. Click **"Save Changes"**.
6. Render will automatically redeploy the backend with the new env var. Wait 2-3 minutes for the redeploy to finish.

**What this does:** When the backend calls `pushNotification()`, it now POSTs to `https://cold-outreach-realtime.onrender.com/emit` instead of `localhost:3003`.

---

## Step 7: Update the Frontend's Environment Variables on Vercel

Now you need to tell the frontend (browser) where to connect for real-time notifications.

1. Go to **https://vercel.com** and log in.
2. Click on your project (`cold-outreach-frontend`).
3. In the top nav, click **"Settings"**.
4. In the left sidebar, click **"Environment Variables"**.
5. Click **"Add"** and add this variable:

| Key | Value | Environment |
|-----|-------|-------------|
| `NEXT_PUBLIC_REALTIME_URL` | `https://cold-outreach-realtime.onrender.com` | Production (and Preview, if you want) |

(Replace the URL with the actual URL you copied in Step 5.)

**IMPORTANT:** The variable name MUST start with `NEXT_PUBLIC_` — this tells Next.js to expose it to the browser. Without the prefix, the browser can't see it.

6. Click **"Save"**.
7. **You MUST redeploy the frontend** for the new env var to take effect:
   - Go to the **"Deployments"** tab
   - Find the most recent deployment
   - Click the **"..."** (three dots) menu on the right
   - Click **"Redeploy"**
   - Click **"Redeploy"** again to confirm
   - Wait 1-2 minutes for the redeploy to finish

---

## Step 8: Verify Everything Works

1. Open your frontend: `https://cold-outreach-frontend-tau.vercel.app`
2. Log in with your credentials.
3. Look at the **notification bell icon** in the top right.
4. You should see a **small green dot** at the bottom-right of the bell icon.
   - Green dot = real-time connection is active ✅
   - Gray dot = connection failed (see Troubleshooting below)
5. To test real-time delivery:
   - Open the **Settings** page in the app
   - Scroll to the **"Notification Preferences"** section
   - Click the **"Send Test"** button
   - The notification bell should update **instantly** (within 1 second)
   - You should NOT need to refresh the page

If the bell updates instantly, everything is working. 🎉

---

## Step 9: Keep the Realtime Service Awake (Optional but Recommended)

Render's Free tier puts services to sleep after 15 minutes of inactivity. When the realtime service sleeps, real-time notifications won't work until it wakes up (which takes ~30 seconds on the first request).

To keep it awake, set up a free ping service:

### Option A: Use cron-job.org (free, recommended)

1. Go to **https://cron-job.org** and create a free account.
2. Click **"CREATE CRONJOB"**.
3. Fill in:
   - **Title:** `Keep Realtime Awake`
   - **URL:** `https://cold-outreach-realtime.onrender.com/health`
   - **Execution Schedule:** Every **5 minutes**
4. Click **"CREATE"**.

This pings the realtime service every 5 minutes, keeping it awake.

### Option B: Use UptimeRobot (free)

1. Go to **https://uptimerobot.com** and create a free account.
2. Click **"Add New Monitor"**.
3. Fill in:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** `Realtime Service`
   - **URL:** `https://cold-outreach-realtime.onrender.com/health`
   - **Monitoring Interval:** 5 minutes
4. Click **"Create Monitor"**.

---

## Troubleshooting

### The green dot on the bell icon is gray (not connected)

**Cause:** The frontend can't reach the realtime service.

**Fix:**
1. Check that `NEXT_PUBLIC_REALTIME_URL` is set correctly on Vercel (Step 7).
2. Check that you redeployed the frontend after adding the env var (Step 7, point 7).
3. Open your browser's Developer Tools (F12) → Console tab. Look for errors like:
   - `socket.io-client` not found → run `bun add socket.io-client` in the frontend and redeploy
   - `CORS error` → the realtime service already allows all origins, but check if a proxy is blocking it
   - `connect_error` → the realtime service URL is wrong or the service is down
4. Verify the realtime service is running:
   ```
   https://cold-outreach-realtime.onrender.com/health
   ```
   Should return `{"ok":true,...}`

### The bell doesn't update when a test notification is sent

**Cause:** The backend can't reach the realtime service.

**Fix:**
1. Check that `REALTIME_PUBLISHER_URL` is set correctly on the backend (Step 6).
2. Check that the backend redeployed after adding the env var.
3. Check the realtime service logs on Render:
   - Go to Render dashboard → `cold-outreach-realtime` → **Logs** tab
   - Look for `Published "..." to N subscribers`
   - If you don't see this, the backend isn't reaching the realtime service
4. Check the backend logs on Render:
   - Go to Render dashboard → your backend service → **Logs** tab
   - Look for `[notifications] realtime publish error`
   - If you see connection errors, the `REALTIME_PUBLISHER_URL` is wrong

### The realtime service won't start on Render

**Cause:** Build or runtime error.

**Fix:**
1. Go to Render dashboard → `cold-outreach-realtime` → **Logs** tab.
2. Look for error messages.
3. Common issues:
   - **"Cannot find module 'socket.io'"** → the Build Command didn't run. Make sure Build Command is `bun install` and Root Directory is `mini-services/realtime`.
   - **"Port already in use"** → don't set `PORT` env var; let Render auto-assign it. The code reads `process.env.PORT`.
   - **"Permission denied"** → make sure the Start Command is `bun index.ts` (not `bun run dev`).

### Notifications work but are delayed by 5 minutes

**Cause:** The real-time pub/sub isn't working, and you're seeing the fallback poll (every 5 minutes).

**Fix:** Follow the "green dot is gray" troubleshooting above.

### Render says "Build failed"

**Cause:** The Root Directory or Build Command is wrong.

**Fix:**
1. Verify Root Directory is exactly `mini-services/realtime` (no leading/trailing slashes).
2. Verify Build Command is `bun install`.
3. Verify Start Command is `bun index.ts`.
4. If Bun is not available as a runtime, select **Node** and use:
   - Build Command: `npm install`
   - Start Command: `npx tsx index.ts` (you may need to add `tsx` as a dependency)

---

## Architecture Summary (for reference)

```
┌─────────────────┐      HTTP POST /emit       ┌──────────────────────┐
│   Backend        │ ──────────────────────────>│  Realtime Service     │
│  (Render)        │  https://...render.com/emit│  (Render, free tier)  │
│                  │                            │                       │
│  pushNotification│                            │  socket.io server     │
│  () → HTTP POST  │                            │  port: PORT env var   │
└─────────────────┘                            └───────────┬───────────┘
                                                            │
                                                socket.io   │
                                                broadcast   │
                                                     ┌──────▼──────┐
                                                     │  Browser    │
                                                     │  (Vercel)   │
                                                     │             │
                                                     │  io(url, {  │
                                                     │   path:     │
                                                     │  '/socket.io/'│
                                                     │  })         │
                                                     │             │
                                                     │  listens for│
                                                     │  'notification'│
                                                     └─────────────┘
```

**Flow:**
1. Backend calls `pushNotification()` → saves to DB + HTTP POST to realtime service
2. Realtime service receives POST → broadcasts via socket.io to all connected browsers
3. Browser receives socket.io event → updates the bell icon instantly

**Fallback:** If the realtime service is down, the frontend still polls `/api/extras/notifications` every 5 minutes as a backup. Notifications are never lost — they're always persisted to the database.

---

## Cost Breakdown

| Service | Plan | Cost |
|---------|------|------|
| Backend (Render) | Starter | $7/month |
| Frontend (Vercel) | Hobby | $0 |
| Realtime (Render) | Free | $0 |
| Database (Neon) | Free | $0 |
| Cron (cron-job.org) | Free | $0 |
| **Total** | | **$7/month** |

The free realtime tier gives you 750 hours/month (enough for 24/7). It sleeps after 15 min of inactivity, but the ping service (Step 9) keeps it awake.

---

## What If I Want to Remove Realtime Notifications?

If you decide you don't want real-time notifications anymore:

1. Delete the realtime service on Render (Dashboard → `cold-outreach-realtime` → Settings → Delete).
2. Remove `REALTIME_PUBLISHER_URL` from the backend's env vars on Render.
3. Remove `NEXT_PUBLIC_REALTIME_URL` from Vercel's env vars.
4. Redeploy both.

The app will fall back to 60-second polling (the old behavior). No data is lost — notifications are always persisted to the database regardless of whether the realtime service is running.
