import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { CustomerRecoveryClient } from "@/components/customers/customer-recovery-client";
import { getRecoveryBoard } from "./actions";

export const dynamic = "force-dynamic";

export default async function CustomerRecoveryPage() {
  const board = await getRecoveryBoard();
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Customer Recovery"
        description="Win back lost customers — everyone moved to Lost, why they left, and every call made to bring them back"
      />
      {board.ok ? <CustomerRecoveryClient initialRows={board.rows} /> : <DbNotReady what="Customer Recovery" />}
    </div>
  );
}
