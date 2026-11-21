import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { ComplaintsClient } from "@/components/complaints/complaints-client";
import { getSessionUser } from "@/lib/auth";
import { getComplaintCustomers, getComplaints } from "./actions";

export const dynamic = "force-dynamic";

export default async function ComplaintsPage() {
  const [{ rows, dbReady }, user] = await Promise.all([getComplaints(30), getSessionUser()]);
  const customers = dbReady ? await getComplaintCustomers() : [];

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Complaints"
        description="Customer complaints, and the refund or replacement given for each"
      />
      {!dbReady ? (
        <DbNotReady what="Complaints" />
      ) : (
        <ComplaintsClient initialRows={rows} customers={customers} userName={user?.name ?? ""} />
      )}
    </div>
  );
}
