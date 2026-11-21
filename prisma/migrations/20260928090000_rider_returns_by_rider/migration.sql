-- Returns are received from a rider, not from a shift.
--
-- Spare stock goes out to a rider and comes back in one lot, and the rider app
-- stamps only the rider and the time on an end-of-shift return — never a shift.
-- Keeping this per shift meant guessing which of his shifts a return belonged to.

-- A rider with two reviews on one day (one per shift) collapses to the newest;
-- there are none of these in production, where nothing has been reviewed yet.
DELETE FROM "RiderReturnReview" a
USING "RiderReturnReview" b
WHERE a."riderId" IS NOT NULL
  AND a."riderId" = b."riderId"
  AND a."date" = b."date"
  AND (a."createdAt" < b."createdAt" OR (a."createdAt" = b."createdAt" AND a.id < b.id));

-- A review with no rider on it cannot be filed against one.
DELETE FROM "RiderReturnReview" WHERE "riderId" IS NULL;

ALTER TABLE "RiderReturnReview" DROP CONSTRAINT IF EXISTS "RiderReturnReview_shiftId_fkey";
DROP INDEX IF EXISTS "RiderReturnReview_date_shiftId_key";
DROP INDEX IF EXISTS "RiderReturnReview_riderId_idx";
ALTER TABLE "RiderReturnReview" DROP COLUMN IF EXISTS "shiftId";
ALTER TABLE "RiderReturnReview" ALTER COLUMN "riderId" SET NOT NULL;
CREATE UNIQUE INDEX "RiderReturnReview_date_riderId_key" ON "RiderReturnReview"("date", "riderId");
