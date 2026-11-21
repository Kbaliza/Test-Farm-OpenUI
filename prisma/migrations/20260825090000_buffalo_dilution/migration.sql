-- Cow milk stirred into buffalo milk to bring its fat down. Purely additive: a
-- farm that never records one is unaffected, and every existing row is untouched.
CREATE TABLE "BuffaloDilutionBatch" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pktDate" TEXT,
    "buffaloBase" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "cowMilkAdded" DECIMAL(12,3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuffaloDilutionBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BuffaloDilutionBatch_date_idx" ON "BuffaloDilutionBatch"("date");
CREATE INDEX "BuffaloDilutionBatch_pktDate_idx" ON "BuffaloDilutionBatch"("pktDate");
