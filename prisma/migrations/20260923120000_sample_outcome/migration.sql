-- Samples: a "not delivered" status, what the rider reports, how it was paid, and
-- the time a sample was last put on a run (so a resend waits for the NEXT run).
ALTER TYPE "SampleStatus" ADD VALUE IF NOT EXISTS 'NOT_DELIVERED';

ALTER TABLE "SampleLead" ADD COLUMN IF NOT EXISTS "assignedAt" TIMESTAMP(3);
ALTER TABLE "SampleLead" ADD COLUMN IF NOT EXISTS "riderOutcome" TEXT;
ALTER TABLE "SampleLead" ADD COLUMN IF NOT EXISTS "riderOutcomeAt" TIMESTAMP(3);
ALTER TABLE "SampleLead" ADD COLUMN IF NOT EXISTS "notDeliveredReason" TEXT;
ALTER TABLE "SampleLead" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT;

-- Samples already resent and still waiting: anchor them at their last change (the
-- resend), so the run that delivered them the first time no longer matches.
UPDATE "SampleLead" SET "assignedAt" = "updatedAt"
WHERE "resendCount" > 0 AND "status" = 'ASSIGNED' AND "assignedAt" IS NULL;

-- A resent sample delivered again is charged again: one payment per sample per
-- delivery round (its resendCount), instead of one per sample per account.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "sampleRound" INTEGER;
UPDATE "Payment" SET "sampleRound" = 0 WHERE "sampleId" IS NOT NULL AND "sampleRound" IS NULL;
DROP INDEX IF EXISTS "Payment_sampleId_head_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_sampleId_sampleRound_key" ON "Payment"("sampleId", "sampleRound");
