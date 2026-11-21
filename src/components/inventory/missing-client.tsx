"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, SearchX } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addDaysToDateStr, fmtDatePKT, yesterdayPKTString } from "@/lib/pkt";
import { unitLabel, type Unit } from "@/lib/units";
import type { MissingLog, MissingRow } from "@/app/(dashboard)/inventory/missing/actions";

const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-PK");

function StatCard({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", cls)}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

type Preset = "today" | "yesterday" | "7" | "15" | "30";
const PRESETS: [Preset, string][] = [["today", "Today"], ["yesterday", "Yesterday"], ["7", "7 days"], ["15", "15 days"], ["30", "30 days"]];
function presetRange(p: Preset, today: string): [string, string] {
  if (p === "today") return [today, today];
  if (p === "yesterday") { const y = yesterdayPKTString(); return [y, y]; }
  return [addDaysToDateStr(today, -(Number(p) - 1)), today];
}

const STATUS: Record<MissingRow["status"], [string, string]> = {
  "written-off": ["Written off at day end", "bg-rose-50 text-rose-700"],
  open: ["Still open", "bg-amber-50 text-amber-700"],
  pending: ["Until midnight", "bg-sky-50 text-sky-700"],
};

export function MissingClient({ data, today }: { data: MissingLog; today: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [kind, setKind] = useState<"all" | "rider" | "retail">("all");
  const [q, setQ] = useState("");

  const preset = PRESETS.find(([k]) => { const [f, t] = presetRange(k, today); return f === data.from && t === data.to; })?.[0];
  const applyRange = (from: string, to: string) => start(() => router.push(`/inventory/missing?${new URLSearchParams({ from, to })}`, { scroll: false }));

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return data.rows.filter((r) => (kind === "all" || r.kind === kind) && (!s || r.who.toLowerCase().includes(s) || r.product.toLowerCase().includes(s)));
  }, [data.rows, kind, q]);

  // Milk is what matters on the cards; eggs and the rest are in the table.
  const litres = (rs: MissingRow[]) => rs.filter((r) => r.unit === "LITER").reduce((t, r) => t + r.missing, 0);
  const riderRows = data.rows.filter((r) => r.kind === "rider"), retailRows = data.rows.filter((r) => r.kind === "retail");
  const riderNames = new Set(riderRows.map((r) => r.who));

  return (
    <div className="space-y-4 p-4 sm:p-6">
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
        <div>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-muted-foreground">From</label>
          <input type="date" value={data.from} max={today} onChange={(e) => e.target.value && applyRange(e.target.value, data.to)} className="h-9 rounded-md border border-border bg-background px-2.5 text-sm tabular-nums" />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-muted-foreground">To</label>
          <input type="date" value={data.to} min={data.from} max={today} onChange={(e) => e.target.value && applyRange(data.from, e.target.value)} className="h-9 rounded-md border border-border bg-background px-2.5 text-sm tabular-nums" />
        </div>
        {pending && <Loader2 className="mb-2.5 size-4 animate-spin text-muted-foreground" />}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Missing milk" value={`${fmt(litres(data.rows))} L`} cls={litres(data.rows) > 0 ? "text-rose-700" : "text-emerald-700"} sub={`${fmtDatePKT(data.from)}${data.from !== data.to ? ` – ${fmtDatePKT(data.to)}` : ""}`} />
        <StatCard label="With riders" value={`${fmt(litres(riderRows))} L`} sub={`${riderNames.size} rider${riderNames.size === 1 ? "" : "s"} · ${riderRows.length} line${riderRows.length === 1 ? "" : "s"}`} />
        <StatCard label="At Retail" value={`${fmt(litres(retailRows))} L`} sub="held at midnight, nobody handed it back" />
        <StatCard label="Reviewer found short" value={`${fmt(riderRows.filter((r) => r.unit === "LITER").reduce((t, r) => t + (r.reviewMissing ?? 0), 0))} L`} sub="reported returned, never handed over" />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <div className="flex gap-1 rounded-md bg-muted p-0.5">
            {([["all", "All"], ["rider", "Riders"], ["retail", "Retail"]] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setKind(k)} className={cn("rounded px-2.5 py-1 text-sm font-medium", kind === k ? "bg-card shadow-sm" : "text-muted-foreground")}>{l}</button>
            ))}
          </div>
          <span className="text-sm text-muted-foreground">{rows.length} line{rows.length === 1 ? "" : "s"}</span>
          <div className="relative ml-auto w-full sm:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rider or product…" className="h-9 pl-8 text-sm" />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-[15px]">
            <thead className="bg-muted/40 text-left text-sm text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 text-right font-medium">Took</th>
                <th className="px-3 py-2 text-right font-medium">Delivered</th>
                <th className="px-3 py-2 text-right font-medium">Returned</th>
                <th className="px-3 py-2 text-right font-medium">Rider wasted</th>
                <th className="px-3 py-2 text-right font-medium">Reviewer short</th>
                <th className="px-3 py-2 text-right font-medium">Missing</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border tabular-nums">
              {rows.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-10 text-center text-sm text-muted-foreground"><SearchX className="mx-auto mb-2 size-6 opacity-40" />Nothing missing in this window.</td></tr>
              ) : rows.map((r) => {
                const u = unitLabel(r.unit as Unit);
                const n = (v: number | null) => (v == null ? <span className="text-muted-foreground">—</span> : `${fmt(v)} ${u}`);
                const [label, cls] = STATUS[r.status];
                return (
                  <tr key={r.key}>
                    <td className="whitespace-nowrap px-3 py-2 text-sm text-muted-foreground">{fmtDatePKT(r.date)}</td>
                    <td className="px-3 py-2 font-medium">{r.who}{r.kind === "retail" && <span className="block text-xs font-normal text-muted-foreground">leftover after the shifts loaded</span>}</td>
                    <td className="px-3 py-2">{r.product}</td>
                    <td className="px-3 py-2 text-right">{n(r.took)}</td>
                    <td className="px-3 py-2 text-right">{n(r.delivered)}</td>
                    <td className="px-3 py-2 text-right">{n(r.returned)}</td>
                    <td className="px-3 py-2 text-right">{n(r.riderWasted)}</td>
                    <td className={cn("px-3 py-2 text-right", (r.reviewMissing ?? 0) > 0 && "font-medium text-amber-700")}>{r.reviewMissing == null ? <span className="text-muted-foreground">—</span> : r.reviewMissing > 0 ? `${fmt(r.reviewMissing)} ${u}` : "—"}</td>
                    <td className="px-3 py-2 text-right font-semibold text-rose-700">{fmt(r.missing)} {u}</td>
                    <td className="px-3 py-2"><span className={cn("whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", cls)}>{label}</span></td>
                  </tr>
                );
              })}
              {rows.length > 0 && (
                <tr className="bg-muted/40 font-semibold">
                  <td className="px-3 py-2.5" colSpan={8}>Shown{rows.some((r) => r.unit !== "LITER") ? " · milk only in the total" : ""}</td>
                  <td className="px-3 py-2.5 text-right text-rose-700">{fmt(litres(rows))} L</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
