"use client";

import { useState, useMemo } from "react";
import { unitLabel } from "@/lib/units";
import {
  Droplets,
  Truck,
  ShoppingCart,
  Package,
} from "lucide-react";
import { type WastageEntry } from "@/app/(dashboard)/inventory/wastage/actions";
import { MiniCalendar, pickRange } from "@/components/ui/mini-calendar";

type Stage = "All" | "Production" | "Packaging" | "Retail" | "Retail mart" | "Yoghurt" | "Rider delivery" | "Riders" | "Rider return";


function fmt(n: number) {
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);
}

function toLocalDateStr(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const STAGES: Stage[] = ["All", "Production", "Packaging", "Retail", "Retail mart", "Yoghurt", "Rider delivery", "Riders", "Rider return"];

// The waste stage is STORED as "Yoghurt" (existing rows depend on that exact
// value), so only its label is spelled the way the catalogue does.
const stageLabel = (s: string) => (s === "Yoghurt" ? "Yogurt" : s);


const stageBg: Record<Exclude<Stage, "All">, string> = {
  Production: "bg-amber-100 text-amber-700",
  Packaging: "bg-sky-100 text-sky-700",
  Retail: "bg-pink-100 text-pink-700",
  "Retail mart": "bg-orange-100 text-orange-700",
  Yoghurt: "bg-purple-100 text-purple-700",
  "Rider delivery": "bg-emerald-100 text-emerald-700",
  "Rider return": "bg-teal-100 text-teal-700",
  Riders: "bg-teal-100 text-teal-700",
};

const stageBar: Record<Exclude<Stage, "All">, string> = {
  Production: "bg-amber-500",
  Packaging: "bg-sky-500",
  Retail: "bg-pink-500",
  "Retail mart": "bg-orange-500",
  Yoghurt: "bg-purple-500",
  "Rider delivery": "bg-emerald-500",
  "Rider return": "bg-teal-500",
  Riders: "bg-teal-500",
};

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  ring,
  icon: Icon,
}: {
  label: string;
  value: number;
  ring: string;
  icon: React.ElementType;
}) {
  return (
    <div className={`rounded-xl border border-border p-4 ${ring}`}>
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
      </div>
      <p className="mt-2 text-2xl font-bold">
        {fmt(value)}{" "}
        <span className="text-sm font-medium text-muted-foreground">L</span>
      </p>
    </div>
  );
}

// ── Dispute Issues ────────────────────────────────────────────────────────────

const DISPUTE_ISSUES: { label: string; color: string }[] = [
  { label: "Spillage during transport",    color: "bg-rose-500" },
  { label: "Incorrect loading at farm",    color: "bg-orange-500" },
  { label: "Incorrect loading at packaging", color: "bg-amber-500" },
  { label: "Incorrect loading by van",     color: "bg-yellow-500" },
  { label: "Packaging damage",             color: "bg-violet-500" },
  { label: "Short supply from farm",       color: "bg-sky-500" },
  { label: "Short supply from packaging",  color: "bg-blue-500" },
  { label: "Short supply from van",        color: "bg-indigo-500" },
  { label: "Other",                        color: "bg-slate-400" },
];

