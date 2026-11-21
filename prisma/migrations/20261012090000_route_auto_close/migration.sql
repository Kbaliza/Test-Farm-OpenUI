-- Day-end close: when the website completed a round the rider never ended.
ALTER TABLE "Route" ADD COLUMN "autoClosedAt" TIMESTAMP(3);
