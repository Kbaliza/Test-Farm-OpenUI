"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Search, Settings2, Milk } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { addDaysToDateStr, fmtDatePKT, yesterdayPKTString } from "@/lib/pkt";
import { adjustBottles, getBottleLedger, recordBottleReturn, setShiftBottles, type BottlesPage } from "@/app/(dashboard)/customers/bottles/actions";
// Types only: the module itself is server-only and never bundled here.
import type { BottleCustomer, BottleLedgerRow, BottleShift } from "@/lib/bottles";

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

function StatCard({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground sm:text-xs">{label}</p>
      <p className={cn("mt-1 text-xl font-semibold tabular-nums sm:text-2xl", cls)}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

type Preset = "today" | "yesterday" | "7" | "15" | "30" | "custom";
const PRESETS: [Exclude<Preset, "custom">, string][] = [["today", "Today"], ["yesterday", "Yesterday"], ["7", "7 days"], ["15", "15 days"], ["30", "30 days"]];
function presetRange(p: Exclude<Preset, "custom">, today: string): [string, string] {
  if (p === "today") return [today, today];
  if (p === "yesterday") { const y = yesterdayPKTString(); return [y, y]; }
  return [addDaysToDateStr(today, -(Number(p) - 1)), today];
}

type Tab = "customers" | "riders" | "shifts";
type SortKey = "name" | "given" | "returned" | "rate" | "held";

export function BottlesClient({ data, today }: { data: BottlesPage; today: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [tab, setTab] = useState<Tab>("customers");
  const [filter, setFilter] = useState<"all" | "holding" | "clear">("all");
  const [shiftFilter, setShiftFilter] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "held", dir: -1 });
  const [open, setOpen] = useState<BottleCustomer | null>(null);
  const [shiftsOpen, setShiftsOpen] = useState(false);

  const preset = (PRESETS.find(([k]) => { const [f, t] = presetRange(k, today); return f === data.from && t === data.to; })?.[0] ?? "custom") as Preset;
  function applyRange(from: string, to: string) {
    const p = new URLSearchParams({ from, to });
    start(() => router.push(`/customers/bottles?${p}`, { scroll: false }));
  }

  const onBottles = data.shifts.filter((s) => s.bottlesSince);
  const all = data.customers;
  const holding = all.filter((c) => c.held > 0);
  const totals = {
    given: all.reduce((s, c) => s + c.given, 0),
    returned: all.reduce((s, c) => s + c.returned, 0),
    held: all.reduce((s, c) => s + c.held, 0),
  };

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = all.filter((c) => {
      if (filter === "holding" && c.held <= 0) return false;
      if (filter === "clear" && c.held > 0) return false;
      if (shiftFilter && c.shiftId !== shiftFilter) return false;
      return !s || c.name.toLowerCase().includes(s) || c.customerCode.toLowerCase().includes(s) || (c.area ?? "").toLowerCase().includes(s) || c.phone.includes(s);
    });
    const val = (c: BottleCustomer) => sort.key === "name" ? c.name.toLowerCase() : sort.key === "rate" ? (c.given ? c.returned / c.given : -1) : c[sort.key];
    return list.sort((a, b) => { const x = val(a), y = val(b); return typeof x === "string" ? sort.dir * x.localeCompare(y as string) : sort.dir * ((x as number) - (y as number)); });
  }, [all, filter, shiftFilter, q, sort]);

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "name" ? 1 : -1 }));
  // A render function, not a component: a component declared here would be a new
  // one every render and remount its cell.
  const th = (k: SortKey, label: string, right = false) => (
    <th key={k} className={cn("cursor-pointer select-none px-3 py-2 font-medium hover:text-foreground", right && "text-right")} onClick={() => sortBy(k)}>
      <span className="inline-flex items-center gap-1">{label}{sort.key === k ? (sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ArrowUpDown className="size-3 opacity-40" />}</span>
    </th>
  );

  // Per rider (by shift): given, collected, still with their customers.
  const byShift = onBottles.map((s) => {
    const cs = all.filter((c) => c.shiftId === s.id);
    const given = cs.reduce((t, c) => t + c.given, 0), returned = cs.reduce((t, c) => t + c.returned, 0), held = cs.reduce((t, c) => t + c.held, 0);
    return { ...s, served: cs.filter((c) => c.visits > 0).length, given, returned, held, holding: cs.filter((c) => c.held > 0).length };
  });
  const rate = (g: number, r: number) => (g ? Math.min(100, Math.round((r / g) * 100)) : null);

  return (
    <div className="space-y-4 p-3 sm:p-6">
      {/* Range */}
      <div className="flex flex-wrap items-end gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5">
        <div>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Range</label>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map(([k, l]) => (
              <Button key={k} size="sm" variant={preset === k ? "default" : "outline"} className="h-9 px-3 text-sm" disabled={pending}
                onClick={() => { const [f, t] = presetRange(k, today); applyRange(f, t); }}>{l}</Button>
            ))}
          </div>
        </div>
        <div className="grid w-full grid-cols-2 gap-3 sm:flex sm:w-auto">
          <div>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-muted-foreground">From</label>
            <input type="date" value={data.from} max={today} onChange={(e) => e.target.value && applyRange(e.target.value, data.to)} className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm tabular-nums" />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-muted-foreground">To</label>
            <input type="date" value={data.to} min={data.from} max={today} onChange={(e) => e.target.value && applyRange(data.from, e.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm tabular-nums" />
          </div>
        </div>
        {pending && <Loader2 className="mb-2.5 size-4 animate-spin text-muted-foreground" />}
        <Button size="sm" variant="outline" className="h-9 w-full text-sm sm:ml-auto sm:w-auto" onClick={() => setShiftsOpen(true)}>
          <Settings2 className="mr-1.5 size-3.5" /> Bottle shifts <span className="ml-1.5 rounded-full bg-muted px-1.5 text-xs">{onBottles.length}</span>
        </Button>
      </div>

      {onBottles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          <Milk className="mx-auto mb-2 size-6 opacity-40" />
          No shift is on bottles yet. Open <b>Bottle shifts</b> and switch the first one over.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Bottles given" value={totals.given.toLocaleString("en-PK")} sub={`in ${fmtDatePKT(data.from)}${data.from !== data.to ? ` – ${fmtDatePKT(data.to)}` : ""}`} />
            <StatCard label="Bottles returned" value={totals.returned.toLocaleString("en-PK")} sub={rate(totals.given, totals.returned) == null ? "nothing given yet" : `${rate(totals.given, totals.returned)}% of those given`} cls="text-emerald-700" />
            <StatCard label="Still with customers" value={totals.held.toLocaleString("en-PK")} sub={`${holding.length} customer${holding.length === 1 ? "" : "s"} holding bottles`} cls={totals.held > 0 ? "text-rose-700" : "text-emerald-700"} />
            <StatCard label="Customers" value={String(all.length)} sub={`on ${onBottles.length} bottle shift${onBottles.length === 1 ? "" : "s"}`} />
          </div>

          {/* Tabs */}
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1 sm:flex sm:w-fit">
            {([["customers", "Customer balances", "Customers"], ["riders", "Rider summary", "Riders"], ["shifts", "Shifts on bottles", "Shifts"]] as const).map(([k, l, short]) => (
              <button key={k} type="button" onClick={() => setTab(k)} className={cn("rounded-md px-3 py-1.5 text-sm font-medium", tab === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                <span className="sm:hidden">{short}</span><span className="hidden sm:inline">{l}</span>
              </button>
            ))}
          </div>

          {tab === "customers" && (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
                <div className="flex gap-1 rounded-md bg-muted p-0.5">
                  {([["all", "All"], ["holding", "Holding"], ["clear", "Settled"]] as const).map(([k, l]) => (
                    <button key={k} type="button" onClick={() => setFilter(k)} className={cn("rounded px-2.5 py-1 text-sm font-medium", filter === k ? "bg-card shadow-sm" : "text-muted-foreground")}>{l}</button>
                  ))}
                </div>
                <select value={shiftFilter} onChange={(e) => setShiftFilter(e.target.value)} className="order-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm sm:order-none sm:w-auto">
                  <option value="">All bottle shifts</option>
                  {onBottles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <span className="text-sm text-muted-foreground">{rows.length} of {all.length}</span>
                <div className="relative order-2 ml-auto w-full sm:order-none sm:w-60">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, code, area or phone…" className="h-9 pl-8 text-sm" />
                </div>
              </div>
              {/* Phone: one card per customer, sorted by the select below. */}
              <div className="sm:hidden">
                <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Sort</span>
                  <select value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [k, d] = e.target.value.split(":"); setSort({ key: k as SortKey, dir: Number(d) as 1 | -1 }); }} className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm">
                    <option value="held:-1">Holds most</option>
                    <option value="held:1">Holds least</option>
                    <option value="rate:1">Worst return %</option>
                    <option value="rate:-1">Best return %</option>
                    <option value="given:-1">Given most</option>
                    <option value="name:1">Name A–Z</option>
                  </select>
                </div>
                {rows.length === 0 ? (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">No customers match.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {rows.map((c) => {
                      const r = rate(c.given, c.returned);
                      return (
                        <button key={c.customerId} type="button" onClick={() => setOpen(c)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left active:bg-muted/40">
                          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{initials(c.name)}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-primary">{c.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">{c.customerCode}{c.area ? ` · ${c.area}` : ""} · {c.shiftName}</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              Given <b className="text-foreground tabular-nums">{c.given}</b> · Back <b className="text-foreground tabular-nums">{c.returned}</b>
                              {r != null && <> · <b className={cn(r >= 80 ? "text-emerald-700" : r >= 50 ? "text-amber-700" : "text-rose-700")}>{r}%</b></>}
                            </span>
                          </span>
                          <span className={cn("shrink-0 text-right text-xl font-semibold tabular-nums", c.held > 0 ? "text-rose-700" : c.held < 0 ? "text-amber-700" : "text-emerald-700")}>
                            {c.held}<span className="block text-[10px] font-medium uppercase text-muted-foreground">{c.held < 0 ? "extra back" : "holds"}</span>
                          </span>
                        </button>
                      );
                    })}
                    <div className="flex items-center justify-between bg-muted/40 px-3 py-2.5 text-sm font-semibold">
                      <span>{filter === "all" && !shiftFilter && !q ? "All customers" : "Shown"}</span>
                      <span className="tabular-nums">Given {rows.reduce((t, c) => t + c.given, 0)} · Back {rows.reduce((t, c) => t + c.returned, 0)} · <span className="text-rose-700">Holds {rows.reduce((t, c) => t + c.held, 0)}</span></span>
                    </div>
                  </div>
                )}
              </div>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[760px] text-[15px]">
                  <thead className="bg-muted/40 text-left text-sm text-muted-foreground">
                    <tr>
                      {th("name", "Customer")}
                      <th className="px-3 py-2 font-medium">Shift · rider</th>
                      {th("given", "Given", true)}
                      {th("returned", "Returned", true)}
                      {th("rate", "Return %", true)}
                      {th("held", "Holds", true)}
                      <th className="px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.length === 0 ? (
                      <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">No customers match.</td></tr>
                    ) : rows.map((c) => {
                      const r = rate(c.given, c.returned);
                      return (
                        <tr key={c.customerId} className="cursor-pointer hover:bg-muted/30" onClick={() => setOpen(c)} title="Open the bottle history">
                          <td className="px-3 py-2">
                            <span className="flex items-center gap-2.5">
                              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{initials(c.name)}</span>
                              <span className="min-w-0">
                                <span className="block font-medium text-primary">{c.name}</span>
                                <span className="block text-xs text-muted-foreground">{c.customerCode}{c.area ? ` · ${c.area}` : ""}</span>
                              </span>
                            </span>
                          </td>
                          <td className="px-3 py-2 text-sm text-muted-foreground">{c.shiftName}{c.riderName ? <span className="block text-xs">{c.riderName}</span> : null}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{c.given || "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{c.returned || "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r == null ? <span className="text-muted-foreground">—</span> : <span className={cn("font-medium", r >= 80 ? "text-emerald-700" : r >= 50 ? "text-amber-700" : "text-rose-700")}>{r}%</span>}</td>
                          <td className={cn("px-3 py-2 text-right text-base font-semibold tabular-nums", c.held > 0 ? "text-rose-700" : c.held < 0 ? "text-amber-700" : "text-emerald-700")}>{c.held}</td>
                          <td className="px-3 py-2">
                            {c.held > 0 ? <span className="rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-medium text-rose-700">Holds {c.held}</span>
                              : c.held < 0 ? <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">{-c.held} extra back</span>
                              : <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">Settled</span>}
                          </td>
                        </tr>
                      );
                    })}
                    {rows.length > 0 && (
                      <tr className="bg-muted/40 font-semibold">
                        <td className="px-3 py-2.5" colSpan={2}>{filter === "all" && !shiftFilter && !q ? "All customers" : "Shown"}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{rows.reduce((s, c) => s + c.given, 0)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{rows.reduce((s, c) => s + c.returned, 0)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{rate(rows.reduce((s, c) => s + c.given, 0), rows.reduce((s, c) => s + c.returned, 0)) ?? "—"}{rate(rows.reduce((s, c) => s + c.given, 0), rows.reduce((s, c) => s + c.returned, 0)) == null ? "" : "%"}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-rose-700">{rows.reduce((s, c) => s + c.held, 0)}</td>
                        <td />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "riders" && (
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card sm:hidden">
              {byShift.map((s) => { const r = rate(s.given, s.returned); return (
                <div key={s.id} className="px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block font-medium">{s.riderName ?? "No rider"}</span>
                      <span className="block text-xs text-muted-foreground">{s.name} · since {fmtDatePKT(s.bottlesSince!)}</span>
                    </span>
                    <span className={cn("shrink-0 text-right text-xl font-semibold tabular-nums", s.held > 0 ? "text-rose-700" : "text-emerald-700")}>
                      {s.held}<span className="block text-[10px] font-medium uppercase text-muted-foreground">still out · {s.holding} cust.</span>
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Served <b className="text-foreground">{s.served}</b> · Given <b className="text-foreground">{s.given}</b> · Collected <b className="text-foreground">{s.returned}</b></span>
                    {r != null && (
                      <span className="ml-auto inline-flex items-center gap-1.5">
                        <span className="inline-block h-1.5 w-14 overflow-hidden rounded-full bg-muted"><span className={cn("block h-full rounded-full", r >= 80 ? "bg-emerald-600" : r >= 50 ? "bg-amber-500" : "bg-rose-600")} style={{ width: `${r}%` }} /></span>
                        <b className={cn(r >= 80 ? "text-emerald-700" : r >= 50 ? "text-amber-700" : "text-rose-700")}>{r}%</b>
                      </span>
                    )}
                  </div>
                </div>
              ); })}
              <div className="flex items-center justify-between bg-muted/40 px-3 py-2.5 text-sm font-semibold">
                <span>All riders</span>
                <span className="tabular-nums">Given {totals.given} · Back {totals.returned} · <span className="text-rose-700">Out {totals.held}</span></span>
              </div>
            </div>
          )}
          {tab === "riders" && (
            <div className="hidden overflow-x-auto rounded-xl border border-border bg-card sm:block">
              <table className="w-full min-w-[720px] text-[15px]">
                <thead className="bg-muted/40 text-left text-sm text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Shift · rider</th>
                    <th className="px-3 py-2 text-right font-medium">Customers served</th>
                    <th className="px-3 py-2 text-right font-medium">Given</th>
                    <th className="px-3 py-2 text-right font-medium">Collected</th>
                    <th className="px-3 py-2 text-right font-medium">Collection rate</th>
                    <th className="px-3 py-2 text-right font-medium">Still out</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {byShift.map((s) => { const r = rate(s.given, s.returned); return (
                    <tr key={s.id}>
                      <td className="px-3 py-2"><span className="block font-medium">{s.riderName ?? "No rider"}</span><span className="block text-xs text-muted-foreground">{s.name} · on bottles since {fmtDatePKT(s.bottlesSince!)}</span></td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.served}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.given}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.returned}</td>
                      <td className="px-3 py-2 text-right">
                        {r == null ? <span className="text-muted-foreground">—</span> : (
                          <span className="inline-flex items-center justify-end gap-2">
                            <span className="inline-block h-2 w-24 overflow-hidden rounded-full bg-muted"><span className={cn("block h-full rounded-full", r >= 80 ? "bg-emerald-600" : r >= 50 ? "bg-amber-500" : "bg-rose-600")} style={{ width: `${r}%` }} /></span>
                            <span className={cn("font-semibold tabular-nums", r >= 80 ? "text-emerald-700" : r >= 50 ? "text-amber-700" : "text-rose-700")}>{r}%</span>
                          </span>
                        )}
                      </td>
                      <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", s.held > 0 ? "text-rose-700" : "text-emerald-700")}>{s.held}<span className="ml-1 text-xs font-normal text-muted-foreground">({s.holding} cust.)</span></td>
                    </tr>
                  ); })}
                  <tr className="bg-muted/40 font-semibold">
                    <td className="px-3 py-2.5">All riders</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{byShift.reduce((t, s) => t + s.served, 0)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{totals.given}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{totals.returned}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{rate(totals.given, totals.returned) ?? "—"}{rate(totals.given, totals.returned) == null ? "" : "%"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-rose-700">{totals.held}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {tab === "shifts" && <ShiftsTable shifts={data.shifts} today={today} onChanged={() => router.refresh()} />}
        </>
      )}

      {shiftsOpen && (
        <Dialog open onOpenChange={(v) => { if (!v) setShiftsOpen(false); }}>
          <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Bottle shifts</DialogTitle>
              <DialogDescription className="text-sm">Switch a shift to glass bottles from a day. From that day every litre of milk delivered on it counts as a bottle the customer holds. Deliveries before it were packets and are not counted.</DialogDescription>
            </DialogHeader>
            <ShiftsTable shifts={data.shifts} today={today} onChanged={() => router.refresh()} />
          </DialogContent>
        </Dialog>
      )}

      {open && <LedgerDialog c={open} today={today} onClose={() => setOpen(null)} onChanged={() => router.refresh()} />}
    </div>
  );
}

function ShiftsTable({ shifts, today, onChanged }: { shifts: BottleShift[]; today: string; onChanged: () => void }) {
  const [busy, start] = useTransition();
  const [dates, setDates] = useState<Record<string, string>>({});
  const act = (id: string, since: string | null) => start(async () => {
    const r = await setShiftBottles(id, since);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(since ? "Shift is on bottles." : "Shift is back on packets.");
    onChanged();
  });
  return (
    <>
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card sm:hidden">
      {shifts.map((s) => (
        <div key={s.id} className="space-y-2 px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="block font-medium">{s.name}</span>
              <span className="block text-xs text-muted-foreground">{s.riderName ?? "No rider"} · {s.customers} customer{s.customers === 1 ? "" : "s"}</span>
            </span>
            {s.bottlesSince
              ? <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">Bottles since {fmtDatePKT(s.bottlesSince)}</span>
              : <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">Packets</span>}
          </div>
          {s.onRoadSince ? (
            <p className="text-xs text-amber-700">On the road — can be switched once today&apos;s round is finished.</p>
          ) : s.bottlesSince ? (
            <Button size="sm" variant="outline" className="h-9 w-full text-sm" disabled={busy} onClick={() => { if (confirm(`Put ${s.name} back on packets? Returns already recorded are kept.`)) act(s.id, null); }}>Back to packets</Button>
          ) : (
            <div className="flex items-center gap-2">
              <input type="date" value={dates[s.id] ?? today} max={today} onChange={(e) => setDates((d) => ({ ...d, [s.id]: e.target.value }))} className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm tabular-nums" />
              <Button size="sm" className="h-9 text-sm" disabled={busy} onClick={() => act(s.id, dates[s.id] ?? today)}>Start bottles</Button>
            </div>
          )}
        </div>
      ))}
    </div>
    <div className="hidden overflow-x-auto rounded-xl border border-border bg-card sm:block">
      <table className="w-full min-w-[560px] text-[15px]">
        <thead className="bg-muted/40 text-left text-sm text-muted-foreground">
          <tr><th className="px-3 py-2 font-medium">Shift</th><th className="px-3 py-2 font-medium">Rider</th><th className="px-3 py-2 text-right font-medium">Customers</th><th className="px-3 py-2 font-medium">Bottles</th><th className="px-3 py-2 text-right font-medium" /></tr>
        </thead>
        <tbody className="divide-y divide-border">
          {shifts.map((s) => (
            <tr key={s.id}>
              <td className="px-3 py-2 font-medium">{s.name}</td>
              <td className="px-3 py-2 text-sm text-muted-foreground">{s.riderName ?? "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{s.customers}</td>
              <td className="px-3 py-2">
                {s.bottlesSince
                  ? <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">On bottles since {fmtDatePKT(s.bottlesSince)}</span>
                  : <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">Packets</span>}
              </td>
              <td className="px-3 py-2 text-right">
                {s.onRoadSince ? (
                  <span className="text-xs text-amber-700">On the road — switch once the round is finished</span>
                ) : s.bottlesSince ? (
                  <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => { if (confirm(`Put ${s.name} back on packets? Returns already recorded are kept.`)) act(s.id, null); }}>Back to packets</Button>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <input type="date" value={dates[s.id] ?? today} max={today} onChange={(e) => setDates((d) => ({ ...d, [s.id]: e.target.value }))} className="h-8 rounded-md border border-border bg-background px-2 text-xs tabular-nums" />
                    <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={() => act(s.id, dates[s.id] ?? today)}>Start bottles</Button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}

function LedgerDialog({ c, today, onClose, onChanged }: { c: BottleCustomer; today: string; onClose: () => void; onChanged: () => void }) {
  const [led, setLed] = useState<{ since: string | null; rows: BottleLedgerRow[]; held: number } | null>(null);
  const [loading, load] = useTransition();
  const [saving, save] = useTransition();
  const [retDate, setRetDate] = useState(today);
  const [retQty, setRetQty] = useState("");
  const [adjQty, setAdjQty] = useState("");
  const [adjReason, setAdjReason] = useState("");
  const refresh = () => load(async () => setLed(await getBottleLedger(c.customerId)));
  // The history is fetched once the dialog opens; it stays until a save refreshes it.
  useEffect(() => { load(async () => setLed(await getBottleLedger(c.customerId))); }, [c.customerId]);

  const doReturn = () => save(async () => {
    const r = await recordBottleReturn({ customerId: c.customerId, date: retDate, returned: Number(retQty) });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success("Return recorded."); setRetQty(""); refresh(); onChanged();
  });
  const doAdjust = () => save(async () => {
    const r = await adjustBottles({ customerId: c.customerId, date: today, bottles: Number(adjQty), reason: adjReason });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success("Correction saved."); setAdjQty(""); setAdjReason(""); refresh(); onChanged();
  });
  const held = led?.held ?? c.held;
  const totGiven = led?.rows.reduce((s, r) => s + r.given, 0) ?? 0, totBack = led?.rows.reduce((s, r) => s + r.returned, 0) ?? 0;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{initials(c.name)}</span>
            <span>{c.name} <span className="text-sm font-normal text-muted-foreground">{c.customerCode}</span></span>
          </DialogTitle>
          <DialogDescription className="text-sm">{[c.address, c.phone, c.shiftName, c.riderName].filter(Boolean).join(" · ")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2">
          <StatCard label="Bottles given" value={String(totGiven)} />
          <StatCard label="Empties back" value={String(totBack)} />
          <StatCard label="Holds now" value={String(held)} cls={held > 0 ? "text-rose-700" : "text-emerald-700"} />
        </div>

        <div className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Record empties returned</p>
            <div className="flex items-center gap-1.5">
              <input type="date" value={retDate} max={today} onChange={(e) => setRetDate(e.target.value)} className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm tabular-nums" />
              <Input type="number" min="0" inputMode="numeric" value={retQty} onChange={(e) => setRetQty(e.target.value)} placeholder="bottles" className="h-9 w-20 text-sm" />
              <Button size="sm" className="h-9 text-sm" disabled={saving || retQty === ""} onClick={doReturn}>Save</Button>
            </div>
            <p className="text-xs text-muted-foreground">Replaces what was recorded for that day. 0 removes it.</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Correction (write off / opening)</p>
            <div className="flex items-center gap-1.5">
              <Input type="number" inputMode="numeric" value={adjQty} onChange={(e) => setAdjQty(e.target.value)} placeholder="−3 or +5" className="h-9 w-20 shrink-0 text-sm" />
              <Input value={adjReason} onChange={(e) => setAdjReason(e.target.value)} placeholder="Reason" className="h-9 min-w-0 text-sm" />
              <Button size="sm" variant="outline" className="h-9 text-sm" disabled={saving || !adjQty || !adjReason.trim()} onClick={doAdjust}>Save</Button>
            </div>
            <p className="text-xs text-muted-foreground">Minus = fewer to collect (broken, lost). Plus = they hold more than recorded.</p>
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">History {led?.since ? `· since ${fmtDatePKT(led.since)}` : ""}</p>
          {loading && !led ? <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>
            : !led?.rows.length ? <p className="py-4 text-center text-sm text-muted-foreground">No bottles given yet.</p>
            : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {led.rows.map((r) => (
                  <div key={r.date} className="grid grid-cols-[64px_1fr_auto] items-center gap-2 px-3 py-2 sm:grid-cols-[76px_1fr_auto] sm:gap-3">
                    <span className="text-sm font-semibold">{fmtDatePKT(r.date)}</span>
                    <span className="space-y-0.5 text-sm">
                      {r.given > 0 && <span className="block text-emerald-700">Gave {r.given} bottle{r.given === 1 ? "" : "s"}{r.litres > 0 && <span className="text-muted-foreground"> · {r.litres} L of milk</span>}</span>}
                      {r.given === 0 && r.litres > 0 && <span className="block text-muted-foreground">{r.litres} L in packets — no bottles</span>}
                      {r.milkBack > 0 && <span className="block text-sky-700">{r.milkBack} bottle{r.milkBack === 1 ? "" : "s"} came back full (milk returned)</span>}
                      {r.returned > 0 ? <span className="block text-sky-700">Took back {r.returned} empt{r.returned === 1 ? "y" : "ies"}{r.by ? <span className="text-muted-foreground"> · {r.by}</span> : null}</span>
                        : r.given > 0 ? <span className="block text-muted-foreground">No empties returned</span> : null}
                      {r.adjusted !== 0 && <span className="block text-amber-700">Correction {r.adjusted > 0 ? "+" : ""}{r.adjusted}{r.reason ? ` — ${r.reason}` : ""}{r.by ? <span className="text-muted-foreground"> · {r.by}</span> : null}</span>}
                    </span>
                    <span className={cn("text-right text-base font-semibold tabular-nums", r.held > 0 ? "text-rose-700" : "text-emerald-700")}>{r.held}<span className="block text-[10px] font-medium uppercase text-muted-foreground">holds</span></span>
                  </div>
                ))}
              </div>
            )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
