"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Download, Info, Phone, Plus, Search, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  getRecoveryBoard,
  setRecoveryStatus,
  logRecoveryEntry,
  findCustomersToAdd,
  addToRecovery,
  type RecoveryRow,
  type RecoveryActivity,
  type AddCandidate,
} from "@/app/(dashboard)/customers/recovery/actions";
import {
  RECOVERY_STATUSES,
  STATUS_COLOR,
  IN_PROGRESS,
  NO_ANSWER,
  SOURCE_LABEL,
  fmtInactive,
  isRecoveryStatus,
  type RecoverySource,
} from "@/lib/customer-recovery";

// Customer Recovery — the lost customers, and the work of winning each one back.

const POTENTIAL_PILL: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-600",
};
const SOURCE_TONE: Record<RecoverySource, string> = {
  auto: "text-amber-700",
  manual: "text-slate-600",
  added: "text-violet-700",
};

const colorOf = (s: string) => (isRecoveryStatus(s) ? STATUS_COLOR[s] : "#4A4842");

/** A light tint of a status colour, for the unselected tabs. */
function tint(hex: string, mix = 0.88) {
  const h = hex.replace("#", "");
  const ch = (i: number) => Math.round(parseInt(h.slice(i, i + 2), 16) + (255 - parseInt(h.slice(i, i + 2), 16)) * mix);
  return `rgb(${ch(0)},${ch(2)},${ch(4)})`;
}

function fmtWhen(iso: string) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "numeric", month: "short", year: "numeric" }) +
    " · " +
    d.toLocaleTimeString("en-US", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" })
  );
}
function fmtDay(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "numeric" }) : "—";
}

function Kpi({ label, tip, value, sub, color }: { label: string; tip: string; value: string; sub: string; color?: string }) {
  return (
    <div className="relative rounded-xl border border-border bg-card p-3.5 shadow-sm">
      <div className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
        {/* The tip is placed against the card, not the icon, so it can never
            run off the side of a phone screen. */}
        <span className="group/tip inline-flex">
          <Info className="size-3 cursor-help opacity-70" />
          <span className="pointer-events-none invisible absolute inset-x-1 bottom-full z-30 mb-1 rounded-lg bg-foreground px-2.5 py-2 text-[11px] font-normal normal-case leading-snug tracking-normal text-background opacity-0 shadow-lg transition group-hover/tip:visible group-hover/tip:opacity-100">
            {tip}
          </span>
        </span>
      </div>
      <div className="text-lg font-bold leading-tight tabular-nums" style={color ? { color } : undefined}>{value}</div>
      <div className="mt-0.5 text-[11px] font-medium text-muted-foreground">{sub}</div>
    </div>
  );
}

