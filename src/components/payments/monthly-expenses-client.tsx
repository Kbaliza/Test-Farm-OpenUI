"use client";

import { Fragment, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { CalendarDays, ChevronDown, Copy, Loader2, Search, Settings2, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  getMonthlyExpenses,
  saveMonthlyBudgets,
  type MonthlyExpensesData,
} from "@/app/(dashboard)/payments/expenses/actions";
import { categoryLines, itemisedInReport, shownUnder } from "@/lib/expense-report-lines";
import { DEPARTMENTS, defaultDepartment, departmentOf, lineKey, type Department } from "@/lib/expense-departments";
import { OWNERS_HEAD } from "@/lib/payment-heads";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DEPT_DOT: Record<Department, string> = { Farm: "bg-emerald-600", Distribution: "bg-sky-600", Agriculture: "bg-amber-600" };
// The department row is filled in its colour, its categories in a lighter wash,
// and the items are left white — so the three levels read at a glance.
const DEPT_ROW: Record<Department, string> = {
  Farm: "bg-emerald-800 hover:bg-emerald-700 text-white [&_*]:!text-white",
  Distribution: "bg-sky-800 hover:bg-sky-700 text-white [&_*]:!text-white",
  Agriculture: "bg-amber-800 hover:bg-amber-700 text-white [&_*]:!text-white",
};
const CAT_ROW: Record<Department, string> = {
  Farm: "bg-emerald-50 hover:bg-emerald-100/70",
  Distribution: "bg-sky-50 hover:bg-sky-100/70",
  Agriculture: "bg-amber-50 hover:bg-amber-100/70",
};

/** Rupees, without saying so — the whole page is in rupees. */
function money(n: number) {
  return `${n < 0 ? "−" : ""}${Math.abs(Math.round(n)).toLocaleString("en-PK")}`;
}
function fmtShortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short" });
}
/** The heads that have a "Paid by …" view of their own. */
const HEAD_VIEWS = { meezan: { head: OWNERS_HEAD, name: "Meezan" }, hbl: { head: "HBL", name: "HBL" } } as const;
type HeadView = keyof typeof HEAD_VIEWS;

// ── The lines ─────────────────────────────────────────────────────────────────

/** A line is stored as category › item; `group` and `label` are where it shows and as what. */
type Line = { key: string; dept: Department; category: string; categoryId: string | null; item: string; group: string; label: string; budget: number; spent: number };
type Status = "over" | "tight" | "ok" | "none" | "idle";

function statusOf(l: { budget: number; spent: number }): Status {
  if (l.budget <= 0) return l.spent > 0 ? "none" : "idle";
  if (l.spent > l.budget) return "over";
  if (l.spent / l.budget >= 0.85) return "tight";
  return "ok";
}

/** Every line, each in its department — the ones nothing was spent on this month
 *  too, at 0. With `onlyHead`, only what was paid from that head — and no budgets,
 *  since a budget is for all spending on a line, not one account's share of it. */
function buildLines(data: MonthlyExpensesData, onlyHead?: string): Line[] {
  const catId = new Map(data.categories.map((c) => [c.name, c.id]));
  const map = new Map<string, Line>();
  const get = (category: string, item: string) => {
    const k = lineKey(category, item);
    let l = map.get(k);
    if (!l) {
      l = { key: k, dept: departmentOf(category, item, data.departments), category, categoryId: catId.get(category) ?? null, item, ...shownUnder(category, item), budget: 0, spent: 0 };
      map.set(k, l);
    }
    return l;
  };
  if (!onlyHead) {
    for (const c of data.categories) for (const item of categoryLines(c.name, data.extraItems)) get(c.name, item);
    for (const b of data.budgets) get(b.category, b.item).budget += b.amount;
  }
  for (const e of data.entries) {
    if (onlyHead && e.headKey !== onlyHead) continue;
    get(e.line.category, e.line.item).spent += e.amount;
  }
  const all = [...map.values()];
  return onlyHead ? all.filter((l) => l.spent > 0) : all;
}

