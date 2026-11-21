import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { FarmSalesClient } from "@/components/over-the-counter/farm-sales-client";
import { getFarmSalesContext, getFarmSalesHistory } from "./actions";

export const revalidate = 30;

export default async function FarmSalesPage() {
  const [context, history] = await Promise.all([getFarmSalesContext(), getFarmSalesHistory()]);

  if (!context.dbReady || !history.dbReady) {
    return (
      <div className="flex flex-col">
        <PageHeader title="Farm Sales" />
        <DbNotReady what="Farm Sales" />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Farm Sales"
        description="Sell an animal, machinery, feed or scrap — paid in full, no stock is deducted"
      />
      <div className="p-4 sm:p-6">
        <FarmSalesClient context={context} initialHistory={history.sales} />
      </div>
    </div>
  );
}
