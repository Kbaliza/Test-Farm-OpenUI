"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search, Banknote, RotateCcw, ShieldAlert, ClipboardList, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { todayPKTString } from "@/lib/pkt";
import {
  addRecoveryVisit, deleteRecoveryVisit, restartSupply, recordRecoveryPayment,
  type RecoveryData, type RecoveryRow,
} from "@/app/(dashboard)/payments/recovery/actions";
import { RECEIVE_HEADS, PAYMENT_HEAD_LABELS } from "@/lib/payment-heads";

// Where money may be received into — see RECEIVE_HEADS (not Rider Cash, not Meezan).
const HEAD_OPTIONS = RECEIVE_HEADS.map((h) => ({ value: h, label: PAYMENT_HEAD_LABELS[h] }));

function fmt(n: number) {
  return Math.abs(Math.round(n)).toLocaleString("en-PK");
}
function fmtSince(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ── Record payment dialog ──────────────────────────────────────────────────────

function RecordPaymentDialog({ row, onClose, onDone }: { row: RecoveryRow | null; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [head, setHead] = useState("CASH");
  const [date, setDate] = useState(todayPKTString());
  const [notes, setNotes] = useState("");
  const [pending, start] = useTransition();

  function submit() {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { toast.error("Enter a valid amount."); return; }
    if (!row) return;
    start(async () => {
      const res = await recordRecoveryPayment({ customerId: row.id, amount: amt, head, date, notes });
      if (res.ok) { toast.success(`₨ ${fmt(amt)} recorded.`); onDone(); }
      else toast.error(res.error);
    });
  }

  return (
    <Dialog open={!!row} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Record payment {row ? `— ${row.name}` : ""}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          {row && (
            <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {row.customerCode} · Pending{" "}
              <span className="font-semibold text-rose-600">₨ {fmt(row.outstanding)}</span>
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Amount (₨)</Label>
              <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 h-8 text-right text-sm" autoFocus />
            </div>
            <div>
              <Label className="text-xs">Date</Label>
              <Input type="date" value={date} max={todayPKTString()} onChange={(e) => setDate(e.target.value)} className="mt-1 h-8 text-sm" />
            </div>
          </div>
          <div>
            <Label className="text-xs">Received in</Label>
            <Select value={head} onValueChange={setHead}>
              <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {HEAD_OPTIONS.map((h) => <SelectItem key={h.value} value={h.value} className="text-xs">{h.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Note (optional)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. partial payment" className="mt-1 h-8 text-sm" />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={pending}>{pending ? "Saving…" : "Record payment"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Visit log dialog (add a visit with a mandatory note; shows date/time) ──────────

function VisitLogDialog({ row, onClose, onChanged }: { row: RecoveryRow | null; onClose: () => void; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();

  function add() {
    const text = note.trim();
    if (!text) { toast.error("Please add a note for this visit."); return; }
    if (!row) return;
    start(async () => {
      const res = await addRecoveryVisit(row.id, text);
      if (res.ok) { toast.success("Visit logged."); setNote(""); onChanged(); }
      else toast.error(res.error);
    });
  }
  function remove(id: string) {
    start(async () => {
      const res = await deleteRecoveryVisit(id);
      if (res.ok) { toast.success("Visit removed."); onChanged(); }
      else toast.error(res.error);
    });
  }

  return (
    <Dialog open={!!row} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ClipboardList className="size-4" /> Visit log {row ? `— ${row.name}` : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {/* Add a visit */}
          <div className="rounded-lg border border-border p-3">
            <Label className="text-xs">Add a visit — what did the customer say? <span className="text-rose-600">*</span></Label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Promised to pay ₨ 5,000 by Friday"
              rows={2}
              className="mt-1 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="mt-2 flex justify-end">
              <Button size="sm" onClick={add} disabled={pending}>
                <Plus className="mr-1 size-3.5" /> {pending ? "Saving…" : "Log visit"}
              </Button>
            </div>
          </div>

          {/* History */}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              History {row && row.visitLog.length > 0 ? `(${row.visitLog.length})` : ""}
            </p>
            {!row || row.visitLog.length === 0 ? (
              <p className="rounded-md bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">No visits logged yet.</p>
            ) : (
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {row.visitLog.map((v) => (
                  <div key={v.id} className="flex items-start justify-between gap-2 rounded-md border border-border/70 bg-card px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-[10px] font-medium text-muted-foreground">{fmtDateTime(v.at)}</p>
                      <p className="mt-0.5 break-words text-xs">{v.note}</p>
                    </div>
                    <button
                      onClick={() => remove(v.id)}
                      disabled={pending}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-rose-50 hover:text-rose-600"
                      title="Remove visit"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────────

function Row({ row, onChanged, onPay, onVisit }: { row: RecoveryRow; onChanged: () => void; onPay: (r: RecoveryRow) => void; onVisit: (r: RecoveryRow) => void }) {
  const [pending, start] = useTransition();

  function restart() {
    if (row.outstanding > 0 && !window.confirm(`${row.name} still owes ₨ ${fmt(row.outstanding)}. Restart supply anyway?`)) return;
    start(async () => {
      const res = await restartSupply(row.id);
      if (res.ok) { toast.success(`Supply restarted for ${row.name}.`); onChanged(); }
      else toast.error(res.error);
    });
  }

  return (
    <tr className="border-b border-border/50 hover:bg-muted/20">
      <td className="px-3 py-2">
        <p className="text-[12px] font-medium">{row.name}</p>
        <p className="text-[10px] text-muted-foreground">{row.customerCode} · {row.phone}</p>
      </td>
      <td className="px-3 py-2 text-[11px] text-muted-foreground whitespace-nowrap">{row.shiftName} · {row.areaName}</td>
      <td className="px-3 py-2 text-[11px] text-muted-foreground whitespace-nowrap">{fmtSince(row.since)}</td>
      <td className="px-3 py-2 text-right font-semibold tabular-nums whitespace-nowrap text-rose-600">₨ {fmt(row.outstanding)}</td>
      <td className="px-3 py-2">
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onVisit(row)} disabled={pending}>
          <ClipboardList className="mr-1 size-3.5" />
          {row.visits > 0 ? `×${row.visits}` : "Add visit"}
        </Button>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-1.5">
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => onPay(row)} disabled={pending}>
            <Banknote className="mr-1 size-3.5" /> Payment
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-[11px] text-emerald-700 hover:bg-emerald-50" onClick={restart} disabled={pending}>
            <RotateCcw className="mr-1 size-3.5" /> Restart supply
          </Button>
        </div>
      </td>
    </tr>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────────

export function RecoveryClient({ data }: { data: RecoveryData }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [payFor, setPayFor] = useState<RecoveryRow | null>(null);
  const [visitForId, setVisitForId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // Look the row up from fresh data so the dialog updates after each add/delete.
  const visitRow = data.rows.find((r) => r.id === visitForId) ?? null;

  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data.rows;
    return data.rows.filter((r) => r.name.toLowerCase().includes(q) || r.customerCode.toLowerCase().includes(q) || r.phone.includes(q));
  }, [data.rows, query]);

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

  function refresh() { router.refresh(); }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <div className="rounded-lg border border-border bg-card p-3 text-center">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">In recovery</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{data.rows.length}</p>
        </div>
        <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-3 text-center">
          <p className="text-[10px] uppercase tracking-wide text-rose-700/70">Total pending</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-rose-700">₨ {fmt(data.totalOutstanding)}</p>
        </div>
      </div>

      {data.rows.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-muted-foreground">
          <ShieldAlert className="size-7 opacity-40" />
          <p className="text-sm">No customers in recovery. Stop supply from the Monthly Receiving tab to add them here.</p>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, code or phone…" className="h-9 pl-8 text-sm sm:max-w-xs" />
          </div>

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full border-collapse text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th
                    onClick={() => handleSort("name")}
                    className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
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
                    className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Shift · Area
                      <span className={sortKey === "shiftName" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "shiftName" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th
                    onClick={() => handleSort("since")}
                    className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      In recovery since
                      <span className={sortKey === "since" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "since" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th
                    onClick={() => handleSort("outstanding")}
                    className="px-3 py-2 text-right text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Pending
                      <span className={sortKey === "outstanding" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "outstanding" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th
                    onClick={() => handleSort("visits")}
                    className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                  >
                    <span className="inline-flex items-center gap-1">
                      Visits
                      <span className={sortKey === "visits" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                        {sortKey === "visits" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </span>
                  </th>
                  <th className="px-3 py-2 text-right text-[10px] font-medium text-muted-foreground"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr><td colSpan={6} className="py-8 text-center text-sm text-muted-foreground">No matches.</td></tr>
                ) : (
                  sorted.map((r) => <Row key={r.id} row={r} onChanged={refresh} onPay={setPayFor} onVisit={(row) => setVisitForId(row.id)} />)
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <RecordPaymentDialog row={payFor} onClose={() => setPayFor(null)} onDone={() => { setPayFor(null); refresh(); }} />
      <VisitLogDialog row={visitRow} onClose={() => setVisitForId(null)} onChanged={refresh} />
    </div>
  );
}

