import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { MonthlyExpensesClient } from "@/components/payments/monthly-expenses-client";
import { getMonthlyExpenses } from "../expenses/actions";
import { todayPKTString } from "@/lib/pkt";

export const dynamic = "force-dynamic";

export default async function MonthlyExpensesPage() {
  // Current month (PKT)
  const today = todayPKTString();
  const [year, month] = today.split("-").map(Number);
  const data = await getMonthlyExpenses(month, year);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Monthly Expenses"
        description="Budget against spend, by department, category and item — every expense for the month"
      />
      {!data.dbReady ? (
        <DbNotReady what="Monthly Expenses" />
      ) : (
        <MonthlyExpensesClient initial={data} today={today} />
      )}
    </div>
  );
}
