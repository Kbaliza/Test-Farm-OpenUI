import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { OtcSaleClient } from "@/components/over-the-counter/otc-sale-client";
import { getOtcSaleContext, getOtcSaleHistory } from "./actions";

export const revalidate = 30;

export default async function OtcSalePage() {
  const [context, history] = await Promise.all([getOtcSaleContext(), getOtcSaleHistory()]);

  if (!context.dbReady || !history.dbReady) {
    return (
      <div className="flex flex-col">
        <PageHeader title="Over the Counter — Sale" />
        <DbNotReady what="Over the Counter Sale" />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Over the Counter — Sale"
        description="Record a walk-in, regular customer, or vendor sale"
      />
      <div className="p-4 sm:p-6">
        <OtcSaleClient context={context} initialHistory={history.sales} />
      </div>
    </div>
  );
}
