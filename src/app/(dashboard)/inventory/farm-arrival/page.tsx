import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { FarmArrivalClient } from "@/components/inventory/farm-arrival-client";
import { PackagingSend } from "@/components/inventory/packaging-send";
import { MixMilkClient } from "@/components/inventory/mix-milk-client";
import { BuffaloDilutionClient } from "@/components/inventory/buffalo-dilution-client";
import { getContext, getPoolView } from "./actions";
import { getMixMilkBatches, getMixMilkAvailability, isPackagingUnlocked } from "./mix-milk-actions";
import { getDilutionContext } from "./dilution-actions";
import { PackagingWastageCard } from "@/components/inventory/packaging-wastage-card";
import { EggsCard } from "@/components/inventory/eggs-card";
import { getEggContext } from "./egg-actions";
import { getPackagingWasteContext, getPackagingWasteLog } from "../waste-entry/actions";
import { ShiftLoadsCard } from "@/components/inventory/shift-loads-card";
import { FoldableSection } from "@/components/inventory/foldable-section";
import { getPackagingLoadNeeds, type PackagingLoadNeeds } from "../../customers/pre-delivery/actions";
import { todayPKTString, addDaysToDateStr } from "@/lib/pkt";

export const revalidate = 30;

export default async function FarmArrivalPage() {
  const ctx = await getContext();
  const today = todayPKTString();
  const tomorrow = addDaysToDateStr(today, 1);
  const noNeeds = (date: string): PackagingLoadNeeds => ({ date, isToday: date === today, lines: [] });
  const [{ entries: mixMilkEntries }, mixMilkAvailability, unlocked, dilution, wasteCtx, wasteLog, eggCtx, poolView, needsToday, needsTomorrow] =
    await Promise.all([
      ctx.dbReady ? getMixMilkBatches() : Promise.resolve({ entries: [], dbReady: false }),
      ctx.dbReady ? getMixMilkAvailability() : Promise.resolve([]),
      ctx.dbReady ? isPackagingUnlocked() : Promise.resolve(false),
      ctx.dbReady
        ? getDilutionContext()
        : Promise.resolve({ buffalo: null, cow: null, addedToday: 0, prepared: 0, entries: [], locked: true, dbReady: false }),
      getPackagingWasteContext(),
      ctx.dbReady ? getPackagingWasteLog() : Promise.resolve([]),
      getEggContext(),
      ctx.dbReady ? getPoolView() : Promise.resolve({ lines: [], sentToday: [], stillWaiting: [] }),
      ctx.dbReady ? getPackagingLoadNeeds(today) : Promise.resolve(noNeeds(today)),
      ctx.dbReady ? getPackagingLoadNeeds(tomorrow) : Promise.resolve(noNeeds(tomorrow)),
    ]);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Packaging"
        description="Accept what production sent, prepare buffalo and mix milk, then send to Retail"
      />
      {!ctx.dbReady ? (
        <DbNotReady what="Packaging" />
      ) : (
        <div className="space-y-4 p-4 sm:p-6">
          {/* The order the work happens in:
              1. Accept what production sent — it becomes packaging's stock.
              2. Prepare the buffalo, then make mix milk, from that stock. Both are
                 locked until something has been accepted.
              3. Eggs and wastage.
              4. What the shifts need today and tomorrow, then Send to Retail,
                 capped at what is at packaging. A shift is only assigned once
                 Retail holds its load. */}
          <FoldableSection title="Accept from production" note="What the farm sent, waiting to be taken in">
            <FarmArrivalClient
              initialDispatches={ctx.dispatches}
              mixMilkProduct={null}
              mixMilkMade={0}
            />
          </FoldableSection>

          <FoldableSection title="Buffalo preparation" note="Standardise the buffalo milk">
            <BuffaloDilutionClient initial={dilution} />
          </FoldableSection>

          <FoldableSection title="Mix milk" note="Made at packaging from accepted stock">
            <MixMilkClient
              initialEntries={mixMilkEntries}
              milkAvailability={mixMilkAvailability}
              locked={!unlocked}
            />
          </FoldableSection>

          <FoldableSection title="Eggs" note="Collected and packed">
            <EggsCard ctx={eggCtx} />
          </FoldableSection>

          <FoldableSection title="Packaging wastage" note="Written off here, before anything leaves">
            <PackagingWastageCard ctx={wasteCtx} log={wasteLog} />
          </FoldableSection>

          <FoldableSection title="What the shifts need" note="Today and tomorrow">
            <ShiftLoadsCard today={needsToday} tomorrow={needsTomorrow} />
          </FoldableSection>

          <FoldableSection title="Send to Retail" note="Capped at what is at packaging">
            <PackagingSend view={poolView} needs={needsToday} />
          </FoldableSection>
        </div>
      )}
    </div>
  );
}
