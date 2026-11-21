-- Optional per-task due time ("HH:MM", PKT). Nullable: existing tasks have none
-- and keep behaving exactly as before. Missing it never raises an alert — it only
-- colours the task red in the UI.
ALTER TABLE "ChecklistItem" ADD COLUMN "dueTime" TEXT;
