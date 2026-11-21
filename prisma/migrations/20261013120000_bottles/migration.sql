-- Glass bottles: which shifts use them, what customers hand back, office corrections.
ALTER TABLE "Shift" ADD COLUMN "bottlesSince" TIMESTAMP(3);

CREATE TABLE "BottleReturn" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT NOT NULL,
    "riderId" TEXT,
    "routeId" TEXT,
    "returned" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'web',
    "note" TEXT,
    "enteredById" TEXT,
    "enteredByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BottleReturn_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BottleReturn_customerId_date_key" ON "BottleReturn"("customerId", "date");
CREATE INDEX "BottleReturn_date_idx" ON "BottleReturn"("date");
CREATE INDEX "BottleReturn_riderId_date_idx" ON "BottleReturn"("riderId", "date");
ALTER TABLE "BottleReturn" ADD CONSTRAINT "BottleReturn_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BottleReturn" ADD CONSTRAINT "BottleReturn_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "BottleAdjustment" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT NOT NULL,
    "bottles" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "enteredById" TEXT,
    "enteredByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BottleAdjustment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BottleAdjustment_customerId_date_idx" ON "BottleAdjustment"("customerId", "date");
ALTER TABLE "BottleAdjustment" ADD CONSTRAINT "BottleAdjustment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Off Supabase's public API: the rider app goes through /api/rider/bottles, which
-- checks the rider owns the shift. Without this, anon/authenticated could read and
-- write every customer's bottle rows with the app's public key.
ALTER TABLE "BottleReturn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BottleAdjustment" ENABLE ROW LEVEL SECURITY;
