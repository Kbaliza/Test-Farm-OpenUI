-- Where a customer's location pin actually is, read once from Customer.locationUrl.
-- Short links (maps.app.goo.gl) hide the coordinates behind a redirect, so the
-- answer is kept here rather than looked up on every page load; it is looked up
-- again only when the customer's link changes (sourceUrl no longer matches).
CREATE TABLE "CustomerPin" (
    "customerId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "error" TEXT,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerPin_pkey" PRIMARY KEY ("customerId")
);
ALTER TABLE "CustomerPin" ADD CONSTRAINT "CustomerPin_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- The office reads it through the website only; the apps have no business here.
ALTER TABLE "CustomerPin" ENABLE ROW LEVEL SECURITY;
