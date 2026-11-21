import {
  Warehouse,
  Truck,
  Package,
  FlaskConical,
  Baby,
  ShoppingCart,
  RotateCcw,
  Trash2,
  ChevronRight,
  Store,
} from "lucide-react";
import Link from "next/link";
import { qtyLabel, packLabel, unitLabel } from "@/lib/units";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { PeriodTabs } from "@/components/inventory/period-tabs";
import { getInventorySummary, type Period } from "./actions";
import { RiderPerformanceCard } from "@/components/dashboard/rider-performance-card";

export const revalidate = 30;


function fmt(n: number, decimals = 1) {
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(decimals);
}

function FlowStep({
  icon: Icon,
  label,
  value,
  unit,
  color,
  arrow = true,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  unit: string;
  color: string;
  arrow?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-col items-center gap-1 rounded-lg border border-border bg-card p-3 text-center min-w-[90px]">
        <div className={`rounded-md p-2 ${color}`}>
          <Icon className="size-4" />
        </div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground mt-1">
          {label}
        </p>
        <p className="text-base font-bold">
          {fmt(value)} {unit}
        </p>
      </div>
      {arrow && (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      )}
    </div>
  );
}

function StoragePanel({
  label,
  value,
  unit,
  sub,
  icon: Icon,
  bg,
  iconClass,
  breakdown,
}: {
  label: string;
  value: number;
  unit: string;
  sub?: string;
  icon: React.ElementType;
  bg: string;
  iconClass: string;
  breakdown?: { name: string; value: number; unit: string }[];
}) {
  return (
    <div className={`rounded-xl border border-border p-5 ${bg}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="mt-2 text-3xl font-bold tracking-tight">
            {fmt(value)} <span className="text-lg font-medium">{unit}</span>
          </p>
          {sub && (
            <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
          )}
        </div>
        <div className={`rounded-full p-3 ${iconClass}`}>
          <Icon className="size-5" />
        </div>
      </div>
      {breakdown && breakdown.length > 0 && (
        <div className="mt-4 space-y-1.5 border-t border-border/60 pt-3">
          {breakdown.map((item) => (
            <div key={item.name} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{item.name}</span>
              <span className="font-semibold tabular-nums">
                {fmt(item.value)} <span className="font-normal text-muted-foreground">{item.unit}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default async function InventorySummaryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const sp = await searchParams;
  const period = (sp.period ?? "today") as Period;
  const selectedFrom = sp.from ?? undefined;
  const selectedTo   = sp.to   ?? undefined;
  const data = await getInventorySummary(period, undefined, selectedFrom, selectedTo);

  const defaultUnit =
    data.products.length > 0 ? unitLabel(data.products[0].unit) : "L";

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Inventory Summary"
        description="Real-time stock across storage, vans, and distribution"
        actions={<PeriodTabs value={period} selectedFrom={selectedFrom} selectedTo={selectedTo} />}
      />

      {!data.dbReady ? (
        <DbNotReady what="Inventory Summary" />
      ) : (
        <div className="space-y-5 p-4 sm:p-6">
          {/* ── Storage panels ── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StoragePanel
              label="In Storage"
              value={data.totals.inStorage}
              unit={defaultUnit}
              sub="At distribution centre"
              icon={Warehouse}
              bg="bg-sky-50/60 ring-1 ring-sky-100"
              iconClass="bg-sky-100 text-sky-700"
              breakdown={data.products
                .filter((p) => p.inStorage > 0)
                .map((p) => ({ name: p.productName, value: p.inStorage, unit: unitLabel(p.unit) }))}
            />
            <StoragePanel
              label="In Retail"
              value={data.totals.inRetail}
              unit={defaultUnit}
              sub={
                data.totals.onTheWay > 0.0005
                  ? `Accepted by Retail today, not yet given to a shift · ${fmt(data.totals.onTheWay)} ${defaultUnit} sent, waiting for Retail to accept`
                  : "Accepted by Retail today, not yet given to a shift — back to storage at day end"
              }
              icon={Store}
              bg="bg-violet-50/60 ring-1 ring-violet-100"
              iconClass="bg-violet-100 text-violet-700"
              breakdown={data.products
                .filter((p) => p.inRetail > 0)
                .map((p) => ({ name: p.productName, value: p.inRetail, unit: unitLabel(p.unit) }))}
            />
            <StoragePanel
              label="With Riders"
              value={data.totals.withRiders}
              unit={defaultUnit}
              sub="Handed to riders — pending delivery or return"
              icon={Truck}
              bg="bg-amber-50/60 ring-1 ring-amber-100"
              iconClass="bg-amber-100 text-amber-700"
              breakdown={data.products
                .filter((p) => p.withRiders > 0)
                .map((p) => ({ name: p.productName, value: p.withRiders, unit: unitLabel(p.unit) }))}
            />
            <StoragePanel
              label="Combined Total"
              value={data.totals.combined}
              unit={defaultUnit}
              sub="In storage + in Retail + on vans"
              icon={Package}
              bg="bg-emerald-50/60 ring-1 ring-emerald-100"
              iconClass="bg-emerald-100 text-emerald-700"
            />
          </div>

          {/* ── Milk Flow diagram ── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Milk Flow</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-1 overflow-x-auto pb-1">
                <FlowStep
                  icon={Package}
                  label="Produced"
                  value={data.totals.produced}
                  unit={defaultUnit}
                  color="bg-emerald-100 text-emerald-700"
                />
                <FlowStep
                  icon={FlaskConical}
                  label="Kitchen"
                  value={data.totals.kitchenUse}
                  unit={defaultUnit}
                  color="bg-violet-100 text-violet-700"
                />
                <FlowStep
                  icon={Baby}
                  label="Calves"
                  value={data.totals.calfUse}
                  unit={defaultUnit}
                  color="bg-pink-100 text-pink-700"
                />
                <FlowStep
                  icon={FlaskConical}
                  label="Skim Milk"
                  value={data.totals.skimUse}
                  unit={defaultUnit}
                  color="bg-orange-100 text-orange-700"
                />
                <FlowStep
                  icon={FlaskConical}
                  label="Yogurt"
                  value={data.totals.yoghurtUse}
                  unit={defaultUnit}
                  color="bg-purple-100 text-purple-700"
                />
                <FlowStep
                  icon={Truck}
                  label="Dispatched"
                  value={data.totals.netDispatched}
                  unit={defaultUnit}
                  color="bg-sky-100 text-sky-700"
                />
                <FlowStep
                  icon={ShoppingCart}
                  label="Delivered"
                  value={data.totals.delivered}
                  unit={defaultUnit}
                  color="bg-emerald-100 text-emerald-700"
                />
                <FlowStep
                  icon={RotateCcw}
                  label="Returned"
                  value={data.totals.returned}
                  unit={defaultUnit}
                  color="bg-amber-100 text-amber-700"
                />
                <FlowStep
                  icon={Trash2}
                  label="Wastage"
                  value={data.totals.wastage}
                  unit={defaultUnit}
                  color="bg-rose-100 text-rose-700"
                  arrow={false}
                />
              </div>
            </CardContent>
          </Card>

          {/* ── Product cards ── */}
          {data.products.length > 0 ? (
            <div>
              <h3 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                By Product
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {data.products.map((p) => {
                  const ul = unitLabel(p.unit);
                  const rate = Math.round(p.deliveryRate);
                  const rateColor =
                    rate >= 90
                      ? "text-emerald-600"
                      : rate >= 70
                        ? "text-amber-600"
                        : "text-rose-600";
                  const barColor =
                    rate >= 90
                      ? "bg-emerald-500"
                      : rate >= 70
                        ? "bg-amber-500"
                        : "bg-rose-500";

                  return (
                    <Card key={p.productId} className="border-border shadow-none">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <p className="font-semibold">{p.productName}</p>
                          <span className={`text-sm font-bold ${rateColor}`}>
                            {rate}% delivered
                          </span>
                        </div>

                        {/* delivery bar */}
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full ${barColor} transition-all`}
                            style={{
                              width: `${Math.min(rate, 100)}%`,
                            }}
                          />
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-y-1.5 text-xs">
                          <Stat label="Produced" value={`${fmt(p.produced)} ${ul}`} />
                          <Stat label="Handed Over" value={`${fmt(p.handedOver)} ${ul}`} />
                          <Stat
                            label="In Storage"
                            value={`${fmt(p.inStorage)} ${ul}`}
                            highlight="sky"
                          />
                          <Stat
                            label="With Riders"
                            value={`${fmt(p.withRiders)} ${ul}`}
                            highlight="amber"
                          />
                          {p.inRetail > 0 && (
                            <Stat label="In Retail" value={`${fmt(p.inRetail)} ${ul}`} />
                          )}
                          {p.onTheWay > 0 && (
                            <Stat label="On the way to Retail" value={`${fmt(p.onTheWay)} ${ul}`} />
                          )}
                          <Stat label="Delivered" value={`${fmt(p.delivered)} ${ul}`} highlight="emerald" />
                          <Stat label="Returned" value={`${fmt(p.returned)} ${ul}`} />
                          {p.wastage > 0 && (
                            <Stat label="Wastage" value={`${fmt(p.wastage)} ${ul}`} highlight="rose" />
                          )}
                          {p.kitchenUse > 0 && (
                            <Stat label="Kitchen" value={`${fmt(p.kitchenUse)} ${ul}`} />
                          )}
                          {p.skimUse > 0 && (
                            <Stat label="Skim Milk" value={`${fmt(p.skimUse)} ${ul}`} />
                          )}
                          {p.yoghurtUse > 0 && (
                            <Stat label="Yogurt" value={`${fmt(p.yoghurtUse)} ${ul}`} />
                          )}
                          {p.calfUse > 0 && (
                            <Stat label="Calves" value={`${fmt(p.calfUse)} ${ul}`} />
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          ) : (
            <Card className="border-dashed">
              <CardContent className="flex h-32 flex-col items-center justify-center gap-2 text-muted-foreground">
                <Package className="size-6 opacity-40" />
                <p className="text-sm">No inventory movements recorded yet.</p>
                <Link
                  href="/inventory/production"
                  className="text-xs text-primary hover:underline"
                >
                  Log production →
                </Link>
              </CardContent>
            </Card>
          )}

          {/* ── Retail products ──
              Their own section, in packs. Deliberately outside the milk totals
              above: a bottle count is not litres and must never be added to one. */}
          {data.retailProducts.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Retail products
              </h3>
              <p className="mb-3 text-xs text-muted-foreground">
                Counted by hand on the{" "}
                <Link href="/retail" className="text-primary hover:underline">Retail page</Link>.
                &ldquo;At shops&rdquo; left storage the day it was dropped, so the two figures
                do not add up — together they are everything you are holding.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {data.retailProducts.map((r) => (
                  <Card key={r.productId}>
                    <CardContent className="p-4">
                      <div className="mb-3 flex items-baseline justify-between gap-2">
                        <p className="text-sm font-semibold">{r.productName}</p>
                        {r.packSize != null && (
                          <span className="text-[11px] text-muted-foreground">
                            {packLabel(r.unit, r.packSize)} pack
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Stat label="In Storage" value={qtyLabel(r.unit, r.inStorage)} highlight="sky" />
                        <Stat label="At Shops" value={r.atShops > 0 ? fmt(r.atShops) : "—"} highlight="amber" />
                        <Stat
                          label="Cost"
                          value={r.costPrice == null ? "—" : `Rs ${fmt(r.costPrice)}`}
                        />
                        <Stat
                          label="Stock Value"
                          value={r.stockValue == null ? "—" : `Rs ${fmt(r.stockValue)}`}
                        />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* ── Rider performance (cash collection) ── */}
          <RiderPerformanceCard />
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: "emerald" | "sky" | "amber" | "rose";
}) {
  const color = highlight
    ? {
        emerald: "text-emerald-700",
        sky: "text-sky-700",
        amber: "text-amber-700",
        rose: "text-rose-700",
      }[highlight]
    : "text-foreground";

  return (
    <div>
      <span className="text-muted-foreground">{label}: </span>
      <span className={`font-medium ${color}`}>{value}</span>
    </div>
  );
}
