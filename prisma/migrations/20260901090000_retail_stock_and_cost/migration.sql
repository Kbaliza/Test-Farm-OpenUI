-- Bought-in goods get a real stock count, and a cost price to value losses with.
--
-- Purely additive: three nullable columns and one new table. No enum is touched,
-- no existing row is rewritten, and nothing reads any of it until the code that
-- follows lands. Dropping the table and the three columns restores every prior
-- figure exactly — which is the property worth having on this particular change,
-- and the reason a new InventoryMovementType was rejected: Postgres cannot drop
-- an enum value.

-- What ONE unit costs us — one PACK for products sold in packs. Nullable, not
-- DEFAULT 0: "nobody has set this" must render as "—", not report every loss as
-- costing nothing.
ALTER TABLE "Product" ADD COLUMN "costPrice" DECIMAL(10,2);

-- Money out of pocket on expired product, beside the existing wastedValue, which
-- keeps its meaning (the same quantity at the shop's selling rate). Null when any
-- expired line had no cost recorded.
ALTER TABLE "RetailResolution" ADD COLUMN "wastedCost" DECIMAL(12,2);
ALTER TABLE "RetailResolutionLine" ADD COLUMN "unitCost" DECIMAL(10,2);

-- The only inbound a bought-in good has. Quantity is always positive; a mistake
-- is voided, never negated.
CREATE TABLE "RetailStockEntry" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "note" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetailStockEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RetailStockEntry_productId_idx" ON "RetailStockEntry"("productId");
CREATE INDEX "RetailStockEntry_date_idx" ON "RetailStockEntry"("date");
CREATE INDEX "RetailStockEntry_voidedAt_idx" ON "RetailStockEntry"("voidedAt");

ALTER TABLE "RetailStockEntry" ADD CONSTRAINT "RetailStockEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RetailStockEntry" ADD CONSTRAINT "RetailStockEntry_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RetailStockEntry" ADD CONSTRAINT "RetailStockEntry_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
