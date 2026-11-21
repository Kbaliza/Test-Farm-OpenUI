import { PageHeader } from "@/components/layout/page-header";
import { RiderSaleSummaryClient } from "@/components/customers/rider-sale-summary-client";
import { todayPKTString } from "@/lib/pkt";

export const dynamic = "force-dynamic";

export default function RiderSaleSummaryPage() {
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Rider Sale Summary"
        description="Shift-wise totals for a day — quantity delivered per product, sale, cash and net receivings"
      />
      <RiderSaleSummaryClient today={todayPKTString()} />
    </div>
  );
}
