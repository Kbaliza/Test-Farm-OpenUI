import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { VendorsClient } from "@/components/payments/vendors-client";
import { getVendorsData } from "./actions";

export const dynamic = "force-dynamic";

export default async function VendorsPage() {
  const { vendors, headBalances, dbReady } = await getVendorsData();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Vendors"
        description="Create vendor bills, track outstanding balances, and print receipts"
      />
      {!dbReady ? (
        <DbNotReady what="Vendors" />
      ) : (
        <VendorsClient initialVendors={vendors} headBalances={headBalances} />
      )}
    </div>
  );
}
