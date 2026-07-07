-- CreateTable
CREATE TABLE "ProviderQuota" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "quotaType" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderQuota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderQuota_ownerId_provider_quotaType_periodStart_key" ON "ProviderQuota"("ownerId", "provider", "quotaType", "periodStart");

-- CreateIndex
CREATE INDEX "ProviderQuota_ownerId_provider_idx" ON "ProviderQuota"("ownerId", "provider");

-- CreateIndex
CREATE INDEX "ProviderQuota_periodStart_idx" ON "ProviderQuota"("periodStart");

-- AddForeignKey
ALTER TABLE "ProviderQuota" ADD CONSTRAINT "ProviderQuota_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
