import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { LedgerClient } from "@/components/ledgers/ledger-client";
import { getLedgerSelectors, getLedgerData } from "./actions";

export const dynamic = "force-dynamic";

export default async function LedgersPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; id?: string }>;
}) {
  const [selectors, sp] = await Promise.all([getLedgerSelectors(), searchParams]);
  // Opened from a link (?type=&id=): its whole history, loaded here so the page
  // arrives with it rather than fetching again from the browser.
  const linked = sp.type && sp.id ? await getLedgerData(sp.type, sp.id) : null;

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Ledger"
        description="Select any customer, product, payment head, vendor, employee or expense category to view its full ledger"
      />
      {!selectors.dbReady ? (
        <DbNotReady what="Ledger" />
      ) : (
        <LedgerClient
          selectors={selectors}
          initialType={sp.type ?? ""}
          initialEntityId={sp.id ?? ""}
          initialData={linked?.ok ? linked.data : null}
        />
      )}
    </div>
  );
}
