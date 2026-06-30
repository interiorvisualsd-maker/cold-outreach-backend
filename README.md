# Cold Outreach Backend

Private cold email automation — backend API + background worker.

**Tech**: Hono (TypeScript) on Bun → deploys to **Google Cloud Run**. Database: **Neon Postgres**.

## Architecture

```
┌─────────────────────────────────────────┐
│  Cloud Run Service (API)                │
│  src/server.ts → Bun.serve()            │
│  Scales 0→3, handles HTTP requests      │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│  Neon Postgres (shared)                 │
│  All state: accounts, leads, queue,     │
│  warm-up, replies, suppression list     │
└─────────────────────────────────────────┘
                   ▲
                   │
┌──────────────────┴──────────────────────┐
│  Cloud Run Job (Worker)                 │
│  src/worker-job.ts → runs one tick,     │
│  exits. Triggered by Cloud Scheduler    │
│  every 5 minutes.                       │
│  - Sends campaign emails (rotation)     │
│  - Sends warm-up emails                 │
│  - IMAP poll: spam rescue + auto-reply  │
│  - Reply processing + sequence breaker  │
│  - LLM sentiment tagging (DeepSeek)     │
└─────────────────────────────────────────┘
```

## Quick Start (Local Dev)

```bash
# 1. Install dependencies
bun install

# 2. Set up environment
cp .env.example .env
# Edit .env — set DATABASE_URL (Neon), JWT_SECRET, ENCRYPTION_KEY

# 3. Push database schema
bun run db:push

# 4. Generate Prisma client
bun run db:generate

# 5. Start API server (port 3001)
bun run dev

# 6. (Optional) Run worker tick manually for testing
bun run worker
```

## Environment Variables

See `.env.example` for all required variables.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | Neon Postgres connection string |
| `JWT_SECRET` | ✅ | JWT signing secret (64 hex chars) |
| `ENCRYPTION_KEY` | ✅ | AES-256-GCM key for credential encryption |
| `FRONTEND_URL` | ✅ | Vercel frontend URL (for CORS) |
| `PUBLIC_BASE_URL` | ✅ | Frontend URL (for unsubscribe links) |
| `DEEPSEEK_API_KEY` | ⬜ | DeepSeek API key for reply sentiment tagging |
| `PORT` | Auto | Cloud Run sets this automatically |

## Generate Secrets

```bash
# JWT secret
openssl rand -hex 32

# Encryption key
openssl rand -hex 32
```

## Features

- **Auth**: JWT + bcrypt, credentials encrypted with AES-256-GCM
- **Account Manager**: SMTP/IMAP CRUD, test connectivity, pause/resume
- **Inbox Rotation**: Round-robin, daily (50-100) + hourly caps, failure auto-pause
- **Warm-up Engine**: Peer-to-peer, spam-folder rescue, auto-reply, ramp-up scheduler
- **Unibox**: Unified reply inbox, thread view, manual reply
- **Sequence Breaker**: Auto-cancel follow-ups on reply, detect unsubscribe/bounce/OOO
- **LLM Sentiment**: DeepSeek-powered reply classification (interested/not_interested/ooo/unsubscribe/neutral)
- **CAN-SPAM**: Unsubscribe footer + suppression list

## Deploy to Google Cloud Run

See `DEPLOYMENT.md` in the main project for complete step-by-step instructions.

Quick summary:
```bash
# Build & deploy API
gcloud run deploy cold-outreach-api \
  --source . --region us-central1 --port 8080 \
  --set-env-vars "DATABASE_URL=..." \
  --set-env-vars "JWT_SECRET=..." \
  --set-env-vars "ENCRYPTION_KEY=..." \
  --set-env-vars "FRONTEND_URL=https://your-app.vercel.app" \
  --allow-unauthenticated

# Create worker job
gcloud run jobs create cold-outreach-worker \
  --source . --region us-central1 \
  --command bun --args src/worker-job.ts \
  --set-env-vars "DATABASE_URL=..." (same as API)

# Schedule worker every 5 minutes
gcloud scheduler jobs create http cold-outreach-worker-trigger \
  --schedule "*/5 * * * *" \
  --uri "https://cold-outreach-worker-xxx-uc.a.run.app/run" \
  --http-method POST \
  --oauth-service-account-email PROJECT-number@cloudbuild.gserviceaccount.com
```

## Related

- **Frontend repo**: https://github.com/interiorvisualsd-maker/cold-outreach-frontend
- **Deployment guide**: See `DEPLOYMENT.md`
