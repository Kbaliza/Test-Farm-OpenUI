-- Which delivery each bill line was built from.
--
-- A bill is rebuilt from the live deliveries every time it is opened, so editing
-- a line's rate or quantity had no effect: the edit was written to the line and
-- overwritten by the rebuild a moment later. With this link the edit reaches the
-- delivery behind the line instead, and the rebuild then reproduces it.
--
-- A loose id rather than a foreign key on purpose: the line is a rebuilt copy of
-- the delivery, not a child of it, and deleting a delivery must not delete the
-- bill's record of it.
ALTER TABLE "InvoiceLine" ADD COLUMN "deliveryEntryId" TEXT;
CREATE INDEX "InvoiceLine_deliveryEntryId_idx" ON "InvoiceLine"("deliveryEntryId");
