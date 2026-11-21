import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { ExpensesClient } from "@/components/payments/expenses-client";
import { getExpensesPageData } from "./actions";

export const dynamic = "force-dynamic";

export default async function ExpensesPage() {
  const data = await getExpensesPageData();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Daily Expenses"
        description="Log expenses, track payment heads, and monitor budgets"
      />
      {!data.dbReady ? (
        <DbNotReady what="Expenses" />
      ) : (
        <ExpensesClient
          initialData={{
            categories:             data.categories,
            headBalances:           data.headBalances,
            recentExpenses:         data.recentExpenses,
            budgetRows:             data.budgetRows,
            employees:              data.employees,
            vendors:                data.vendors,
            riders:                 data.riders,
            salaryCategoryId:       data.salaryCategoryId,
            vendorPaymentCategoryId: data.vendorPaymentCategoryId,
            riderCategoryId:        data.riderCategoryId,
            extraItems:             data.extraItems,
          }}
        />
      )}
    </div>
  );
}