function StatusSelect({ value, onChange, disabled, className }: { value: string; onChange: (s: string) => void; disabled?: boolean; className?: string }) {
  const c = colorOf(value);
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn("h-8 max-w-[180px] cursor-pointer rounded-md border bg-background px-2 text-[11px] font-semibold focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60", className)}
      style={{ borderColor: c, color: c }}
    >
      {RECOVERY_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

type SortKey = "name" | "area" | "potential" | "daysInactive";

export function CustomerRecoveryClient({ initialRows }: { initialRows: RecoveryRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [busy, startBusy] = useTransition();
  const [search, setSearch] = useState("");
  const [potential, setPotential] = useState("all");
  const [source, setSource] = useState("all");
  const [category, setCategory] = useState("all");
  const [tab, setTab] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("daysInactive");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [logId, setLogId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  function reload() {
    startBusy(async () => {
      const res = await getRecoveryBoard();
      if (res.ok) setRows(res.rows);
      else toast.error(res.error);
    });
  }

  /** Run a change, then read the list again so every figure is the database's. */
  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done?: string) {
    startBusy(async () => {
      const res = await fn();
      if (!res.ok) { toast.error(res.error); return; }
      if (done) toast.success(done);
      const b = await getRecoveryBoard();
      if (b.ok) setRows(b.rows);
    });
  }

  const categories = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const kpi = useMemo(() => {
    const total = rows.length;
    const by = (s: string) => rows.filter((r) => r.status === s).length;
    const recovered = by("Recovered");
    return {
      total,
      auto: rows.filter((r) => r.source === "auto").length,
      manual: rows.filter((r) => r.source === "manual").length,
      added: rows.filter((r) => r.source === "added").length,
      high: rows.filter((r) => r.potential === "high").length,
      noAnswer: rows.filter((r) => (NO_ANSWER as string[]).includes(r.status)).length,
      na: NO_ANSWER.map(by),
      progress: rows.filter((r) => (IN_PROGRESS as string[]).includes(r.status)).length,
      recovered,
      rate: total ? (recovered / total) * 100 : 0,
    };
  }, [rows]);

  const statusCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.status] = (m[r.status] ?? 0) + 1;
    return m;
  }, [rows]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (tab !== "all" && r.status !== tab) return false;
      if (potential !== "all" && r.potential !== potential) return false;
      if (source !== "all" && r.source !== source) return false;
      if (category !== "all" && r.category !== category) return false;
      if (q && !`${r.name} ${r.code} ${r.phone} ${r.area} ${r.reason}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const rank = { high: 3, medium: 2, low: 1 } as const;
    const val = (r: RecoveryRow): string | number | null =>
      sortKey === "name" ? r.name.toLowerCase()
      : sortKey === "area" ? r.area.toLowerCase()
      : sortKey === "potential" ? rank[r.potential]
      : r.daysInactive;
    return list.map((r, i) => [r, i] as const)
      .sort((a, b) => {
        const va = val(a[0]), vb = val(b[0]);
        // No delivery on record has no "how long" — it goes last either way, not first.
        if (va === null || vb === null) return va === vb ? a[1] - b[1] : va === null ? 1 : -1;
        return va < vb ? -sortDir : va > vb ? sortDir : a[1] - b[1];
      })
      .map((x) => x[0]);
  }, [rows, search, tab, potential, source, category, sortKey, sortDir]);

  function sortBy(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(1); }
  }
  const Arrow = ({ k }: { k: SortKey }) =>
    sortKey === k ? (sortDir === 1 ? <ArrowUp className="ml-0.5 inline size-3 text-primary" /> : <ArrowDown className="ml-0.5 inline size-3 text-primary" />) : null;

  function exportCsv() {
    const head = ["Name", "Code", "Phone", "Area", "Left because", "Source", "Category", "Potential", "Last delivery", "Days inactive", "Was taking", "Recovery status", "Timeline"];
    const lines = [head.join(",")];
    for (const r of shown) {
      const timeline = [...r.activity].reverse().map((a) =>
        a.type === "STATUS" ? `[${fmtWhen(a.at)}] Status: ${a.from} -> ${a.to}${a.by ? ` (${a.by})` : ""}`
        : `[${fmtWhen(a.at)}] ${a.type === "CALL" ? "Call" : "Note"}: ${a.text}${a.by ? ` (${a.by})` : ""}`,
      ).join("  ||  ");
      const vals = [r.name, r.code, r.phone, r.area, r.reason, SOURCE_LABEL[r.source], r.category, r.potential, fmtDay(r.lastDelivery), r.daysInactive ?? "", r.products, r.status, timeline];
      lines.push(vals.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = "customer-recovery.csv";
    a.click();
  }

  const selected = logId ? rows.find((r) => r.customerId === logId) ?? null : null;
  const tabs = ["all", ...RECOVERY_STATUSES];

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="sm" className="h-9" onClick={exportCsv}><Download className="mr-1.5 size-3.5" /> Export CSV</Button>
        <Button size="sm" className="h-9" onClick={() => setAddOpen(true)}><Plus className="mr-1.5 size-3.5" /> Add customer</Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Total Churned" value={kpi.total.toLocaleString("en-PK")}
          sub={`${kpi.auto} lapsed · ${kpi.manual} marked${kpi.added ? ` · ${kpi.added} added` : ""}`}
          tip="Every customer on the list: moved to Lost automatically after 20 days with no delivery, marked as left by a manager, or added by hand." />
        <Kpi label="High Potential" value={kpi.high.toLocaleString("en-PK")} sub="away for a while, or simply stopped" color="#0F5028"
          tip="Customers who left for a while and said so, or who stopped ordering without leaving — the likeliest to come back." />
        <Kpi label="Not Picking Up" value={kpi.noAnswer.toLocaleString("en-PK")} sub={`${kpi.na[0]} / ${kpi.na[1]} / ${kpi.na[2]} by attempt`} color="#B23408"
          tip="Customers who have not answered — at the 1st, 2nd or 3rd call attempt." />
        <Kpi label="In Progress" value={kpi.progress.toLocaleString("en-PK")} sub="interested · call back · pending" color="#1A3A9E"
          tip="Being won back: reached and interested, asked to call back, or a delivery is pending." />
        <Kpi label="Recovered" value={kpi.recovered.toLocaleString("en-PK")} sub="back on service" color="#0F5028"
          tip="Marked recovered — by hand, or automatically once the customer is active again." />
        <Kpi label="Recovery Rate" value={`${kpi.rate.toFixed(1)}%`} sub="recovered / total" color="#1A3A9E"
          tip="Recovered ÷ everyone on the list. The win-back success rate." />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, code, area or reason…" className="h-9 pl-8 text-xs" />
          </div>
          {[
            { v: potential, set: setPotential, opts: [["all", "All potential"], ["high", "High potential"], ["medium", "Medium potential"], ["low", "Low potential"]] },
            { v: source, set: setSource, opts: [["all", "All sources"], ["auto", "Auto-lapsed (no delivery 20+ days)"], ["manual", "Marked left by a manager"], ["added", "Added for follow-up"]] },
            { v: category, set: setCategory, opts: [["all", "All reasons"], ...categories.map(([c, n]) => [c, `${c} (${n})`])] },
          ].map((f, i) => (
            <select key={i} value={f.v} onChange={(e) => f.set(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2.5 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-ring">
              {f.opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ))}
        </div>

        {/* Status tabs */}
        <div className="flex flex-wrap gap-2 px-4 pb-2 pt-3">
          {tabs.map((t) => {
            const col = t === "all" ? "#1A4D2E" : colorOf(t);
            const on = tab === t;
            const n = t === "all" ? rows.length : statusCounts[t] ?? 0;
            return (
              <button key={t} type="button" onClick={() => setTab(t)}
                className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-transform hover:-translate-y-px"
                style={on ? { background: col, color: "#fff", borderColor: col } : { background: tint(col), color: col, borderColor: tint(col) }}>
                {t === "all" ? "All" : t}
                <span className="rounded-full px-1.5 text-[10px] font-bold" style={on ? { background: "rgba(255,255,255,.25)", color: "#fff" } : { background: col, color: "#fff" }}>{n}</span>
              </button>
            );
          })}
        </div>

        {/* Table */}
        <div className="max-h-[600px] overflow-auto">
          <table className="w-full min-w-[900px] text-xs">
            <thead>
              <tr className="border-b border-border">
                {([["name", "Customer"], ["area", "Area"], [null, "Left because"], ["potential", "Potential"], ["daysInactive", "Inactive"], [null, "Recovery status"], [null, "Action"]] as [SortKey | null, string][]).map(([k, l]) => (
                  <th key={l} onClick={k ? () => sortBy(k) : undefined}
                    className={cn("sticky top-0 whitespace-nowrap bg-card px-3.5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground", k && "cursor-pointer select-none hover:text-foreground")}>
                    {l}{k && <Arrow k={k} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {shown.length === 0 ? (
                <tr><td colSpan={7} className="py-14 text-center text-sm text-muted-foreground"><UserX className="mx-auto mb-2 size-6 opacity-40" />Nobody matches these filters.</td></tr>
              ) : shown.map((r) => (
                <tr key={r.customerId} className="hover:bg-muted/30">
                  <td className="px-3.5 py-2.5">
                    <div className="text-[13px] font-semibold">{r.name}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {r.code} · {r.phone} · <span className={cn("font-semibold", SOURCE_TONE[r.source])}>{SOURCE_LABEL[r.source].toLowerCase()}</span>
                      {r.source === "added" && r.customerStatus === "ACTIVE" && <span className="ml-1 font-semibold text-emerald-700">· active</span>}
                    </div>
                  </td>
                  <td className="max-w-[160px] px-3.5 py-2.5 text-muted-foreground">{r.area || "—"}</td>
                  <td className="max-w-[220px] px-3.5 py-2.5">{r.reason}</td>
                  <td className="px-3.5 py-2.5">
                    <span className={cn("rounded-full px-2.5 py-0.5 text-[10px] font-semibold capitalize", POTENTIAL_PILL[r.potential])}>{r.potential}</span>
                  </td>
                  <td className="whitespace-nowrap px-3.5 py-2.5 tabular-nums" title={r.lastDelivery ? `Last delivery ${fmtDay(r.lastDelivery)}` : "No delivery on record"}>
                    {fmtInactive(r.daysInactive)}
                  </td>
                  <td className="px-3.5 py-2.5">
                    <StatusSelect value={r.status} disabled={busy}
                      onChange={(s) => {
                        setRows((list) => list.map((x) => (x.customerId === r.customerId ? { ...x, status: s } : x)));
                        run(() => setRecoveryStatus(r.customerId, s));
                      }} />
                  </td>
                  <td className="whitespace-nowrap px-3.5 py-2.5">
                    <a href={`tel:${r.phone}`} className="mr-1.5 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-[11px] font-semibold text-emerald-800 hover:bg-muted">
                      <Phone className="size-3" /> Call
                    </a>
                    <Button size="sm" variant="secondary" className="h-7 px-2.5 text-[11px]" onClick={() => setLogId(r.customerId)}>
                      Log{r.activity.length ? ` (${r.activity.length})` : ""}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="px-1 text-[11px] text-muted-foreground">
        Showing {shown.length} of {rows.length} customers{busy ? " · saving…" : ""}
        <button type="button" onClick={reload} className="ml-2 underline-offset-2 hover:underline">Refresh</button>
      </p>

      <LogDialog row={selected} busy={busy} onClose={() => setLogId(null)} run={run} />
      <AddDialog open={addOpen} onClose={() => setAddOpen(false)} run={run} />
    </div>
  );
}

// ── Log / detail ─────────────────────────────────────────────────────────────

function LogDialog({
  row, busy, onClose, run,
}: {
  row: RecoveryRow | null;
  busy: boolean;
  onClose: () => void;
  run: (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done?: string) => void;
}) {
  const [note, setNote] = useState("");
  if (!row) return null;

  // One way to log: write what happened above, then Log.
  const log = () => {
    const t = note.trim();
    if (!t) { toast.error("Write what happened first."); return; }
    run(() => logRecoveryEntry(row.customerId, "NOTE", t));
    setNote("");
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) { setNote(""); onClose(); } }}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-lg">{row.name}</DialogTitle>
          <DialogDescription className="text-xs">
            {row.code} · {row.phone}{row.area ? ` · ${row.area}` : ""} · {SOURCE_LABEL[row.source]}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1 rounded-lg bg-muted/50 px-3.5 py-3 text-xs">
          {[
            ["Left because", row.reason],
            ["Last delivery", fmtDay(row.lastDelivery)],
            ["Inactive for", fmtInactive(row.daysInactive)],
            ["Was taking", row.products || "—"],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4">
              <span className="text-muted-foreground">{k}</span>
              <span className="max-w-[65%] text-right font-semibold">{v}</span>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <label className="block text-[11px] font-semibold text-muted-foreground">Recovery status</label>
          <StatusSelect value={row.status} disabled={busy} className="h-9 w-full max-w-none text-xs"
            onChange={(s) => run(() => setRecoveryStatus(row.customerId, s))} />

          <label className="block pt-1 text-[11px] font-semibold text-muted-foreground">Log what happened (call outcome, note, next step…)</label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") log(); }}
            placeholder="e.g. Said will resume after Eid, call back on the 15th" className="h-9 text-xs" />
          <Button className="w-full" size="sm" disabled={busy || !note.trim()} onClick={log}>Log</Button>
        </div>

        <div>
          <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Activity timeline</p>
          <p className="mb-2 text-[11px] text-muted-foreground">Every status change and logged call or note, newest first.</p>
          {row.activity.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">No activity yet. Log what happened or change the status to start the timeline.</p>
          ) : (
            <div className="max-h-[340px] divide-y divide-border/60 overflow-y-auto">
              {row.activity.map((a) => <TimelineItem key={a.id} a={a} />)}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TimelineItem({ a }: { a: RecoveryActivity }) {
  const badge =
    a.type === "STATUS" ? { label: "STATUS", cls: "bg-blue-50 text-blue-800" }
    : a.type === "CALL" ? { label: "CALL", cls: "bg-emerald-50 text-emerald-800" }
    : { label: "NOTE", cls: "bg-amber-50 text-amber-800" };
  return (
    <div className="flex gap-3 py-3">
      <div className="w-14 shrink-0">
        <span className={cn("rounded px-2 py-0.5 text-[9.5px] font-bold tracking-wide", badge.cls)}>{badge.label}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-snug">
          {a.type === "STATUS" ? (
            <>
              <span className="font-semibold">{a.from}</span> <span className="text-muted-foreground">to</span>{" "}
              <span className="font-semibold" style={{ color: colorOf(a.to ?? "") }}>{a.to}</span>
              {a.text && <span className="text-muted-foreground"> — {a.text}</span>}
            </>
          ) : a.text}
        </div>
        <div className="mt-1 text-[10.5px] text-muted-foreground">{fmtWhen(a.at)}{a.by ? ` · ${a.by}` : ""}</div>
      </div>
    </div>
  );
}

// ── Add a customer by hand ───────────────────────────────────────────────────

function AddDialog({
  open, onClose, run,
}: {
  open: boolean;
  onClose: () => void;
  run: (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done?: string) => void;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<AddCandidate[]>([]);
  const [pick, setPick] = useState<AddCandidate | null>(null);
  const [note, setNote] = useState("");
  const [searching, startSearch] = useTransition();

  function close() { setQ(""); setFound([]); setPick(null); setNote(""); onClose(); }
  function doSearch(v: string) {
    setQ(v); setPick(null);
    if (v.trim().length < 2) { setFound([]); return; }
    startSearch(async () => setFound(await findCustomersToAdd(v)));
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add customer to recovery</DialogTitle>
          <DialogDescription className="text-xs">
            Lost customers are on the list already. Add anyone else you want to follow up — someone who has gone quiet, say.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus value={q} onChange={(e) => doSearch(e.target.value)} placeholder="Search by name, phone or code…" className="h-9 pl-8 text-xs" />
          </div>
          {!pick && q.trim().length >= 2 && (
            <div className="max-h-56 overflow-y-auto rounded-md border border-border">
              {searching ? <p className="p-3 text-center text-xs text-muted-foreground">Searching…</p>
              : found.length === 0 ? <p className="p-3 text-center text-xs text-muted-foreground">No customer found who isn&apos;t already on the list.</p>
              : found.map((c) => (
                <button key={c.id} type="button" onClick={() => setPick(c)} className="flex w-full items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-left text-xs last:border-0 hover:bg-muted">
                  <span><span className="font-semibold">{c.name}</span> <span className="text-muted-foreground">· {c.code} · {c.phone}</span></span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{c.status.replace("_", " ").toLowerCase()}{c.area ? ` · ${c.area}` : ""}</span>
                </button>
              ))}
            </div>
          )}
          {pick && (
            <div className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs">
              <span className="font-semibold">{pick.name}</span> · {pick.code} · {pick.phone}
              <button type="button" className="ml-2 text-muted-foreground underline" onClick={() => setPick(null)}>change</button>
            </div>
          )}
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why — e.g. stopped ordering since last week (optional)" className="h-9 text-xs" />
          <Button className="w-full" disabled={!pick} onClick={() => { if (pick) { run(() => addToRecovery(pick.id, note), `${pick.name} added to the recovery list.`); close(); } }}>
            Add to recovery list
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
