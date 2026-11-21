-- The last position each rider's phone broadcast, one row per rider. The web
-- server listens on the riders' Realtime channels and keeps this up to date, so
-- the Riders live map can show where a rider was the moment it is opened instead
-- of waiting for the phone's next point. Only the latest point is kept.
CREATE TABLE "RiderLocation" (
    "riderId" TEXT NOT NULL,
    "routeId" TEXT,
    "shiftId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "bearing" DOUBLE PRECISION,
    "at" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RiderLocation_pkey" PRIMARY KEY ("riderId")
);
ALTER TABLE "RiderLocation" ADD CONSTRAINT "RiderLocation_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Written and read by the web server only; the apps have no business here.
ALTER TABLE "RiderLocation" ENABLE ROW LEVEL SECURITY;