function DisputeIssues({
  entries,
  total,
}: {
  entries: WastageEntry[];
  total: number;
}) {
  const byIssue = useMemo(() => {
    const map = new Map<string, number>(DISPUTE_ISSUES.map((i) => [i.label, 0]));
    for (const e of entries) {
      const key = e.reason?.trim() || "Other";
      if (map.has(key)) map.set(key, map.get(key)! + e.loss);
      else map.set("Other", (map.get("Other") ?? 0) + e.loss);
    }
    return DISPUTE_ISSUES.map((i) => ({ ...i, val: map.get(i.label) ?? 0 }));
  }, [entries]);

  const hasAny = byIssue.some((i) => i.val > 0);
  if (!hasAny) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Dispute Issues
      </p>
      <div className="space-y-3">
        {byIssue.map(({ label, color, val }) => {
          const pct = Math.round((val / Math.max(total, 0.001)) * 100);
          return (
            <div key={label}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium shrink-0 ml-1">{fmt(val)} L</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full transition-all ${color}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-0.5 text-right text-[10px] text-muted-foreground">
                {pct}%
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main client ───────────────────────────────────────────────────────────────

export function WastageClient({ entries }: { entries: WastageEntry[] }) {
  const [stage, setStage] = useState<Stage>("All");
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [rangeEnd, setRangeEnd] = useState<string | null>(null);
  const [calMonth, setCalMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  // Click flow: 1st click sets start, 2nd sets end (auto-ordered), 3rd restarts.
  function handlePick(dateStr: string) {
    // The two-click rule is shared with the Rider Cash calendar, so the fiddly part
    // (picking backwards) cannot drift between the two pages.
    const next = pickRange({ start: rangeStart, end: rangeEnd }, dateStr);
    setRangeStart(next.start);
    setRangeEnd(next.end);
  }
  function clearRange() {
    setRangeStart(null);
    setRangeEnd(null);
  }

  const datesWithEntries = useMemo(
    () => new Set(entries.map((e) => toLocalDateStr(e.date))),
    [entries]
  );

  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        if (stage !== "All" && e.stage !== stage) return false;
        if (rangeStart) {
          const ds = toLocalDateStr(e.date);
          const end = rangeEnd ?? rangeStart;
          if (ds < rangeStart || ds > end) return false;
        }
        return true;
      }),
    [entries, stage, rangeStart, rangeEnd]
  );

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      // Null sorts to bottom regardless of direction
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return sortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [filtered, sortKey, sortDir]);

  const rangeLabel =
    rangeStart && rangeEnd && rangeEnd !== rangeStart
      ? `${rangeStart} → ${rangeEnd}`
      : rangeStart;

  const dispatchEntries = entries.filter((e) => e.stage !== "Yoghurt");
  const total = entries.reduce((s, e) => s + e.loss, 0);
  const productionLoss = dispatchEntries.filter((e) => e.stage === "Production").reduce((s, e) => s + e.loss, 0);
  const packLoss = dispatchEntries.filter((e) => e.stage === "Packaging").reduce((s, e) => s + e.loss, 0);
  const retailLoss = dispatchEntries.filter((e) => e.stage === "Retail").reduce((s, e) => s + e.loss, 0);
  // Rider-side losses: reported in the app ("Rider delivery") or logged from the office ("Riders").
  const riderLoss = dispatchEntries
    .filter((e) => e.stage === "Rider delivery" || e.stage === "Riders" || e.stage === "Rider return")
    .reduce((s, e) => s + e.loss, 0);
  // Expired on a shop's shelf — stock that left storage when it was dropped there.
  const martLoss = dispatchEntries.filter((e) => e.stage === "Retail mart").reduce((s, e) => s + e.loss, 0);

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* ── Stat cards ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard
          label="Total Wastage"
          value={total}
          ring="bg-rose-50/60 ring-1 ring-rose-100"
          icon={Droplets}
        />
        <StatCard
          label="Production"
          value={productionLoss}
          ring="bg-amber-50/60 ring-1 ring-amber-100"
          icon={Package}
        />
        <StatCard
          label="Packaging"
          value={packLoss}
          ring="bg-sky-50/60 ring-1 ring-sky-100"
          icon={Truck}
        />
        <StatCard
          label="Retail"
          value={retailLoss}
          ring="bg-pink-50/60 ring-1 ring-pink-100"
          icon={ShoppingCart}
        />
        <StatCard
          label="Retail mart"
          value={martLoss}
          ring="bg-orange-50/60 ring-1 ring-orange-100"
          icon={ShoppingCart}
        />
        <StatCard
          label="Rider delivery"
          value={riderLoss}
          ring="bg-emerald-50/60 ring-1 ring-emerald-100"
          icon={Truck}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_240px]">
        {/* ── Left: filter + table ── */}
        <div className="space-y-4">
          {/* Filter tabs */}
          <div className="flex flex-wrap gap-2">
            {STAGES.map((s) => (
              <button
                key={s}
                onClick={() => setStage(s)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors
                  ${stage === s
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}
              >
                {stageLabel(s)}
              </button>
            ))}
            {rangeStart && (
              <button
                onClick={clearRange}
                className="rounded-full bg-rose-100 px-3 py-1 text-xs font-medium text-rose-700 hover:bg-rose-200"
              >
                {rangeLabel} ×
              </button>
            )}
          </div>

          {/* Table */}
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th
                    onClick={() => handleSort("date")}
                    className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Date
                      <span className={sortKey === "date" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "date" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th
                    onClick={() => handleSort("stage")}
                    className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Stage
                      <span className={sortKey === "stage" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "stage" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th
                    onClick={() => handleSort("loggedBy")}
                    className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Logged By
                      <span className={sortKey === "loggedBy" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "loggedBy" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th
                    onClick={() => handleSort("productName")}
                    className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Product
                      <span className={sortKey === "productName" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "productName" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th
                    onClick={() => handleSort("loss")}
                    className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center justify-end gap-1">
                      Loss
                      <span className={sortKey === "loss" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "loss" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th
                    onClick={() => handleSort("reason")}
                    className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Notes
                      <span className={sortKey === "reason" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "reason" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="py-12 text-center text-sm text-muted-foreground"
                    >
                      No wastage recorded
                      {stage !== "All" ? ` for ${stageLabel(stage)}` : ""}
                      {rangeStart ? ` for ${rangeLabel}` : ""}.
                    </td>
                  </tr>
                ) : (
                  sorted.map((e) => {
                    const d = new Date(e.date);
                    const dateLabel = d.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    });
                    const badge =
                      stageBg[e.stage as Exclude<Stage, "All">] ?? "";
                    return (
                      <tr key={e.id} className="hover:bg-muted/20">
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                          {dateLabel}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${badge}`}
                          >
                            {e.stage}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {e.loggedBy}
                        </td>
                        <td className="px-4 py-3 font-medium">
                          {e.productName}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">
                          {fmt(e.loss)}{" "}
                          <span className="text-xs font-normal text-muted-foreground">
                            {unitLabel(e.unit)}
                          </span>
                        </td>
                        <td className="max-w-[160px] truncate px-4 py-3 text-xs text-muted-foreground">
                          {e.reason ?? "—"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Right: calendar + distribution ── */}
        <div className="space-y-4">
          <MiniCalendar
            year={calMonth.year}
            month={calMonth.month}
            datesWithEntries={datesWithEntries}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onPick={handlePick}
            onPrevMonth={() =>
              setCalMonth((c) =>
                c.month === 0
                  ? { year: c.year - 1, month: 11 }
                  : { ...c, month: c.month - 1 }
              )
            }
            onNextMonth={() =>
              setCalMonth((c) =>
                c.month === 11
                  ? { year: c.year + 1, month: 0 }
                  : { ...c, month: c.month + 1 }
              )
            }
          />

          {/* Waste distribution */}
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Waste Distribution
            </p>
            <div className="space-y-3">
              {(
                [
                  ["Production", productionLoss],
                  ["Packaging", packLoss],
                  ["Retail", retailLoss],
                  ["Retail mart", martLoss],
                  ["Rider delivery", riderLoss],
                ] as const
              ).map(([s, val]) => {
                const pct = Math.round((val / Math.max(total, 0.001)) * 100);
                return (
                  <div key={s}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{stageLabel(s)}</span>
                      <span className="font-medium">
                        {fmt(val)} L
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full transition-all ${stageBar[s]}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-right text-[10px] text-muted-foreground">
                      {pct}%
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Dispute issues */}
          <DisputeIssues entries={dispatchEntries} total={total} />
        </div>
      </div>
    </div>
  );
}