// ── Small pieces ────────────────────────────────────────────────────────────

/** "into HBL Rs 50,000 · paid through Rs 12,300" — the two ways the owners paid. */
function meezanSub(data: MonthlyExpensesData) {
  const intoHbl = data.ownerFunding.contributions.reduce((s, c) => s + c.amount, 0);
  const through = data.ownerFunding.byOwner.find((o) => o.name === "Through Meezan")?.amount ?? 0;
  return [intoHbl > 0.005 && `into HBL ${money(intoHbl)}`, through > 0.005 && `paid through ${money(through)}`].filter(Boolean).join(" · ");
}

function StatCard({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", cls)}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function StatusPill({ s }: { s: Status }) {
  const m = {
    over: ["Over budget", "bg-rose-50 text-rose-700"],
    tight: ["Almost used", "bg-amber-50 text-amber-700"],
    ok: ["On track", "bg-emerald-50 text-emerald-700"],
    none: ["No budget", "bg-muted text-muted-foreground"],
    idle: ["Not used", "text-muted-foreground"],
  }[s];
  return <span className={cn("whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", m[1])}>{m[0]}</span>;
}

function Used({ budget, spent }: { budget: number; spent: number }) {
  if (budget <= 0) return <span className="text-muted-foreground">—</span>;
  const p = Math.round((spent / budget) * 100);
  return <span className={cn("font-semibold tabular-nums", spent > budget ? "text-rose-700" : p >= 85 ? "text-amber-700" : "text-muted-foreground")}>{p}%</span>;
}

function Remaining({ budget, spent }: { budget: number; spent: number }) {
  if (budget <= 0) return <span className="text-muted-foreground">—</span>;
  const r = budget - spent;
  return <span className={cn("font-semibold tabular-nums", r < 0 ? "text-rose-700" : "text-emerald-700")}>{money(r)}</span>;
}

// ── The page ────────────────────────────────────────────────────────────────

// "meezan" and "hbl" are not budget statuses: they show what was paid from that account.
type Filter = "all" | "over" | "ok" | "none" | HeadView;

export function MonthlyExpensesClient({ initial, today }: { initial: MonthlyExpensesData; today: string }) {
  const [data, setData] = useState<MonthlyExpensesData>(initial);
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<"grouped" | "flat">("grouped");
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [line, setLine] = useState<string | null>(null);
  const [expQ, setExpQ] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  // The expenses list sits under the budget table; picking a line scrolls to it.
  const expensesRef = useRef<HTMLDivElement>(null);
  const pickLine = (key: string) => {
    const next = line === key ? null : key;
    setLine(next);
    if (next) expensesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const [ty, tm, td] = today.split("-").map(Number);
  const lastMonth = tm === 1 ? { month: 12, year: ty - 1 } : { month: tm - 1, year: ty };
  const isThis = data.month === tm && data.year === ty;
  const isLast = data.month === lastMonth.month && data.year === lastMonth.year;

  const daysInMonth = new Date(Date.UTC(data.year, data.month, 0)).getUTCDate();
  const daysLeft = isThis ? daysInMonth - td + 1
    : data.year * 12 + data.month > ty * 12 + tm ? daysInMonth : 0;

  function load(month: number, year: number) {
    startTransition(async () => {
      setData(await getMonthlyExpenses(month, year));
      setLine(null);
    });
  }
  const reload = () => load(data.month, data.year);

  const lines = useMemo(() => buildLines(data), [data]);
  // What was paid from Meezan (the owners) and from HBL, line by line.
  const meezanLines = useMemo(() => buildLines(data, HEAD_VIEWS.meezan.head), [data]);
  const hblLines = useMemo(() => buildLines(data, HEAD_VIEWS.hbl.head), [data]);
  const hv = filter === "meezan" || filter === "hbl" ? HEAD_VIEWS[filter] : null;
  const mz = hv !== null;
  const headLines = filter === "hbl" ? hblLines : meezanLines;
  const paidByHbl = data.entries.filter((e) => e.headKey === HEAD_VIEWS.hbl.head).reduce((s, e) => s + e.amount, 0);
  const matchesSearch = (l: Line) => {
    const s = q.trim().toLowerCase();
    return !s || [l.category, l.group, l.label, l.item, l.dept].some((x) => x.toLowerCase().includes(s));
  };
  const searched = lines.filter(matchesSearch);
  const visible = mz ? headLines.filter(matchesSearch) : searched.filter((l) => {
    const s = statusOf(l);
    return filter === "all" || (filter === "ok" ? s === "ok" || s === "tight" : s === filter);
  });

  const sum = (ls: Line[]) => ({ budget: ls.reduce((t, l) => t + l.budget, 0), spent: ls.reduce((t, l) => t + l.spent, 0) });
  // The cards are about the budget, so the Meezan view leaves them on every line.
  const cardLines = mz ? searched : visible;
  const totals = sum(cardLines);
  const overCount = cardLines.filter((l) => statusOf(l) === "over").length;
  const counts = {
    all: searched.length,
    over: searched.filter((l) => statusOf(l) === "over").length,
    ok: searched.filter((l) => ["ok", "tight"].includes(statusOf(l))).length,
    none: searched.filter((l) => statusOf(l) === "none").length,
    meezan: meezanLines.filter(matchesSearch).length,
    hbl: hblLines.filter(matchesSearch).length,
  };

  // Department → category (where the line is shown) → lines.
  const tree = DEPARTMENTS.map((dept) => {
    const inDept = visible.filter((l) => l.dept === dept);
    const cats = [...new Set(inDept.map((l) => l.group))].sort((a, b) => a.localeCompare(b))
      .map((category) => ({ category, lines: inDept.filter((l) => l.group === category).sort((a, b) => a.label.localeCompare(b.label)) }));
    return { dept, lines: inDept, cats };
  }).filter((d) => d.lines.length > 0);

  const toggle = (k: string) => setClosed((c) => ({ ...c, [k]: !c[k] }));

  // The expenses behind the table, narrowed to the line clicked.
  const selected = line ? (mz ? headLines : lines).find((l) => l.key === line) : null;
  const entries = data.entries.filter((e) => {
    if (hv && e.headKey !== hv.head) return false;
    if (selected && lineKey(e.line.category, e.line.item) !== selected.key) return false;
    const s = expQ.trim().toLowerCase();
    return !s || e.description.toLowerCase().includes(s) || e.categoryName.toLowerCase().includes(s) || (e.item ?? "").toLowerCase().includes(s) || e.head.toLowerCase().includes(s);
  });

  // Render helpers, called as functions — not components, which would be new on
  // every render and remount their rows.
  const lineRow = (l: Line, indent: string, crumb = false, rowCls = "hover:bg-muted/30") => (
    <tr
      key={l.key}
      className={cn("cursor-pointer", rowCls, line === l.key && "bg-primary/5")}
      onClick={() => pickLine(l.key)}
      title="Show these expenses below"
    >
      <td className={cn("px-2 py-2 sm:px-3", indent)}>
        <span className="flex items-center gap-2">
          {crumb && <span className={cn("size-2 shrink-0 rounded-full", DEPT_DOT[l.dept])} />}
          {crumb && <span className="hidden text-sm text-muted-foreground sm:inline">{l.dept} › {l.group} ›</span>}
          <span className="font-medium">{l.label}</span>
        </span>
      </td>
      {!mz && <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{l.budget > 0 ? money(l.budget) : "—"}</td>}
      <td className="px-2 py-2 text-right tabular-nums sm:px-3">{money(l.spent)}</td>
      {!mz && (
        <>
          <td className="hidden px-3 py-2 text-right md:table-cell"><Used budget={l.budget} spent={l.spent} /></td>
          <td className="px-2 py-2 text-right sm:px-3"><Remaining budget={l.budget} spent={l.spent} /></td>
          <td className="hidden px-3 py-2 sm:table-cell"><StatusPill s={statusOf(l)} /></td>
          <td className="hidden px-3 py-2 text-sm text-muted-foreground md:table-cell">{daysLeft}d</td>
        </>
      )}
    </tr>
  );

  const sumCells = ({ budget, spent }: { budget: number; spent: number }) => mz ? (
    <td className="px-2 py-2 text-right tabular-nums sm:px-3">{money(spent)}</td>
  ) : (
    <>
      <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{budget > 0 ? money(budget) : "—"}</td>
      <td className="px-2 py-2 text-right tabular-nums sm:px-3">{money(spent)}</td>
      <td className="hidden px-3 py-2 text-right md:table-cell"><Used budget={budget} spent={spent} /></td>
      <td className="px-2 py-2 text-right sm:px-3"><Remaining budget={budget} spent={spent} /></td>
      <td className="hidden sm:table-cell" />
      <td className="hidden md:table-cell" />
    </>
  );

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Month */}
      <div className="flex flex-wrap items-end gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5">
        <div>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Month</label>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant={isThis ? "default" : "outline"} className="h-9 px-3 text-sm" disabled={pending} onClick={() => load(tm, ty)}>This month</Button>
            <Button size="sm" variant={isLast ? "default" : "outline"} className="h-9 px-3 text-sm" disabled={pending} onClick={() => load(lastMonth.month, lastMonth.year)}>Last month</Button>
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Pick a month</label>
          <input
            type="month"
            value={`${data.year}-${String(data.month).padStart(2, "0")}`}
            onChange={(e) => { const [y, m] = e.target.value.split("-").map(Number); if (y && m) load(m, y); }}
            className="h-9 rounded-md border border-border bg-background px-2.5 text-sm tabular-nums"
          />
        </div>
        {pending && <Loader2 className="mb-2.5 size-4 animate-spin text-muted-foreground" />}
        <div className="ml-auto flex items-center gap-2">
          <span className="flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background px-3 text-sm text-muted-foreground">
            <CalendarDays className="size-3.5" />
            {MONTH_NAMES[data.month - 1]} {data.year} ·{" "}
            <b className="text-foreground">{isThis ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : daysLeft ? "not started" : "closed"}</b>
          </span>
          <Button size="sm" className="h-9 text-sm" onClick={() => setEditOpen(true)}>
            <Settings2 className="mr-1.5 size-3.5" /> Set budgets
          </Button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <StatCard label="Total budget" value={money(totals.budget)} sub={`${MONTH_NAMES[data.month - 1]}`} />
        <StatCard label="Total spent" value={money(totals.spent)} cls="text-sky-700"
          sub={totals.budget > 0 ? `${Math.round((totals.spent / totals.budget) * 100)}% of budget` : `${data.count} entries`} />
        <StatCard
          label={totals.budget - totals.spent < 0 ? "Over budget" : "Remaining"}
          value={money(totals.budget - totals.spent)}
          cls={totals.budget - totals.spent < 0 ? "text-rose-700" : "text-emerald-700"}
          sub="budget minus spent"
        />
        <StatCard label="Lines over budget" value={String(overCount)} cls={overCount ? "text-rose-700" : "text-emerald-700"} sub={`of ${cardLines.length} lines`} />
        <StatCard label="Days left" value={String(daysLeft)} sub={isThis ? "in this month" : daysLeft ? "month not started" : "month closed"} />
        {/* Meezan is the owners' one shared account, so no owner is named here:
            what they put into HBL and what was paid through Meezan, together. */}
        <StatCard
          label="Paid by Meezan"
          value={money(data.ownerFunding.total)}
          cls={data.ownerFunding.total > 0 ? "text-violet-700" : undefined}
          sub={data.ownerFunding.total > 0 ? meezanSub(data) : "owners' shared account"}
        />
        <StatCard
          label="Paid by HBL"
          value={money(paidByHbl)}
          cls={paidByHbl > 0 ? "text-sky-700" : undefined}
          sub="spent from HBL this month"
        />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {([["all", "All"], ["over", "Over budget"], ["ok", "On track"], ["none", "No budget"], ["meezan", "Paid by Meezan"], ["hbl", "Paid by HBL"]] as const).map(([k, l]) => (
            <Button key={k} size="sm" variant={filter === k ? "default" : "outline"} className="h-9 gap-1.5 px-3 text-sm" onClick={() => setFilter(k)}>
              {l}
              <span className={cn("rounded-full px-1.5 text-xs", filter === k ? "bg-white/20" : "bg-muted")}>{counts[k]}</span>
            </Button>
          ))}
        </div>
        <div className="ml-auto flex overflow-hidden rounded-md border border-border">
          {(["grouped", "flat"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)}
              className={cn("h-9 px-3 text-sm font-medium capitalize", view === v ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted/40")}>
              {v}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search category…" className="h-9 pl-8 text-sm" />
        </div>
      </div>

      {/* Budget vs spend */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-[15px] sm:min-w-[640px]">
          <thead className="bg-muted/40 text-left text-sm text-muted-foreground">
            <tr>
              <th className="px-2 py-2 font-medium sm:px-3">Category</th>
              {!mz && <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Budget</th>}
              <th className="px-2 py-2 text-right font-medium sm:px-3">{hv ? `Paid by ${hv.name}` : "Spent"}</th>
              {!mz && (
                <>
                  <th className="hidden px-3 py-2 text-right font-medium md:table-cell">Used</th>
                  <th className="px-2 py-2 text-right font-medium sm:px-3">Remaining</th>
                  <th className="hidden px-3 py-2 font-medium sm:table-cell">Status</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">Days left</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={mz ? 2 : 7} className="px-3 py-10 text-center text-sm text-muted-foreground">
                  <Wallet className="mx-auto mb-2 size-6 opacity-40" />
                  {hv && !q.trim() ? `Nothing was paid through ${hv.name} in ${MONTH_NAMES[data.month - 1]} ${data.year}.` : lines.length === 0 ? `No budgets or expenses in ${MONTH_NAMES[data.month - 1]} ${data.year} yet.` : "No lines match these filters."}
                </td>
              </tr>
            ) : view === "flat" ? (
              [...visible]
                .sort((a, b) => a.dept.localeCompare(b.dept) || a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
                .map((l) => lineRow(l, "", true))
            ) : (
              tree.map((d) => {
                const dOpen = !closed[d.dept];
                const ds = sum(d.lines);
                return (
                  <Fragment key={d.dept}>
                    <tr className={cn("cursor-pointer", DEPT_ROW[d.dept])} onClick={() => toggle(d.dept)}>
                      <td className="px-2 py-2.5 sm:px-3">
                        <span className="flex items-center gap-2 font-semibold">
                          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !dOpen && "-rotate-90")} />
                          <span className={cn("size-2.5 rounded-sm", DEPT_DOT[d.dept])} />
                          {d.dept}
                          <span className="hidden text-sm font-normal text-muted-foreground sm:inline">{d.cats.length} categor{d.cats.length === 1 ? "y" : "ies"}</span>
                        </span>
                      </td>
                      {sumCells(ds)}
                    </tr>
                    {dOpen && d.cats.map((c) => {
                      // A category that is not split by item is a line on its own.
                      const only = c.lines[0];
                      if (c.lines.length === 1 && !only.item && only.group === only.category && !itemisedInReport(only.category)) {
                        return lineRow(c.lines[0], "pl-7 sm:pl-9", false, CAT_ROW[d.dept]);
                      }
                      const ck = `${d.dept}›${c.category}`;
                      const cOpen = !closed[ck];
                      const cs = sum(c.lines);
                      return (
                        <Fragment key={ck}>
                          <tr className={cn("cursor-pointer", CAT_ROW[d.dept])} onClick={() => toggle(ck)}>
                            <td className="py-2 pl-7 pr-2 sm:pl-9 sm:pr-3">
                              <span className="flex items-center gap-1.5 font-medium">
                                <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", !cOpen && "-rotate-90")} />
                                {c.category}
                              </span>
                            </td>
                            {!mz && <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{cs.budget > 0 ? money(cs.budget) : "—"}</td>}
                            <td className="px-2 py-2 text-right tabular-nums sm:px-3">{money(cs.spent)}</td>
                            {!mz && (
                              <>
                                <td className="hidden px-3 py-2 text-right md:table-cell"><Used {...cs} /></td>
                                <td className="px-2 py-2 text-right sm:px-3"><Remaining {...cs} /></td>
                                <td className="hidden px-3 py-2 sm:table-cell"><StatusPill s={statusOf(cs)} /></td>
                                <td className="hidden md:table-cell" />
                              </>
                            )}
                          </tr>
                          {cOpen && c.lines.map((l) => lineRow(l, "pl-12 text-muted-foreground sm:pl-16"))}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })
            )}
            {visible.length > 0 && (
              <tr className="bg-muted/40 font-semibold">
                <td className="px-2 py-2.5 sm:px-3">{hv ? `Paid through ${hv.name}` : "Grand total"}</td>
                {sumCells(sum(visible))}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* The owners' money that went into HBL — not tied to any one line, so it is
          listed here rather than in the table. With the table it adds up to the
          "Paid by Meezan" card. */}
      {filter === "meezan" && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
            <p className="text-base font-semibold">Owners&apos; money put into HBL</p>
            <span className="text-sm text-muted-foreground">owed back on Meezan · {data.ownerFunding.contributions.length}</span>
          </div>
          {data.ownerFunding.contributions.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No owner put money into HBL in {MONTH_NAMES[data.month - 1]} {data.year}.</p>
          ) : (
            <table className="w-full text-[15px]">
              <tbody className="divide-y divide-border">
                {data.ownerFunding.contributions.map((c) => (
                  <tr key={c.id}>
                    <td className="whitespace-nowrap px-2 py-2 text-sm text-muted-foreground sm:px-3">{fmtShortDate(c.date)}</td>
                    <td className="px-2 py-2 sm:px-3">
                      <span className="font-medium">{c.owner} — personal account → HBL</span>
                      {c.reason && <span className="block text-xs text-muted-foreground">{c.reason}</span>}
                    </td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums sm:px-3">{money(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-muted/30">
                  <td colSpan={2} className="px-2 py-2 text-right text-sm font-semibold text-muted-foreground sm:px-3">Put into HBL</td>
                  <td className="px-2 py-2 text-right font-bold tabular-nums sm:px-3">{money(data.ownerFunding.contributions.reduce((s, c) => s + c.amount, 0))}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}

      {/* The expenses */}
      <div ref={expensesRef} className="scroll-mt-4 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <p className="text-base font-semibold">Expenses</p>
          {selected && (
            <button type="button" onClick={() => setLine(null)} className="rounded-full bg-primary/10 px-2.5 py-0.5 text-sm font-medium text-primary hover:bg-primary/15">
              {selected.group === selected.label ? selected.label : `${selected.group} › ${selected.label}`} ✕
            </button>
          )}
          <span className="text-sm text-muted-foreground">{entries.length} of {data.count}</span>
          <div className="relative ml-auto w-full sm:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={expQ} onChange={(e) => setExpQ(e.target.value)} placeholder="Search expenses…" className="h-9 pl-8 text-sm" />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[15px] md:min-w-[640px]">
            <thead className="bg-muted/40 text-left text-sm text-muted-foreground">
              <tr>
                <th className="px-2 py-2 font-medium sm:px-3">Date</th>
                <th className="px-2 py-2 font-medium sm:px-3">Description</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">Category</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">Head</th>
                <th className="px-2 py-2 text-right font-medium sm:px-3">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">No expenses here.</td></tr>
              ) : entries.map((e) => (
                <tr key={`${e.kind}-${e.id}`}>
                  <td className="whitespace-nowrap px-2 py-2 text-sm text-muted-foreground sm:px-3">{fmtShortDate(e.date)}</td>
                  <td className="px-2 py-2 font-medium sm:max-w-[260px] sm:truncate sm:px-3">
                    {e.description || "—"}
                    {/* On a phone the category and head sit under the description. */}
                    <span className="block text-xs font-normal text-muted-foreground sm:hidden">
                      {e.categoryName}{e.item ? ` › ${e.item}` : ""} · {e.head}
                    </span>
                  </td>
                  <td className="hidden px-3 py-2 text-sm sm:table-cell">
                    {e.categoryName}{e.item ? <span className="text-muted-foreground"> › {e.item}</span> : null}
                  </td>
                  <td className="hidden px-3 py-2 text-sm text-muted-foreground md:table-cell">{e.head}</td>
                  <td className="px-2 py-2 text-right font-semibold tabular-nums sm:px-3">{money(e.amount)}</td>
                </tr>
              ))}
            </tbody>
            {entries.length > 0 && (
              <tfoot>
                <tr className="border-t border-border bg-muted/30">
                  <td colSpan={4} className="px-2 py-2 text-right text-sm font-semibold text-muted-foreground sm:px-3">{selected || expQ ? "Shown" : hv ? `Paid through ${hv.name}` : "Month total"}</td>
                  <td className="px-2 py-2 text-right font-bold tabular-nums sm:px-3">{money(entries.reduce((s, e) => s + e.amount, 0))}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {editOpen && (
        <Dialog open onOpenChange={(v) => { if (!v) setEditOpen(false); }}>
          <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Budgets · {MONTH_NAMES[data.month - 1]} {data.year}</DialogTitle>
              <DialogDescription className="text-sm">
                A budget for each line, and which department it belongs to. A category&apos;s budget is its lines added up.
              </DialogDescription>
            </DialogHeader>
            <BudgetEditor data={data} onDone={() => { setEditOpen(false); reload(); }} onCancel={() => setEditOpen(false)} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── Setting the budgets ─────────────────────────────────────────────────────
// Exported: the Budgets page shows the same form, so budgets have one editor.

type Draft = { amount: string; dept: Department };

/** Every line a budget can be set on, under the category it is shown in. */
function editableLines(data: MonthlyExpensesData) {
  const out: { category: string; categoryId: string; item: string; group: string; label: string }[] = [];
  const have = new Set<string>();
  const push = (category: string, categoryId: string, item: string) => {
    const k = lineKey(category, item);
    if (have.has(k)) return;
    have.add(k);
    out.push({ category, categoryId, item, ...shownUnder(category, item) });
  };
  const ids = new Map(data.categories.map((c) => [c.name, c.id]));
  for (const c of data.categories) for (const it of categoryLines(c.name, data.extraItems)) push(c.name, c.id, it);
  // Anything with a budget or spending that the lists above do not name — an old
  // item, a vendor paid, or a whole-category budget set before budgets went by item.
  for (const b of data.budgets) push(b.category, b.categoryId, b.item);
  for (const e of data.entries) {
    const id = ids.get(e.line.category);
    if (id) push(e.line.category, id, e.line.item);
  }
  return out.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
}

export function BudgetEditor({ data, onDone, onCancel }: { data: MonthlyExpensesData; onDone: () => void; onCancel?: () => void }) {
  const lines = useMemo(() => editableLines(data), [data]);
  const startDrafts = () => {
    const d: Record<string, Draft> = {};
    for (const l of lines) {
      const k = lineKey(l.category, l.item);
      const amt = data.budgets.filter((b) => b.category === l.category && b.item === l.item).reduce((s, b) => s + b.amount, 0);
      d[k] = { amount: amt > 0 ? String(amt) : "", dept: departmentOf(l.category, l.item, data.departments) };
    }
    return d;
  };
  const [drafts, setDrafts] = useState<Record<string, Draft>>(startDrafts);
  const [saving, startSave] = useTransition();
  const [copying, startCopy] = useTransition();

  const set = (k: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [k]: { ...d[k], ...patch } }));
  const total = Object.values(drafts).reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
  const byCategory = [...new Set(lines.map((l) => l.group))].map((c) => ({ category: c, lines: lines.filter((l) => l.group === c) }));

  function copyLastMonth() {
    const m = data.month === 1 ? 12 : data.month - 1;
    const y = data.month === 1 ? data.year - 1 : data.year;
    startCopy(async () => {
      const prev = await getMonthlyExpenses(m, y);
      if (!prev.budgets.length) { toast.error(`No budgets were set for ${MONTH_NAMES[m - 1]}.`); return; }
      setDrafts((d) => {
        const next = { ...d };
        for (const k of Object.keys(next)) next[k] = { ...next[k], amount: "" };
        for (const b of prev.budgets) {
          const k = lineKey(b.category, b.item);
          if (next[k]) next[k] = { ...next[k], amount: String((parseFloat(next[k].amount) || 0) + b.amount) };
        }
        return next;
      });
      toast.success(`${MONTH_NAMES[m - 1]}'s budgets copied in — check them, then save.`);
    });
  }

  function save() {
    const changed = lines.filter((l) => {
      const k = lineKey(l.category, l.item);
      const before = data.budgets.filter((b) => b.category === l.category && b.item === l.item).reduce((s, b) => s + b.amount, 0);
      return (parseFloat(drafts[k]?.amount) || 0) !== before;
    });
    // Only assignments that differ from the default are kept.
    const departments: Record<string, string> = {};
    for (const l of lines) {
      const k = lineKey(l.category, l.item);
      if (drafts[k] && drafts[k].dept !== defaultDepartment(l.category, l.item)) departments[k] = drafts[k].dept;
    }
    startSave(async () => {
      const r = await saveMonthlyBudgets({
        month: data.month,
        year: data.year,
        lines: changed.map((l) => ({ categoryId: l.categoryId, item: l.item, amount: parseFloat(drafts[lineKey(l.category, l.item)]?.amount) || 0 })),
        departments,
      });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Budgets saved.");
      onDone();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base">Total <b className="tabular-nums">{money(total)}</b></p>
        <Button size="sm" variant="outline" className="h-9 text-sm" onClick={copyLastMonth} disabled={copying}>
          {copying ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Copy className="mr-1.5 size-3.5" />} Copy last month
        </Button>
      </div>

      <div className="space-y-2">
        {byCategory.map(({ category, lines: ls }) => {
          const catTotal = ls.reduce((s, l) => s + (parseFloat(drafts[lineKey(l.category, l.item)]?.amount) || 0), 0);
          return (
            <div key={category} className="rounded-lg border border-border">
              <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1.5">
                <p className="text-[15px] font-semibold">{category}</p>
                <p className="text-sm text-muted-foreground tabular-nums">{catTotal > 0 ? money(catTotal) : "—"}</p>
              </div>
              <div className="divide-y divide-border">
                {ls.map((l) => {
                  const k = lineKey(l.category, l.item);
                  const d = drafts[k];
                  return (
                    <div key={k} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                      <span className="min-w-0 flex-1 text-[15px]">{l.label}</span>
                      <select
                        value={d.dept}
                        onChange={(e) => set(k, { dept: e.target.value as Department })}
                        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                        aria-label="Department"
                      >
                        {DEPARTMENTS.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                      <span className="text-sm text-muted-foreground">Rs</span>
                      <Input
                        type="number" min="0" inputMode="numeric"
                        value={d.amount}
                        onChange={(e) => set(k, { amount: e.target.value })}
                        placeholder="0"
                        className="h-9 w-32 text-right text-[15px]"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-background pt-3">
        {onCancel && <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>}
        <Button size="sm" onClick={save} disabled={saving}>
          {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />} Save budgets
        </Button>
      </div>
    </div>
  );
}
