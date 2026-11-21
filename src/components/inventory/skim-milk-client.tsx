"use client";

import { useState, useMemo, useTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FlaskConical, Trash2, Plus, Lock, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  logSkimMilkBatch,
  deleteSkimMilkBatch,
  getTodayMilkAvailability,
  type SkimMilkBatchEntry,
  type MilkAvailability,
} from "@/app/(dashboard)/inventory/skim-milk/actions";
import { todayPKTString, toDateStrPKT, fmtDatePKT, fmtTimePKT } from "@/lib/pkt";

function fmt(n: number) {
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);
}

// Flexible keyword match so names like "Buffalo Milk", "buffalo milk", "Buffalo" all work.
function findMilk(items: MilkAvailability[], keyword: string): MilkAvailability | undefined {
  return items.find((i) => i.name.toLowerCase().includes(keyword.toLowerCase()));
}

function StatTile({
  label, value, unit, color,
  breakdown,
}: {
  label: string; value: number; unit: string; color: string;
  breakdown?: { label: string; value: number }[];
}) {
  return (
    <div className={`rounded-xl border border-border p-4 ${color}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-bold">
        {fmt(value)}{" "}
        <span className="text-sm font-medium text-muted-foreground">{unit}</span>
      </p>
      {breakdown && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5">
          {breakdown.map((b) => (
            <span key={b.label} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{b.label}</span> {fmt(b.value)} {unit}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function SkimMilkClient({
  initialEntries,
  milkAvailability = [],
  locked = false,
}: {
  initialEntries:   SkimMilkBatchEntry[];
  milkAvailability?: MilkAvailability[];
  locked?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  // Auto-advance date at midnight
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

  // Live availability state — refetched whenever the date changes so the user
  // always sees the correct produced/used figures for the selected date.
  const [availability, setAvailability] = useState<MilkAvailability[]>(milkAvailability);
  useEffect(() => {
    getTodayMilkAvailability(date).then(setAvailability);
  }, [date]);

  // React to production / calf-use / kitchen-use saved on the SAME page
  // (ProductionForm and UsageForm dispatch this event after a successful save).
  useEffect(() => {
    const handler = () => getTodayMilkAvailability(date).then(setAvailability);
    window.addEventListener("milk:inventory-changed", handler);
    return () => window.removeEventListener("milk:inventory-changed", handler);
  }, [date]);

  // Also refresh when the user switches back to this tab (production may have
  // been logged on another page while this one was in the background).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        getTodayMilkAvailability(date).then(setAvailability);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [router, date]);

  const [buffaloMilk,   setBuffaloMilk]   = useState("");
  const [cowMilk,       setCowMilk]       = useState("");
  const [creamMade,     setCreamMade]    = useState("");
  const [skimMilkMade,  setSkimMilkMade]  = useState("");
  const [notes,         setNotes]         = useState("");

  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const sorted = useMemo(() => {
    if (!sortKey) return initialEntries;
    return [...initialEntries].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return sortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [initialEntries, sortKey, sortDir]);

  const totalMilkInput =
    (parseFloat(buffaloMilk) || 0) +
    (parseFloat(cowMilk)     || 0);

  // Today's summary from already-logged batches
  const today        = initialEntries.filter((e) => toDateStrPKT(e.date) === date);
  const todayBuffalo = today.reduce((s, e) => s + e.buffaloMilk,  0);
  const todayCow     = today.reduce((s, e) => s + e.cowMilk,      0);
  const todayMilk    = today.reduce((s, e) => s + e.milkUsed,     0);
  const todayCream   = today.reduce((s, e) => s + e.creamMade,    0);
  const todaySkim    = today.reduce((s, e) => s + e.skimMilkMade, 0);

  // Per-keyword matches from inventory movements
  const buffaloAvail = findMilk(availability, "buffalo");
  const cowAvail     = findMilk(availability, "cow");

  // Lock the whole panel when there's no milk to process — derived from the LIVE
  // availability (refreshed on date change / inventory events), OR'd with the
  // `locked` prop for a correct first paint.
  const noMilkAvailable = (buffaloAvail?.available ?? 0) <= 0 && (cowAvail?.available ?? 0) <= 0;
  const effectiveLocked = locked || noMilkAvailable;

  function handleSubmit() {
    const buffalo = parseFloat(buffaloMilk) || 0;
    const cow     = parseFloat(cowMilk)     || 0;
    const cheese  = parseFloat(creamMade);
    const skim    = parseFloat(skimMilkMade);

    if (buffalo + cow <= 0) {
      toast.error("Enter at least one milk quantity (Buffalo / Cow)."); return;
    }
    // Missing availability = 0 available (block), not "skip the check". The old
    // `&& *.produced > 0` guard silently passed when nothing was produced — the
    // same hole the mix page had, letting skim be made from milk that never existed.
    if (buffalo > (buffaloAvail?.available ?? 0))
      { toast.error(`Buffalo Milk: only ${fmt(buffaloAvail?.available ?? 0)} L available — cannot use ${fmt(buffalo)} L.`); return; }
    if (cow > (cowAvail?.available ?? 0))
      { toast.error(`Cow Milk: only ${fmt(cowAvail?.available ?? 0)} L available — cannot use ${fmt(cow)} L.`); return; }
    if (isNaN(cheese) || cheese < 0) { toast.error("Enter cream made."); return; }
    if (isNaN(skim)   || skim   <= 0) { toast.error("Enter skim milk made."); return; }

    startTransition(async () => {
      const res = await logSkimMilkBatch({
        date, buffaloMilk: buffalo, cowMilk: cow, mixMilk: 0,
        creamMade: cheese, skimMilkMade: skim, notes,
      });
      if (res.ok) {
        toast.success("Batch logged.");
        setBuffaloMilk(""); setCowMilk("");
        setCreamMade(""); setSkimMilkMade(""); setNotes("");
        router.refresh();
        getTodayMilkAvailability(date).then(setAvailability);
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      const res = await deleteSkimMilkBatch(id);
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
        <CardHeader className={open ? "pb-2" : undefined}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex w-full items-center justify-between gap-2 text-left"
          >
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConical className="size-4" /> Skim Milk Production
            </CardTitle>
            <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </CardHeader>
        <CardContent hidden={!open}>
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center text-muted-foreground">
            <Lock className="size-5 opacity-40" />
            <p className="text-sm">Save today&apos;s production first — there is no buffalo or cow milk available to process.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className={open ? "pb-2" : undefined}>
        {/* Closed by default — the section is used now and then, not every entry. */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="size-4" /> Skim Milk Production
          </CardTitle>
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </CardHeader>
      <CardContent className="space-y-6 pt-2" hidden={!open}>

        {/* Today's totals */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatTile label="Milk Used Today"   value={todayMilk}   unit="L"  color="bg-sky-50/60 ring-1 ring-sky-100"
            breakdown={[
              { label: "Buffalo", value: todayBuffalo },
              { label: "Cow",     value: todayCow     },
            ]}
          />
          <StatTile label="Cream Made Today" value={todayCream} unit="kg" color="bg-amber-50/60 ring-1 ring-amber-100" />
          <StatTile label="Skim Milk Today"   value={todaySkim}   unit="L"  color="bg-emerald-50/60 ring-1 ring-emerald-100" />
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[380px_1fr]">

          {/* Entry form */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FlaskConical className="size-4 text-muted-foreground" /> Log Batch
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

                      {/* Show available quantity */}
                      {avail && avail.produced > 0 ? (
                        <span className="text-[11px] font-semibold text-sky-700 whitespace-nowrap">
                          {fmt(avail.available)} L avail
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">no production today</span>
                      )}
                    </div>

                    <Input
                      type="number"
                      min="0"
                      max={avail && avail.available > 0 ? avail.available : undefined}
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
                <Label>Cream Made (kg)</Label>
                <Input type="number" min="0" step="0.1" placeholder="0" className="mt-1"
                  value={creamMade} onChange={(e) => setCreamMade(e.target.value)} />
              </div>

              <div>
                <Label>Skim Milk Made (L)</Label>
                <Input type="number" min="0" step="0.1" placeholder="0" className="mt-1"
                  value={skimMilkMade} onChange={(e) => setSkimMilkMade(e.target.value)} />
                <p className="mt-1 text-xs text-muted-foreground">
                  Added to inventory as produced. Milk used is deducted from packaging dispatch.
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
              Recent Batches
            </h3>
            {initialEntries.length === 0 ? (
              <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-muted-foreground">
                <FlaskConical className="size-6 opacity-40" />
                <p className="text-sm">No batches logged yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th
                        onClick={() => handleSort("date")}
                        className="px-4 py-2.5 text-left   text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                      >
                        <span className="inline-flex items-center gap-1">
                          Date
                          <span className={sortKey === "date" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                            {sortKey === "date" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                          </span>
                        </span>
                      </th>
                      <th
                        onClick={() => handleSort("buffaloMilk")}
                        className="px-3 py-2.5 text-right  text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                      >
                        <span className="inline-flex items-center gap-1 justify-end">
                          Buffalo
                          <span className={sortKey === "buffaloMilk" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                            {sortKey === "buffaloMilk" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                          </span>
                        </span>
                      </th>
                      <th
                        onClick={() => handleSort("cowMilk")}
                        className="px-3 py-2.5 text-right  text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                      >
                        <span className="inline-flex items-center gap-1 justify-end">
                          Cow
                          <span className={sortKey === "cowMilk" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                            {sortKey === "cowMilk" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                          </span>
                        </span>
                      </th>
                      <th
                        onClick={() => handleSort("milkUsed")}
                        className="px-3 py-2.5 text-right  text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                      >
                        <span className="inline-flex items-center gap-1 justify-end">
                          Total Used
                          <span className={sortKey === "milkUsed" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                            {sortKey === "milkUsed" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                          </span>
                        </span>
                      </th>
                      <th
                        onClick={() => handleSort("creamMade")}
                        className="px-3 py-2.5 text-right  text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                      >
                        <span className="inline-flex items-center gap-1 justify-end">
                          Cream
                          <span className={sortKey === "creamMade" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                            {sortKey === "creamMade" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                          </span>
                        </span>
                      </th>
                      <th
                        onClick={() => handleSort("skimMilkMade")}
                        className="px-3 py-2.5 text-right  text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                      >
                        <span className="inline-flex items-center gap-1 justify-end">
                          Skim Milk
                          <span className={sortKey === "skimMilkMade" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                            {sortKey === "skimMilkMade" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                          </span>
                        </span>
                      </th>
                      <th
                        onClick={() => handleSort("notes")}
                        className="px-3 py-2.5 text-left   text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                      >
                        <span className="inline-flex items-center gap-1">
                          Notes
                          <span className={sortKey === "notes" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                            {sortKey === "notes" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                          </span>
                        </span>
                      </th>
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
                        <td className="px-3 py-3 text-right tabular-nums font-medium">
                          {fmt(e.milkUsed)} <span className="text-xs text-muted-foreground">L</span>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums font-medium">
                          {fmt(e.creamMade)} <span className="text-xs text-muted-foreground">kg</span>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums font-semibold text-emerald-700">
                          {fmt(e.skimMilkMade)} <span className="text-xs font-normal text-muted-foreground">L</span>
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

