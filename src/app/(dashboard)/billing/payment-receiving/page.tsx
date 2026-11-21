import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { PaymentReceivingClient } from "@/components/billing/payment-receiving-client";
import { getPageData } from "./actions";
import { getBillingLastDate } from "../billing-settings";

export const dynamic = "force-dynamic";

function parseMonthParam(m: string | undefined): { year: number; month: number } {
  if (m && /^\d{4}-\d{2}$/.test(m)) {
    const [y, mo] = m.split("-").map(Number);
    if (y >= 2020 && y <= 2100 && mo >= 1 && mo <= 12) return { year: y, month: mo };
  }
  const now = new Date(Date.now() + 5 * 60 * 60 * 1000); // PKT
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

export default async function PaymentReceivingPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const { m } = await searchParams;
  const { year, month } = parseMonthParam(m);

  const [data, savedLastDate] = await Promise.all([
    getPageData(month, year),
    getBillingLastDate(),
  ]);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Payment Receiving"
        description="Monthly billing overview: Track payments, call status, and head balances"
      />
      {!data.dbReady ? (
        <DbNotReady what="Payment Receiving" />
      ) : (
        <PaymentReceivingClient
          data={data}
          month={month}
          year={year}
          initialDate={savedLastDate ?? undefined}
        />
      )}
    </div>
  );
}
