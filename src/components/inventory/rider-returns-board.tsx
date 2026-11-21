"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { Loader2, PackageCheck, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { milkLoadOrder } from "@/lib/product-names";
import { addDaysToDateStr, todayPKTString, yesterdayPKTString } from "@/lib/pkt";
import { RiderReturnDialog } from "@/components/inventory/rider-return-dialog";
import { RangeCalendar } from "@/components/ui/range-calendar";
import {
  getReturnsBoard, getRetailReturnRows,
  type RetailReturnRow, type ReturnsBoard, type RiderReturnRow,
} from "@/app/(dashboard)/inventory/rider-returns/actions";

const uLabel = (u: string) => (u === "LITER" ? "L" : u === "KG" ? "kg" : "pc");
const fmt = (n: number) => (n % 1 === 0 ? n.toFixed(0) : String(Math.round(n * 10) / 10));
const ALL_RIDERS = "__all__";
const ALL_MILK = "__milk__";

type Metric = "returned" | "stock" | "waste" | "pending";
const METRIC_LABEL: Record<Metric, string> = {
  returned: "Returned",
  stock: "Into inventory",
  waste: "Wastage",
  pending: "Pending review",
};
type Preset = "today" | "yesterday" | "7d" | "15d" | "30d" | "range";

/** What one rider's day shows for the chosen metric, per product. */
function valuesOf(row: RiderReturnRow, metric: Metric): Record<string, number> {
  if (metric === "returned") return row.returned;
  if (metric === "stock") return row.stock;
  if (metric === "waste") return row.waste;
  const out: Record<string, number> = {};
  if (!row.reviewed) for (const [pid, q] of Object.entries(row.returned)) out[pid] = (out[pid] ?? 0) + q;
  for (const [pid, q] of Object.entries(row.extrasOut)) out[pid] = (out[pid] ?? 0) + q;
  return out;
}

