-- What the office decided about a shift's returns: how much came back as usable
-- stock and how much was thrown away. Additive — nothing existing changes.
CREATE TABLE "RiderReturnReview" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "shiftId" TEXT NOT NULL,
    "riderId" TEXT,
    "notes" TEXT,
    "clientToken" TEXT,
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RiderReturnReview_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RiderReturnLine" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "extraItemId" TEXT,
    "returnedQty" DECIMAL(10,3) NOT NULL,
    "stockQty" DECIMAL(10,3) NOT NULL,
    "wasteQty" DECIMAL(10,3) NOT NULL,
    "wasteReason" TEXT,
    CONSTRAINT "RiderReturnLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RiderReturnReview_clientToken_key" ON "RiderReturnReview"("clientToken");
CREATE UNIQUE INDEX "RiderReturnReview_date_shiftId_key" ON "RiderReturnReview"("date", "shiftId");
CREATE INDEX "RiderReturnReview_date_idx" ON "RiderReturnReview"("date");
CREATE INDEX "RiderReturnReview_riderId_idx" ON "RiderReturnReview"("riderId");
CREATE INDEX "RiderReturnLine_reviewId_idx" ON "RiderReturnLine"("reviewId");
CREATE INDEX "RiderReturnLine_productId_idx" ON "RiderReturnLine"("productId");

ALTER TABLE "RiderReturnReview" ADD CONSTRAINT "RiderReturnReview_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RiderReturnReview" ADD CONSTRAINT "RiderReturnReview_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RiderReturnReview" ADD CONSTRAINT "RiderReturnReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RiderReturnLine" ADD CONSTRAINT "RiderReturnLine_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "RiderReturnReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiderReturnLine" ADD CONSTRAINT "RiderReturnLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
