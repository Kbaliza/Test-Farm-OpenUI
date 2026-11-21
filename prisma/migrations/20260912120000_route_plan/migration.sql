-- Planning a FUTURE day in the shift editor, without handing it to the rider.
--
-- Deliberately NOT a Route row. Route is what the rider's mobile app reads, and its
-- row-level policies are scoped by SHIFT, not by date (see supabase/rider_rls.sql):
-- a route dated tomorrow is therefore readable on a rider's phone today. Saving
-- tomorrow as a Route would hand out the round a day early, which is exactly what
-- this feature must not do.
--
-- A plan is a different table that riders have no access to at all, and it becomes
-- the real route only when someone presses "Save route" on the day itself.
--
-- Purely additive: one new table. Nothing existing is touched.

CREATE TABLE "RoutePlan" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    -- PKT noon of the day being planned, the same canonical key Route.date uses.
    "date" TIMESTAMP(3) NOT NULL,
    -- [{ customerId, stopNumber, products: [{ productId, quantity }] }]
    -- Held as JSON rather than as stop/item tables: a plan is a short-lived draft
    -- for one day, it is rewritten whole on every save, and nothing else ever joins
    -- to it. The reader drops anything that no longer exists.
    "stops" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutePlan_pkey" PRIMARY KEY ("id")
);

-- One plan per shift per day, matching Route's own key.
CREATE UNIQUE INDEX "RoutePlan_date_shiftId_key" ON "RoutePlan"("date", "shiftId");
CREATE INDEX "RoutePlan_date_idx" ON "RoutePlan"("date");

ALTER TABLE "RoutePlan" ADD CONSTRAINT "RoutePlan_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoutePlan" ADD CONSTRAINT "RoutePlan_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Keep plans off Supabase's public API. Postgres grants anon and authenticated
-- SELECT on every new table in "public", and riders authenticate against exactly
-- that API — so without this a plan would be readable on a rider's phone, which is
-- the whole thing this table exists to prevent. No policy is added, so those roles
-- see nothing; the app connects as the table owner and is unaffected.
ALTER TABLE "RoutePlan" ENABLE ROW LEVEL SECURITY;