export function RiderReturnsBoard({
  initial,
  initialRetail,
  riders,
}: {
  initial: ReturnsBoard;
  initialRetail: RetailReturnRow[];
  riders: { id: string; name: string }[];
}) {
  const today = todayPKTString();
  const [board, setBoard] = useState(initial);
  const [retailRows, setRetailRows] = useState(initialRetail);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [rider, setRider] = useState(ALL_RIDERS);
  const [product, setProduct] = useState<string>(ALL_MILK);
  const [metric, setMetric] = useState<Metric>("returned");
  const [preset, setPreset] = useState<Preset>("today");
  const [showRange, setShowRange] = useState(false);
  const [loading, startLoading] = useTransition();
  const [openRow, setOpenRow] = useState<RiderReturnRow | null>(null);
  const [openRetailDate, setOpenRetailDate] = useState<string | null>(null);

  function load(nextFrom: string, nextTo: string, nextRider: string, nextPreset: Preset) {
    setFrom(nextFrom); setTo(nextTo); setRider(nextRider); setPreset(nextPreset);
    if (!nextFrom || !nextTo) return;
    startLoading(async () => {
      const [b, r] = await Promise.all([
        getReturnsBoard(nextFrom, nextTo, nextRider === ALL_RIDERS ? null : nextRider),
        getRetailReturnRows(nextFrom, nextTo),
      ]);
      setBoard(b);
      setRetailRows(r);
    });
  }
  const refresh = () => load(from, to, rider, preset);

  function applyPreset(p: Preset) {
    if (p === "range") { setShowRange(true); setPreset(p); return; }
    setShowRange(false);
    if (p === "today") return load(today, today, rider, p);
    if (p === "yesterday") { const y = yesterdayPKTString(); return load(y, y, rider, p); }
    const back = p === "7d" ? 6 : p === "15d" ? 14 : 29;
    return load(addDaysToDateStr(today, -back), today, rider, p);
  }

  const rows = board.rows;

  // Which products are worth a column, in loading order.
  const columns = useMemo(() => {
    const seen = new Set<string>();
    const scan = (m: Record<string, number>) => {
      for (const [pid, q] of Object.entries(m)) if (q > 0.0005) seen.add(pid);
    };
    for (const r of rows) for (const m of [r.got, r.delivered, r.chargedBack, r.returned, r.riderWasted, r.stock, r.waste, r.extrasOut]) scan(m);
    for (const r of retailRows) for (const m of [r.leftover, r.stock, r.waste]) scan(m);
    return board.products
      .filter((p) => seen.has(p.id))
      .sort((a, b) => milkLoadOrder(a.name) - milkLoadOrder(b.name) || a.name.localeCompare(b.name));
  }, [rows, retailRows, board.products]);

  // What the product filter offers: every product that can go out with a shift,
  // whether or not it moved in these dates. Offering only what moved left the
  // list with a single entry on a quiet day, which read as a broken dropdown.
  const filterProducts = useMemo(
    () => board.products
      // Mart goods never leave with a shift, so they are not worth filtering by.
      .filter((p) => !p.retailOnly)
      .sort((a, b) => milkLoadOrder(a.name) - milkLoadOrder(b.name) || a.name.localeCompare(b.name)),
    [board.products],
  );

  const milkIds = useMemo(() => board.products.filter((p) => p.unit === "LITER").map((p) => p.id), [board.products]);
  const eggProduct = useMemo(() => board.products.find((p) => /egg/i.test(p.name)) ?? null, [board.products]);

  /** The figure the table shows: one product, or every milk added together. */
  const pick = (m: Record<string, number>, which: string) =>
    which === ALL_MILK
      ? Math.round(milkIds.reduce((t, id) => t + (m[id] ?? 0), 0) * 10) / 10
      : Math.round((m[which] ?? 0) * 10) / 10;
  const unitOf = (which: string) =>
    which === ALL_MILK ? "L" : uLabel(board.products.find((p) => p.id === which)?.unit ?? "LITER");

  /** One shift's line for a product: what it took, delivered, owes and brought back.
   *  Milk charged on a stop the rider skipped — nobody in, or turned away — was
   *  never handed over, so it is expected back like anything else he still has. */
  const lineFor = (row: RiderReturnRow, which: string) => {
    const got = pick(row.got, which);
    const delivered = pick(row.delivered, which);
    const chargedBack = pick(row.chargedBack, which);
    const returned = pick(row.returned, which);
    // What the RIDER said he lost on the road, from the app. He records handing back
    // and wasting as two separate things, so with 14 L left and 4 L spilled he enters
    // return 10 and wastage 4 — the 4 L is not inside `returned`.
    const riderWasted = pick(row.riderWasted, which);
    // What the OFFICE wrote off out of what did come back, at review. A different
    // question from the rider's, and it must not be added to his.
    const wasted = pick(row.waste, which);
    // What the reviewer never received out of the app's return. The app put it in
    // `returned`; it never arrived, so it is missing.
    const reviewMissing = pick(row.reviewMissing, which);
    const should = Math.round((got - delivered) * 10) / 10;
    // Missing is what nobody has accounted for. Both of the rider's answers count:
    // what he handed over, and what he told us he lost. Leaving his wastage out made
    // an honest rider read short by exactly the amount he had just declared.
    const missing = Math.round((should - returned - riderWasted + reviewMissing) * 10) / 10;
    return { got, delivered, chargedBack, riderWasted, wasted, should, returned, missing };
  };

  const totals = useMemo(() => {
    const t = { got: 0, delivered: 0, chargedBack: 0, riderWasted: 0, wasted: 0, should: 0, returned: 0, missing: 0 };
    for (const r of rows) {
      const l = lineFor(r, product);
      t.got += l.got; t.delivered += l.delivered; t.chargedBack += l.chargedBack;
      t.riderWasted += l.riderWasted;
      t.wasted += l.wasted; t.should += l.should; t.returned += l.returned; t.missing += l.missing;
    }
    return {
      got: Math.round(t.got * 10) / 10, delivered: Math.round(t.delivered * 10) / 10,
      chargedBack: Math.round(t.chargedBack * 10) / 10,
      riderWasted: Math.round(t.riderWasted * 10) / 10, wasted: Math.round(t.wasted * 10) / 10,
      should: Math.round(t.should * 10) / 10, returned: Math.round(t.returned * 10) / 10,
      missing: Math.round(t.missing * 10) / 10,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, product, milkIds]);

  // The per-product breakdown, as it was: whichever figure the tabs are on.
  const breakdown = useMemo(() => {
    const sum = (key: Metric) => {
      const out: Record<string, number> = {};
      for (const r of rows) for (const [pid, q] of Object.entries(valuesOf(r, key))) out[pid] = (out[pid] ?? 0) + q;
      return out;
    };
    return { returned: sum("returned"), stock: sum("stock"), waste: sum("waste"), pending: sum("pending") };
  }, [rows]);

  // A rider takes his spare stock as one lot and hands one lot back, whichever
  // rounds he ran that day — so his day is the row, and there is nothing to fold.

  const pendingCount = rows.filter((r) => !r.reviewed).length;
  const doneCount = rows.length - pendingCount;
  const u = unitOf(product);

  const StatusPill = ({ done }: { done: boolean }) => (
    <span className={cn(
      "inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
      done ? "bg-emerald-50 text-emerald-700" : "bg-sky-50 text-sky-700",
    )}>
      {done ? "Received" : "Awaiting"}
    </span>
  );

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Dates */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-wrap gap-1.5">
          {([["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7D"], ["15d", "15D"], ["30d", "30D"], ["range", "Range"]] as [Preset, string][]).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={preset === key ? "default" : "outline"}
              className="h-8 text-xs"
              disabled={loading}
              onClick={() => applyPreset(key)}
            >
              {label}
            </Button>
          ))}
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Rider</label>
          <Select value={rider} onValueChange={(v) => load(from, to, v, preset)}>
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue>{rider === ALL_RIDERS ? "All riders" : riders.find((r) => r.id === rider)?.name ?? "All riders"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_RIDERS}>All riders</SelectItem>
              {riders.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {loading && <span className="flex h-8 items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Loading…</span>}
        <span className="ml-auto flex h-8 items-center text-xs text-muted-foreground">
          {board.from === board.to ? board.from : `${board.from} to ${board.to}`} · {rows.length} shift{rows.length === 1 ? "" : "s"} · {pendingCount} to review · {doneCount} done
        </span>
      </div>

      {/* Range mode shows the calendar where the two typed date boxes used to be.
          Those re-queried the board on every keystroke; this asks once, on the
          second click. It sits below the row rather than inside it — a month grid
          wedged between the presets and the rider picker would not line up with
          either. */}
      {showRange && (
        <RangeCalendar
          className="max-w-xs"
          from={from}
          to={to}
          maxDate={today}
          onApply={(f, t) => load(f, t, rider, "range")}
        />
      )}

      {/* The day in four figures */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {([
          ["Expected return", `${fmt(totals.should)} ${u}`, "What should come back: taken less what actually reached customers", "text-indigo-700"],
          ["Returned", `${fmt(totals.returned)} ${u}`, "What the riders physically handed back", "text-emerald-700"],
          ["Rider wasted", `${fmt(totals.riderWasted)} ${u}`, "What the riders reported wasting on the road — accounted for, not missing", "text-orange-700"],
          ["Missing", `${fmt(totals.missing)} ${u}`, "Expected, less handed back, less what they reported wasted", totals.missing > 0.05 ? "text-rose-700" : "text-emerald-700"],
          ["Shifts pending", `${pendingCount} of ${rows.length}`, "Returns nobody has been through yet", pendingCount > 0 ? "text-amber-700" : "text-emerald-700"],
        ] as [string, string, string, string][]).map(([label, value, note, colour]) => (
          <div key={label} className="rounded-xl border border-border bg-card p-3.5 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className={cn("mt-1.5 text-xl font-bold leading-none tabular-nums", colour)}>{value}</p>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{note}</p>
          </div>
        ))}
      </div>

      {/* Where the stock stands, and what these returns put back */}
      {board.levels.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Inventory levels</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {board.levels.map((l) => (
              <div key={l.productId} className="rounded-xl border border-border border-l-4 border-l-primary bg-card p-3 shadow-sm">
                <p className="truncate text-[11px] font-semibold">{l.name}</p>
                <p className="mt-1 text-lg font-bold leading-none tabular-nums">
                  {fmt(l.onHand)} <span className="text-[11px] font-medium text-muted-foreground">{uLabel(l.unit)}</span>
                </p>
                <p className={cn("mt-1 text-[10px] font-medium", l.fromReturns > 0 ? "text-emerald-700" : "text-muted-foreground")}>
                  {l.fromReturns > 0 ? `+ ${fmt(l.fromReturns)} ${uLabel(l.unit)} from returns` : "nothing back yet"}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Returns, shift by shift */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Returns by rider</h2>
            <p className="text-[11px] text-muted-foreground">
              Showing {product === ALL_MILK ? "all milk (L)" : `${board.products.find((p) => p.id === product)?.name} (${u})`}
              {" "}· open a rider for their shifts, and a shift for the item-by-item split
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={product} onValueChange={setProduct}>
              <SelectTrigger className="h-8 w-44 text-xs">
                {/* SelectValue with its own children: Radix only mounts the items
                    when the menu opens, so leaving it to derive the label shows
                    nothing until then. */}
                <SelectValue>{product === ALL_MILK ? "All milk" : board.products.find((p) => p.id === product)?.name ?? "All milk"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_MILK}>All milk</SelectItem>
                {filterProducts.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="text-[11px] font-semibold text-muted-foreground">
              {pendingCount > 0 ? `${pendingCount} pending` : "all reviewed"}
            </span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Rider</th>
                <th className="px-3 py-2 text-right font-semibold" title="What the rider confirmed he loaded in the app, plus the spare stock given to him. Falls back to the round's planned quantities on a day he confirmed no load.">Got</th>
                <th className="px-3 py-2 text-right font-semibold">Delivered</th>
                <th className="px-3 py-2 text-right font-semibold" title="Charged but never handed over — nobody in, or the customer turned it away. The bill stands; the milk comes back.">Charged, came back</th>
                <th className="px-3 py-2 text-right font-semibold" title="Got less what actually reached customers. The rider accounts for this with what he hands back plus what he reports wasted.">Expected return</th>
                <th className="px-3 py-2 text-right font-semibold" title="What the RIDER reported wasting on the road, in the app. Separate from what he handed back, and accounted for — so it is not missing.">Rider wasted</th>
                <th className="px-3 py-2 text-right font-semibold" title="What the rider physically handed back, as recorded in the app.">Returned</th>
                <th className="px-3 py-2 text-right font-semibold" title="Expected, less what he handed back, less what he reported wasted. What nobody has accounted for.">Missing</th>
                <th className="px-3 py-2 text-right font-semibold" title="Written off by the OFFICE at review, out of milk that did come back and turned out to be spoilt. Not the rider's figure.">Spoilt at review</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-right font-semibold" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-10 text-center text-sm text-muted-foreground">
                    <PackageCheck className="mx-auto mb-2 size-6 opacity-40" />
                    Nothing came back in these dates.
                  </td>
                </tr>
              ) : rows.map((row) => {
                const l = lineFor(row, product);
                const stillOut = Object.values(row.extrasOut).some((q) => q > 0.0005);
                return (
                  <tr key={row.key} className="align-top hover:bg-muted/20">
                    <td className="px-3 py-2">
                      <div className="font-semibold">{row.riderName}</div>
                      <div className="text-[11px] text-muted-foreground">{row.date}</div>
                      {stillOut && <div className="text-[10px] font-medium text-amber-700">spare stock still out</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{fmt(l.got)} {u}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-emerald-700">{fmt(l.delivered)} {u}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-amber-700">
                      {l.chargedBack > 0.05 ? `${fmt(l.chargedBack)} ${u}` : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">{fmt(l.should)} {u}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-orange-700">
                      {l.riderWasted > 0.05 ? `${fmt(l.riderWasted)} ${u}` : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums text-indigo-700">{fmt(l.returned)} {u}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                      {l.missing > 0.05
                        ? <span className="font-semibold text-rose-700">{fmt(l.missing)} {u}</span>
                        : l.missing < -0.05
                          ? <span className="font-semibold text-amber-700">{fmt(-l.missing)} {u} extra</span>
                          : <span className="font-semibold text-emerald-700">0 {u}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-rose-700">
                      {l.wasted > 0.05 ? `${fmt(l.wasted)} ${u}` : "—"}
                    </td>
                    <td className="px-3 py-2"><StatusPill done={row.reviewed} /></td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {row.reviewed ? (
                        <div className="flex flex-col items-end gap-0.5">
                          <Button size="sm" variant="outline" className="h-7 text-xs text-emerald-700" onClick={() => setOpenRow(row)}>
                            <Check className="mr-1 size-3.5" /> Received
                          </Button>
                          {row.reviewedByName && <span className="text-[10px] text-muted-foreground">by {row.reviewedByName}</span>}
                        </div>
                      ) : (
                        <Button size="sm" className="h-7 text-xs" onClick={() => setOpenRow(row)}>Review</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length > 0 && (
                <tr className="bg-muted/30 font-semibold">
                  <td className="px-3 py-2">All riders</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.got)} {u}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.delivered)} {u}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-700">
                    {totals.chargedBack > 0.05 ? `${fmt(totals.chargedBack)} ${u}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.should)} {u}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-orange-700">
                    {totals.riderWasted > 0.05 ? `${fmt(totals.riderWasted)} ${u}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.returned)} {u}</td>
                  <td className={cn("px-3 py-2 text-right tabular-nums", totals.missing > 0.05 ? "text-rose-700" : "text-emerald-700")}>
                    {fmt(totals.missing)} {u}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-rose-700">
                    {totals.wasted > 0.05 ? `${fmt(totals.wasted)} ${u}` : "—"}
                  </td>
                  <td colSpan={2} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Eggs, in pieces, on their own — they never add into the milk figures */}
      {eggProduct && rows.some((r) => (r.got[eggProduct.id] ?? 0) > 0 || (r.returned[eggProduct.id] ?? 0) > 0) && (
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">{eggProduct.name} returns</h2>
            <p className="text-[11px] text-muted-foreground">Pieces (pc)</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Rider</th>
                  <th className="px-3 py-2 text-right font-semibold">Got</th>
                  <th className="px-3 py-2 text-right font-semibold">Delivered</th>
                  <th className="px-3 py-2 text-right font-semibold" title="Charged but never handed over">Charged, came back</th>
                  <th className="px-3 py-2 text-right font-semibold">Expected return</th>
                  <th className="px-3 py-2 text-right font-semibold" title="What the rider reported as broken or wasted in the app — accounted for, so not missing.">Rider wasted</th>
                  <th className="px-3 py-2 text-right font-semibold" title="What the rider physically handed back.">Returned</th>
                  <th className="px-3 py-2 text-right font-semibold">Missing</th>
                  <th className="px-3 py-2 text-left font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => {
                  const l = lineFor(row, eggProduct.id);
                  if (l.got === 0 && l.returned === 0) return null;
                  return (
                    <tr key={row.key} className="hover:bg-muted/20">
                      <td className="px-3 py-2">
                        <div className="font-medium">{row.riderName}</div>
                        <div className="text-[11px] text-muted-foreground">{row.date}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(l.got)} pc</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{fmt(l.delivered)} pc</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-700">
                        {l.chargedBack > 0.05 ? `${fmt(l.chargedBack)} pc` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fmt(l.should)} pc</td>
                      <td className="px-3 py-2 text-right tabular-nums text-orange-700">
                        {l.riderWasted > 0.05 ? `${fmt(l.riderWasted)} pc` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-indigo-700">{fmt(l.returned)} pc</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {l.missing > 0.05
                          ? <span className="font-semibold text-rose-700">{fmt(l.missing)} pc</span>
                          : <span className="font-semibold text-emerald-700">0 pc</span>}
                      </td>
                      <td className="px-3 py-2"><StatusPill done={row.reviewed} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* The per-product breakdown, as it was */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Product breakdown</h2>
          <p className="text-[11px] text-muted-foreground">Pick which quantities the cards show</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
            <Button key={m} size="sm" variant={metric === m ? "default" : "outline"} className="h-7 text-xs" onClick={() => setMetric(m)}>
              {METRIC_LABEL[m]}
            </Button>
          ))}
        </div>
      </div>
      {columns.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {columns.map((p) => (
            <div key={p.id} className="rounded-xl border border-border bg-card p-3">
              <p className="truncate text-[11px] text-muted-foreground">{p.name}</p>
              <p className="mt-1 text-lg font-bold leading-none tabular-nums">
                {fmt(breakdown[metric][p.id] ?? 0)} <span className="text-[11px] font-medium text-muted-foreground">{uLabel(p.unit)}</span>
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                In {fmt(breakdown.stock[p.id] ?? 0)} · <span className="text-rose-700">waste {fmt(breakdown.waste[p.id] ?? 0)}</span>
              </p>
            </div>
          ))}
        </div>
      )}

      {/* What Retail itself had left after the shifts were loaded */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">At the retail centre</h2>
            <p className="text-[11px] text-muted-foreground">
              What the retail centre still has to hand back — sent to Retail, less what the rounds and the spare stock took.
              Milk a rider brought back is shown under each day but is not the centre&apos;s to return; the Inventory page&apos;s
              &ldquo;In Retail&rdquo; is the two added together.
            </p>
          </div>
          {retailRows.length > 0 && (
            <span className="text-[11px] font-semibold text-muted-foreground">
              {retailRows.some((r) => !r.reviewed) ? `${retailRows.filter((r) => !r.reviewed).length} pending` : "all reviewed"}
            </span>
          )}
        </div>
        {retailRows.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm text-muted-foreground">
            <PackageCheck className="mx-auto mb-2 size-6 opacity-40" />
            Nothing left over at Retail in these dates.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Day</th>
                  {columns.map((p) => (
                    <th key={p.id} className="whitespace-nowrap px-3 py-2 text-right font-semibold">
                      {p.name}<span className="block font-normal normal-case">{uLabel(p.unit)}</span>
                    </th>
                  ))}
                  <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Milk total</th>
                  <th className="px-3 py-2 text-right font-semibold">Allocation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {retailRows.map((row) => {
                  const vals = metric === "stock" ? row.stock
                    : metric === "waste" ? row.waste
                    : metric === "pending" ? (row.reviewed ? {} : row.leftover)
                    : row.leftover;
                  // The same day's rider returns, so the two pages can be read
                  // against each other instead of appearing to contradict.
                  const back: Record<string, number> = {};
                  for (const r of rows) {
                    if (r.date !== row.date) continue;
                    for (const [pid, q] of Object.entries(r.returned)) back[pid] = Math.round(((back[pid] ?? 0) + q) * 10) / 10;
                  }
                  const anyBack = Object.values(back).some((q) => q > 0.05);
                  return (
                    <Fragment key={row.date}>
                    <tr className="align-top hover:bg-muted/20">
                      <td className="px-3 py-2">
                        <div className="font-medium">Retail centre</div>
                        <div className="text-[11px] text-muted-foreground">{row.date}</div>
                      </td>
                      {columns.map((p) => (
                        <td key={p.id} className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                          {vals[p.id] ? fmt(vals[p.id]) : <span className="text-muted-foreground">—</span>}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums">
                        {fmt(Math.round(milkIds.reduce((t, id) => t + (vals[id] ?? 0), 0) * 10) / 10)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <div className="flex flex-col items-end gap-1">
                          <StatusPill done={row.reviewed} />
                          <Button size="sm" variant={row.reviewed ? "outline" : "default"} className="h-7 text-xs" onClick={() => setOpenRetailDate(row.date)}>
                            {row.reviewed ? "View / edit split" : "Review return"}
                          </Button>
                          {row.reviewed && row.reviewedByName && (
                            <span className="text-[10px] text-muted-foreground">by {row.reviewedByName}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {anyBack && (metric === "returned" || metric === "pending") && (
                      <tr className="bg-muted/20 text-[12px]">
                        <td className="px-3 py-1.5 pl-6 text-muted-foreground">
                          Riders brought back
                          <div className="text-[10px]">counted in the Inventory page&apos;s In Retail, not owed by the centre</div>
                        </td>
                        {columns.map((p) => (
                          <td key={p.id} className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                            {back[p.id] ? fmt(back[p.id]) : "—"}
                          </td>
                        ))}
                        <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                          {fmt(Math.round(milkIds.reduce((t, id) => t + (back[id] ?? 0), 0) * 10) / 10)}
                        </td>
                        <td />
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Returned does not mean usable. Every return is split into stock and wastage, and the wasted part is taken out of
        stock with a reason — it shows in the Wastage log under &ldquo;Rider return&rdquo;.
      </p>

      <RiderReturnDialog
        open={!!openRow}
        kind="RIDER"
        riderId={openRow?.riderId ?? null}
        date={openRow?.date ?? today}
        onClose={() => setOpenRow(null)}
        onSaved={refresh}
      />
      <RiderReturnDialog
        open={!!openRetailDate}
        kind="RETAIL"
        riderId={null}
        date={openRetailDate ?? today}
        onClose={() => setOpenRetailDate(null)}
        onSaved={refresh}
      />
    </div>
  );
}
