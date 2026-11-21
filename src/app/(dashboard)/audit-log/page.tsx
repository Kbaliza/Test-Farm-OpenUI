import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { AuditLogClient } from "@/components/audit/audit-log-client";
import { getAuditLog, pruneAuditLog } from "./actions";

export const dynamic = "force-dynamic";

// The date window lives in the URL, like Rider Cash: the view is linkable, and
// the filtering happens in the query rather than over rows already sent — which
// matters more here than anywhere else, because this is the biggest table.
export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const sp = await searchParams;
  const data = await getAuditLog({
    from: sp.from,
    to: sp.to,
    table: sp.table,
    actorId: sp.actor,
    operation: sp.op,
    rowId: sp.row,
    productId: sp.product,
    customer: sp.customer,
    routine: sp.routine === "1",
  });

  // Old entries go on read, throttled to once every six hours — there is no cron
  // in this project, and this mirrors how the checklist history is kept in check.
  void pruneAuditLog();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Audit Log"
        description={`Every add, edit and delete made by a person — who, when, and what changed. Routine rewrites the software makes by itself are hidden unless you ask. Kept ${data.retentionMonths} months.`}
      />
      {!data.dbReady ? <DbNotReady what="Audit Log" /> : <AuditLogClient data={data} />}
    </div>
  );
}
