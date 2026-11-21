import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { YoghurtClient } from "@/components/inventory/yoghurt-client";
import { getYoghurtBatches } from "./actions";

export const revalidate = 30;

export default async function YoghurtPage() {
  const { entries, dbReady } = await getYoghurtBatches();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Yogurt Processing"
        description="Log yoghurt batches and track milk usage"
      />
      {!dbReady ? (
        <DbNotReady what="Yogurt" />
      ) : (
        <YoghurtClient initialEntries={entries} />
      )}
    </div>
  );
}

