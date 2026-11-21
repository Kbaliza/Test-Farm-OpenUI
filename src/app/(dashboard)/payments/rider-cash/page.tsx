import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { RiderCashClient } from "@/components/payments/rider-cash-client";
import { getRiderCashData } from "./actions";

export const dynamic = "force-dynamic";

// The date window lives in the URL rather than in component state, so a filtered
// view can be linked, reloaded and shared — and so the filtering can happen in the
// query. Filtering in the browser only ever searched the rows already sent, and the
// default view caps settled history at ~30 days, so any older date looked empty.
export default async function RiderCashPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const data = await getRiderCashData({ from: sp.from, to: sp.to });

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Rider Cash"
        description="Cash collected by riders from customers (synced from the app). It stays with the rider until they hand it over and a manager confirms receipt — which is what moves it into the Rider Cash box."
      />
      {!data.dbReady ? (
        <DbNotReady what="Rider Cash" />
      ) : (
        <RiderCashClient data={data} />
      )}
    </div>
  );
}
