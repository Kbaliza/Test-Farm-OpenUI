-- Who ticked each checklist item. Nullable on purpose: rows ticked before this
-- column existed have no recorded actor, and a deleted user must not delete the
-- audit row (ON DELETE SET NULL).
ALTER TABLE "ChecklistCompletion" ADD COLUMN IF NOT EXISTS "doneById" TEXT;

CREATE INDEX IF NOT EXISTS "ChecklistCompletion_doneById_idx" ON "ChecklistCompletion"("doneById");

-- Drop-then-add so the migration stays re-runnable without a DO block.
ALTER TABLE "ChecklistCompletion" DROP CONSTRAINT IF EXISTS "ChecklistCompletion_doneById_fkey";
ALTER TABLE "ChecklistCompletion"
  ADD CONSTRAINT "ChecklistCompletion_doneById_fkey"
  FOREIGN KEY ("doneById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
