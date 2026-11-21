import { DbNotReady } from "@/components/db-not-ready";
import { SummaryReportClient } from "@/components/reports/summary-report-client";
import { getSummaryReport } from "./actions";
import { isValidDateStr, type ReportPeriod } from "@/lib/report-window";
import { todayPKTString } from "@/lib/pkt";

export const dynamic = "force-dynamic";

// Typography is plain Calibri now — see --sr-font in summary-report-styles.
// The three downloaded faces (Fraunces, Manrope, JetBrains Mono) are gone, so
// this page also stops fetching three webfonts it no longer uses.

export default async function SummaryReportPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string; d?: string }>;
}) {
  const sp = await searchParams;
  const period: ReportPeriod = sp.p === "week" || sp.p === "month" ? sp.p : "day";
  const dateStr = sp.d && isValidDateStr(sp.d) ? sp.d : todayPKTString();

  const data = await getSummaryReport(period, dateStr);

  if (!data.dbReady) {
    return <DbNotReady what="Summary Report" />;
  }

  return (
    <SummaryReportClient data={data} />
  );
}
