-- Money an owner put into the farm from their own pocket.
--
-- Purely additive: one new table, no existing row touched and no enum altered.
-- `owner` is a plain text column validated in the application against FARM_OWNERS
-- (src/lib/farm-owners.ts) rather than a Postgres enum, so adding a third partner
-- later needs no migration.
CREATE TABLE "OwnerContribution" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "owner" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerContribution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OwnerContribution_owner_idx" ON "OwnerContribution"("owner");
CREATE INDEX "OwnerContribution_date_idx" ON "OwnerContribution"("date");

ALTER TABLE "OwnerContribution" ADD CONSTRAINT "OwnerContribution_enteredById_fkey"
    FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
