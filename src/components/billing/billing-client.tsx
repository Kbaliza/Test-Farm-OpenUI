"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { FileText, Plus, Search, RefreshCw, ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  generateInvoice,
  bulkGenerate,
  setPeriodDueDate,
  type BillingOverview,
  type BillingCustomerRow,
} from "@/app/(dashboard)/billing/invoices/actions";
import { setBillingLastDate } from "@/app/(dashboard)/billing/billing-settings";
import { BillDispatchDialog } from "@/components/billing/bill-dispatch-dialog";
import { BRAND } from "@/components/billing/invoice-document";
import { useRefreshOnFocus } from "@/components/util/use-refresh-on-focus";
import { fileNameFrom, saveBlob, describeFailure } from "@/lib/download";

function fmt(n: number) {
  return Math.abs(Math.round(n)).toLocaleString("en-PK");
}

// "2026-08-06" → "6 August 2026" for the message/due-date line.
const MONTH_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function fmtDueDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${Number(d)} ${MONTH_FULL[Number(mo) - 1]} ${y}`;
}

/**
 * Is there anything at all on this customer's row?
 *
 * Whole rows of dashes — a customer on the books who took no delivery this
 * fortnight, paid nothing and owes nothing — pushed the people who do have a
 * bill down the page. Rounded to the rupee, because a stray fraction of a paisa
 * is not "something".
 */
function hasAnything(c: BillingCustomerRow): boolean {
  return [c.prevBalance, c.deliveries, c.returns, c.deliveryCharge, c.discount, c.otcAmt, c.paymentsAmt, c.totalDue]
    .some((n) => Math.round(n) !== 0);
}

function StatusPill({ row }: { row: BillingCustomerRow }) {
  if (!row.generated) {
    return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">Not generated</span>;
  }
  const map: Record<string, { cls: string; label: string }> = {
    PAID:    { cls: "bg-emerald-100 text-emerald-700", label: "Paid" },
    PARTIAL: { cls: "bg-amber-100 text-amber-700",     label: "Partial" },
    OVERDUE: { cls: "bg-rose-100 text-rose-700",       label: "Overdue" },
    SENT:    { cls: "bg-sky-100 text-sky-700",         label: "Sent" },
    DRAFT:   { cls: "bg-violet-100 text-violet-700",   label: "Draft" },
  };
  const cfg = map[row.invoiceStatus] ?? map.DRAFT;
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", cfg.cls)}>{cfg.label}</span>;
}

export function BillingClient({ data, initialLastDate }: { data: BillingOverview; initialLastDate?: string }) {
  const router = useRouter();
  // Deliveries land from the rider app; keep this list live so a new delivery
  // shows without anyone having to regenerate. (Bills already compute live.)
  useRefreshOnFocus();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [shiftFilter, setShiftFilter] = useState<string>("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const [showEmpty, setShowEmpty] = useState(false);
  const monthLabel = `${MONTH_FULL[data.month - 1]} ${data.year}`;

  const selMonth = `${data.year}-${String(data.month).padStart(2, "0")}`;

  // "Last date" to pay — DB-persisted value if it belongs to this month, else end-of-month default.
  const monthEndDay = new Date(data.year, data.month, 0).getDate();
  const defaultLast = `${selMonth}-${String(monthEndDay).padStart(2, "0")}`;
  const [lastDate, setLastDate] = useState(initialLastDate ?? defaultLast);
  const periodKey = `${data.year}-${data.month}-${data.half}`;
  const [syncedPeriod, setSyncedPeriod] = useState(periodKey);
  if (syncedPeriod !== periodKey) {
    setSyncedPeriod(periodKey);
    setLastDate(defaultLast);
  }

  function navigate(m: string, h: number) {
    router.push(`/billing/invoices?${new URLSearchParams({ m, h: String(h) }).toString()}`, { scroll: false });
  }

  function handleLastDateChange(val: string) {
    setLastDate(val);
    // Persist to DB — both billing pages read from the same key on next load.
    setBillingLastDate(val);
  }

  function handleGenerate(customerId: string) {
    setBusyId(customerId);
    startTransition(async () => {
      const res = await generateInvoice(customerId, data.year, data.month, data.half, lastDate);
      setBusyId(null);
      if (res.ok && res.id) {
        toast.success("Invoice generated.");
        router.push(`/billing/invoices/${res.id}`);
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  const [zipping, setZipping] = useState(false);

  /**
   * Download every generated bill for this period as a zip, one PDF per customer.
   *
   * Follows the shift pills: with a shift chosen it is that shift, with "All" it is
   * the whole period. Which is why the button says which, rather than leaving the
   * person to remember what the pills were set to.
   *
   * It can take a minute for a large shift \u2014 each bill is a real page printed in a
   * real browser on the server \u2014 so the button says what it is doing and stays
   * disabled rather than looking ignored.
   */
  async function handleDownloadAll() {
    setZipping(true);
    const shiftName = shiftFilter ? data.shifts.find((s) => s.id === shiftFilter)?.name ?? "that shift" : "every shift";
    const note = toast.loading(`Making PDFs for ${shiftName}\u2026 this can take a minute.`);
    try {
      const p = new URLSearchParams({ year: String(data.year), month: String(data.month), half: String(data.half) });
      if (shiftFilter) p.set("shift", shiftFilter);
      const res = await fetch(`/api/bills/pdf?${p}`);
      if (!res.ok) {
        // Read the body whatever it turns out to be: a JSON message when the
        // server managed one, otherwise the status, so what goes wrong can be
        // reported rather than guessed at.
        const said = await describeFailure(res);
        toast.error(said ?? "Those bills could not be turned into PDFs.", { id: note });
        return;
      }
      const blob = await res.blob();
      const name = fileNameFrom(res.headers.get("content-disposition")) ?? "Bills.zip";
      saveBlob(blob, name);
      const zero = Number(res.headers.get("x-bills-skipped-zero") ?? 0);
      toast.success(
        zero > 0 ? `Bills downloaded. ${zero} bill${zero === 1 ? "" : "s"} of Rs 0 left out.` : "Bills downloaded.",
        { id: note },
      );
    } catch {
      toast.error("Those bills could not be downloaded.", { id: note });
    } finally {
      setZipping(false);
    }
  }

  function handleBulk() {
    startTransition(async () => {
      const res = await bulkGenerate(data.year, data.month, data.half, lastDate);
      if (res.ok) {
        toast.success(`Generated ${res.created} invoice${res.created !== 1 ? "s" : ""}${res.skipped ? ` · ${res.skipped} already existed` : ""}.`);
        router.refresh();
      } else {
        toast.error(res.error ?? "Bulk generation failed.");
      }
    });
  }

  function handleApplyLastDate() {
    startTransition(async () => {
      const res = await setPeriodDueDate(data.year, data.month, data.half, lastDate);
      if (res.ok) {
        toast.success(`Last date set on ${res.count} bill${res.count !== 1 ? "s" : ""}.`);
        router.refresh();
      } else {
        toast.error(res.error ?? "Failed to set last date.");
      }
    });
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return data.customers.filter((c) => {
      if (shiftFilter && c.shiftId !== shiftFilter) return false;
      // Nothing delivered, nothing returned, nothing bought, nothing paid and
      // nothing owing — a row of dashes that only makes the list longer. Kept
      // behind a toggle rather than dropped, because a customer with an old
      // balance still has a figure and must never disappear.
      if (!showEmpty && !hasAnything(c)) return false;
      if (q && !c.name.toLowerCase().includes(q) && !c.phone.includes(q) && !c.customerCode.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data.customers, search, shiftFilter, showEmpty]);

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

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Period selector */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Month</label>
            <input
              type="month"
              value={selMonth}
              onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) navigate(e.target.value, data.half); }}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Billing period</label>
            <div className="flex rounded-md border border-border bg-muted/40 p-0.5">
              {[
                { h: 1, label: "1st – 15th" },
                { h: 2, label: "16th – end" },
              ].map((p) => {
                const isActive = data.half === p.h;
                const isLocked = !data.openHalves.includes(p.h);
                return (
                  <button
                    key={p.h}
                    onClick={() => !isLocked && navigate(selMonth, p.h)}
                    disabled={isLocked}
                    className={cn(
                      "rounded px-3 py-1.5 text-xs font-medium transition-colors",
                      isActive
                        ? "bg-card shadow-sm text-foreground"
                        : isLocked
                          ? "pointer-events-none cursor-not-allowed opacity-40 text-muted-foreground"
                          : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Last date (shown on bills)</label>
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={lastDate}
                onChange={(e) => handleLastDateChange(e.target.value)}
                className="h-9 rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Button variant="outline" size="sm" className="h-9 text-xs" onClick={handleApplyLastDate} disabled={pending} title="Set this last date on all bills already generated for this period">
                Apply to all
              </Button>
            </div>
          </div>

          <p className="pb-1.5 text-xs text-muted-foreground">
            Showing <span className="font-medium text-foreground">{data.periodLabel}</span>
            {data.half === 2 ? " · delivery charge applies" : ""}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <BillDispatchDialog
            customers={data.customers}
            shifts={data.shifts}
            periodLabel={data.periodLabel}
            dueDate={fmtDueDate(lastDate)}
            businessName={BRAND.name}
          />
          <Button
            variant="outline"
            onClick={handleDownloadAll}
            disabled={zipping}
            className="shrink-0"
            title="Every generated bill for this period as a zip, one PDF per customer"
          >
            {zipping ? <RefreshCw className="mr-1.5 size-4 animate-spin" /> : <Download className="mr-1.5 size-4" />}
            {zipping ? "Making PDFs\u2026" : shiftFilter ? "Download this shift" : "Download all"}
          </Button>
          <Button onClick={handleBulk} disabled={pending} className="shrink-0">
            <Plus className="mr-1.5 size-4" />
            Generate all pending
          </Button>
        </div>
      </div>

      {/* The month as a whole — both fortnights added together. The cards below
          only ever speak for the half being viewed, which is the figure nobody
          was asking for when they wanted to know how the month is going. */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: `Total billed · ${monthLabel}`, value: `₨ ${fmt(data.totals.monthBilled)}`, color: "", ring: "" },
          { label: `Total received · ${monthLabel}`, value: `₨ ${fmt(data.totals.monthCollected)}`, color: "text-emerald-600", ring: "" },
          // Everything still owed, not just this month's share of it — so it is
          // marked out rather than sitting quietly beside the other two.
          { label: "Total pending", value: `₨ ${fmt(data.totals.monthPending)}`, color: "text-rose-600", ring: "border-rose-300 bg-rose-50/60" },
        ].map((s) => (
          <div key={s.label} className={cn("rounded-lg border border-border bg-card p-3 text-center", s.ring)}>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.label}</p>
            <p className={cn("mt-1 text-lg font-bold tabular-nums", s.color)}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {[
          { label: "Billed (period)", value: `₨ ${fmt(data.totals.billed)}`, color: "" },
          { label: "Collected", value: `₨ ${fmt(data.totals.collected)}`, color: "text-emerald-600" },
          { label: "Pending", value: `₨ ${fmt(data.totals.outstanding)}`, color: "text-rose-600" },
          { label: "Generated", value: String(data.totals.generated), color: "text-sky-600" },
          { label: "Ungenerated", value: String(data.totals.pending), color: "text-amber-600" },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-border bg-card p-3 text-center">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.label}</p>
            <p className={cn("mt-1 text-base font-bold tabular-nums", s.color)}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-4 py-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search name, phone or code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-xs sm:max-w-xs"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => startTransition(() => router.refresh())}
          disabled={pending}
          title="Reload the latest deliveries onto every bill"
        >
          <RefreshCw className={cn("size-3.5", pending && "animate-spin")} />
          Refresh
        </Button>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setShiftFilter("")}
            className={cn(
              "rounded-full border px-3 py-1 text-[11px] font-medium transition-colors",
              !shiftFilter ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:bg-muted/40"
            )}
          >
            All
          </button>
          {data.shifts.map((s) => (
            <button
              key={s.id}
              onClick={() => setShiftFilter(s.id)}
              className={cn(
                "rounded-full border px-3 py-1 text-[11px] font-medium transition-colors",
                shiftFilter === s.id ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:bg-muted/40"
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowEmpty((v) => !v)}
          className={cn(
            "rounded-full border px-3 py-1 text-[11px] font-medium transition-colors",
            showEmpty ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:bg-muted/40"
          )}
          title="Customers with no deliveries, no payments and nothing owing"
        >
          {showEmpty ? "Hide empty" : "Show empty"}
        </button>
        <span className="ml-auto text-[11px] text-muted-foreground">{filtered.length} customers</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th
                onClick={() => handleSort("name")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Customer
                  <span className={sortKey === "name" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "name" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("shiftName")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Shift
                  <span className={sortKey === "shiftName" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "shiftName" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("prevBalance")}
                className="border-b border-border px-3 py-2 text-right text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center justify-end gap-1">
                  Previous
                  <span className={sortKey === "prevBalance" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "prevBalance" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("deliveries")}
                className="border-b border-border px-3 py-2 text-right text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center justify-end gap-1">
                  Deliveries
                  <span className={sortKey === "deliveries" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "deliveries" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("paymentsAmt")}
                className="border-b border-border px-3 py-2 text-right text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center justify-end gap-1">
                  Paid
                  <span className={sortKey === "paymentsAmt" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "paymentsAmt" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("totalDue")}
                className="border-b border-border px-3 py-2 text-right text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center justify-end gap-1">
                  Total due
                  <span className={sortKey === "totalDue" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "totalDue" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("invoiceStatus")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Status
                  <span className={sortKey === "invoiceStatus" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "invoiceStatus" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th className="border-b border-border px-3 py-2 text-right text-[10px] font-medium text-muted-foreground"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={8} className="py-10 text-center text-sm text-muted-foreground">No customers found.</td></tr>
            ) : (
              sorted.map((c) => (
                <tr key={c.id} className="border-b border-border/50 hover:bg-muted/20">
                  <td className="px-3 py-2">
                    <p className="text-[12px] font-medium">{c.name}</p>
                    <p className="text-[10px] text-muted-foreground">{c.customerCode} · {c.phone}</p>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-muted-foreground whitespace-nowrap">{c.shiftName}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {c.prevBalance !== 0 ? (
                      <span className={c.prevBalance > 0 ? "text-rose-600" : "text-emerald-600"}>₨ {fmt(c.prevBalance)}</span>
                    ) : <span className="text-muted-foreground">—</span>}
                    {/* Payments this period clear the previous balance first — the last
                        bill is paid in the first days of this one. Display only. */}
                    {c.prevBalance > 0.5 && c.paymentsAmt > 0 && (
                      c.paymentsAmt >= c.prevBalance - 0.5
                        ? <span className="block text-[10px] font-medium text-emerald-600">paid ✓</span>
                        : <span className="block text-[10px] text-amber-600">₨ {fmt(c.prevBalance - c.paymentsAmt)} still owed</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    ₨ {fmt(c.deliveries)}
                    {c.otcAmt > 0 ? <span className="block text-[10px] text-amber-600">+ ₨ {fmt(c.otcAmt)} OTC</span> : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {c.paymentsAmt > 0 ? <span className="text-emerald-600">₨ {fmt(c.paymentsAmt)}</span> : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums whitespace-nowrap">
                    {c.totalDue <= 0 ? <span className="text-emerald-600">Clear</span> : <span className="text-rose-600">₨ {fmt(c.totalDue)}</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap"><StatusPill row={c} /></td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {c.generated && c.invoiceId ? (
                      <Link
                        href={`/billing/invoices/${c.invoiceId}`}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-muted/50"
                      >
                        <FileText className="size-3" /> View
                        <ChevronRight className="size-3" />
                      </Link>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-[11px]"
                        disabled={pending && busyId === c.id}
                        onClick={() => handleGenerate(c.id)}
                      >
                        {pending && busyId === c.id ? (
                          <RefreshCw className="size-3 animate-spin" />
                        ) : (
                          <><Plus className="mr-1 size-3" /> Generate</>
                        )}
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

