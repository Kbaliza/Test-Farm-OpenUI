import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { MissingClient } from "@/components/inventory/missing-client";
import { getMissingLog } from "./actions";
import { todayPKTString } from "@/lib/pkt";

export const dynamic = "force-dynamic";

// The window lives in the URL, like the Flow Log, so a day is linkable.
export default async function MissingPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { from, to } = await searchParams;
  const data = await getMissingLog(from ?? "", to ?? "");
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Missing log"
        description="Milk that went out and never came back — what each rider still owes, what a reviewer found short, and what Retail held at midnight"
      />
      {!data.dbReady ? <DbNotReady what="Missing log" /> : <MissingClient data={data} today={todayPKTString()} />}
    </div>
  );
}
