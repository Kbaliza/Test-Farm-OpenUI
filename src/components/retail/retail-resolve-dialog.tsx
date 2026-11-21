"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { unitLabel, isPackUnit, packLabel } from "@/lib/units";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { stepForUnit } from "@/lib/quantity";
import { validateResolution, resolutionTotals, round2 } from "@/lib/retail-math";
import { resolveRetailPlacement, type PlacementView } from "@/app/(dashboard)/retail/actions";
import { fmt, fmtQty } from "./retail-client";

type Entry = { sold: string; wasted: string };

export function RetailResolveDialog({
  placement,
  heads,
  today,
  onClose,
  onSaved,
}: {
  placement: PlacementView | null;
  heads: { head: string; label: string; balance: number }[];
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [date, setDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [paid, setPaid] = useState("");
  const [head, setHead] = useState("CASH");
  // One token per dialog open: submitting twice writes one report, not two.
  const [token, setToken] = useState("");

  useEffect(() => {
    if (!placement) return;
    setEntries(Object.fromEntries(placement.lines.map((l) => [l.id, { sold: "", wasted: "" }])));
    setDate(today);
    setNotes("");
    setPaid("");
    setHead("CASH");
    setToken(`${placement.id}:${Date.now()}:${Math.round(Math.random() * 1e9)}`);
  }, [placement, today]);

  const parsed = useMemo(
    () =>
      (placement?.lines ?? []).map((l) => ({
        lineId: l.id,
        soldQty: parseFloat(entries[l.id]?.sold ?? "") || 0,
        wastedQty: parseFloat(entries[l.id]?.wasted ?? "") || 0,
      })),
    [placement, entries]
  );

  const touched = parsed.filter((e) => e.soldQty > 0.000001 || e.wastedQty > 0.000001);

  // The SAME function the server runs — the hint below can never disagree with
  // the rejection.
  const problem = useMemo(() => {
    if (!placement) return null;
    if (touched.length === 0) return null;
    return validateResolution(placement.lines, touched);
  }, [placement, touched]);

  const totals = useMemo(() => {
    if (!placement) return { soldAmount: 0, wastedValue: 0, wastedCost: 0 as number | null, amounts: {} };
    const rateOf = (lineId: string) => placement.lines.find((l) => l.id === lineId)?.rate ?? 0;
    // Same function, same arguments as the server — so the figure shown here is
    // the figure that gets stored, never an approximation of it.
    const costOf = (lineId: string) => placement.lines.find((l) => l.id === lineId)?.costPrice ?? null;
    return resolutionTotals(touched, rateOf, costOf);
  }, [placement, touched]);

  if (!placement) return null;

  const paidNum = round2(parseFloat(paid) || 0);
  const overPaid = paidNum - totals.soldAmount > 0.005;

  function save() {
    if (touched.length === 0) {
      toast.error("Enter how much sold, or how much expired.");
      return;
    }
    if (problem) {
      toast.error(problem);
      return;
    }
    if (overPaid) {
      toast.error(`They can only pay for what sold — ₨ ${fmt(totals.soldAmount)}.`);
      return;
    }
    start(async () => {
      const res = await resolveRetailPlacement({
        placementId: placement!.id,
        date,
        entries: touched,
        paidAmount: paidNum,
        paymentHead: paidNum > 0.005 ? head : null,
        notes,
        clientToken: token,
      });
      if (res.ok) {
        toast.success(
          totals.soldAmount > 0
            ? `Reported — ₨ ${fmt(totals.soldAmount)} owed${paidNum > 0.005 ? `, ₨ ${fmt(paidNum)} collected` : ""}.`
            : "Reported — nothing sold."
        );
        onClose();
        onSaved();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={!!placement} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>What sold at {placement.martName}?</DialogTitle>
          <DialogDescription>
            {placement.placementNo} · dropped {placement.date}. Anything they have not sold or lost yet stays
            on their shelf for next time.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {placement.lines.map((l) => {
            const e = entries[l.id] ?? { sold: "", wasted: "" };
            const sold = parseFloat(e.sold) || 0;
            const wasted = parseFloat(e.wasted) || 0;
            const left = Math.round((l.openQty - sold - wasted) * 1000) / 1000;
            const settled = l.openQty <= 0.000001;

            return (
              <div key={l.id} className={cn("rounded-lg border border-border p-3", settled && "opacity-60")}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{l.productName}</p>
                  <p className="text-xs text-muted-foreground">
                    {isPackUnit(l.unit)
                      ? `${fmtQty(l.quantity)} × ${packLabel(l.unit, l.packSize) || unitLabel(l.unit)}`
                      : `${fmtQty(l.quantity)} ${unitLabel(l.unit)}`}{" "}
                    dropped
                    {l.soldQty > 0 || l.wastedQty > 0 ? (
                      <>
                        {" "}· already reported {fmtQty(l.soldQty)} sold, {fmtQty(l.wastedQty)} expired
                      </>
                    ) : null}
                    {" "}· <span className="font-semibold text-foreground">{fmtQty(l.openQty)} {unitLabel(l.unit)}</span> unaccounted
                  </p>
                </div>

                {settled ? (
                  <p className="mt-2 text-xs text-emerald-700">Fully accounted for.</p>
                ) : (
                  <>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-[11px] text-emerald-700">Sold</Label>
                        <Input
                          type="number"
                          min={0}
                          step={stepForUnit(l.unit)}
                          placeholder="0"
                          className="mt-1 h-9"
                          value={e.sold}
                          onChange={(ev) => setEntries((p) => ({ ...p, [l.id]: { ...e, sold: ev.target.value } }))}
                        />
                      </div>
                      <div>
                        <Label className="text-[11px] text-rose-700">Expired</Label>
                        <Input
                          type="number"
                          min={0}
                          step={stepForUnit(l.unit)}
                          placeholder="0"
                          className="mt-1 h-9 bg-rose-50/40"
                          value={e.wasted}
                          onChange={(ev) => setEntries((p) => ({ ...p, [l.id]: { ...e, wasted: ev.target.value } }))}
                        />
                      </div>
                    </div>
                    {(sold > 0 || wasted > 0) && (
                      <p
                        className={cn(
                          "mt-1.5 text-[11px] font-medium",
                          left < -0.000001 ? "text-rose-600" : left > 0.000001 ? "text-amber-600" : "text-emerald-700"
                        )}
                      >
                        {left < -0.000001
                          ? `That is ${fmtQty(-left)} ${unitLabel(l.unit)} more than they were left with.`
                          : left > 0.000001
                            ? `${fmtQty(left)} ${unitLabel(l.unit)} still unaccounted — stays on their shelf.`
                            : "All accounted for."}
                      </p>
                    )}
                  </>
                )}
              </div>
            );
          })}

          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/30 p-3">
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wide text-emerald-700">They owe</p>
              <p className="text-lg font-bold tabular-nums text-emerald-700">₨ {fmt(totals.soldAmount)}</p>
            </div>
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wide text-rose-700">Our loss</p>
              <p className="text-lg font-bold tabular-nums text-rose-700">
                {totals.wastedCost == null ? "—" : `₨ ${fmt(totals.wastedCost)}`}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {totals.wastedCost == null
                  ? "no cost set for this product"
                  : `at cost · ₨ ${fmt(totals.wastedValue)} of sales`}
              </p>
            </div>
          </div>

          {totals.soldAmount > 0.005 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Collected now (optional)</Label>
                <div className="mt-1 flex gap-2">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="0"
                    value={paid}
                    onChange={(e) => setPaid(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0 text-xs"
                    onClick={() => setPaid(String(totals.soldAmount))}
                  >
                    Full
                  </Button>
                </div>
                {overPaid && (
                  <p className="mt-1 text-[11px] text-rose-600">
                    More than they owe for this visit (₨ {fmt(totals.soldAmount)}).
                  </p>
                )}
              </div>
              <div>
                <Label className="text-xs">Into</Label>
                <Select value={head} onValueChange={setHead}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {heads.map((h) => (
                      <SelectItem key={h.head} value={h.head}>
                        {h.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Date</Label>
              <Input type="date" className="mt-1" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Notes (optional)</Label>
              <Input className="mt-1" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>

          {problem && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
              {problem}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending || !!problem || touched.length === 0 || overPaid}>
            {pending ? "Saving…" : "Save report"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
