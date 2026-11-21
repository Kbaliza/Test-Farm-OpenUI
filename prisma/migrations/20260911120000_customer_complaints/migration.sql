-- Customer complaints (Daily Notes → Complaints).
--
-- Purely additive: one enum, one table, and one nullable column on DeliveryEntry.
-- No existing row is changed.
--
-- A refund or replacement is NOT stored on the complaint. It is written as a
-- DeliveryEntry (isReturn / isReplacement) carrying "complaintId", because that is
-- what every bill, balance, ledger and the customer app already read — so the
-- credit reaches all of them at once. The column is also how the stock trigger
-- (supabase/returns-sync-trigger.sql) and the rider screens tell a complaint
-- credit apart from milk a rider really brought back.

CREATE TYPE "ComplaintResolution" AS ENUM ('REFUND', 'REPLACEMENT', 'NONE');

CREATE TABLE "CustomerComplaint" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "shiftId" TEXT,
    "deliveryDate" TIMESTAMP(3) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "resolution" "ComplaintResolution" NOT NULL,
    "productId" TEXT,
    "quantity" DECIMAL(10,3),
    "rate" DECIMAL(10,2),
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "enteredById" TEXT,
    "enteredByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerComplaint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomerComplaint_customerId_deliveryDate_idx" ON "CustomerComplaint"("customerId", "deliveryDate");
CREATE INDEX "CustomerComplaint_date_idx" ON "CustomerComplaint"("date");

ALTER TABLE "CustomerComplaint" ADD CONSTRAINT "CustomerComplaint_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerComplaint" ADD CONSTRAINT "CustomerComplaint_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerComplaint" ADD CONSTRAINT "CustomerComplaint_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerComplaint" ADD CONSTRAINT "CustomerComplaint_enteredById_fkey"
    FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Nullable with no default: adding it rewrites nothing, and every existing row is
-- simply "not a complaint".
ALTER TABLE "DeliveryEntry" ADD COLUMN "complaintId" TEXT;

-- One credit row per complaint. Deleting the complaint deletes that row, which
-- undoes the refund on every bill and balance in the same statement.
CREATE UNIQUE INDEX "DeliveryEntry_complaintId_key" ON "DeliveryEntry"("complaintId");
ALTER TABLE "DeliveryEntry" ADD CONSTRAINT "DeliveryEntry_complaintId_fkey"
    FOREIGN KEY ("complaintId") REFERENCES "CustomerComplaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep complaints off Supabase's public API. Postgres grants the anon and
-- authenticated roles SELECT on every new table in "public", so without this the
-- table would be readable with the app's public key. No policy is added, so those
-- roles see nothing; the app connects as the table owner and is unaffected.
ALTER TABLE "CustomerComplaint" ENABLE ROW LEVEL SECURITY;
