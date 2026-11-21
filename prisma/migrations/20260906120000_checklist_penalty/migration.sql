-- Rs 300 off the day when somebody does under 70% of their checklist.
--
-- The score is MATERIALISED per day rather than computed when the salary page is
-- opened, and that is a correctness requirement, not a speed one:
-- ChecklistCompletion is pruned after 60 days, and editing a checklist changes its
-- item count — so a past day's percentage cannot be recomputed later. It would
-- silently come back as 0% and fine everybody. It has to be written down while it
-- is still knowable.
--
-- Purely additive: one new table, nothing existing touched.
CREATE TABLE "ChecklistPenalty" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- Nullable: a checklist belongs to a User, and only some Users have a staff
    -- record. Those rows are still written so the shortfall is visible, but nothing
    -- is deducted from a salary that does not exist.
    "employeeId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "itemsTotal" INTEGER NOT NULL,
    "itemsDone" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "waivedAt" TIMESTAMP(3),
    "waivedById" TEXT,
    "waiveReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChecklistPenalty_pkey" PRIMARY KEY ("id")
);

-- One row per person per day, so the reconciler can run as often as it likes.
CREATE UNIQUE INDEX "ChecklistPenalty_userId_date_key" ON "ChecklistPenalty"("userId", "date");
CREATE INDEX "ChecklistPenalty_employeeId_date_idx" ON "ChecklistPenalty"("employeeId", "date");
CREATE INDEX "ChecklistPenalty_date_idx" ON "ChecklistPenalty"("date");

ALTER TABLE "ChecklistPenalty" ADD CONSTRAINT "ChecklistPenalty_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChecklistPenalty" ADD CONSTRAINT "ChecklistPenalty_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
