import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { RidersLiveClient } from "@/components/customers/riders-live-client";
import { getRidersLive } from "./actions";

export const dynamic = "force-dynamic";

// Admins and managers only — see RESTRICTED_ROUTES in src/lib/access.ts; the
// layout refuses everyone else before this renders, and the action checks again.
export default async function RidersLivePage() {
  const data = await getRidersLive();
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Riders live"
        description="Where each rider is right now while his round is out. Positions come straight from the rider's phone every few seconds; only the last one is kept, so the map shows where he was when you open it."
      />
      {!data.dbReady ? <DbNotReady what="Riders live" /> : <RidersLiveClient data={data} />}
    </div>
  );
}
