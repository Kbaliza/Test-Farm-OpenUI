import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { WasteEntryForm } from "@/components/inventory/waste-entry-form";
import { getWasteEntryContext } from "./actions";

export const dynamic = "force-dynamic";

export default async function WasteEntryPage() {
  const ctx = await getWasteEntryContext();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Waste entry"
        description="Write off spoiled or damaged stock — deducts from in-storage and appears in the Wastage log"
      />
      {!ctx.dbReady ? (
        <DbNotReady what="Waste entry" />
      ) : (
        <WasteEntryForm
          loggedByName={ctx.loggedByName}
          stages={ctx.stages}
          reasons={ctx.reasons}
          products={ctx.products}
        />
      )}
    </div>
  );
}
