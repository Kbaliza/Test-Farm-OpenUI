import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { RetailClient } from "@/components/retail/retail-client";
import { getRetailContext, getRetailOverview, getRetailMarts, getRetailStock } from "./actions";

export const dynamic = "force-dynamic";

export default async function RetailPage() {
  const [context, overview, marts, stock] = await Promise.all([
    getRetailContext(),
    getRetailOverview(),
    getRetailMarts(),
    getRetailStock(),
  ]);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Retail Marts"
        description="Product left at shops on consignment — what sold, what expired, and what they owe"
      />
      {!context.dbReady ? (
        <DbNotReady what="Retail marts" />
      ) : (
        <RetailClient context={context} overview={overview} marts={marts} stock={stock.rows} />
      )}
    </div>
  );
}
