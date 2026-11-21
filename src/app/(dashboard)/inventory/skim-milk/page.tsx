import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { SkimMilkClient } from "@/components/inventory/skim-milk-client";
import { getSkimMilkBatches, getTodayMilkAvailability } from "./actions";

export const dynamic = "force-dynamic";

export default async function SkimMilkPage() {
  const [{ entries, dbReady }, milkAvailability] = await Promise.all([
    getSkimMilkBatches(),
    getTodayMilkAvailability(),
  ]);

  // Initial lock state for a correct first paint (the client keeps it in sync
  // with live availability). Locked when no buffalo/cow milk is available to
  // process — i.e. no production has been logged yet.
  const skimLocked = !milkAvailability.some(
    (a) => (/buffalo|cow/i.test(a.name)) && a.available > 0
  );

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Skim Milk Processing"
        description="Log milk input, cream output, and skim milk produced"
      />
      {!dbReady ? (
        <DbNotReady what="Skim Milk Processing" />
      ) : (
        <SkimMilkClient initialEntries={entries} milkAvailability={milkAvailability} locked={skimLocked} />
      )}
    </div>
  );
}
