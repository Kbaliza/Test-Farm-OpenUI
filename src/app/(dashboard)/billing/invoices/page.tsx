import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { BillingClient } from "@/components/billing/billing-client";
import { getBillingOverview } from "./actions";
import { todayPKTString } from "@/lib/pkt";
import { getBillingLastDate } from "../billing-settings";

export const dynamic = "force-dynamic";

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; h?: string }>;
}) {
  const sp = await searchParams;
  const [ty, tm, td] = todayPKTString().split("-").map(Number);

  let year = ty, month = tm;
  if (sp.m && /^\d{4}-\d{2}$/.test(sp.m)) {
    const [y, m] = sp.m.split("-").map(Number);
    year = y; month = m;
  }
  const half = sp.h === "1" || sp.h === "2" ? Number(sp.h) : td <= 15 ? 1 : 2;

  const [data, savedLastDate] = await Promise.all([
    getBillingOverview(year, month, half),
    getBillingLastDate(),
  ]);

  // Only use the saved date if it belongs to the currently selected month.
  const selMonth = `${year}-${String(month).padStart(2, "0")}`;
  const initialLastDate = savedLastDate?.startsWith(selMonth) ? savedLastDate : undefined;

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Customer Bills"
        description="Generate 15-day invoices, track dues and carry forward balances"
      />
      {!data.dbReady ? (
        <DbNotReady what="Customer Bills" />
      ) : (
        <BillingClient data={data} initialLastDate={initialLastDate} />
      )}
    </div>
  );
}
