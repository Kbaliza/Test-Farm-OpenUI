import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { RecoveryClient } from "@/components/payments/recovery-client";
import { getRecoveryData } from "./actions";

export const dynamic = "force-dynamic";

export default async function RecoveryPage() {
  const data = await getRecoveryData();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Recovery / Milk Stop"
        description="Customers whose supply is stopped for unpaid dues — track collection visits, record payments, and restart supply"
      />
      {!data.dbReady ? (
        <DbNotReady what="Recovery / Milk Stop" />
      ) : (
        <RecoveryClient data={data} />
      )}
    </div>
  );
}
