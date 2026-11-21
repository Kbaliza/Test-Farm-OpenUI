-- On-call customers: served only when they phone in. The route builder loads
-- status = 'ACTIVE' only, so ON_CALL customers are never auto-added to a shift —
-- a manager adds them for the day from the route editor.
ALTER TYPE "CustomerStatus" ADD VALUE IF NOT EXISTS 'ON_CALL';

-- Specific-weekday subscriptions (third option beside DAILY and ALTERNATE).
ALTER TYPE "ScheduleType" ADD VALUE IF NOT EXISTS 'WEEKLY';

-- Weekdays a WEEKLY subscription delivers on: JS numbering, 0 = Sunday … 6 = Saturday.
-- Empty for every existing row, so DAILY/ALTERNATE behaviour is untouched.
ALTER TABLE "CustomerProduct"
  ADD COLUMN IF NOT EXISTS "weekdays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
