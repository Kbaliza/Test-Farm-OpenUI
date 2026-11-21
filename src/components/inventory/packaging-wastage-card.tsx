"use client";

import { Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WasteEntryForm } from "@/components/inventory/waste-entry-form";
import type { PackagingWasteRow, WasteEntryContext } from "@/app/(dashboard)/inventory/waste-entry/actions";

const UNIT_LABEL: Record<string, string> = { LITER: "L", KG: "kg", PIECE: "pc" };

const fmt = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Karachi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

// Packaging-stage wastage: log it here, see what has been logged. Writes the same
// record as the Waste entry page with the stage fixed to Packaging, so it comes
// off storage and shows in the Wastage log.
export function PackagingWastageCard({ ctx, log }: { ctx: WasteEntryContext; log: PackagingWasteRow[] }) {
  // Totals per product for the rows shown, so a glance gives the damage.
  const totals = new Map<string, { qty: number; unit: string }>();
  for (const r of log) {
    const t = totals.get(r.productName) ?? { qty: 0, unit: UNIT_LABEL[r.unit] ?? "" };
    t.qty += r.quantity;
    totals.set(r.productName, t);
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Trash2 className="size-4" /> Packaging Wastage
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Mark milk or product lost during packaging. It is taken off storage and appears in the Wastage log under Packaging.
        </p>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <div>
          {ctx.dbReady ? (
            <WasteEntryForm
              packaging
              loggedByName={ctx.loggedByName}
              stages={ctx.stages}
              reasons={ctx.reasons}
              products={ctx.products}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Wastage entry is not available right now.</p>
          )}
        </div>

        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">Last 30 days</p>
            {totals.size > 0 && (
              <p className="text-xs text-muted-foreground">
                {[...totals.entries()].map(([name, t]) => `${name}: ${fmt(t.qty)} ${t.unit}`).join(" · ")}
              </p>
            )}
          </div>
          {log.length === 0 ? (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              No packaging wastage logged in the last 30 days.
            </p>
          ) : (
            <div className="max-h-[26rem] overflow-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">When</th>
                    <th className="px-3 py-2 text-left font-medium">Product</th>
                    <th className="px-3 py-2 text-right font-medium">Quantity</th>
                    <th className="px-3 py-2 text-left font-medium">Reason</th>
                    <th className="px-3 py-2 text-left font-medium">Logged by</th>
                  </tr>
                </thead>
                <tbody>
                  {log.map((r, i) => (
                    <tr key={r.id} className={i % 2 ? "bg-muted/20" : ""}>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fmtWhen(r.date)}</td>
                      <td className="px-3 py-2">{r.productName}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        {fmt(r.quantity)} {UNIT_LABEL[r.unit] ?? ""}
                      </td>
                      <td className="px-3 py-2">{r.reason || "—"}</td>
                      <td className="px-3 py-2 text-muted-foreground">{r.loggedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
