-- Extra items the rider takes, saved with a future day's plan (additive).
ALTER TABLE "RoutePlan" ADD COLUMN "extras" JSONB NOT NULL DEFAULT '[]';
