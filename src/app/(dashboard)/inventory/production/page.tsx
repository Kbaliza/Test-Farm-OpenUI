import { fmtTimePKT } from "@/lib/pkt";
import { unitLabel } from "@/lib/units";
import { PageHeader } from "@/components/layout/page-header";
import { ProductionForm, UsageForm, ProductionWastageForm } from "@/components/inventory/production-form";
import { SkimMilkClient } from "@/components/inventory/skim-milk-client";
import { DbNotReady } from "@/components/db-not-ready";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getProductionContext, getRecentProduction, getNetForDispatch, getTodaysDispatches } from "./actions";
import { isYoghurtName, isGheeName, isEggName } from "@/lib/product-names";
import { getSkimMilkBatches, getTodayMilkAvailability } from "@/app/(dashboard)/inventory/skim-milk/actions";
import { DispatchCard } from "@/components/inventory/production-form";

export const dynamic = "force-dynamic";


export default async function ProductionPage() {
  const ctx = await getProductionContext();
  const [recent, { entries: skimEntries }, milkAvailability, netPreview, dispatches] = await Promise.all([
    ctx.dbReady ? getRecentProduction() : Promise.resolve([]),
    ctx.dbReady ? getSkimMilkBatches() : Promise.resolve({ entries: [], dbReady: false }),
    ctx.dbReady ? getTodayMilkAvailability() : Promise.resolve([]),
    ctx.dbReady ? getNetForDispatch() : Promise.resolve([]),
    ctx.dbReady ? getTodaysDispatches() : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Milk Entry / Production"
        description="Log what comes out of the farm each day, per shift"
      />

      {!ctx.dbReady ? (
        <DbNotReady what="Production logging" />
      ) : (
        <div className="space-y-6 p-4 sm:p-6">
          {/* Order: 1. Production  2. Skim Milk  3. Calf Use  4. Kitchen Use
              Skim Milk gets first priority on produced milk; calf and kitchen
              use deduct from whatever remains. All three deduct from the
              FarmDispatch so packaging receives the net. */}
          <ProductionForm
            products={ctx.products
              // Yoghurt is produced on its own page (/inventory/yoghurt), so it must
              // never be a production-entry line here. Matched by pattern, not exact
              // name: the catalog spells it "Yogurt" while this list said "Yoghurt",
              // so the name check alone silently let it through.
              .filter((p) => !["Skim Milk", "Yoghurt", "Cream", "Mix Milk", "Ghee"].includes(p.name)
                && !isYoghurtName(p.name)
                // Ghee is always bought in (OTC purchase), never produced here.
                && !isGheeName(p.name)
                // Eggs are collected, not produced through the milk pipeline, and are
                // never used in the kitchen — they are entered on the Packaging page.
                && !isEggName(p.name))
              .map((p) => ({
                id: p.id,
                name: p.name,
                unit: p.unit,
              }))}
          />

          <SkimMilkClient
            initialEntries={skimEntries}
            milkAvailability={milkAvailability}
            locked={recent.length === 0}
          />

          <UsageForm
            type="CALF_USE"
            products={ctx.products
              .filter((p) => p.unit === "LITER" && p.name !== "Mix Milk" && !["skim", "ghee", "yogh"].some((kw) => p.name.toLowerCase().includes(kw)) && !isYoghurtName(p.name))
              .map((p) => ({ id: p.id, name: p.name, unit: p.unit }))}
            locked={recent.length === 0}
          />

          <UsageForm
            type="KITCHEN_USE"
            products={ctx.products
              .filter((p) => p.name !== "Mix Milk" && !["skim", "ghee", "yogh", "cream"].some((kw) => p.name.toLowerCase().includes(kw)) && !isYoghurtName(p.name) && !isEggName(p.name))
              .map((p) => ({ id: p.id, name: p.name, unit: p.unit }))}
            locked={recent.length === 0}
          />

          <ProductionWastageForm
            products={ctx.products
              .filter((p) => p.name !== "Mix Milk" && !["skim", "ghee", "yogh", "cream"].some((kw) => p.name.toLowerCase().includes(kw)) && !isYoghurtName(p.name) && !isEggName(p.name))
              .map((p) => ({ id: p.id, name: p.name, unit: p.unit }))}
            locked={recent.length === 0}
          />

          <DispatchCard
            preview={netPreview}
            locked={!netPreview.some((p) => p.net > 0)}
          />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Dispatched to Packaging Today</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Accepted at packaging</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dispatches.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-20 text-center text-sm text-muted-foreground">
                        Nothing dispatched to packaging today yet
                      </TableCell>
                    </TableRow>
                  ) : (
                    dispatches.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="font-mono text-xs whitespace-nowrap">{fmtTimePKT(d.date)}</TableCell>
                        <TableCell className="text-sm">
                          {d.declared.map((i) => `${i.productName} ${i.quantity}${unitLabel(i.unit as keyof typeof unitLabel) ?? ""}`).join(" · ")}
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              d.status === "CONFIRMED"
                                ? "rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700"
                                : d.status === "DISPUTED"
                                  ? "rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700"
                                  : "rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700"
                            }
                          >
                            {d.status === "PENDING" ? "Awaiting packaging" : d.status === "CONFIRMED" ? "Accepted" : "Disputed"}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {d.received
                            ? d.received.map((i) => `${i.productName} ${i.quantity}${unitLabel(i.unit as keyof typeof unitLabel) ?? ""}`).join(" · ") || "—"
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Today&apos;s Production Log
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="h-24 text-center text-sm text-muted-foreground"
                      >
                        No production logged today yet
                      </TableCell>
                    </TableRow>
                  ) : (
                    recent.filter((r) => r.productName !== "Mix Milk").map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs">
                          {fmtTimePKT(r.date)}
                        </TableCell>
                        <TableCell className="font-medium">
                          {r.productName}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {r.quantity} {unitLabel(r.unit)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {r.notes ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
