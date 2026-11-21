import { DM_Sans } from "next/font/google";
import { DbNotReady } from "@/components/db-not-ready";
import { ReconciliationClient } from "@/components/inventory/reconciliation-client";
import { getReconciliationSummary, getCurrentMilkInventory } from "./actions";
import { todayPKTString } from "@/lib/pkt";

export const revalidate = 30;

// The typeface the approved design is set in.
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--recon-font" });

export default async function ProductionReconciliationPage() {
  // The page opens on today; every other range is fetched as it is picked.
  const today = todayPKTString();
  const [summary, inventory] = await Promise.all([
    getReconciliationSummary(today, today),
    getCurrentMilkInventory(),
  ]);

  if (!summary.dbReady) return <DbNotReady what="Production Reconciliation" />;
  return <ReconciliationClient summary={summary} inventory={inventory} fontClass={dmSans.variable} />;
}
