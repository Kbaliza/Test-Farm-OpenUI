import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { TransfersClient } from "@/components/payments/transfers-client";
import { getTransfersPageData } from "./actions";

export const dynamic = "force-dynamic";

export default async function TransfersPage() {
  const data = await getTransfersPageData();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Move Funds Between Heads"
        description="Move money between payment heads — e.g. Easypaisa → bank — and keep every balance in sync"
      />
      {!data.dbReady ? (
        <DbNotReady what="Move Funds Between Heads" />
      ) : (
        <TransfersClient data={data} />
      )}
    </div>
  );
}
