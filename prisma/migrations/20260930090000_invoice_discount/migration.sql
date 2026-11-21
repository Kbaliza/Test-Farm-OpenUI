-- A one-off allowance on a single bill.
--
-- For a delivery that went wrong and cannot be put right any other way: the
-- office types an amount, it comes off that bill's total and off what the
-- customer owes, and it does not carry into the next period.
ALTER TABLE "Invoice" ADD COLUMN "discount" DECIMAL(12,2) NOT NULL DEFAULT 0;
