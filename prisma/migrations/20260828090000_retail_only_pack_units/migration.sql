-- Bought-in goods we do not track stock for, and the pack units they are sold in.
--
-- Purely additive: every existing product becomes retailOnly = false with no pack
-- size, which is exactly today's behaviour, and no existing row is rewritten.
--
-- ALTER TYPE ... ADD VALUE is the same form already used and proven here by
-- 20260820190000_oncall_status_and_weekly_schedule. The new values are only
-- ADDED in this migration, never used by it, so there is no
-- "unsafe use of new value" problem.
ALTER TYPE "ProductUnit" ADD VALUE IF NOT EXISTS 'MILLILITER';
ALTER TYPE "ProductUnit" ADD VALUE IF NOT EXISTS 'GRAM';

ALTER TABLE "Product" ADD COLUMN "retailOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "packSize" DECIMAL(10,3);

-- Every hide-query filters on this flag.
CREATE INDEX "Product_retailOnly_idx" ON "Product"("retailOnly");

-- Snapshot on the drop line, so editing a product's pack size later cannot
-- rewrite what a past drop recorded.
ALTER TABLE "RetailPlacementLine" ADD COLUMN "packSize" DECIMAL(10,3);
