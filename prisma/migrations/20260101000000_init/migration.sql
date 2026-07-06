-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedById" TEXT,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "InviteToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmtpAccount" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL,
    "smtpUser" TEXT NOT NULL,
    "smtpPassEnc" TEXT NOT NULL,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT true,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL,
    "imapUser" TEXT NOT NULL,
    "imapPassEnc" TEXT NOT NULL,
    "imapSecure" BOOLEAN NOT NULL DEFAULT true,
    "dailyCap" INTEGER NOT NULL DEFAULT 50,
    "hourlyCap" INTEGER NOT NULL DEFAULT 10,
    "warmupState" TEXT NOT NULL DEFAULT 'cold',
    "warmupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "warmupDay" INTEGER NOT NULL DEFAULT 0,
    "warmupTargetMax" INTEGER NOT NULL DEFAULT 20,
    "warmupStartQty" INTEGER NOT NULL DEFAULT 2,
    "warmupIncrement" INTEGER NOT NULL DEFAULT 2,
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "warmupSentToday" INTEGER NOT NULL DEFAULT 0,
    "failureStreak" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3),
    "lastResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDailyResetAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "provider" TEXT NOT NULL DEFAULT 'custom',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmtpAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "csvFilename" TEXT,
    "totalLeads" INTEGER NOT NULL DEFAULT 0,
    "sendingWindowStart" INTEGER NOT NULL DEFAULT 9,
    "sendingWindowEnd" INTEGER NOT NULL DEFAULT 17,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "fromNameOverride" TEXT,
    "allowedClickDomains" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailStep" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "delayDays" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "companyName" TEXT,
    "email" TEXT NOT NULL,
    "website" TEXT,
    "state" TEXT,
    "industry" TEXT,
    "outreachSubject" TEXT,
    "initialOutreach" TEXT,
    "followupDay3" TEXT,
    "followupDay7" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "lastStepSentAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "pausedUntil" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "verificationStatus" TEXT DEFAULT 'PENDING',
    "verificationMode" TEXT,
    "verificationReason" TEXT,
    "verificationChecks" TEXT,
    "verificationResults" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledEmail" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "smtpAccountId" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "assignedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "failureReason" TEXT,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "messageId" TEXT,
    "trackingId" TEXT,
    "openedAt" TIMESTAMP(3),
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "clickedAt" TIMESTAMP(3),
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "smtpAccountId" TEXT,
    "leadId" TEXT,
    "campaignId" TEXT,
    "toEmail" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "messageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT,
    "receivedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "isReply" BOOLEAN NOT NULL DEFAULT false,
    "isWarmup" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupMessage" (
    "id" TEXT NOT NULL,
    "fromAccountId" TEXT NOT NULL,
    "toAccountId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "threadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "rescuedAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarmupMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reply" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "messageId" TEXT,
    "inReplyTo" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "sentiment" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionList" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressionList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "InviteToken_token_key" ON "InviteToken"("token");

-- CreateIndex
CREATE INDEX "InviteToken_createdById_idx" ON "InviteToken"("createdById");

-- CreateIndex
CREATE INDEX "SmtpAccount_ownerId_idx" ON "SmtpAccount"("ownerId");

-- CreateIndex
CREATE INDEX "SmtpAccount_status_idx" ON "SmtpAccount"("status");

-- CreateIndex
CREATE INDEX "SmtpAccount_warmupState_idx" ON "SmtpAccount"("warmupState");

-- CreateIndex
CREATE INDEX "Campaign_ownerId_idx" ON "Campaign"("ownerId");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE INDEX "EmailStep_campaignId_idx" ON "EmailStep"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailStep_campaignId_stepNumber_key" ON "EmailStep"("campaignId", "stepNumber");

-- CreateIndex
CREATE INDEX "Lead_campaignId_status_idx" ON "Lead"("campaignId", "status");

-- CreateIndex
CREATE INDEX "Lead_email_idx" ON "Lead"("email");

-- CreateIndex
CREATE INDEX "Lead_verificationStatus_idx" ON "Lead"("verificationStatus");

-- CreateIndex
CREATE INDEX "Lead_ownerId_idx" ON "Lead"("ownerId");

