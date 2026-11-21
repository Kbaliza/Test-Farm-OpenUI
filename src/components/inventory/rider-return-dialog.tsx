"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  RETURN_WASTE_REASONS, returnTotals, validateReturnAllocation, validateReturnLine, missingOf,
  type ReturnEntry, type ReturnLineSpec,
} from "@/lib/rider-return-math";
import {
  getRetailReturnDetail, getRiderReturnDetail, saveRetailReturnReview, saveRiderReturnReview,
  type RetailReturnDetail, type RiderReturnDetail,
} from "@/app/(dashboard)/inventory/rider-returns/actions";

const uLabel = (u: string) => (u === "LITER" ? "L" : u === "KG" ? "kg" : "pc");
const fmt = (n: number) => (n % 1 === 0 ? n.toFixed(0) : String(Math.round(n * 1000) / 1000));
const NO_REASON = "__none__";

type Draft = { stock: string; waste: string; reason: string };

// Splitting a return: what came back goes into inventory, or is written off.
//
// A rider hands back one lot for the whole day, whichever rounds he ran, and it
// has to be accounted for exactly — as does what the retail centre had left at
// the end of the day. Only spare stock may be part-returned, because the rest
// was sold on the round.
export function RiderReturnDialog({
  open,
  kind,
  riderId,
  date,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** RIDER = one rider's day. RETAIL = what the retail centre had left over. */
  kind: "RIDER" | "RETAIL";
  riderId: string | null;
  date: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState<RiderReturnDetail | RetailReturnDetail | null>(null);
  /** Which rider+date the loaded detail belongs to — the dialog is "loading"
   *  until it matches what is open, so nothing has to be reset up front. */
  const [loadedFor, setLoadedFor] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [notes, setNotes] = useState("");
  const [pending, start] = useTransition();
  // One token per dialog open: a double submit writes one review, not two.
  const [token, setToken] = useState("");

  const want = open && (kind === "RETAIL" || riderId) ? `${kind}:${riderId ?? ""}:${date}` : "";
  const loading = !!want && loadedFor !== want;

  useEffect(() => {
    if (!want) return;
    let cancelled = false;
    const load = kind === "RETAIL" ? getRetailReturnDetail(date) : getRiderReturnDetail(riderId!, date);
    load.then((d) => {
      if (cancelled) return;
      setDetail(d);
      setLoadedFor(want);
      if (d.ok) {
        const saved = new Map(d.saved.map((s) => [s.key, s]));
        setDrafts(Object.fromEntries(d.specs.map((s) => {
          const had = saved.get(s.key);
          return [s.key, {
            stock: had ? String(had.stockQty) : "",
            waste: had ? String(had.wasteQty) : "",
            reason: had?.wasteReason ?? NO_REASON,
          }];
        })));
        setNotes(d.notes ?? "");
      }
      setToken(`${want}:${Date.now()}:${Math.round(Math.random() * 1e9)}`);
    });
    return () => { cancelled = true; };
  }, [want, kind, riderId, date]);

  const specs = useMemo(
    () => (detail?.ok && !loading ? (detail.specs as (ReturnLineSpec & { givenQty?: number })[]) : []),
    [detail, loading],
  );
  const entries: ReturnEntry[] = useMemo(
    () => specs.map((s) => ({
      key: s.key,
      stockQty: parseFloat(drafts[s.key]?.stock ?? "") || 0,
      wasteQty: parseFloat(drafts[s.key]?.waste ?? "") || 0,
      wasteReason: drafts[s.key]?.reason === NO_REASON ? null : drafts[s.key]?.reason ?? null,
    })),
    [specs, drafts],
  );
  const totals = useMemo(() => returnTotals(specs, entries), [specs, entries]);
  // The same function the server runs, so the hint here and the refusal there
  // are always the same sentence.
  const problem = useMemo(() => (specs.length ? validateReturnAllocation(specs, entries) : null), [specs, entries]);

  const set = (key: string, patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { stock: "", waste: "", reason: NO_REASON }), ...patch } }));

  function allIntoInventory() {
    setDrafts(Object.fromEntries(specs.map((s) => [s.key, { stock: String(s.returnedQty), waste: "0", reason: NO_REASON }])));
  }

  function save() {
    if (problem || (kind === "RIDER" && !riderId)) {
      if (problem) toast.error(problem);
      return;
    }
    start(async () => {
      const res = kind === "RETAIL"
        ? await saveRetailReturnReview({ date, entries, notes, clientToken: token })
        : await saveRiderReturnReview({ riderId: riderId!, date, entries, notes, clientToken: token });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(totals.missing > 0 ? `Split saved — ${fmt(totals.missing)} missing is on the Missing log.` : "Split saved — the wasted part is out of stock.");
      onSaved();
      onClose();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{kind === "RETAIL" ? "Retail return" : "Allocate returned items"}</DialogTitle>
          <DialogDescription>
            {!detail?.ok ? "Loading…"
              : "riderId" in detail ? `${detail.riderName} · ${date}`
              : `What Retail had left after loading the shifts · ${date}`}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading these returns…</p>
        ) : !detail || !detail.ok ? (
          <p className="py-8 text-center text-sm text-rose-700">{detail?.error ?? "Could not load this."}</p>
        ) : specs.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {kind === "RETAIL"
              ? "Retail has nothing left over on this day — everything sent across went out with the shifts."
              : "Nothing came back on this shift, and nothing is out with the rider."}
          </p>
        ) : (
          <>
            <div className="rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2 text-xs text-sky-900">
              Returned is not the same as usable. Enter what went <span className="font-medium">into inventory</span> and what was <span className="font-medium">wasted</span>;
              only the usable part stays in stock.{kind === "RIDER"
                ? " Anything left over was never handed to you — it shows as Missing here and goes on the Missing log."
                : " Everything Retail had left has to be accounted for."}
            </div>

            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">
                {kind === "RETAIL"
                  ? "Left over = sent to Retail − what the shifts took."
                  : "Spare stock may be part-returned — the rest was sold on the round."}
              </p>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={allIntoInventory} disabled={pending}>
                Put all into inventory
              </Button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Item</th>
                    <th className="px-3 py-2 text-right font-semibold">{kind === "RETAIL" ? "Left over" : "Returned"}</th>
                    <th className="px-3 py-2 text-left font-semibold">Into inventory</th>
                    <th className="px-3 py-2 text-left font-semibold">Wastage</th>
                    {kind === "RIDER" && <th className="px-3 py-2 text-left font-semibold">Missing</th>}
                    <th className="px-3 py-2 text-left font-semibold">Reason</th>
                    <th className="px-3 py-2 text-right font-semibold">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {specs.map((s) => {
                    const d = drafts[s.key] ?? { stock: "", waste: "", reason: NO_REASON };
                    const e = entries.find((x) => x.key === s.key)!;
                    const lineProblem = validateReturnLine(s, e);
                    const left = Math.round((s.returnedQty - e.stockQty - e.wasteQty) * 1000) / 1000;
                    const missing = missingOf(s, e);
                    const u = uLabel(s.unit);
                    return (
                      <tr key={s.key} className="align-top">
                        <td className="px-3 py-2">
                          <div className="font-medium">{s.productName}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {s.source === "RETAIL" ? "Left with Retail after the shifts were loaded"
                              : s.source === "APP" ? "Handed back at the end of the shift"
                              : `Spare stock · ${fmt(s.givenQty ?? s.returnedQty)} ${u} given`}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums">
                          {fmt(s.returnedQty)} {u}
                          {s.source === "EXTRA" && <div className="text-[10px] font-normal text-muted-foreground">still out</div>}
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            type="number" min="0" step={s.unit === "PIECE" ? "1" : "0.001"} inputMode="decimal"
                            className="h-8 w-24 text-sm" placeholder="0"
                            value={d.stock} onChange={(ev) => set(s.key, { stock: ev.target.value })}
                            aria-label={`${s.productName} into inventory`}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            type="number" min="0" step={s.unit === "PIECE" ? "1" : "0.001"} inputMode="decimal"
                            className="h-8 w-24 text-sm" placeholder="0"
                            value={d.waste} onChange={(ev) => set(s.key, { waste: ev.target.value })}
                            aria-label={`${s.productName} wastage`}
                          />
                        </td>
                        {kind === "RIDER" && (
                          <td className="whitespace-nowrap px-3 py-2 tabular-nums" title="Reported returned by the app, never handed over">
                            {s.source === "APP"
                              ? <span className={cn("font-semibold", missing > 0 ? "text-amber-700" : "text-muted-foreground")}>{fmt(missing)} {u}</span>
                              : <span className="text-[11px] text-muted-foreground">—</span>}
                          </td>
                        )}
                        <td className="px-3 py-2">
                          <Select
                            value={d.reason}
                            onValueChange={(v) => set(s.key, { reason: v })}
                            disabled={!(e.wasteQty > 0)}
                          >
                            <SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Select reason" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_REASON}>Select reason</SelectItem>
                              {RETURN_WASTE_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right text-[11px]">
                          {lineProblem ? (
                            <span className="font-medium text-rose-700">
                              {left > 0 ? `${fmt(left)} ${u} left` : left < 0 ? `${fmt(-left)} ${u} over` : "Check"}
                            </span>
                          ) : missing > 0 ? (
                            <span className="font-medium text-amber-700">{fmt(missing)} {u} missing</span>
                          ) : (
                            <span className="font-medium text-emerald-700">
                              {s.source === "EXTRA" && left > 0 ? `${fmt(left)} ${u} sold` : "Balanced"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                Accounted for: <span className="font-semibold text-foreground">{fmt(totals.returned)}</span> ·
                into inventory <span className="font-semibold text-emerald-700">{fmt(totals.stock)}</span> ·
                wasted <span className="font-semibold text-rose-700">{fmt(totals.waste)}</span>
                {totals.missing > 0 && <> · missing <span className="font-semibold text-amber-700">{fmt(totals.missing)}</span></>}
              </span>
              {detail.reviewedByName && (
                <span className="text-muted-foreground">Last reviewed by {detail.reviewedByName} — saving replaces that split.</span>
              )}
            </div>

            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Note (optional)"
              className="h-9 text-sm"
            />

            {problem && <p className="text-xs font-medium text-rose-700">{problem}</p>}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button
            onClick={save}
            disabled={pending || loading || !detail?.ok || specs.length === 0 || !!problem}
            className={cn(pending && "opacity-70")}
          >
            {pending ? "Saving…" : "Confirm allocation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
