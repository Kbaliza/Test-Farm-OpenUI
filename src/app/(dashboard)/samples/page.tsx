import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { SamplesClient } from "@/components/samples/samples-client";
import { getSamplesPageData } from "./actions";

export const dynamic = "force-dynamic";

export default async function SamplesPage() {
  const data = await getSamplesPageData();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Samples"
        description="Track sample deliveries, follow-ups, and conversions to customers"
      />
      {!data.dbReady ? (
        <DbNotReady what="Samples" />
      ) : (
        <SamplesClient data={data} />
      )}
    </div>
  );
}
