import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { OtcPurchaseClient } from "@/components/over-the-counter/otc-purchase-client";
import { getOtcPurchaseContext, getOtcPurchaseHistory } from "./actions";

export const revalidate = 30;

export default async function OtcPurchasePage() {
  const [context, history] = await Promise.all([getOtcPurchaseContext(), getOtcPurchaseHistory()]);

  if (!context.dbReady || !history.dbReady) {
    return (
      <div className="flex flex-col">
        <PageHeader title="Over the Counter — Purchase" />
        <DbNotReady what="Over the Counter Purchase" />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Over the Counter — Purchase"
        description="Record a walk-in purchase from a vendor"
      />
      <div className="p-4 sm:p-6">
        <OtcPurchaseClient context={context} initialHistory={history.purchases} />
      </div>
    </div>
  );
}
