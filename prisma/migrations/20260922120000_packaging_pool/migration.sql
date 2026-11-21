-- Packaging accepts a production load into its own stock, and sends to Retail as a
-- separate step. acceptedAt marks loads accepted that way. Nullable: old loads unchanged.
ALTER TABLE "FarmDispatch" ADD COLUMN IF NOT EXISTS "acceptedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "FarmDispatch_acceptedAt_idx" ON "FarmDispatch"("acceptedAt");
