import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { FlowLogClient } from "@/components/inventory/flow-log-client";
import { getFlowLog } from "./actions";
import { getFlowDeadlines } from "@/lib/flow-deadlines";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// The window lives in the URL, like Rider Cash, so a day is linkable and the
// filtering happens in the query rather than over rows already sent.
export default async function FlowLogPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from, to } = await searchParams;
  const [data, deadlines, user] = await Promise.all([getFlowLog(from ?? "", to ?? ""), getFlowDeadlines(), getSessionUser()]);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Flow Log"
        description="The day from farm to customer, with the time of every step — milkings, sends to Retail, each rider going out and the leftover coming back."
      />
      {!data.dbReady ? (
        <DbNotReady what="Flow Log" />
      ) : (
        <FlowLogClient data={data} deadlines={deadlines} canEdit={user?.role === "ADMIN" || user?.role === "MANAGER"} />
      )}
    </div>
  );
}
