-- What the retail distribution centre had left at the end of a day, and how the
-- office split it into usable stock and wastage. Additive.
CREATE TABLE "RetailReturnReview" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "clientToken" TEXT,
    "reviewedById" TEXT,
    "reviewedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RetailReturnReview_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RetailReturnLine" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "leftoverQty" DECIMAL(10,3) NOT NULL,
    "stockQty" DECIMAL(10,3) NOT NULL,
    "wasteQty" DECIMAL(10,3) NOT NULL,
    "wasteReason" TEXT,
    CONSTRAINT "RetailReturnLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RetailReturnReview_date_key" ON "RetailReturnReview"("date");
CREATE UNIQUE INDEX "RetailReturnReview_clientToken_key" ON "RetailReturnReview"("clientToken");
CREATE INDEX "RetailReturnReview_date_idx" ON "RetailReturnReview"("date");
CREATE INDEX "RetailReturnLine_reviewId_idx" ON "RetailReturnLine"("reviewId");
CREATE INDEX "RetailReturnLine_productId_idx" ON "RetailReturnLine"("productId");

ALTER TABLE "RetailReturnReview" ADD CONSTRAINT "RetailReturnReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RetailReturnLine" ADD CONSTRAINT "RetailReturnLine_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "RetailReturnReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RetailReturnLine" ADD CONSTRAINT "RetailReturnLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
