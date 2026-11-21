import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { BudgetsClient } from "@/components/payments/budgets-client";
import { getMonthlyExpenses } from "../expenses/actions";
import { todayPKTString } from "@/lib/pkt";

export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
  // Current month (PKT)
  const [year, month] = todayPKTString().split("-").map(Number);
  const data = await getMonthlyExpenses(month, year);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Budgets"
        description="Set each expense category's monthly limit — tracked on the dashboard and Monthly Expenses"
      />
      {!data.dbReady ? (
        <DbNotReady what="Budgets" />
      ) : (
        <BudgetsClient initial={data} />
      )}
    </div>
  );
}
