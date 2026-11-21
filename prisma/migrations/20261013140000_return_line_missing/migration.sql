-- A reviewer can now say part of what the rider's app reported as returned was
-- never handed over. Every existing line accounted for all of it.
ALTER TABLE "RiderReturnLine" ADD COLUMN "missingQty" DECIMAL(10,3) NOT NULL DEFAULT 0;
