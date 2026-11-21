import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { RiderReturnsBoard } from "@/components/inventory/rider-returns-board";
import { getReturnsBoard, getRetailReturnRows, getRiderOptions } from "./actions";

import { todayPKTString } from "@/lib/pkt";

// Returns must reflect what the riders sent back the moment a manager opens this
// page, so nothing here is cached.
export const dynamic = "force-dynamic";

export default async function RiderReturnsPage() {
  const today = todayPKTString();
  const [board, retailRows, riders] = await Promise.all([
    getReturnsBoard(today, today),
    getRetailReturnRows(today, today),
    getRiderOptions(),
  ]);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Rider Item Returns"
        description="Review what each shift sent back. Split it into usable stock and wastage."
      />
      {!board.dbReady ? (
        <DbNotReady what="Rider Item Returns" />
      ) : (
        <RiderReturnsBoard initial={board} initialRetail={retailRows} riders={riders} />
      )}
    </div>
  );
}
