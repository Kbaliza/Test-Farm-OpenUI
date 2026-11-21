-- The path each rider took: a point whenever the phone has moved a little since
-- the last one kept (rider-location-keeper). Riders live draws it as a line, and
-- the first point after a round starts marks where it started. Kept 30 days.
CREATE TABLE "RiderTrackPoint" (
    "id" BIGSERIAL NOT NULL,
    "riderId" TEXT NOT NULL,
    "routeId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RiderTrackPoint_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RiderTrackPoint_riderId_at_idx" ON "RiderTrackPoint"("riderId", "at");
CREATE INDEX "RiderTrackPoint_at_idx" ON "RiderTrackPoint"("at");
ALTER TABLE "RiderTrackPoint" ADD CONSTRAINT "RiderTrackPoint_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Written and read by the web server only; the apps have no business here.
ALTER TABLE "RiderTrackPoint" ENABLE ROW LEVEL SECURITY;
