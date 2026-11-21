-- Budgets per item inside a category ("" = the whole category, which is every
-- budget set before this).
ALTER TABLE "MonthlyBudget" ADD COLUMN "item" TEXT NOT NULL DEFAULT '';
DROP INDEX "MonthlyBudget_categoryId_month_year_key";
CREATE UNIQUE INDEX "MonthlyBudget_categoryId_item_month_year_key" ON "MonthlyBudget"("categoryId", "item", "month", "year");
