-- An optional remark against one checklist task on one day. Purely additive:
-- nothing existing is altered, and a day with no notes behaves exactly as before.
CREATE TABLE "ChecklistNote" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChecklistNote_pkey" PRIMARY KEY ("id")
);

-- One note per task per day, so a repeated save updates rather than duplicating.
CREATE UNIQUE INDEX "ChecklistNote_itemId_date_key" ON "ChecklistNote"("itemId", "date");
CREATE INDEX "ChecklistNote_date_idx" ON "ChecklistNote"("date");

ALTER TABLE "ChecklistNote" ADD CONSTRAINT "ChecklistNote_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "ChecklistItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChecklistNote" ADD CONSTRAINT "ChecklistNote_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
