-- Staff category (Agriculture / Retail / Farm). Nullable: existing staff stay "not set".
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "category" TEXT;
