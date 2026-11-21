"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Search, Wallet, Clock, Coins, CheckCircle2, Download, HandCoins, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { fmtDatePKT, fmtTimePKT, toDateStrPKT, todayPKTString } from "@/lib/pkt";
import { RangeCalendar } from "@/components/ui/range-calendar";
import type { PaymentHeadName } from "@/lib/payment-heads";
import {
  confirmRiderCashReceived, type RiderCashData, type RiderCashRow,
} from "@/app/(dashboard)/payments/rider-cash/actions";

/** One colour per account, so a head reads the same here as on the dashboard. */
const HEAD_COLOUR: Record<string, string> = {
  RIDER_CASH: "#1A4D2E",
  HBL: "#1A3A9E",
  MEEZAN: "#6B2A8C",
  JAZZCASH: "#B23408",
  EASYPAISA: "#0F766E",
  CASH: "#7A4F08",
} satisfies Record<PaymentHeadName, string>;

function fmt(n: number) {
  return "Rs " + Math.round(n).toLocaleString("en-PK");
}
function initials(name: string) {
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

const STATUS_META: Record<RiderCashRow["status"], { label: string; cls: string }> = {
  pending:  { label: "Pending",             cls: "bg-amber-100 text-amber-700"   },
  awaiting: { label: "Awaiting acceptance",  cls: "bg-indigo-100 text-indigo-700" },
  received: { label: "Confirmed received",   cls: "bg-emerald-100 text-emerald-700" },
};

function StatusBadge({ status }: { status: RiderCashRow["status"] }) {
  const m = STATUS_META[status];
  return <span className={cn("inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap", m.cls)}>{m.label}</span>;
}

// ── Confirm-received dialog ───────────────────────────────────────────────────
function ConfirmDialog({ row, onClose, onDone }: { row: RiderCashRow | null; onClose: () => void; onDone: () => void }) {
  // A plain flag, deliberately NOT useTransition.
  //
  // onDone() refreshes the page, and router.refresh() called from inside a
  // transition keeps that transition pending until the entire server re-render has
  // come back and committed. So "Saving…" sat on this button for the save AND a
  // full re-render of this page — the table, the head balances, cash with riders,
  // collected today — when the save itself had finished seconds earlier. The money
  // was already in the box; the person was just watching the page rebuild.
  //
  // With a flag the button is finished when the save is finished. The dialog closes
  // at once and the refreshed figures land a moment later, which is the same work
  // in the same order — the person simply is not held behind it.
  const [saving, setSaving] = useState(false);
  async function confirm() {
    if (!row || saving) return;
    setSaving(true);
    const res = await confirmRiderCashReceived(row.id);
    setSaving(false);
    if (res.ok) { toast.success("Cash confirmed received."); onDone(); }
    else toast.error(res.error);
  }
  const pending = saving;
  return (
    <Dialog open={!!row} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Confirm cash received</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Confirm you have physically received this cash from the rider. It moves out of <strong>Cash With Riders</strong> and into the <strong>Rider Cash</strong> box.
        </p>
        {row && (
          <div className="mt-2 flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <div>
              <p className="text-[11px] text-muted-foreground">Rider · Customer</p>
              <p className="text-sm font-medium">{row.riderName} · {row.customer}</p>
            </div>
            <div className="text-right">
              <p className="text-[11px] text-muted-foreground">Amount</p>
              <p className="text-sm font-semibold">{fmt(row.amount)}</p>
            </div>
          </div>
        )}
        {row?.handedOverAt && (
          <p className="text-[11px] text-muted-foreground">
            Handed over{row.handedToName ? ` to ${row.handedToName}` : ""} on {fmtDatePKT(row.handedOverAt)} · {fmtTimePKT(row.handedOverAt)}.
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button size="sm" onClick={confirm} disabled={pending}>{pending ? "Saving…" : "Confirm received"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Summary card ──────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, icon: Icon, feature }: {
  label: string; value: string; sub?: string; icon: React.ElementType; feature?: boolean;
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-4", feature ? "border-emerald-500 ring-1 ring-emerald-500" : "border-border")}>
      <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <span className={cn("grid size-7 place-items-center rounded-md", feature ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground")}>
          <Icon className="size-4" />
        </span>
        {label}
      </div>
      <p className="mt-2.5 text-2xl font-bold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export function RiderCashClient({ data }: { data: RiderCashData }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [rider, setRider] = useState("");
  const [status, setStatus] = useState("");
  const [confirmRow, setConfirmRow] = useState<RiderCashRow | null>(null);
  const [pending, start] = useTransition();

  // Seeded from what the server actually applied, not from raw URL text, so a
  // reversed or malformed range shows the corrected window rather than lying about
  // what is on screen.
  const from = data.range?.from ?? "";
  const to = data.range?.to ?? "";

  // A dot under every day that actually has a collection in view.
  const datesWithRows = useMemo(
    () => new Set(data.rows.map((r) => toDateStrPKT(r.collectedAt))),
    [data.rows]
  );

  /** Put the window in the URL and let the page re-query. */
  function applyRange(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams();
    if (nextFrom) params.set("from", nextFrom);
    if (nextTo) params.set("to", nextTo);
    const qs = params.toString();
    start(() => { router.push(qs ? `/payments/rider-cash?${qs}` : "/payments/rider-cash", { scroll: false }); });
  }
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (q && !(r.customer.toLowerCase().includes(q) || r.riderName.toLowerCase().includes(q) || r.customerCode.toLowerCase().includes(q))) return false;
      if (rider && r.riderId !== rider) return false;
      // "__sample__" is not a status — it is the sample/real split, which is what the
      // chip above offers alongside the three real statuses.
      if (status === "__sample__") { if (r.customerCode !== "SAMPLE") return false; }
      else if (status && r.status !== status) return false;
      return true;
    });
  }, [data.rows, search, rider, status]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return sortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [filtered, sortKey, sortDir]);

  const filteredTotal = filtered.reduce((s, r) => s + r.amount, 0);

  /**
   * Cash still with riders, split real from sample.
   *
   * A sample collection is rider cash like any other until it is confirmed, but it
   * must never be added to the real Rider Cash box — so the two are counted apart
   * and shown apart. A sample row is one with no customer behind it.
   */
  const split = useMemo(() => {
    let real = 0, sample = 0, samplePending = 0;
    for (const r of data.rows) {
      if (r.status === "received") continue;
      if (r.customerCode === "SAMPLE") { sample += r.amount; samplePending++; }
      else real += r.amount;
    }
    return { real, sample, samplePending };
  }, [data.rows]);

  /**
   * The same collection entered twice.
   *
   * Same rider, same customer, same amount, same day. The app has written a second
   * copy of a collection more than once, and two identical rows read as two separate
   * payments — so they are flagged rather than left to be spotted by eye.
   */
  const dupKeys = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of data.rows) {
      if (r.customerCode === "SAMPLE" && !r.customer) continue;
      const k = `${r.riderId ?? ""}|${(r.customerCode || r.customer).toLowerCase()}|${Math.round(r.amount)}|${toDateStrPKT(r.collectedAt)}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    return new Set([...count].filter(([, n]) => n > 1).map(([k]) => k));
  }, [data.rows]);
  const isDup = (r: RiderCashRow) =>
    dupKeys.has(`${r.riderId ?? ""}|${(r.customerCode || r.customer).toLowerCase()}|${Math.round(r.amount)}|${toDateStrPKT(r.collectedAt)}`);

  /** Counts for the chips, over the range and search but not the status itself. */
  const chipCounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = data.rows.filter((r) => {
      if (q && !(r.customer.toLowerCase().includes(q) || r.riderName.toLowerCase().includes(q) || r.customerCode.toLowerCase().includes(q))) return false;
      if (rider && r.riderId !== rider) return false;
      return true;
    });
    return {
      all: base.length,
      pending: base.filter((r) => r.status === "pending").length,
      awaiting: base.filter((r) => r.status === "awaiting").length,
      received: base.filter((r) => r.status === "received").length,
      sample: base.filter((r) => r.customerCode === "SAMPLE").length,
    };
  }, [data.rows, search, rider]);

  function toggleRider(name: string) {
    setRider((cur) => (cur === name ? "" : name));
  }

  function exportCSV() {
    const head = ["Date", "Time", "Rider", "Customer", "Code", "Area", "Amount", "Status", "Handed Over To", "Handed Over At", "Received At"];
    const lines = filtered.map((r) => [
      fmtDatePKT(r.collectedAt), fmtTimePKT(r.collectedAt), r.riderName, r.customer, r.customerCode, r.area,
      Math.round(r.amount), STATUS_META[r.status].label,
      r.handedToName ?? "", r.handedOverAt ? `${fmtDatePKT(r.handedOverAt)} ${fmtTimePKT(r.handedOverAt)}` : "",
      r.receivedAt ? `${fmtDatePKT(r.receivedAt)} ${fmtTimePKT(r.receivedAt)}` : "",
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = data.range
      ? `rider-cash-${data.range.from}-to-${data.range.to}.csv`
      : `rider-cash-${toDateStrPKT(new Date())}.csv`;
    a.click();
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* Cash with riders */}
      {data.tiles.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Cash with riders</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {data.tiles.map((t) => (
              <button
                key={t.riderId ?? "__unassigned__"}
                onClick={() => toggleRider(t.riderId ?? "")}
                className={cn(
                  "flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:border-emerald-500",
                  t.riderId && rider === t.riderId ? "border-emerald-500 ring-1 ring-emerald-500" : "border-border"
                )}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[#13352b] text-xs font-semibold text-white">{initials(t.riderName)}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold">{t.riderName}</span>
                  <span className="block text-lg font-bold tabular-nums text-amber-700">{fmt(t.pending)}</span>
                  <span className="block text-[11px] text-muted-foreground">still to hand over</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard feature label="Cash With Riders" value={fmt(data.summary.withRiders)} sub="Collected but not yet handed over · not in any account" icon={Wallet} />
        <StatCard label="Pending Settlements" value={String(data.summary.pendingCount)} sub="collections awaiting confirmation" icon={Clock} />
        <StatCard label="Collected Today" value={fmt(data.summary.collectedToday)} icon={Coins} />
        <StatCard label="Received Today" value={fmt(data.summary.receivedToday)} icon={CheckCircle2} />
      </div>

      {/* Payment heads.
          Cash With Riders above and the Rider Cash box here are the two figures
          people confuse: the first is money the riders are carrying — real money owed
          to the farm, but in NO account, because it is not here yet. Confirming a
          handover is what moves it into the box.

          Office Cash is deliberately absent. It is a separate account and is not where
          confirmed cash lands — that only happens when somebody actually deposits the
          box, as a transfer on the Transfers screen. */}
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Payment heads · balances
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {data.headBalances.map((h) => {
            const colour = HEAD_COLOUR[h.head] ?? "#6B7280";
            const isBox = h.head === "RIDER_CASH";
            return (
              <div key={h.head} className="rounded-xl border border-border bg-card p-3.5" style={{ borderLeftWidth: 4, borderLeftColor: colour }}>
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-muted-foreground">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: colour }} />
                  {isBox ? "Rider Cash box" : h.label}
                </p>
                <p className="mt-2 text-[22px] font-bold leading-none tabular-nums" style={{ color: colour }}>{fmt(h.balance)}</p>
                <p className="mt-1.5 text-[11px] font-medium text-muted-foreground">
                  {isBox ? "handed over & confirmed" : "account balance"}
                </p>
                {isBox && (
                  <p className={cn("mt-1.5 text-[11px] font-semibold", split.real > 0 ? "text-amber-700" : "text-muted-foreground")}>
                    {split.real > 0 ? `● ${fmt(split.real)} still with riders` : "Nothing pending"}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Sample, kept apart on purpose: sample collections are rider cash until they
          are confirmed, but they must never be counted into the real box above. */}
      {(split.sample > 0 || split.samplePending > 0) && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sample</p>
          <div className="max-w-xs rounded-xl border border-dashed border-blue-300 bg-blue-50/60 p-3.5 dark:border-blue-900 dark:bg-blue-950/30"
               style={{ borderLeftWidth: 4, borderLeftStyle: "solid", borderLeftColor: "#1A3A9E" }}>
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-blue-900 dark:text-blue-300">
              <span className="size-2 shrink-0 rounded-full bg-[#1A3A9E]" />
              Sample rider cash
              <span className="ml-auto rounded-full bg-blue-100 px-2 py-px text-[10px] font-bold uppercase tracking-wide text-blue-800">Sample</span>
            </p>
            <p className="mt-2 text-[22px] font-bold leading-none tabular-nums text-[#1A3A9E]">{fmt(split.sample)}</p>
            <p className="mt-1.5 text-[11px] font-medium text-muted-foreground">
              {split.samplePending} collection{split.samplePending === 1 ? "" : "s"} · never settles into the real box
            </p>
          </div>
        </div>
      )}

      {/* Status at a glance, with how many of each. The dropdown below still works
          and stays in step with these. */}
      <div className="flex flex-wrap gap-1.5">
        {([
          ["", "All", chipCounts.all],
          ["awaiting", "Awaiting acceptance", chipCounts.awaiting],
          ["pending", "With rider", chipCounts.pending],
          ["received", "Confirmed", chipCounts.received],
          ["__sample__", "Sample", chipCounts.sample],
        ] as const).map(([key, label, n]) => (
          <button
            key={label}
            type="button"
            onClick={() => setStatus(key)}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors",
              status === key ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:border-emerald-600 hover:text-emerald-700"
            )}
          >
            {label}
            <span className={cn("rounded-full px-1.5 text-[11px] font-bold", status === key ? "bg-white/20" : "bg-black/5 dark:bg-white/10")}>{n}</span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer or rider…" className="h-9 pl-8 text-sm" />
        </div>
        <Select value={rider || "__all__"} onValueChange={(v) => setRider(v === "__all__" ? "" : v)}>
          <SelectTrigger className="h-9 w-40 text-xs"><SelectValue placeholder="All riders" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__" className="text-xs">All riders</SelectItem>
            {data.riders.map((r) => <SelectItem key={r.id} value={r.id} className="text-xs">{r.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={status || "__all__"} onValueChange={(v) => setStatus(v === "__all__" ? "" : v)}>
          <SelectTrigger className="h-9 w-40 text-xs"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__" className="text-xs">All statuses</SelectItem>
            <SelectItem value="pending" className="text-xs">Pending</SelectItem>
            <SelectItem value="awaiting" className="text-xs">Awaiting acceptance</SelectItem>
            <SelectItem value="received" className="text-xs">Confirmed received</SelectItem>
            <SelectItem value="__sample__" className="text-xs">Sample only</SelectItem>
          </SelectContent>
        </Select>
        {/* The date window is picked on the calendar below — the two typed date
            boxes that used to sit here are gone. Either way the range goes into the
            URL, so the SERVER re-queries and the table is not limited to the rows
            already in the browser. */}
        {(from || to) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-2 text-xs text-muted-foreground"
            onClick={() => applyRange("", "")}
            disabled={pending}
            title="Clear the date filter"
          >
            <X className="mr-1 size-3.5" /> Clear dates
          </Button>
        )}
        <Button variant="outline" size="sm" className="ml-auto h-9 text-xs" onClick={exportCSV}>
          <Download className="mr-1.5 size-3.5" /> Export CSV
        </Button>
      </div>

      {/* The only way to pick dates here now. Unlike the Wastage page a pick goes
          into the URL rather than into local state — this table is filtered by the
          SERVER, so a browser-side range would only search the rows already sent.
          It stays on screen rather than closing itself after a pick: a calendar
          that vanishes once used cannot be corrected without hunting for the way
          back to it. */}
      <RangeCalendar
        className="max-w-xs"
        from={from}
        to={to}
        maxDate={todayPKTString()}
        datesWithEntries={datesWithRows}
        onApply={applyRange}
      />

      {/* Say plainly what the table is showing, and that the figures above are not
          scoped to it — otherwise a filtered view reading "with riders" as unchanged
          looks like a bug rather than the point. */}
      <p className="-mt-1 text-[11px] text-muted-foreground">
        {data.range ? (
          <>
            Showing <span className="font-medium text-foreground">{filtered.length}</span> collection{filtered.length === 1 ? "" : "s"}
            {data.range.from === data.range.to
              ? <> on <span className="font-medium text-foreground">{fmtDatePKT(data.range.from)}</span></>
              : <> from <span className="font-medium text-foreground">{fmtDatePKT(data.range.from)}</span> to <span className="font-medium text-foreground">{fmtDatePKT(data.range.to)}</span></>}
            {" · "}totalling <span className="font-medium text-foreground">{fmt(filteredTotal)}</span>.
            {" "}The cards above always show the live position, not this window.
          </>
        ) : (
          <>Showing everything not yet confirmed, plus the last 30 days. Pick a date range to look further back.</>
        )}
      </p>

      {/* Ledger table */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th
                onClick={() => handleSort("collectedAt")}
                className="border-b border-border px-3 py-2.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap text-left cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Date
                  <span className={sortKey === "collectedAt" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "collectedAt" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("riderName")}
                className="border-b border-border px-3 py-2.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap text-left cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Rider
                  <span className={sortKey === "riderName" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "riderName" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("customer")}
                className="border-b border-border px-3 py-2.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap text-left cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Customer
                  <span className={sortKey === "customer" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "customer" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("amount")}
                className="border-b border-border px-3 py-2.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap text-right cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center justify-end gap-1">
                  Cash Amount
                  <span className={sortKey === "amount" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "amount" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("status")}
                className="border-b border-border px-3 py-2.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap text-left cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Status
                  <span className={sortKey === "status" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "status" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("handedToName")}
                className="border-b border-border px-3 py-2.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap text-left cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Handed Over To
                  <span className={sortKey === "handedToName" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "handedToName" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th className="border-b border-border px-3 py-2.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap text-left" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={7} className="py-10 text-center text-sm text-muted-foreground">No rider cash matches these filters.</td></tr>
            ) : sorted.map((r) => (
              <tr key={r.id} className={cn("border-b border-border/50 hover:bg-muted/20", isDup(r) && "bg-amber-50/40 dark:bg-amber-950/10")}>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <div className="font-medium">{fmtDatePKT(r.collectedAt)}</div>
                  <div className="text-[11px] text-muted-foreground">{fmtTimePKT(r.collectedAt)}</div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#13352b] text-[10px] font-semibold text-white">{initials(r.riderName)}</span>
                    <span className="whitespace-nowrap">{r.riderName}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5 font-medium">
                    {r.customer}
                    {r.customerCode === "SAMPLE" && (
                      <span className="rounded-full bg-blue-50 px-2 py-px text-[9px] font-bold uppercase tracking-wide text-blue-800">Sample</span>
                    )}
                    {isDup(r) && (
                      <span
                        className="rounded-full bg-rose-50 px-2 py-px text-[9px] font-bold uppercase tracking-wide text-rose-800"
                        title="Same rider, customer, amount and day as another row — check before confirming both"
                      >
                        Possible duplicate
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{r.customerCode} · {r.area}</div>
                </td>
                <td className="px-3 py-2.5 text-right font-semibold tabular-nums whitespace-nowrap">{fmt(r.amount)}</td>
                <td className="px-3 py-2.5"><StatusBadge status={r.status} /></td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {r.receivedAt ? (
                    <div><div className="font-medium">{r.handedToName ?? "—"}</div><div className="text-[11px] text-muted-foreground">Received {fmtDatePKT(r.receivedAt)} · {fmtTimePKT(r.receivedAt)}</div></div>
                  ) : r.handedOverAt ? (
                    <div><div className="font-medium">{r.handedToName ?? "—"}</div><div className="text-[11px] text-muted-foreground">Handed {fmtDatePKT(r.handedOverAt)} · {fmtTimePKT(r.handedOverAt)}</div></div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {r.status === "received" ? (
                    <span className="text-[11px] text-muted-foreground">
                      Confirmed{r.receivedByName ? ` (by ${r.receivedByName})` : ""}
                    </span>
                  ) : (
                    // Only once the rider has recorded the handover in the app
                    // (status "awaiting"). The office confirms that cash ARRIVED; it
                    // does not get to assert that a rider handed it over. The server
                    // refuses it anyway — this makes the rule visible.
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px] text-emerald-700 hover:bg-emerald-50"
                      disabled={r.status !== "awaiting"}
                      title={r.status !== "awaiting" ? "Waiting on the rider to record the handover in the app" : undefined}
                      onClick={() => setConfirmRow(r)}
                    >
                      <HandCoins className="mr-1 size-3.5" /> Confirm received
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {filtered.length > 0 && (
            <tfoot>
              <tr className="bg-muted/40">
                <td colSpan={3} className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Total (filtered)</td>
                <td className="px-3 py-2.5 text-right font-bold tabular-nums">{fmt(filteredTotal)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* router.refresh() is required, not belt-and-braces: revalidatePath inside
          the action does NOT re-render this view on its own. Tested — drop it and
          the row sits on "Awaiting acceptance" until the page is reloaded by hand.
          What changed is only WHEN it runs: the dialog no longer holds the person
          behind it (see ConfirmDialog). */}
      <ConfirmDialog row={confirmRow} onClose={() => setConfirmRow(null)} onDone={() => { setConfirmRow(null); router.refresh(); }} />
    </div>
  );
}

