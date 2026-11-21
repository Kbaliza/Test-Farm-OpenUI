-- Several photos per expense instead of one.
--
-- A chit is often two or three pages, and Expense.chitImageUrl could only hold the
-- first. The existing photos are copied across BEFORE the column is dropped, in
-- this one transaction, so nothing is lost even if the deploy fails afterwards.
CREATE TABLE "ExpenseChit" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseChit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExpenseChit_expenseId_idx" ON "ExpenseChit"("expenseId");

ALTER TABLE "ExpenseChit" ADD CONSTRAINT "ExpenseChit_expenseId_fkey"
    FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry every existing photo over. `bytes` stays 0: the real size was never
-- recorded for these, and a migrated row is never re-validated against the cap.
INSERT INTO "ExpenseChit" ("id", "expenseId", "url", "bytes", "createdAt")
SELECT gen_random_uuid()::text, "id", "chitImageUrl", 0, "createdAt"
FROM "Expense"
WHERE "chitImageUrl" IS NOT NULL AND "chitImageUrl" <> '';

ALTER TABLE "Expense" DROP COLUMN "chitImageUrl";
