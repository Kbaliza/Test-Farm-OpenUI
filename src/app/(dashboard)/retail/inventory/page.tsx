import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { RetailStockClient } from "@/components/retail/retail-stock-client";
import { getRetailStock } from "../actions";
import { getDashboardUser, FULL_ACCESS } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function RetailInventoryPage() {
  const [stock, user] = await Promise.all([getRetailStock(), getDashboardUser()]);

  // The cost decides what every loss is worth, and voiding an entry removes
  // stock — neither belongs to the retail manager.
  const canEditCost = !!user && FULL_ACCESS.includes(user.role);
  const canVoid = user?.role === "ADMIN";

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Retail Inventory"
        description="What is in stock, what it cost to make, and what is sitting at shops"
      />
      {!stock.dbReady ? (
        <DbNotReady what="Retail inventory" />
      ) : (
        <div className="p-4 sm:p-6">
          <RetailStockClient stock={stock} canEditCost={canEditCost} canVoid={canVoid} />
        </div>
      )}
    </div>
  );
}
