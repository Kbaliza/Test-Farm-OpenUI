-- Selling things that are not milk: an animal, a machine, feed, scrap.
--
-- Purely additive: two new tables, no existing row touched, no column dropped and
-- no enum altered. Payment gains only a Prisma back-relation (the FK lives here on
-- FarmSale), so that table is not modified at all.
--
-- Deliberately NOT folded into OtcSale: that model requires a real Product and a
-- milk Unit, and every revenue figure in the app reads it. A farm sale is an asset
-- disposal and is reported separately.
--
-- `buyerType`, `category` and `unit` are plain TEXT validated in the application
-- (src/lib/farm-sale-catalog.ts) rather than Postgres enums, the same choice
-- OtcSale.customerType made — extending needs no migration.
CREATE TABLE "FarmSale" (
    "id" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "buyerType" TEXT NOT NULL,
    "vendorId" TEXT,
    "cashName" TEXT,
    "transportCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "gatePassNo" TEXT,
    "narration" TEXT,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "paymentHead" TEXT NOT NULL,
    "paymentId" TEXT,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FarmSale_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FarmSaleLine" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "animalTag" TEXT,
    "details" JSONB,

    CONSTRAINT "FarmSaleLine_pkey" PRIMARY KEY ("id")
);

-- invoiceNo is unique so the FSAL-#### sequence cannot double-issue under a race;
-- paymentId is unique so a Payment belongs to at most one sale, which is what makes
-- the `farmSale: null` exclusion on the dashboard exact.
CREATE UNIQUE INDEX "FarmSale_invoiceNo_key" ON "FarmSale"("invoiceNo");
CREATE UNIQUE INDEX "FarmSale_paymentId_key" ON "FarmSale"("paymentId");
CREATE INDEX "FarmSale_date_idx" ON "FarmSale"("date");
CREATE INDEX "FarmSale_vendorId_idx" ON "FarmSale"("vendorId");
CREATE INDEX "FarmSaleLine_saleId_idx" ON "FarmSaleLine"("saleId");
-- Indexed so a future herd register can ask "which sale did tag 447 leave on".
CREATE INDEX "FarmSaleLine_animalTag_idx" ON "FarmSaleLine"("animalTag");

ALTER TABLE "FarmSale" ADD CONSTRAINT "FarmSale_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FarmSale" ADD CONSTRAINT "FarmSale_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FarmSale" ADD CONSTRAINT "FarmSale_enteredById_fkey"
    FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FarmSaleLine" ADD CONSTRAINT "FarmSaleLine_saleId_fkey"
    FOREIGN KEY ("saleId") REFERENCES "FarmSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
