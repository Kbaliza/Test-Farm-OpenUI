import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { RiderReportClient } from "@/components/customers/rider-report-client";
import { getRiderReportContext } from "./actions";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function RiderReportPage({
  searchParams,
}: {
  searchParams: Promise<{ rider?: string; shift?: string; date?: string }>;
}) {
  const [ctx, sp, user] = await Promise.all([getRiderReportContext(), searchParams, getSessionUser()]);
  // Pre-select when linked from the Rider Sale Summary's Detail button.
  const initialDate = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : undefined;

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Rider Report"
        description="Pick a rider, shift and date to see who was delivered to, planned vs actual, cash and skipped stops"
      />
      {!ctx.dbReady ? (
        <DbNotReady what="Rider Report" />
      ) : (
        <RiderReportClient
          riders={ctx.riders}
          shifts={ctx.shifts}
          initialRiderId={sp.rider ?? ""}
          initialShiftId={sp.shift ?? ""}
          initialDate={initialDate}
          canEdit={user?.role === "ADMIN"}
          // Managers may edit too, but only within 24 hours of a shift ending.
          isManager={user?.role === "MANAGER"}
        />
      )}
    </div>
  );
}
