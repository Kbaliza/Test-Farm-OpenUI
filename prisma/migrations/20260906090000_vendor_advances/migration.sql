-- Letting a vendor payment be more (or less) than what was owed.
--
-- Until now both directions were refused, because a surplus had nowhere to live:
-- the head was debited in full while only part landed on a bill, so the extra was
-- dropped on the floor. The surplus now becomes a credit on the OPPOSITE side —
-- overpay them and they owe us; they overpay us and we owe them — consumed with no
-- cash movement by the next real document on that side.
--
-- Purely additive. Every existing row defaults to TRADE with null links, so every
-- figure on every screen is byte-identical the moment this lands, and stays that
-- way until somebody actually overpays.
CREATE TYPE "VendorDocKind" AS ENUM ('TRADE', 'ADVANCE');

ALTER TABLE "VendorBill"       ADD COLUMN "kind" "VendorDocKind" NOT NULL DEFAULT 'TRADE';
ALTER TABLE "VendorBill"       ADD COLUMN "sourcePaymentId" TEXT;
ALTER TABLE "VendorReceivable" ADD COLUMN "kind" "VendorDocKind" NOT NULL DEFAULT 'TRADE';
ALTER TABLE "VendorReceivable" ADD COLUMN "sourceExpenseId" TEXT;
-- The mirror of Expense.vendorId. A vendor receipt had no link to the vendor at
-- all, which is why it could never be shown on their ledger or reversed.
ALTER TABLE "Payment"          ADD COLUMN "vendorId" TEXT;

-- Unique so one Expense/Payment can father at most one advance — that is what makes
-- reversing it exact rather than a guess.
CREATE UNIQUE INDEX "VendorBill_sourcePaymentId_key"       ON "VendorBill"("sourcePaymentId");
CREATE UNIQUE INDEX "VendorReceivable_sourceExpenseId_key" ON "VendorReceivable"("sourceExpenseId");
CREATE INDEX "VendorBill_vendorId_kind_idx"       ON "VendorBill"("vendorId", "kind");
CREATE INDEX "VendorReceivable_vendorId_kind_idx" ON "VendorReceivable"("vendorId", "kind");
CREATE INDEX "Payment_vendorId_idx"               ON "Payment"("vendorId");

ALTER TABLE "VendorBill" ADD CONSTRAINT "VendorBill_sourcePaymentId_fkey"
    FOREIGN KEY ("sourcePaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VendorReceivable" ADD CONSTRAINT "VendorReceivable_sourceExpenseId_fkey"
    FOREIGN KEY ("sourceExpenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