-- CreateIndex
CREATE INDEX "Lead_pausedUntil_idx" ON "Lead"("pausedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_campaignId_email_key" ON "Lead"("campaignId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledEmail_trackingId_key" ON "ScheduledEmail"("trackingId");

-- CreateIndex
CREATE INDEX "ScheduledEmail_status_scheduledAt_idx" ON "ScheduledEmail"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledEmail_campaignId_idx" ON "ScheduledEmail"("campaignId");

-- CreateIndex
CREATE INDEX "ScheduledEmail_leadId_idx" ON "ScheduledEmail"("leadId");

-- CreateIndex
CREATE INDEX "ScheduledEmail_smtpAccountId_idx" ON "ScheduledEmail"("smtpAccountId");

-- CreateIndex
CREATE INDEX "ScheduledEmail_trackingId_idx" ON "ScheduledEmail"("trackingId");

-- CreateIndex
CREATE INDEX "ScheduledEmail_ownerId_idx" ON "ScheduledEmail"("ownerId");

-- CreateIndex
CREATE INDEX "EmailLog_leadId_idx" ON "EmailLog"("leadId");

-- CreateIndex
CREATE INDEX "EmailLog_smtpAccountId_idx" ON "EmailLog"("smtpAccountId");

-- CreateIndex
CREATE INDEX "EmailLog_campaignId_idx" ON "EmailLog"("campaignId");

-- CreateIndex
CREATE INDEX "EmailLog_messageId_idx" ON "EmailLog"("messageId");

-- CreateIndex
CREATE INDEX "EmailLog_ownerId_idx" ON "EmailLog"("ownerId");

-- CreateIndex
CREATE INDEX "WarmupMessage_status_scheduledAt_idx" ON "WarmupMessage"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "WarmupMessage_fromAccountId_idx" ON "WarmupMessage"("fromAccountId");

-- CreateIndex
CREATE INDEX "WarmupMessage_toAccountId_idx" ON "WarmupMessage"("toAccountId");

-- CreateIndex
CREATE INDEX "Reply_leadId_idx" ON "Reply"("leadId");

-- CreateIndex
CREATE INDEX "Reply_isRead_idx" ON "Reply"("isRead");

-- CreateIndex
CREATE INDEX "Reply_receivedAt_idx" ON "Reply"("receivedAt");

-- CreateIndex
CREATE INDEX "SuppressionList_email_idx" ON "SuppressionList"("email");

-- CreateIndex
CREATE INDEX "SuppressionList_ownerId_idx" ON "SuppressionList"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressionList_email_reason_key" ON "SuppressionList"("email", "reason");

-- CreateIndex
CREATE INDEX "Template_ownerId_idx" ON "Template"("ownerId");

-- CreateIndex
CREATE INDEX "Notification_ownerId_isRead_idx" ON "Notification"("ownerId", "isRead");

-- CreateIndex
CREATE INDEX "Notification_ownerId_createdAt_idx" ON "Notification"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "Webhook_ownerId_idx" ON "Webhook"("ownerId");

-- AddForeignKey
ALTER TABLE "InviteToken" ADD CONSTRAINT "InviteToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteToken" ADD CONSTRAINT "InviteToken_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmtpAccount" ADD CONSTRAINT "SmtpAccount_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailStep" ADD CONSTRAINT "EmailStep_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledEmail" ADD CONSTRAINT "ScheduledEmail_smtpAccountId_fkey" FOREIGN KEY ("smtpAccountId") REFERENCES "SmtpAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_smtpAccountId_fkey" FOREIGN KEY ("smtpAccountId") REFERENCES "SmtpAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupMessage" ADD CONSTRAINT "WarmupMessage_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "SmtpAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupMessage" ADD CONSTRAINT "WarmupMessage_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "SmtpAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuppressionList" ADD CONSTRAINT "SuppressionList_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Custom case-insensitive unique index on Lead(campaignId, LOWER(email)) ───
-- Postgres doesn't natively support case-insensitive @@unique via Prisma's
-- schema (the `length:` modifier is MySQL-only). This raw index enforces
-- dedupe at the DB level so "John@x.com" and "john@x.com" can't both exist
-- in the same campaign. All lead inserts normalize email to lowercase first
-- (see routes/csv.ts and any other lead-creation path).
CREATE UNIQUE INDEX "lead_campaign_email_ci"
  ON "Lead" ("campaignId", LOWER ("email"));
