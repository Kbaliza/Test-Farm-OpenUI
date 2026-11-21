import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { BottlesClient } from "@/components/customers/bottles-client";
import { getBottlesPage } from "./actions";
import { todayPKTString } from "@/lib/pkt";

export const dynamic = "force-dynamic";

// The window lives in the URL, like the Flow Log, so a day is linkable.
export default async function BottlesPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { from, to } = await searchParams;
  const data = await getBottlesPage(from ?? "", to ?? "");
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Bottles"
        description="Glass bottles out with customers on the bottle shifts — what each one holds, what came back, and which shifts are on bottles"
      />
      {!data.dbReady ? <DbNotReady what="Bottles" /> : <BottlesClient data={data} today={todayPKTString()} />}
    </div>
  );
}
