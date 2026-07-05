# Campaign Setup Guide — Step by Step

Follow these steps in order. Each step has what to do and what to expect.

---

## Step 1: Connect Your Sending Accounts

**Where:** Click **Sending Accounts** in the left sidebar.

1. Click **Add Account** (top right).
2. Fill in:
   - **Label:** Any name (e.g., "Hostinger 1")
   - **Email Address:** The address you'll send FROM (e.g., `you@yourdomain.com`)
   - **From Name:** The display name recipients see (e.g., "John Doe")
   - **SMTP Host:** `smtp.hostinger.com` (or your provider's)
   - **SMTP Port:** `465`
   - **SMTP User:** Your full email address
   - **SMTP Password:** Your email password
   - **IMAP Host:** `imap.hostinger.com`
   - **IMAP Port:** `993`
   - **IMAP User:** Your full email address
   - **IMAP Password:** Same as SMTP password
   - **Daily Cap:** `30` (start low — increase to 50-80 after a week of warmup)
   - **Hourly Cap:** `5` (never more than 10)
3. Click **Save**. The app auto-verifies SMTP + IMAP. You should see a green checkmark.
4. Repeat for each sending account. **Minimum 3 accounts** recommended.

**What to expect:** Each account shows as "Active" with a green dot.

---

## Step 2: Warm Up Your Accounts (CRITICAL — do NOT skip)

**Where:** Click **Warm-up** in the left sidebar.

1. For each account, click **Enable Warmup**.
2. Set:
   - **Start Qty:** `2` (emails per day to start)
   - **Increment:** `2` (add 2 more per day)
   - **Target Max:** `30` (stop ramping at 30/day)
3. Click **Save**.

**What to expect:** The warmup engine sends peer-to-peer emails between your accounts to build reputation. It takes **7-15 days** to reach "Warm" status. The badge on each account changes from `cold` → `heating` → `warm`.

**IMPORTANT:** Do NOT start a campaign until at least 3 accounts show **"warm"** status. Sending cold emails from un-warmed accounts will get you suspended.

---

## Step 3: Create a Campaign

**Where:** Click **Campaigns** in the left sidebar.

1. Click **New Campaign** (top right).
2. Fill in:
   - **Name:** e.g., "Q4 SaaS Founders"
   - **From Name Override:** (optional) Leave blank to use the account's from-name
   - **Sending Window Start:** `9` (9 AM)
   - **Sending Window End:** `17` (5 PM)
   - **Timezone:** Select the recipient's timezone (e.g., `America/New_York`)
4. Click **Create**.

**What to expect:** Campaign shows as "Draft" with 0 leads.

---

## Step 4: Write Your Email Sequence

**Where:** Open the campaign → scroll to **Sequence Steps**.

1. **Step 1 (Day 0 — Initial outreach):**
   - **Subject:** Your subject line. Use `|||` to add A/B/C variants:
     ```
     Quick question|||Hey {{first_name}}|||Saw your company
     ```
   - **Body:** Your email text. **This is sent EXACTLY as written** — no footer, no signature, no tracking pixel, no unsubscribe link. Just plain text like a phone email. Use `|||` for variants.
   - **Delay Days:** `0` (sends immediately when campaign starts)

2. **Step 2 (Day 3 — Follow-up):**
   - **Subject:** Leave as `Re: <original>` (auto-generated for natural threading)
   - **Body:** Your follow-up text
   - **Delay Days:** `3`

3. **Step 3 (Day 7 — Final follow-up):**
   - **Subject:** Leave as `Re: <original>`
   - **Body:** Your final text
   - **Delay Days:** `7`

4. Click **Save** on each step.

**What to expect:** 3 step cards appear, each showing the subject + body preview.

---

## Step 5: Prepare Your CSV

**Where:** Open a spreadsheet (Google Sheets, Excel, etc.)

Your CSV needs these columns (headers can be any name — the app auto-detects):

| company_name | emails | website | state | industry | outreach_subject | initial_outreach | followup_day3 | followup_day7 |
|---|---|---|---|---|---|---|---|---|
| Acme Corp | john@acme.com | acme.com | CA | SaaS | Quick question | Hi John, saw your site... | Just bumping this up | Last try — worth a chat? |

**Column meanings:**
- `company_name` — Company name (shown in leads table)
- `emails` — Recipient email (REQUIRED)
- `website`, `state`, `industry` — Metadata (optional)
- `outreach_subject` — Per-lead subject override (overrides step 1 subject)
- `initial_outreach` — Per-lead body override (overrides step 1 body)
- `followup_day3` — Per-lead body override for step 2
- `followup_day7` — Per-lead body override for step 3

**If you DON'T have per-lead overrides**, just include `company_name` + `emails` and the app will use the step defaults you wrote in Step 4.

**Save as CSV** (UTF-8 encoding).

---

## Step 6: Import Your CSV

**Where:** Click **Import Leads** in the left sidebar.

1. **Select Campaign:** Choose the campaign from Step 3.
2. **Upload CSV:** Drag your CSV file or click to browse.
3. Click **Parse CSV**. The app shows:
   - Detected columns + mapping
   - First 5 rows preview
   - Validation status (has email, has subject, has body)
4. Review the mapping. If a column is mapped wrong, fix it.
5. Click **Import X Leads**.

**What to expect:** The app runs **quick verification** on every email (format + disposable domain + MX records). Bad emails are auto-suppressed and skipped. You'll see:
- `Imported: 1,850`
- `Invalid: 50` (bad format, disposable, no MX)
- `Duplicates: 64`

**NOTE:** Role-based emails (info@, sales@, contact@) are NOT removed — they're allowed through since you might want to email them. Only confirmed-bad emails are suppressed.

---

## Step 7: Deep-Verify Emails (RECOMMENDED before first send)

**Where:** Open your campaign → click **Verify (Deep)** in the header.

1. Click **Verify (Deep)**.
2. Wait (it takes 1-5 seconds per email — the app connects to each recipient's mail server to check if the mailbox exists).
3. When done, you'll see a toast:
   ```
   Verification complete (deep)
   Scanned 1850 · valid 1700 · invalid 45 · warnings 105 · suppressed 45
   Invalid: mailbox_does_not_exist: 45
   Warnings: role_based: 105
   ```

**What this does:**
- ✅ Valid emails → stay as "pending" (ready to send)
- ❌ Confirmed-invalid emails (SMTP 550) → auto-suppressed + marked "bounced"
- ⚠️ Warnings (role-based, catch-all) → allowed through (just flagged)

**Only emails CONFIRMED as not deliverable are suppressed.** Unknown/greylisted/catch-all emails are NOT suppressed.

---

## Step 8: Set Up the Cron Worker

**Where:** Go to [cron-job.org](https://cron-job.org) (free) or any cron service.

1. Create a new cron job:
   - **URL:** `https://your-backend-url.com/api/cron/YOUR_CRON_SECRET`
   - **Method:** `POST`
   - **Schedule:** Every **5 minutes**
   - **Timeout:** 120 seconds
2. Save.

**What this does:** The cron hits your backend every 5 minutes. Each hit:
- Sends 1-3 emails (randomized, humanized)
- Checks for new replies/bounces
- Sends warmup emails
- Processes the queue

**Why 1-3 per tick?** This makes traffic look human. 1-3 emails every 5 minutes = 12-36 emails/hour = 60-180 emails/day (across all accounts). It's slow but safe.

---

## Step 9: Start the Campaign

**Where:** Open your campaign → click **Start** in the header.

1. Click **Start**.
2. Confirm.

**What to expect:**
- Campaign status changes to "Active"
- The cron worker picks up due emails on the next tick (within 5 min)
- Emails are sent 1-3 per tick, random accounts, random 10-45s delays between sends
- Each lead's status changes: `pending` → `step1_sent` → `step2_sent` → `step3_sent`
- The **Dispatcher** view shows the queue in real-time

---

## Step 10: Monitor the Unibox

**Where:** Click **Unibox** in the left sidebar.

**What to expect:**
- All replies appear here in real-time (via pub/sub notifications — no more 60s polling)
- The bell icon (top right) shows a green dot when real-time is connected
- When a lead replies:
  - Follow-ups are automatically cancelled (sequence breaker)
  - Lead status changes to "replied"
  - You see the reply in the Unibox
- When an email bounces:
  - The lead is auto-suppressed (added to Suppression List)
  - Lead status changes to "bounced"
  - You get a notification
  - The bounce shows in the Suppression page

---

## Step 11: Check the Suppression List

**Where:** Click **Suppression** in the left sidebar.

**What to expect:**
- Bounces, unsubscribes, and manually-suppressed emails all appear here
- If you see a yellow banner "X leads out of sync", click **Sync from Leads** to backfill
- You can manually add or remove suppression entries

---

## Daily Routine (after launch)

1. **Check the Unibox** — reply to interested leads within 2 hours
2. **Check the Suppression list** — see what bounced and why
3. **Check the Dashboard** — monitor sent/opened/replied rates
4. **Check Sending Accounts** — make sure none are suspended or in error state

## Troubleshooting

**No emails are sending:**
- Check the Dispatcher view — is the queue moving?
- Check Sending Accounts — are they all "active"? (not "error" or "suspended")
- Check the cron job — is it hitting your backend every 5 min?
- Check the sending window — is it within 9 AM - 5 PM in the campaign's timezone?

**Emails are bouncing:**
- Run **Verify (Deep)** to pre-check mailboxes
- Check that your sending accounts are "warm" (not cold/heating)
- Check that your daily cap isn't too high (start at 30/day per account)
- Check that you're not sending HTML emails (the app sends plain text only)

**Accounts getting suspended:**
- Lower your daily cap to 20-30 per account
- Make sure warmup is enabled and accounts are "warm" before sending
- Don't start campaigns from cold accounts — warm up for 7-15 days first
- Check that your email content doesn't trigger spam filters (no links, no HTML, no tracking pixels)
