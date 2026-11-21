-- Customer Recovery: who we are trying to win back, and what has happened since.

CREATE TABLE "WinbackCase" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Not Contacted',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WinbackCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WinbackActivity" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "byId" TEXT,
    "byName" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WinbackActivity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WinbackCase_customerId_key" ON "WinbackCase"("customerId");
CREATE INDEX "WinbackActivity_caseId_at_idx" ON "WinbackActivity"("caseId", "at");

ALTER TABLE "WinbackCase" ADD CONSTRAINT "WinbackCase_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WinbackActivity" ADD CONSTRAINT "WinbackActivity_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "WinbackCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Off Supabase's public API, like complaints: Postgres grants anon and
-- authenticated SELECT on every new table in "public", so without this the call
-- notes would be readable with the app's public key. No policy is added, so those
-- roles see nothing; the app connects as the table owner and is unaffected.
ALTER TABLE "WinbackCase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WinbackActivity" ENABLE ROW LEVEL SECURITY;
