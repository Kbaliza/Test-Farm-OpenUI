"use client";

import { useState, useMemo, useTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Beaker, Trash2, Plus, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  logMixMilkBatch,
  deleteMixMilkBatch,
  getMixMilkAvailability,
  type MixMilkBatchEntry,
  type MixMilkAvailability,
} from "@/app/(dashboard)/inventory/farm-arrival/mix-milk-actions";
import { todayPKTString, toDateStrPKT, fmtDatePKT, fmtTimePKT, addDaysToDateStr } from "@/lib/pkt";

function fmt(n: number) {
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);
}

function findMilk(items: MixMilkAvailability[], keyword: string): MixMilkAvailability | undefined {
  return items.find((i) => i.name.toLowerCase().includes(keyword.toLowerCase()));
}

function StatTile({
  label, value, unit, color,
}: {
  label: string; value: number; unit: string; color: string;
}) {
  return (
    <div className={`rounded-xl border border-border p-4 ${color}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-bold">
        {fmt(value)}{" "}
        <span className="text-sm font-medium text-muted-foreground">{unit}</span>
      </p>
    </div>
  );
}

export function MixMilkClient({
  initialEntries,
  milkAvailability = [],
  locked = false,
}: {
  initialEntries: MixMilkBatchEntry[];
  milkAvailability?: MixMilkAvailability[];
  locked?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [date, setDate] = useState(todayPKTString());
  const lastDay = useRef(todayPKTString());
  useEffect(() => {
    const id = setInterval(() => {
      const today = todayPKTString();
      if (today !== lastDay.current) {
        setDate((prev) => (prev === lastDay.current ? today : prev));
        lastDay.current = today;
      }
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  const [availability, setAvailability] = useState<MixMilkAvailability[]>(milkAvailability);
  useEffect(() => {
    getMixMilkAvailability(date).then(setAvailability);
  }, [date]);

  useEffect(() => {
    const handler = () => getMixMilkAvailability(date).then(setAvailability);
    window.addEventListener("milk:inventory-changed", handler);
    return () => window.removeEventListener("milk:inventory-changed", handler);
  }, [date]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        getMixMilkAvailability(date).then(setAvailability);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [router, date]);

  const [buffaloMilk, setBuffaloMilk] = useState("");
  const [cowMilk,     setCowMilk]     = useState("");
  const [notes,       setNotes]       = useState("");

  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  // Recent batches: the last 3 days only, so the list stays short. A long run of
  // batches within those days scrolls rather than stretching the page.
  const recentEntries = useMemo(() => {
    const cutoff = addDaysToDateStr(todayPKTString(), -2);
    return initialEntries.filter((e) => toDateStrPKT(e.date) >= cutoff);
  }, [initialEntries]);

  const sorted = useMemo(() => {
    if (!sortKey) return recentEntries;
    return [...recentEntries].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return sortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [recentEntries, sortKey, sortDir]);

  const totalMilkInput = (parseFloat(buffaloMilk) || 0) + (parseFloat(cowMilk) || 0);

  const today       = initialEntries.filter((e) => toDateStrPKT(e.date) === date);
  const todayBuf    = today.reduce((s, e) => s + e.buffaloMilk, 0);
  const todayCow    = today.reduce((s, e) => s + e.cowMilk,     0);
  const todayMix    = today.reduce((s, e) => s + e.mixMilkMade, 0);

  const buffaloAvail = findMilk(availability, "buffalo");
  const cowAvail     = findMilk(availability, "cow");

  // Lock the whole panel when there's no milk to mix from — derived from the LIVE
  // availability (which the effects above refresh on date change / inventory
  // events), so changing to a date with no dispatched milk re-locks. Combined with
  // the `locked` prop for a correct first paint before the client refetches.
  // Both pools count: milk dispatched to packaging today AND stock already in
  // inventory. Locking on the dispatch pool alone hid mixable stock.
  const noMilkAvailable = (buffaloAvail?.total ?? 0) <= 0 && (cowAvail?.total ?? 0) <= 0;
  const effectiveLocked = locked || noMilkAvailable;

  function handleSubmit() {
    const buffalo = parseFloat(buffaloMilk) || 0;
    const cow     = parseFloat(cowMilk)     || 0;
    // Mixing buffalo + cow doesn't change the volume, so mix milk made is simply
    // the total milk used — auto-derived, not entered by hand.
    const mix     = totalMilkInput;

    if (buffalo + cow <= 0) {
      toast.error("Enter at least one milk quantity (Buffalo / Cow)."); return;
    }
    // Missing availability = 0 available (block), not "skip the check". The old
    // `&& buffaloAvail.received > 0` guard silently passed when nothing was
    // dispatched — the exact hole that let mix be made from milk that didn't exist.
    const overPool = ([
      { label: "Buffalo Milk", qty: buffalo, pool: buffaloAvail },
      { label: "Cow Milk", qty: cow, pool: cowAvail },
    ] as const).find((c) => c.qty > (c.pool?.total ?? 0) + 0.001);
    if (overPool) {
      toast.error(
        `${overPool.label}: only ${fmt(overPool.pool?.total ?? 0)} L in inventory — cannot use ${fmt(overPool.qty)} L.`
      );
      return;
    }

    startTransition(async () => {
      const res = await logMixMilkBatch({ date, buffaloMilk: buffalo, cowMilk: cow, mixMilkMade: mix, notes });
      if (res.ok) {
        toast.success("Batch logged.");
        setBuffaloMilk(""); setCowMilk(""); setNotes("");
        router.refresh();
        getMixMilkAvailability(date).then(setAvailability);
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      const res = await deleteMixMilkBatch(id);
      if (res.ok) { toast.success("Batch removed."); router.refresh(); }
      else         toast.error(res.error);
    });
  }

  const milkFields = [
    { label: "Buffalo Milk", keyword: "buffalo", value: buffaloMilk, set: setBuffaloMilk, avail: buffaloAvail },
    { label: "Cow Milk",     keyword: "cow",     value: cowMilk,     set: setCowMilk,     avail: cowAvail     },
  ];

  if (effectiveLocked) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Beaker className="size-4" /> Mix Milk Processing
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center text-muted-foreground">
            <Lock className="size-5 opacity-40" />
            <p className="text-sm">Locked until a load from production is accepted above — mix milk is made from what packaging has accepted.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Beaker className="size-4" /> Mix Milk Processing
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 pt-2">

        {/* Today's totals */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatTile label="Buffalo Used Today" value={todayBuf} unit="L"  color="bg-sky-50/60 ring-1 ring-sky-100" />
          <StatTile label="Cow Used Today"     value={todayCow} unit="L"  color="bg-indigo-50/60 ring-1 ring-indigo-100" />
          <StatTile label="Mix Milk Today"     value={todayMix} unit="L"  color="bg-emerald-50/60 ring-1 ring-emerald-100" />
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[380px_1fr]">

          {/* Entry form */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Beaker className="size-4 text-muted-foreground" /> Log Batch
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">

              <div>
                <Label>Date</Label>
                <Input type="date" className="mt-1" value={date} max={todayPKTString()}
                  onChange={(e) => setDate(e.target.value)} />
              </div>

              {/* Milk input */}
              <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Milk Input
                </p>

                {milkFields.map(({ label, keyword, value, set, avail }) => (
                  <div key={keyword}>
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs shrink-0">{label} (L)</Label>
                      {avail && avail.total > 0 ? (
                        <span className="text-[11px] whitespace-nowrap">
                          {/* Inventory reads first because it is drawn on first. */}
                          <span className="font-semibold text-sky-700">{fmt(avail.inStorage)} L in inventory</span>
                          {avail.available > 0 && (
                            <span className="text-muted-foreground"> + {fmt(avail.available)} at packaging</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">no milk to mix from</span>
                      )}
                    </div>
                    <Input
                      type="number"
                      min="0"
                      max={avail && avail.total > 0 ? avail.total : undefined}
                      step="0.1"
                      placeholder="0"
                      className="mt-1 h-8 text-sm"
                      value={value}
                      onChange={(e) => set(e.target.value)}
                    />
                  </div>
                ))}

                {totalMilkInput > 0 && (
                  <div className="flex items-center justify-between rounded-md bg-sky-50 px-3 py-1.5 text-sm">
                    <span className="text-muted-foreground">Total Milk Used</span>
                    <span className="font-semibold tabular-nums text-sky-700">{fmt(totalMilkInput)} L</span>
                  </div>
                )}
              </div>

              <div>
                <Label>Mix Milk Made (L)</Label>
                <div className="mt-1 flex items-center justify-between rounded-md border border-input bg-muted/40 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Auto · same as milk used</span>
                  <span className="font-semibold tabular-nums">{fmt(totalMilkInput)} L</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Added to inventory as produced. The milk used comes out of inventory
                  first, and only draws on today&apos;s packaging stock once inventory runs out.
                </p>
              </div>

              <div>
                <Label>Notes (optional)</Label>
                <Input placeholder="Any remarks…" className="mt-1" value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
              </div>

              <Button className="w-full" onClick={handleSubmit} disabled={pending}>
                <Plus className="mr-1.5 size-4" />
                {pending ? "Saving…" : "Log Batch"}
              </Button>
            </CardContent>
          </Card>

          {/* History table */}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Recent Batches <span className="font-normal normal-case tracking-normal">· last 3 days</span>
            </h3>
            {recentEntries.length === 0 ? (
              <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-muted-foreground">
                <Beaker className="size-6 opacity-40" />
                <p className="text-sm">No batches logged yet.</p>
              </div>
            ) : (
              <div className="max-h-80 overflow-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-[1]">
                    <tr className="border-b border-border bg-muted">
                      {[
                        { key: "date",        label: "Date",        align: "left"  },
                        { key: "buffaloMilk", label: "Buffalo (L)", align: "right" },
                        { key: "cowMilk",     label: "Cow (L)",     align: "right" },
                        { key: "mixMilkMade", label: "Mix Made (L)",align: "right" },
                        { key: "notes",       label: "Notes",       align: "left"  },
                      ].map(({ key, label, align }) => (
                        <th
                          key={key}
                          onClick={() => handleSort(key)}
                          className={`px-4 py-2.5 text-${align} text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60`}
                        >
                          <span className={`inline-flex items-center gap-1 ${align === "right" ? "justify-end" : ""}`}>
                            {label}
                            <span className={sortKey === key ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                              {sortKey === key ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                            </span>
                          </span>
                        </th>
                      ))}
                      <th className="px-3 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sorted.map((e) => (
                      <tr key={e.id} className="hover:bg-muted/20">
                        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                          <div>{fmtDatePKT(e.date)}</div>
                          <div className="text-[10px]">{fmtTimePKT(e.date)}</div>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-xs">
                          {e.buffaloMilk > 0 ? <>{fmt(e.buffaloMilk)} <span className="text-muted-foreground">L</span></> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-xs">
                          {e.cowMilk > 0 ? <>{fmt(e.cowMilk)} <span className="text-muted-foreground">L</span></> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums font-semibold text-emerald-700">
                          {fmt(e.mixMilkMade)} <span className="text-xs font-normal text-muted-foreground">L</span>
                        </td>
                        <td className="max-w-[120px] truncate px-3 py-3 text-xs text-muted-foreground">
                          {e.notes ?? "—"}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <button onClick={() => handleDelete(e.id)} disabled={pending}
                            className="rounded p-1 text-muted-foreground hover:bg-rose-50 hover:text-rose-600 transition-colors"
                            title="Delete batch">
                            <Trash2 className="size-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
