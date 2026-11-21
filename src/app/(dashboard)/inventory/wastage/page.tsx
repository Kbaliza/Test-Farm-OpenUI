import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { WastageClient } from "@/components/inventory/wastage-client";
import { getWastageData } from "./actions";

export const revalidate = 30;

export default async function WastagePage() {
  const { entries, dbReady } = await getWastageData();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Wastage log"
        description="Track milk losses across all distribution stages"
      />
      {!dbReady ? (
        <DbNotReady what="Wastage" />
      ) : (
        <WastageClient entries={entries} />
      )}
    </div>
  );
}

