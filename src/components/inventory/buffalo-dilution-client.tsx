"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Droplets, Lock, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getDilutionContext,
  logBuffaloDilution,
  deleteBuffaloDilution,
  type DilutionContext,
} from "@/app/(dashboard)/inventory/farm-arrival/dilution-actions";
import { preparedBuffalo, cowLeft, dilutionProblem, splitDilutionSource } from "@/lib/buffalo-dilution";
import { hasTooManyDecimals, QTY_DECIMALS } from "@/lib/quantity";
import { todayPKTString, fmtTimePKT } from "@/lib/pkt";

function fmt(n: number) {
  return n % 1 === 0 ? n.toFixed(0) : String(Math.round(n * 1000) / 1000);
}

export function BuffaloDilutionClient({ initial }: { initial: DilutionContext }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [date, setDate] = useState(todayPKTString());
  const [ctx, setCtx] = useState<DilutionContext>(initial);
  // A page refresh (e.g. after a load is accepted above) brings a new `initial`;
  // take it, or the section keeps showing the copy it started with.
  const [seeded, setSeeded] = useState(initial);
  if (initial !== seeded) {
    setSeeded(initial);
    setCtx(initial);
  }
  const [cowMilk, setCowMilk] = useState("");
  const [notes, setNotes] = useState("");

  // Keep the two sides live: production saved, milk used elsewhere, a batch
  // deleted — all of it moves what is available to give away.
  async function refresh(d: string) {
    setCtx(await getDilutionContext(d));
  }
  useEffect(() => { refresh(date); }, [date]);
  useEffect(() => {
    const handler = () => refresh(date);
    window.addEventListener("milk:inventory-changed", handler);
    return () => window.removeEventListener("milk:inventory-changed", handler);
  }, [date]);

  const buffaloName = ctx.buffalo?.name ?? "Buffalo Milk";
  const cowName = ctx.cow?.name ?? "Cow Milk";
  const buffaloReceived = ctx.buffalo?.received ?? 0;
  const buffaloNow = ctx.buffalo?.available ?? 0;
  // Cow milk may come from two places: what was dispatched to packaging today,
  // and what is already sitting in inventory. Inventory is used FIRST — see
  // splitDilutionSource. Buffalo has no such split (its inventory is already
  // standardised milk), so ctx.buffalo.inStorage is always 0 by construction.
  const cowToday = ctx.cow?.available ?? 0;
  const cowStorage = ctx.cow?.inStorage ?? 0;
  const cowAvailable = ctx.cow?.total ?? 0;

  const typed = cowMilk === "" ? 0 : parseFloat(cowMilk);
  const entered = Number.isFinite(typed) ? typed : 0;
  const previewPrepared = preparedBuffalo(buffaloNow, entered);
  const previewCowLeft = cowLeft(cowAvailable, entered);
  const overAvailable = entered > cowAvailable + 0.001;
  // Where this particular entry would be drawn from, using the same function
  // the save action uses, so the preview cannot drift from what is written.
  const split = splitDilutionSource(entered, cowToday, cowStorage);

  function save() {
    const problem = dilutionProblem({ cowAdded: entered, cowAvailable, cowName });
    if (problem) { toast.error(problem); return; }
    if (hasTooManyDecimals(entered)) {
      toast.error(`${cowName}: use at most ${QTY_DECIMALS} decimal places.`);
      return;
    }
    start(async () => {
      const res = await logBuffaloDilution({ date, cowMilk: entered, notes });
      if (res.ok) {
        toast.success(`${fmt(entered)} L of ${cowName} added to ${buffaloName}.`);
        setCowMilk("");
        setNotes("");
        await refresh(date);
        router.refresh();
        window.dispatchEvent(new CustomEvent("milk:inventory-changed"));
      } else {
        toast.error(res.error);
      }
    });
  }

  function remove(id: string) {
    start(async () => {
      const res = await deleteBuffaloDilution(id);
      if (res.ok) {
        toast.success("Entry removed — the milk goes back to where it came from.");
        await refresh(date);
        router.refresh();
        window.dispatchEvent(new CustomEvent("milk:inventory-changed"));
      } else {
        toast.error(res.error);
      }
    });
  }

  if (ctx.locked) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Droplets className="size-4" /> Buffalo Milk Preparation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center text-muted-foreground">
            <Lock className="size-5 opacity-40" />
            <p className="text-sm">Locked until a load from production is accepted above — the buffalo is prepared from what packaging has accepted.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Droplets className="size-4" /> Buffalo Milk Preparation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 pt-2">
        {/* Today at a glance — produced vs prepared, side by side */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-sky-50/60 p-4 ring-1 ring-sky-100">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{buffaloName}</p>
            <p className="mt-2 text-2xl font-bold">
              {fmt(buffaloNow)}{" "}
              <span className="text-sm font-medium text-muted-foreground">L produced</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {fmt(buffaloReceived)} L accepted from production today
              {ctx.addedToday > 0 && <> · <span className="font-medium text-sky-700">+{fmt(ctx.addedToday)} L cow added</span></>}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-emerald-50/60 p-4 ring-1 ring-emerald-100">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{cowName}</p>
            <p className="mt-2 text-2xl font-bold">
              {fmt(cowAvailable)}{" "}
              <span className="text-sm font-medium text-muted-foreground">L available</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">In inventory</p>
            {/* "Dispatched here" is left out on purpose — the line above already
                gives today's production. What went to the buffalo still shows. */}
            {ctx.addedToday > 0 && (
              <p className="mt-0.5 text-xs font-medium text-emerald-700">−{fmt(ctx.addedToday)} L to buffalo</p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[340px_1fr]">
          {/* Entry form */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Droplets className="size-4 text-muted-foreground" /> Add cow milk
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-xs">Date</Label>
                <Input type="date" className="mt-1" value={date} max={todayPKTString()}
                  onChange={(e) => setDate(e.target.value)} />
              </div>

              <div>
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs shrink-0">{cowName} to add (L)</Label>
                  <span className="text-[11px] whitespace-nowrap text-muted-foreground">
                    here now: <span className="font-semibold text-foreground">{fmt(cowAvailable)} L</span>
                  </span>
                </div>
                <Input
                  type="number"
                  min="0"
                  max={cowAvailable > 0 ? cowAvailable : undefined}
                  step="0.01"
                  placeholder="0"
                  className="mt-1 text-lg font-semibold"
                  value={cowMilk}
                  onChange={(e) => setCowMilk(e.target.value)}
                />
                {entered > 0 && (
                  <>
                    <p className={`mt-1.5 text-xs font-medium ${overAvailable ? "text-rose-600" : "text-muted-foreground"}`}>
                      {overAvailable
                        ? `Only ${fmt(cowAvailable)} L of ${cowName} is here.`
                        : `${buffaloName} goes on as ${fmt(previewPrepared)} L · ${cowName} as ${fmt(previewCowLeft)} L`}
                    </p>
                    {!overAvailable && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Taken from inventory <span className="font-semibold text-foreground">{fmt(split.fromStorage + split.fromPackaging)} L</span>
                      </p>
                    )}
                  </>
                )}
              </div>

              <div>
                <Label className="text-xs">Notes (optional)</Label>
                <Input className="mt-1" placeholder="Any remarks…" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>

              <Button className="w-full" onClick={save} disabled={pending || entered <= 0 || overAvailable}>
                <Plus className="size-4" />
                {pending ? "Saving…" : "Add to buffalo milk"}
              </Button>
            </CardContent>
          </Card>

          {/* Today's entries */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Today&apos;s entries</CardTitle>
            </CardHeader>
            <CardContent>
              {ctx.entries.length === 0 ? (
                <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                  Nothing added yet today.
                </div>
              ) : (
                // Same column layout as the mix milk batches: what the buffalo was,
                // how much cow milk went in, and the buffalo that came out.
                <div className="max-h-72 overflow-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-muted/60 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Time</th>
                        <th className="px-3 py-2 text-right font-medium">{buffaloName} before (L)</th>
                        <th className="px-3 py-2 text-right font-medium">{cowName} added (L)</th>
                        <th className="px-3 py-2 text-right font-medium">New {buffaloName} (L)</th>
                        <th className="px-3 py-2 text-left font-medium">Notes</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {ctx.entries.map((e, i) => (
                        <tr key={e.id} className={i % 2 ? "bg-muted/20" : ""}>
                          <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fmtTimePKT(e.date)}</td>
                          <td className="px-3 py-2 text-right">{fmt(e.buffaloBase)}</td>
                          <td className="px-3 py-2 text-right text-sky-700">+{fmt(e.cowMilkAdded)}</td>
                          <td className="px-3 py-2 text-right font-semibold">{fmt(e.buffaloBase + e.cowMilkAdded)}</td>
                          <td className="px-3 py-2 text-muted-foreground">{e.notes || "—"}</td>
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => remove(e.id)}
                              disabled={pending}
                              className="rounded p-1 text-muted-foreground transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                              title="Remove this entry"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </CardContent>
    </Card>
  );
}
