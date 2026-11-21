"use client";

import { useState, useMemo, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Wallet, Search, ChevronDown, ChevronsUpDown, X, Ban, AlertTriangle, Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { todayPKTString } from "@/lib/pkt";
import {
  setCallStatus,
  recordPayment,
  type PageData,
  type CustomerRow,
  type HeadBalance,
} from "@/app/(dashboard)/billing/payment-receiving/actions";
import { setBillingLastDate } from "@/app/(dashboard)/billing/billing-settings";
import { stopSupply, getStopSupplyCandidates, type StopCandidate } from "@/app/(dashboard)/payments/recovery/actions";
import { BRAND } from "./invoice-document";
import { RECEIVE_HEADS, PAYMENT_HEAD_LABELS, type PaymentHeadName } from "@/lib/payment-heads";

// Where money may be received into — see RECEIVE_HEADS (not Rider Cash, not Meezan).
const HEAD_OPTIONS = RECEIVE_HEADS.map((h) => ({ value: h, label: PAYMENT_HEAD_LABELS[h] }));

// ── Customer combobox (searchable) ─────────────────────────────────────────────

function CustomerCombobox({
  customers, value, onChange,
}: {
  customers: CustomerRow[];
  value: CustomerRow | null;
  onChange: (c: CustomerRow | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? customers.filter((c) =>
          c.name.toLowerCase().includes(q) ||
          c.customerCode.toLowerCase().includes(q) ||
          c.phone.includes(q))
      : customers;
    return list.slice(0, 50);
  }, [customers, query]);

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQuery(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value ? `${value.name} · ${value.customerCode}` : "Search & select customer…"}
          </span>
          {value ? (
            <X className="size-4 shrink-0 opacity-60" onClick={(e) => { e.stopPropagation(); onChange(null); }} />
          ) : (
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <div className="relative border-b border-border p-2">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, code or phone…"
            className="h-8 pl-7 text-xs"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">No customers found.</p>
          ) : (
            matches.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { onChange(c); setOpen(false); setQuery(""); }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted",
                  value?.id === c.id && "bg-muted"
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{c.customerCode} · {c.phone}</span>
                </span>
                {c.balance > 0 && (
                  <span className="shrink-0 text-[10px] font-medium text-rose-600">₨ {fmt(c.balance)}</span>
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Record payment form (top of page) ──────────────────────────────────────────

function RecordPaymentForm({
  customers, initialDate, onDone,
}: {
  customers: CustomerRow[];
  initialDate?: string;
  onDone: () => void;
}) {
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [amount, setAmount] = useState("");
  // Most payments come in by bank transfer, so HBL is the default. Reset below
  // must use the same value, or recording one payment would snap it back.
  const [head, setHead] = useState("HBL");
  const [date, setDate] = useState(initialDate ?? todayPKTString());
  const [notes, setNotes] = useState("");
  const [pending, start] = useTransition();

  function handleDateChange(val: string) {
    setDate(val);
    // Persist to DB — both billing pages read from the same key on next load.
    setBillingLastDate(val);
  }

  function submit() {
    if (!customer) { toast.error("Select a customer."); return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { toast.error("Enter a valid amount."); return; }
    // More than the customer owes is allowed: the extra is held as his credit and
    // comes off his next bill. It is confirmed first, and only when there IS an
    // extra — an ordinary receipt goes straight through. The reason for asking is
    // that the usual cause of a figure larger than the balance is a mistyped one,
    // and unnoticed credit is far harder to find later than a refused entry is to
    // type again. Tolerance covers decimal rounding on the balance.
    const due = customer.balance;
    const extra = amt - Math.max(0, due);
    if (extra > 0.009) {
      const owes = due > 0.009
        ? `${customer.name} owes ₨ ${fmt(due)}.`
        : `${customer.name} has nothing outstanding.`;
      const proceed = window.confirm(
        `${owes}\n\n`
        + `You are entering ₨ ${fmt(amt)} — that is ₨ ${fmt(extra)} more.\n\n`
        + `The extra ₨ ${fmt(extra)} will be kept as ${customer.name}'s credit and taken off his next bill.\n\n`
        + `Record it?`
      );
      if (!proceed) return;
    }
    start(async () => {
      const res = await recordPayment({ customerId: customer.id, amount: amt, head, date, notes });
      if (res.ok) {
        toast.success(`₨ ${Math.round(amt).toLocaleString("en-PK")} recorded for ${customer.name}.`);
        // Reset customer/amount/notes but keep the date — user may be recording
        // multiple back-dated payments on the same date.
        setCustomer(null); setAmount(""); setNotes(""); setHead("HBL");
        onDone();
      } else {
        toast.error(res.error);
      }
    });
  }

  // How much of what is typed is more than the customer owes — the same figure
  // the confirmation quotes, so the note and the prompt always agree.
  const extraTyped = customer ? (parseFloat(amount) || 0) - Math.max(0, customer.balance) : 0;
  const overPaid = !!customer && extraTyped > 0.009;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Wallet className="size-4 text-primary" />
        <p className="text-sm font-semibold">Record a payment</p>
        <span className="text-[11px] text-muted-foreground">Updates the customer's bill, ledger and head balances</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-end">
        {/* Customer */}
        <div className="sm:col-span-4">
          <Label className="mb-1 block text-xs text-muted-foreground">Customer</Label>
          <CustomerCombobox customers={customers} value={customer} onChange={setCustomer} />
        </div>
        {/* Amount */}
        <div className="sm:col-span-2">
          <Label className="mb-1 block text-xs text-muted-foreground">Amount (₨)</Label>
          <Input
            type="number"
            min="0"
            step="any"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={cn(
              "h-9 text-right",
              overPaid && "border-amber-400 focus-visible:ring-amber-400"
            )}
          />
          {overPaid && customer && (
            <p className="mt-1 text-[10px] font-medium text-amber-600">
              ₨ {fmt(extraTyped)} more than owed — kept as credit.
            </p>
          )}
        </div>
        {/* Head */}
        <div className="sm:col-span-2">
          <Label className="mb-1 block text-xs text-muted-foreground">Received in</Label>
          <Select value={head} onValueChange={setHead}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {HEAD_OPTIONS.map((h) => <SelectItem key={h.value} value={h.value} className="text-xs">{h.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {/* Record — moved immediately after Received In */}
        <div className="sm:col-span-2">
          <Label className="mb-1 block text-xs text-muted-foreground">&nbsp;</Label>
          <Button className="h-9 w-full" onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Record"}
          </Button>
        </div>
        {/* Change Last Date */}
        <div className="sm:col-span-2">
          <Label className="mb-1 block text-xs text-muted-foreground">Change last date</Label>
          <Input type="date" value={date} max={todayPKTString()} onChange={(e) => handleDateChange(e.target.value)} className="h-9" />
        </div>
      </div>

      {/* Note + selected balance */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note (optional) — e.g. paid to rider, advance" className="h-9 text-sm" />
        {customer && (
          <p className="flex items-center text-xs text-muted-foreground">
            Current balance for <span className="mx-1 font-medium text-foreground">{customer.name}</span>:
            <span className={cn("ml-1 font-semibold", customer.balance > 0 ? "text-rose-600" : "text-emerald-600")}>
              ₨ {fmt(customer.balance)}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return Math.abs(Math.round(n)).toLocaleString("en-PK");
}

const HEAD_COLORS: Record<string, { bg: string; text: string; card: string }> = {
  RIDER_CASH: { bg: "bg-sky-100",    text: "text-sky-800",    card: "bg-sky-50 border-sky-200"       },
  HBL:        { bg: "bg-teal-100",   text: "text-teal-800",   card: "bg-teal-50 border-teal-200"     },
  MEEZAN:     { bg: "bg-purple-100", text: "text-purple-800", card: "bg-purple-50 border-purple-200" },
  JAZZCASH:   { bg: "bg-amber-100",  text: "text-amber-800",  card: "bg-amber-50 border-amber-200"   },
  EASYPAISA:  { bg: "bg-orange-100", text: "text-orange-800", card: "bg-orange-50 border-orange-200" },
  CASH:       { bg: "bg-slate-100",  text: "text-slate-700",  card: "bg-slate-50 border-slate-200"   },
} satisfies Record<PaymentHeadName, { bg: string; text: string; card: string }>;

// Payment status — auto-derived from payments + dates (never manually set).
const STATUS_OPTIONS = [
  { value: "PAID",        label: "Paid"        },
  { value: "PARTIAL",     label: "Part Paid"   },
  { value: "PENDING",     label: "Pending"     },
  { value: "OVERDUE",     label: "Overdue"     },
  { value: "IN_RECOVERY", label: "In Recovery" },
  { value: "NO_BILL",     label: "No Bill"     },
];

// Collection-call escalation — the only thing the row dropdown sets.
const CALL_OPTIONS = [
  { value: "CALL_1",   label: "1x Call"  },
  { value: "CALL_2",   label: "2x Call"  },
  { value: "CALL_3",   label: "3x Call"  },
  { value: "RECOVERY", label: "Recovery" },
];
const CALL_VALUE_BY_COUNT: Record<number, string> = { 1: "CALL_1", 2: "CALL_2", 3: "CALL_3" };
const CALL_COUNTS: Record<string, number> = { CALL_1: 1, CALL_2: 2, CALL_3: 3 };

function derivedStatus(row: CustomerRow): string {
  // Recovery (supply stopped for cumulative dues) is the dominant state — it must
  // read consistently here and on the Recovery page, even if this month is paid.
  if (row.customerStatus === "RECOVERY") return "IN_RECOVERY";
  if (row.bill <= 0) return "NO_BILL";
  if (row.balance <= 0) return "PAID";          // fully covered
  if (row.totalPaid > 0 || row.paidLater > 0) return "PARTIAL"; // some paid, still owing
  return row.isOverdue ? "OVERDUE" : "PENDING"; // nothing paid yet
}

// ── Head balance card ─────────────────────────────────────────────────────────

function HeadCard({ h }: { h: HeadBalance }) {
  const col = HEAD_COLORS[h.head] ?? HEAD_COLORS.CASH;
  return (
    <div className={cn("rounded-lg border p-3", col.card)}>
      <p className={cn("text-[10px] font-semibold uppercase tracking-wide", col.text)}>{h.label}</p>
      <p className={cn("mt-1 text-sm font-bold tabular-nums", col.text)}>{h.balance < 0 ? "−" : ""}₨ {fmt(h.balance)}</p>
      <p className={cn("mt-0.5 text-[10px] opacity-70", col.text)}>
        {h.paymentCount
          ? `${h.paymentCount} payment${h.paymentCount > 1 ? "s" : ""} this month`
          : "No payments yet"}
      </p>
    </div>
  );
}

// ── Stop supply dialog (customers with unpaid dues → recovery) ──────────────────

function StopSupplyDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [candidates, setCandidates] = useState<StopCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    getStopSupplyCandidates()
      .then((r) => { setCandidates(r.candidates); setSelected(new Set(r.candidates.map((c) => c.id))); })
      .catch(() => setCandidates([]));
  }, []);

  const list = candidates ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => c.name.toLowerCase().includes(q) || c.customerCode.toLowerCase().includes(q) || c.phone.includes(q));
  }, [list, query]);

  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleAllFiltered() {
    const allSelected = filtered.every((c) => selected.has(c.id)) && filtered.length > 0;
    setSelected((prev) => {
      const n = new Set(prev);
      for (const c of filtered) { if (allSelected) n.delete(c.id); else n.add(c.id); }
      return n;
    });
  }
  function confirm() {
    start(async () => {
      const res = await stopSupply([...selected]);
      if (res.ok) {
        toast.success(`Supply stopped for ${res.count} customer${res.count !== 1 ? "s" : ""}.`);
        onDone();
      } else toast.error(res.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Ban className="size-4 text-rose-600" /> Stop supply — customers with unpaid dues
          </DialogTitle>
        </DialogHeader>

        {confirming ? (
          <div className="space-y-3 py-2">
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-800">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <p>
                Stop milk supply for <strong>{selected.size}</strong> customer{selected.size !== 1 ? "s" : ""}? They'll be
                removed from all delivery shifts and moved to Recovery until you restart them.
              </p>
            </div>
          </div>
        ) : candidates === null ? (
          <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading customers with dues…
          </div>
        ) : (
          <div className="space-y-2 py-1">
            {list.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No customers with pending payments. 🎉</p>
            ) : (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, code or phone…" className="h-8 pl-8 text-xs" />
                </div>
                <div className="overflow-hidden rounded-lg border border-border">
                  <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
                    <input type="checkbox" checked={filtered.length > 0 && filtered.every((c) => selected.has(c.id))} onChange={toggleAllFiltered} />
                    <span className="flex-1">Customer</span>
                    <span className="w-24 text-right">Due</span>
                  </div>
                  <div className="max-h-72 overflow-y-auto">
                    {filtered.map((c) => (
                      <label key={c.id} className="flex cursor-pointer items-center gap-2 border-b border-border/50 px-3 py-2 text-xs hover:bg-muted/20">
                        <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{c.name}</span>
                          <span className="block truncate text-[10px] text-muted-foreground">{c.customerCode} · {c.phone}</span>
                        </span>
                        <span className="w-24 text-right font-semibold tabular-nums text-rose-600">₨ {fmt(c.amount)}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">All selected by default — untick anyone you want to give relief to. {selected.size} selected.</p>
              </>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {confirming ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={pending}>Back</Button>
              <Button size="sm" className="bg-rose-600 text-white hover:bg-rose-700" onClick={confirm} disabled={pending}>
                {pending ? "Stopping…" : `Yes, stop ${selected.size}`}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button size="sm" disabled={selected.size === 0} onClick={() => setConfirming(true)}>
                Stop supply ({selected.size})
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    PAID:        { cls: "bg-emerald-100 text-emerald-700", label: "Paid"        },
    PARTIAL:     { cls: "bg-amber-100  text-amber-700",   label: "Part Paid"   },
    PENDING:     { cls: "bg-slate-100  text-slate-600",   label: "Pending"     },
    OVERDUE:     { cls: "bg-rose-100   text-rose-700",    label: "Overdue"     },
    IN_RECOVERY: { cls: "bg-orange-100 text-orange-700",  label: "In Recovery" },
    NO_BILL:     { cls: "bg-slate-100  text-slate-400",   label: "No Bill"     },
  };
  const cfg = map[status] ?? map.PENDING;
  return (
    <span className={cn("inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap", cfg.cls)}>
      {cfg.label}
    </span>
  );
}

// ── Row call-status dropdown ──────────────────────────────────────────────────

function CallStatusCell({ row }: { row: CustomerRow }) {
  const [pending, startTransition] = useTransition();
  const [notesOpen, setNotesOpen] = useState(false);
  const [pendingVal, setPendingVal] = useState("");
  const [noteText, setNoteText] = useState("");
  const [localCount, setLocalCount] = useState(row.callCount);
  const ds = derivedStatus(row);

  function handleCallClick(val: string) {
    if (val === "RECOVERY") {
      if (!window.confirm(`Move ${row.name} to Recovery and stop their supply?`)) return;
      startTransition(async () => {
        const res = await setCallStatus(row.id, row.invoiceId, val);
        if (!res.ok) toast.error(res.error);
      });
      return;
    }
    setPendingVal(val);
    setNoteText("");
    setNotesOpen(true);
  }

  function confirmNote() {
    const prevCount = localCount;
    const n = CALL_COUNTS[pendingVal];
    if (n !== undefined) setLocalCount(n);
    setNotesOpen(false);
    startTransition(async () => {
      const res = await setCallStatus(row.id, row.invoiceId, pendingVal, noteText || undefined);
      if (res.ok) {
        toast.success("Call status saved.");
      } else {
        toast.error(res.error);
        setLocalCount(prevCount);
      }
    });
  }

  if (ds === "IN_RECOVERY") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2.5 py-1 text-[11px] font-semibold text-orange-700">
        Recovery
      </span>
    );
  }
  if (ds === "PAID") {
    return <span className="text-[11px] text-muted-foreground">—</span>;
  }
  if (row.invoiceStatus === "NONE") {
    return <span className="text-[11px] text-muted-foreground">No invoice</span>;
  }

  return (
    <>
      <div className="flex items-center gap-1">
        {([
          { value: "CALL_1", label: "1x", n: 1 },
          { value: "CALL_2", label: "2x", n: 2 },
          { value: "CALL_3", label: "3x", n: 3 },
        ] as const).map((b) => (
          <button
            key={b.value}
            type="button"
            disabled={pending}
            onClick={() => handleCallClick(b.value)}
            className={cn(
              "h-6 rounded px-2 text-[11px] font-medium transition-colors disabled:opacity-50",
              localCount === b.n
                ? "bg-primary text-primary-foreground"
                : "border border-border bg-background text-muted-foreground hover:bg-muted"
            )}
          >
            {b.label}
          </button>
        ))}
        <button
          type="button"
          disabled={pending}
          onClick={() => handleCallClick("RECOVERY")}
          className="h-6 rounded px-1.5 text-[11px] font-medium text-orange-600 hover:bg-orange-50 border border-orange-200 transition-colors disabled:opacity-50"
        >
          Rec
        </button>
      </div>
      {notesOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-80 rounded-xl border border-border bg-card p-4 shadow-lg space-y-3">
            <p className="text-sm font-semibold">What did {row.name} say?</p>
            <Input
              autoFocus
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && confirmNote()}
              placeholder="e.g. will pay on Friday"
              className="h-9 text-sm"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setNotesOpen(false)}>Skip</Button>
              <Button size="sm" onClick={confirmNote}>Save</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Area-wise collection / recovery sheet (print → PDF for riders) ────────────
// Purely additive: builds a clean, isolated printable document from the rows the
// user is currently viewing, grouped by area (one page per area) so each area's
// sheet can be handed to the rider covering it. Blank "Received" / "Sign" columns
// let it double as a physical collection sheet. Returns false if a pop-up blocker
// prevented the print window from opening.
function printCollectionList(rows: CustomerRow[], monthLabel: string): boolean {
  const byArea = new Map<string, CustomerRow[]>();
  for (const c of rows) {
    const area = c.areaName?.trim() || "— No area —";
    let arr = byArea.get(area);
    if (!arr) { arr = []; byArea.set(area, arr); }
    arr.push(c);
  }
  const areas = [...byArea.keys()].sort((a, b) => a.localeCompare(b));

  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] as string));
  const money = (n: number) => "₨ " + Math.round(n).toLocaleString("en-PK");
  const stamp = new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  const sections = areas.map((area) => {
    const list = [...byArea.get(area)!].sort((a, b) => (b.balance - a.balance) || a.name.localeCompare(b.name));
    const totBill = list.reduce((s, c) => s + c.bill, 0);
    const totPaid = list.reduce((s, c) => s + c.totalPaid, 0);
    const totDue  = list.reduce((s, c) => s + Math.max(0, c.balance), 0);

    const body = list.map((c, i) => {
      const dueCell = c.bill <= 0
        ? "—"
        : c.balance <= 0
          ? `<span class="clear">Clear</span>`
          : `<b>${money(c.balance)}</b>`;
      return `<tr>
        <td class="c">${i + 1}</td>
        <td><div class="nm">${esc(c.name)}</div><div class="sub">${esc(c.customerCode)}${c.phone ? " · " + esc(c.phone) : ""}</div></td>
        <td class="r">${c.bill > 0 ? money(c.bill) : "—"}</td>
        <td class="r">${c.totalPaid > 0 ? money(c.totalPaid) : "—"}</td>
        <td class="r due">${dueCell}</td>
        <td class="blank"></td>
        <td class="blank"></td>
      </tr>`;
    }).join("");

    return `<section class="area">
      <div class="ah">
        <div>
          <div class="brand">${esc(BRAND.name)}</div>
          <h1>Collection &amp; Recovery Sheet</h1>
          <div class="meta">Area: <b>${esc(area)}</b> &nbsp;·&nbsp; ${esc(monthLabel)}</div>
        </div>
        <div class="ahr">
          <div class="cnt">${list.length} customer${list.length !== 1 ? "s" : ""}</div>
          <div class="tot">Total due&nbsp;&nbsp;<b>${money(totDue)}</b></div>
          <div class="stamp">Printed ${esc(stamp)}</div>
        </div>
      </div>
      <table>
        <thead><tr>
          <th class="c">#</th><th>Customer</th><th class="r">Bill</th><th class="r">Paid</th><th class="r">Due</th><th>Received</th><th>Sign</th>
        </tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr>
          <td></td><td class="r"><b>Area total</b></td><td class="r">${money(totBill)}</td><td class="r">${money(totPaid)}</td><td class="r"><b>${money(totDue)}</b></td><td></td><td></td>
        </tr></tfoot>
      </table>
    </section>`;
  }).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Collection Sheet · ${esc(monthLabel)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1a1a; margin: 0; }
  .bar { position: sticky; top: 0; z-index: 5; background: #111827; color: #fff; padding: 10px 16px; display: flex; align-items: center; gap: 12px; font-size: 13px; }
  .bar button { font: inherit; font-weight: 600; padding: 6px 14px; border: 0; border-radius: 6px; background: #fff; color: #111827; cursor: pointer; }
  .area { padding: 20px 22px; }
  .area + .area { page-break-before: always; }
  .ah { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #111827; padding-bottom: 10px; margin-bottom: 12px; }
  .brand { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #6b7280; }
  .ah h1 { font-size: 19px; margin: 3px 0 2px; }
  .meta { font-size: 12.5px; color: #374151; }
  .ahr { text-align: right; font-size: 12px; color: #374151; white-space: nowrap; }
  .ahr .tot b { font-size: 15px; }
  .stamp { color: #9ca3af; font-size: 10px; margin-top: 5px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #d1d5db; padding: 5px 8px; text-align: left; vertical-align: top; }
  thead th { background: #f3f4f6; text-transform: uppercase; font-size: 9.5px; letter-spacing: .04em; color: #374151; }
  td.c, th.c { text-align: center; width: 28px; }
  td.r, th.r { text-align: right; white-space: nowrap; }
  .nm { font-weight: 600; }
  .sub { color: #6b7280; font-size: 9.5px; margin-top: 1px; }
  td.due b { font-size: 12px; }
  .clear { color: #16a34a; font-weight: 600; }
  td.blank { min-width: 74px; }
  tfoot td { background: #fafafa; }
  @page { size: A4 portrait; margin: 12mm; }
  @media print { .bar { display: none; } .area { padding: 0; } }
</style></head>
<body onload="setTimeout(function(){window.print();},200)">
  <div class="bar">
    <button onclick="window.print()">Print / Save as PDF</button>
    <span>${areas.length} area${areas.length !== 1 ? "s" : ""} · ${rows.length} customer${rows.length !== 1 ? "s" : ""} · one page per area</span>
  </div>
  ${sections}
</body></html>`;

  const win = window.open("", "_blank");
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  return true;
}

// ── Main client component ─────────────────────────────────────────────────────

export function PaymentReceivingClient({
  data,
  month,
  year,
  initialDate,
}: {
  data: PageData;
  month: number;
  year: number;
  initialDate?: string;
}) {
  const router = useRouter();
  const [search,      setSearch]      = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Which span the Bill column speaks for. Bills go out twice a month, so a
  // single whole-month figure is not the bill anyone is being chased for. This
  // changes that column and nothing else — Paid, Balance and every total below
  // stay on the month, because that is what the money actually settles against.
  const [billSpan, setBillSpan] = useState<"month" | "h1" | "h2">("month");
  // Full month is the two cycles added together, and nothing else. It used to
  // show the running balance instead — carry-forward from earlier months and
  // all — so it never matched 1–15 plus 16–end and was not the month's bill by
  // any reading. What is still owed is the Balance column's job.
  function billFor(c: CustomerRow): number {
    if (billSpan === "h1") return c.billHalf1;
    if (billSpan === "h2") return c.billHalf2;
    return c.billHalf1 + c.billHalf2;
  }
  const [activeShifts, setActiveShifts] = useState<Set<string>>(new Set(["__all__"]));
  // Which payment heads to show — "who paid via HBL?" etc. A customer matches when
  // ANY of the payments listed for this month used a selected head.
  const [activeHeads, setActiveHeads] = useState<Set<string>>(new Set(["__all__"]));
  const [stopOpen, setStopOpen] = useState(false);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const selMonth = `${year}-${String(month).padStart(2, "0")}`;

  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  function handleMonthChange(val: string) {
    if (/^\d{4}-\d{2}$/.test(val)) router.push(`?m=${val}`, { scroll: false });
  }

  function toggleHead(h: string) {
    if (h === "__all__") {
      setActiveHeads(new Set(["__all__"]));
      return;
    }
    setActiveHeads((prev) => {
      const next = new Set(prev);
      next.delete("__all__");
      if (next.has(h)) next.delete(h);
      else next.add(h);
      return next.size === 0 ? new Set(["__all__"]) : next;
    });
  }

  function toggleShift(id: string) {
    if (id === "__all__") {
      setActiveShifts(new Set(["__all__"]));
    } else {
      setActiveShifts((prev) => {
        const next = new Set(prev);
        next.delete("__all__");
        if (next.has(id)) next.delete(id);
        else next.add(id);
        if (next.size === 0) return new Set(["__all__"]);
        return next;
      });
    }
  }

  const { filtered, stats } = useMemo(() => {
    const q = search.toLowerCase();
    const rows: typeof data.customers = [];
    let paid = 0, pending = 0, totalBill = 0, totalCollected = 0, totalPending = 0, prevBill = 0, prevPending = 0;

    for (const c of data.customers) {
      if (!activeShifts.has("__all__") && c.shiftId && !activeShifts.has(c.shiftId)) continue;
      if (!activeHeads.has("__all__") && !c.payments.some((p) => activeHeads.has(p.head))) continue;
      if (q && !c.name.toLowerCase().includes(q) && !c.phone.includes(q) && !c.customerCode.toLowerCase().includes(q)) continue;
      const ds = derivedStatus(c);
      if (statusFilter && ds !== statusFilter) continue;

      rows.push(c);
      totalBill      += billFor(c);
      totalCollected += c.totalPaid;
      // The Balance column added up: what is still owed, carried balances and all
      // — for a month that is over, less what has been paid since it closed.
      // Credits net off rather than being hidden.
      totalPending   += c.balance;
      // Last month is over, so this one does not move while the collection round
      // runs — which is the whole point of having it beside a total that does.
      prevBill       += c.prevMonthBill;
      // What is still unpaid, today, of what was owed when last month closed —
      // payments clear the oldest dues first.
      prevPending    += c.prevMonthPending;
      if (ds === "PAID") paid++; else pending++;
    }

    return {
      filtered: rows,
      stats: { total: rows.length, paid, pending, totalBill, totalCollected, totalPending, prevBill, prevPending },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.customers, activeShifts, activeHeads, search, statusFilter, billSpan]);

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

  function clearFilters() {
    setSearch("");
    setStatusFilter("");
    setActiveShifts(new Set(["__all__"]));
    setActiveHeads(new Set(["__all__"]));
  }

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  function handlePrint() {
    if (filtered.length === 0) {
      toast.error("No customers match the current filters — nothing to print.");
      return;
    }
    if (!printCollectionList(filtered, monthLabel)) {
      toast.error("Your browser blocked the print window. Allow pop-ups for this site and try again.");
    }
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Record a payment */}
      <RecordPaymentForm customers={data.customers} initialDate={initialDate} onDone={() => router.refresh()} />

      {/* Head balances */}
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          General Heads Balance
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {data.headBalances.map((h) => (
            <HeadCard key={h.head} h={h} />
          ))}
        </div>
      </div>

      {/* Receipts with no customer account. Previously these were fetched and
          silently dropped, so this page's collected total could not be squared
          against the head ledger for the same month. Listed rather than folded
          into a customer row: attaching them to a customer would reduce that
          customer's balance, which for the August 2026 backfill would credit
          people whose dues were already netted off. */}
      {data.otherReceipts.length > 0 && (
        // Collapsed by default: a long list most days, and only sometimes needed.
        <details className="group rounded-lg border border-border">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-muted/30 [&::-webkit-details-marker]:hidden">
            <span className="flex min-w-0 items-center gap-2">
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
              <span className="font-medium">Other receipts this month · not tied to a customer account</span>
            </span>
            <span className="shrink-0 text-muted-foreground">
              {data.otherReceipts.length} · ₨ {fmt(data.otherReceipts.reduce((t, r) => t + r.amount, 0))}
            </span>
          </summary>
          <div className="overflow-hidden border-t border-border">
            {data.otherReceipts.map((r, i) => (
              <div
                key={r.id}
                className={`flex items-center justify-between gap-3 px-3 py-2 text-sm ${i % 2 ? "bg-muted/30" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {new Date(r.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
                  </span>
                  <span className="truncate">{r.notes ?? "—"}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{r.label}</span>
                  <span className="w-28 text-right">₨ {fmt(r.amount)}</span>
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/50 px-3 py-2 text-sm font-semibold">
              <span>{data.otherReceipts.length} receipt{data.otherReceipts.length === 1 ? "" : "s"}</span>
              <span className="w-28 text-right">
                ₨ {fmt(data.otherReceipts.reduce((t, r) => t + r.amount, 0))}
              </span>
            </div>
          </div>
        </details>
      )}
      {/* Monthly dashboard */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Monthly Dashboard
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs text-rose-600 hover:bg-rose-50 hover:border-rose-300"
            onClick={() => setStopOpen(true)}
            title="Stop supply for customers with unpaid dues"
          >
            <Ban className="mr-1 size-3.5" /> Stop supply
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {[
            { label: "Total customers", value: String(stats.total),                    color: "" },
            { label: "Paid / clear",    value: String(stats.paid),                     color: "text-emerald-600" },
            { label: "Pending",         value: String(stats.pending),                  color: "text-amber-600" },
            // Follows the Bill column, so the card and the column can never tell
            // two different stories about the same fortnight.
            { label: billSpan === "month" ? "Total billing" : billSpan === "h1" ? "Total billing · 1–15" : "Total billing · 16–end",
              value: `₨ ${fmt(stats.totalBill)}`,            color: "" },
            { label: "Total collected", value: `₨ ${fmt(stats.totalCollected)}`,       color: "text-emerald-600" },
            // Beside what came in, what has not. Marked out in red, because it is
            // the figure the collection round is actually run against.
            //
            // Signed by hand: fmt() takes the absolute value, which is right for
            // the other cards but would show a filtered-down set of overpaid
            // customers as money owed when the farm is the one holding credit.
            { label: stats.totalPending < -0.5 ? "Total in credit" : "Total pending",
              value: `${stats.totalPending < -0.5 ? "−" : ""}₨ ${fmt(stats.totalPending)}`,
              color: stats.totalPending < -0.5 ? "text-emerald-600" : "text-rose-600" },
            // Named for the month rather than labelled "previous", so nobody has to
            // work out which month is meant from which month is selected.
            { label: data.prevMonthLabel ? `${data.prevMonthLabel} bill` : "Previous month bill",
              value: `₨ ${fmt(stats.prevBill)}`, color: "text-sky-700" },
            // Beside last month's bill, what was still owed when it closed. Pending
            // climbs every day; this one does not, so the gap is this month's doing.
            { label: data.prevMonthLabel ? `${data.prevMonthLabel} pending` : "Previous month pending",
              value: `${stats.prevPending < -0.5 ? "−" : ""}₨ ${fmt(stats.prevPending)}`,
              color: stats.prevPending < -0.5 ? "text-emerald-600" : "text-rose-600" },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-md border border-border bg-muted/20 p-3 text-center">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className={cn("mt-1.5 text-base font-semibold", color)}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Filter card */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-auto">
            <label className="mb-1 block text-xs text-muted-foreground">Month</label>
            <input
              type="month"
              value={selMonth}
              onChange={(e) => handleMonthChange(e.target.value)}
              className="h-8 w-full sm:w-36 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="mb-1 block text-xs text-muted-foreground">Search</label>
            <Input
              placeholder="Name, phone or code…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="w-full sm:w-auto">
            <label className="mb-1 block text-xs text-muted-foreground">Status</label>
            <Select value={statusFilter || "ALL"} onValueChange={(v) => setStatusFilter(v === "ALL" ? "" : v)}>
              <SelectTrigger className="h-8 w-full sm:w-36 text-xs">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL" className="text-xs">All statuses</SelectItem>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value} className="text-xs">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-full sm:w-auto">
            <label className="mb-1 block text-xs text-muted-foreground">Bill column</label>
            <div className="flex gap-1">
              {([
                ["month", "Full month"],
                ["h1", "1–15"],
                ["h2", "16–end"],
              ] as const).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setBillSpan(v)}
                  className={cn(
                    "h-8 rounded-md border px-2.5 text-[11px] font-medium transition-colors",
                    billSpan === v ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:bg-muted/40"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={clearFilters}>
            Clear
          </Button>
        </div>

        {/* Shift filter pills */}
        {data.shifts.length > 0 && (
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Shift
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => toggleShift("__all__")}
                className={cn(
                  "rounded-full border px-3 py-1 text-[11px] font-medium transition-colors",
                  activeShifts.has("__all__")
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                )}
              >
                All
              </button>
              {data.shifts.map((s) => (
                <button
                  key={s.id}
                  onClick={() => toggleShift(s.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-[11px] font-medium transition-colors",
                    activeShifts.has(s.id)
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                  )}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Payment head filter pills — who paid through which head */}
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Payment head
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => toggleHead("__all__")}
              className={cn(
                "rounded-full border px-3 py-1 text-[11px] font-medium transition-colors",
                activeHeads.has("__all__")
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
              )}
            >
              All
            </button>
            {HEAD_OPTIONS.map((h) => {
              const count = data.customers.filter((c) => c.payments.some((p) => p.head === h.value)).length;
              return (
                <button
                  key={h.value}
                  onClick={() => toggleHead(h.value)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-[11px] font-medium transition-colors",
                    activeHeads.has(h.value)
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                  )}
                >
                  {h.label}
                  <span className="ml-1 opacity-70">({count})</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>


      {/* Print / PDF toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          Grouped by area — one page per area, so each rider gets the customers on their round.
        </p>
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handlePrint}>
          <Printer className="mr-1.5 size-3.5" /> Print list (by area)
        </Button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground whitespace-nowrap w-16">#</th>
              <th
                onClick={() => handleSort("name")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
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
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Shift
                  <span className={sortKey === "shiftName" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "shiftName" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("areaName")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Area
                  <span className={sortKey === "areaName" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "areaName" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("bill")}
                className="border-b border-border px-3 py-2 text-right text-[10px] font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center justify-end gap-1">
                  <span title="What was billed: delivered less returned, plus the month's delivery charge and any counter purchases taken on credit, less a one-off discount.">
                    {billSpan === "month" ? "Bill" : billSpan === "h1" ? "Bill · 1–15" : "Bill · 16–end"}
                  </span>
                  <span className={sortKey === "bill" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "bill" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("totalPaid")}
                className="border-b border-border px-3 py-2 text-right text-[10px] font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center justify-end gap-1">
                  Paid
                  <span className={sortKey === "totalPaid" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "totalPaid" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("balance")}
                className="border-b border-border px-3 py-2 text-right text-[10px] font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center justify-end gap-1">
                  Balance
                  <span className={sortKey === "balance" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "balance" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground whitespace-nowrap">Payment received</th>
              <th
                onClick={() => handleSort("callCount")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Call status
                  <span className={sortKey === "callCount" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "callCount" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground whitespace-nowrap">Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                  No customers found.
                </td>
              </tr>
            ) : (
              sorted.map((c) => {
                const ds = derivedStatus(c);
                const balColor =
                  c.balance === 0
                    ? "text-emerald-600 font-semibold"
                    : c.balance < c.bill && c.balance > 0
                      ? "text-amber-600 font-semibold"
                      : "text-rose-600 font-semibold";

                return (
                  <tr key={c.id} className="border-b border-border/50 hover:bg-muted/20">
                    {/* # */}
                    <td className="px-3 py-2 text-[11px] text-muted-foreground">{c.customerCode}</td>

                    {/* Customer */}
                    <td className="px-3 py-2">
                      <Link href={`/ledgers?type=customer&id=${c.id}`} className="text-[12px] font-medium hover:underline">
                        {c.name}
                      </Link>
                      <p className="text-[10px] text-muted-foreground">{c.phone}</p>
                    </td>

                    {/* Shift */}
                    <td className="px-3 py-2 text-[11px] text-muted-foreground whitespace-nowrap">{c.shiftName}</td>

                    {/* Area */}
                    <td className="px-3 py-2 text-[11px] text-muted-foreground whitespace-nowrap">{c.areaName}</td>

                    {/* Bill — the whole month, or just one fortnight's own charges. */}
                    <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                      {billFor(c) > 0 ? `₨ ${fmt(billFor(c))}` : "—"}
                    </td>

                    {/* Paid */}
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {c.totalPaid > 0 ? (
                        <span className="font-medium text-emerald-600">₨ {fmt(c.totalPaid)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {c.paidLater > 0 && (
                        <p className="text-[10px] text-emerald-700" title="Paid after this month closed, towards what was owed then">
                          + ₨ {fmt(c.paidLater)} paid later{c.paidLaterOn ? ` (${c.paidLaterOn})` : ""}
                        </p>
                      )}
                    </td>

                    {/* Balance + Status */}
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {c.bill > 0 && c.balance <= 0 ? (
                        <span className="font-semibold text-emerald-600">Paid</span>
                      ) : c.bill === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className={balColor}>₨ {fmt(c.balance)}</span>
                      )}
                      <div className="mt-1 flex justify-end">
                        <StatusPill status={ds} />
                      </div>
                    </td>

                    {/* Payment received */}
                    <td className="px-3 py-2">
                      {c.payments.length === 0 ? (
                        <span className="text-[11px] text-muted-foreground">— not received —</span>
                      ) : (
                        <div className="space-y-1.5">
                          {c.payments.map((p, i) => {
                            const col = HEAD_COLORS[p.head] ?? HEAD_COLORS.CASH;
                            return (
                              <div key={i}>
                                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", col.bg, col.text)}>
                                  {p.label}
                                </span>
                                <p className="mt-0.5 text-[10px] font-medium">₨ {fmt(p.amount)}</p>
                                {p.notes && <p className="text-[9px] text-muted-foreground">{p.notes}</p>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </td>

                    {/* Call status */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      <CallStatusCell row={c} />
                    </td>

                    {/* Call notes */}
                    <td className="px-3 py-2 max-w-[160px]">
                      {c.callNotes ? (
                        <div>
                          <p className="text-[11px] text-foreground truncate" title={c.callNotes}>{c.callNotes}</p>
                          {c.callNotesAt && (
                            <p className="text-[10px] text-muted-foreground">
                              {new Date(c.callNotesAt).toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short" })}
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Row count */}
      <p className="text-right text-[11px] text-muted-foreground">
        Showing {filtered.length} of {data.customers.length} customers
      </p>

      {stopOpen && (
        <StopSupplyDialog
          open
          onClose={() => setStopOpen(false)}
          onDone={() => { setStopOpen(false); router.refresh(); }}
        />
      )}
    </div>
  );
}

