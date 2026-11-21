-- Retail marts (consignment): shops that take our product on trust, report what
-- sold and what expired, then pay for the sold part.
--
-- Purely additive. No enum is changed, no existing row is touched, and this
-- module writes no InventoryMovement at all - stock leaves through a derived
-- term that reads "RetailPlacementLine".quantity. Dropping these tables restores
-- every prior figure exactly.

CREATE TABLE "RetailVendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "managerName" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "areaName" TEXT,
    "city" TEXT,
    "notes" TEXT,
    "followUpDays" INTEGER NOT NULL DEFAULT 3,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RetailVendor_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RetailVendor_name_key" ON "RetailVendor"("name");
CREATE INDEX "RetailVendor_active_idx" ON "RetailVendor"("active");
CREATE INDEX "RetailVendor_city_idx" ON "RetailVendor"("city");

CREATE TABLE "RetailPlacement" (
    "id" TEXT NOT NULL,
    "placementNo" TEXT NOT NULL,
    "retailVendorId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "followUpAt" TIMESTAMP(3),
    "notes" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RetailPlacement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RetailPlacement_placementNo_key" ON "RetailPlacement"("placementNo");
CREATE INDEX "RetailPlacement_retailVendorId_idx" ON "RetailPlacement"("retailVendorId");
CREATE INDEX "RetailPlacement_date_idx" ON "RetailPlacement"("date");
CREATE INDEX "RetailPlacement_voidedAt_idx" ON "RetailPlacement"("voidedAt");

CREATE TABLE "RetailPlacementLine" (
    "id" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "soldQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "wastedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    CONSTRAINT "RetailPlacementLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RetailPlacementLine_placementId_idx" ON "RetailPlacementLine"("placementId");
CREATE INDEX "RetailPlacementLine_productId_idx" ON "RetailPlacementLine"("productId");

CREATE TABLE "RetailReceivable" (
    "id" TEXT NOT NULL,
    "retailVendorId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" DECIMAL(12,2) NOT NULL,
    "received" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RetailReceivable_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RetailReceivable_retailVendorId_idx" ON "RetailReceivable"("retailVendorId");
CREATE INDEX "RetailReceivable_date_idx" ON "RetailReceivable"("date");

CREATE TABLE "RetailResolution" (
    "id" TEXT NOT NULL,
    "resolutionNo" TEXT NOT NULL,
    "placementId" TEXT NOT NULL,
    "retailVendorId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "soldAmount" DECIMAL(12,2) NOT NULL,
    "wastedValue" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "receivableId" TEXT,
    "clientToken" TEXT,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RetailResolution_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RetailResolution_resolutionNo_key" ON "RetailResolution"("resolutionNo");
CREATE UNIQUE INDEX "RetailResolution_receivableId_key" ON "RetailResolution"("receivableId");
CREATE UNIQUE INDEX "RetailResolution_clientToken_key" ON "RetailResolution"("clientToken");
CREATE INDEX "RetailResolution_placementId_idx" ON "RetailResolution"("placementId");
CREATE INDEX "RetailResolution_retailVendorId_idx" ON "RetailResolution"("retailVendorId");
CREATE INDEX "RetailResolution_date_idx" ON "RetailResolution"("date");

CREATE TABLE "RetailResolutionLine" (
    "id" TEXT NOT NULL,
    "resolutionId" TEXT NOT NULL,
    "placementLineId" TEXT NOT NULL,
    "soldQty" DECIMAL(12,3) NOT NULL,
    "wastedQty" DECIMAL(12,3) NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "RetailResolutionLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RetailResolutionLine_resolutionId_idx" ON "RetailResolutionLine"("resolutionId");
CREATE INDEX "RetailResolutionLine_placementLineId_idx" ON "RetailResolutionLine"("placementLineId");

CREATE TABLE "RetailPayment" (
    "id" TEXT NOT NULL,
    "retailVendorId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" DECIMAL(12,2) NOT NULL,
    "head" "PaymentHead" NOT NULL,
    "paymentId" TEXT NOT NULL,
    "notes" TEXT,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RetailPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RetailPayment_paymentId_key" ON "RetailPayment"("paymentId");
CREATE INDEX "RetailPayment_retailVendorId_idx" ON "RetailPayment"("retailVendorId");
CREATE INDEX "RetailPayment_date_idx" ON "RetailPayment"("date");

-- A straight counter sale to a mart (not a consignment drop).
ALTER TABLE "OtcSale" ADD COLUMN "retailVendorId" TEXT;
ALTER TABLE "OtcSale" ADD COLUMN "retailReceivableId" TEXT;
CREATE UNIQUE INDEX "OtcSale_retailReceivableId_key" ON "OtcSale"("retailReceivableId");
CREATE INDEX "OtcSale_retailVendorId_idx" ON "OtcSale"("retailVendorId");

-- Foreign keys. Cascade from a placement or resolution to its own lines; RESTRICT
-- to anything shared (a mart, a product, a payment) so history cannot be orphaned;
-- SET NULL to User, matching ChecklistNote_authorId_fkey.
ALTER TABLE "RetailPlacement" ADD CONSTRAINT "RetailPlacement_retailVendorId_fkey" FOREIGN KEY ("retailVendorId") REFERENCES "RetailVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RetailPlacement" ADD CONSTRAINT "RetailPlacement_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RetailPlacement" ADD CONSTRAINT "RetailPlacement_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RetailPlacementLine" ADD CONSTRAINT "RetailPlacementLine_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "RetailPlacement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RetailPlacementLine" ADD CONSTRAINT "RetailPlacementLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RetailReceivable" ADD CONSTRAINT "RetailReceivable_retailVendorId_fkey" FOREIGN KEY ("retailVendorId") REFERENCES "RetailVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RetailResolution" ADD CONSTRAINT "RetailResolution_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "RetailPlacement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RetailResolution" ADD CONSTRAINT "RetailResolution_retailVendorId_fkey" FOREIGN KEY ("retailVendorId") REFERENCES "RetailVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RetailResolution" ADD CONSTRAINT "RetailResolution_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "RetailReceivable"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RetailResolution" ADD CONSTRAINT "RetailResolution_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RetailResolutionLine" ADD CONSTRAINT "RetailResolutionLine_resolutionId_fkey" FOREIGN KEY ("resolutionId") REFERENCES "RetailResolution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RetailResolutionLine" ADD CONSTRAINT "RetailResolutionLine_placementLineId_fkey" FOREIGN KEY ("placementLineId") REFERENCES "RetailPlacementLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RetailPayment" ADD CONSTRAINT "RetailPayment_retailVendorId_fkey" FOREIGN KEY ("retailVendorId") REFERENCES "RetailVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RetailPayment" ADD CONSTRAINT "RetailPayment_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RetailPayment" ADD CONSTRAINT "RetailPayment_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OtcSale" ADD CONSTRAINT "OtcSale_retailVendorId_fkey" FOREIGN KEY ("retailVendorId") REFERENCES "RetailVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OtcSale" ADD CONSTRAINT "OtcSale_retailReceivableId_fkey" FOREIGN KEY ("retailReceivableId") REFERENCES "RetailReceivable"("id") ON DELETE SET NULL ON UPDATE CASCADE;
