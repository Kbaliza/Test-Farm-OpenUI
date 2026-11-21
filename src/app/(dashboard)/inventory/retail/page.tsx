import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { RetailClient } from "@/components/inventory/retail-client";
import { getRetailContext } from "./actions";

export const revalidate = 30;

export default async function RetailPage() {
  const ctx = await getRetailContext();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Retail"
        description="Confirm quantities received at retail from packaging"
      />
      {!ctx.dbReady ? (
        <DbNotReady what="Retail" />
      ) : (
        <RetailClient initialDispatches={ctx.dispatches} />
      )}
    </div>
  );
}

