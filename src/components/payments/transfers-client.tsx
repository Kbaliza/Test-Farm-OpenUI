"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ArrowRight, ArrowLeftRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { todayPKTString } from "@/lib/pkt";
import { FARM_OWNERS, ownerName, OWNER_FUNDING_HEAD } from "@/lib/farm-owners";
import { OWNERS_HEAD, type PaymentHeadName } from "@/lib/payment-heads";
import {
  createTransfer, deleteTransfer, createOwnerContribution, deleteOwnerContribution,
  type TransfersPageData,
} from "@/app/(dashboard)/payments/transfers/actions";

const HEAD_COLORS: Record<string, { bg: string; text: string }> = {
  RIDER_CASH: { bg: "bg-sky-100",    text: "text-sky-800"    },
  HBL:        { bg: "bg-teal-100",   text: "text-teal-800"   },
  MEEZAN:     { bg: "bg-purple-100", text: "text-purple-800" },
  JAZZCASH:   { bg: "bg-amber-100",  text: "text-amber-800"  },
  EASYPAISA:  { bg: "bg-orange-100", text: "text-orange-800" },
  CASH:       { bg: "bg-slate-100",  text: "text-slate-700"  },
} satisfies Record<PaymentHeadName, { bg: string; text: string }>;

/** "From" values that are an owner's personal account rather than a farm head.
 *  Prefixed so they can never collide with a PaymentHead value. */
const OWNER_PREFIX = "OWNER:";
const ownerValue = (id: string) => OWNER_PREFIX + id;
const ownerIdOf = (v: string) => (v.startsWith(OWNER_PREFIX) ? v.slice(OWNER_PREFIX.length) : null);

const HEAD_OPTIONS = [
  { value: "CASH", label: "Cash" },
  { value: "RIDER_CASH", label: "Rider Cash" },
  { value: "HBL", label: "HBL" },
  { value: "MEEZAN", label: "Meezan" },
  { value: "JAZZCASH", label: "JazzCash" },
  { value: "EASYPAISA", label: "Easypaisa" },
];

function fmt(n: number) {
  return Math.abs(Math.round(n)).toLocaleString("en-PK");
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "numeric" });
}

export function TransfersClient({ data }: { data: TransfersPageData }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [fromHead, setFromHead] = useState("EASYPAISA");
  const [toHead, setToHead] = useState("HBL");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayPKTString());
  const [notes, setNotes] = useState("");

  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const sorted = useMemo(() => {
    if (!sortKey) return data.transfers;
    return [...data.transfers].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return sortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [data.transfers, sortKey, sortDir]);

  const balOf = (h: string) => data.balances.find((b) => b.head === h)?.balance ?? 0;

  // Non-null when "From" is an owner's personal account rather than a farm head.
  // That is a different thing entirely — money arriving from outside — so it takes a
  // different action, has no source balance and cannot overdraw anything.
  const fromOwner = ownerIdOf(fromHead);

  function submit() {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { toast.error("Enter a valid amount."); return; }

    if (fromOwner) {
      if (!notes.trim()) { toast.error("Enter what this money was for."); return; }
      start(async () => {
        const res = await createOwnerContribution({ owner: fromOwner, amount: amt, date, reason: notes });
        if (res.ok) {
          toast.success(`₨ ${fmt(amt)} from ${ownerName(fromOwner)} credited to HBL.`);
          setAmount(""); setNotes("");
          router.refresh();
        } else {
          toast.error(res.error);
        }
      });
      return;
    }

    if (fromHead === toHead) { toast.error("Source and destination must differ."); return; }
    start(async () => {
      const res = await createTransfer({ fromHead, toHead, amount: amt, date, notes });
      if (res.ok) {
        toast.success(`₨ ${fmt(amt)} moved.`);
        setAmount(""); setNotes("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function remove(id: string, kind: "transfer" | "owner") {
    const msg = kind === "owner"
      ? "Delete this owner contribution? This takes the money back out of HBL."
      : "Delete this transfer? This moves the money back to the source account.";
    if (!window.confirm(msg)) return;
    start(async () => {
      const res = kind === "owner" ? await deleteOwnerContribution(id) : await deleteTransfer(id);
      if (res.ok) { toast.success(kind === "owner" ? "Contribution removed." : "Transfer reversed."); router.refresh(); }
      else toast.error(res.error);
    });
  }

  const fromLabel = HEAD_OPTIONS.find((h) => h.value === fromHead)?.label ?? fromHead;
  const toLabel = HEAD_OPTIONS.find((h) => h.value === toHead)?.label ?? toHead;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Current head balances */}
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Current head balances
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {data.balances.map((h) => {
            const col = HEAD_COLORS[h.head] ?? HEAD_COLORS.CASH;
            return (
              <div key={h.head} className={cn("rounded-lg p-3", col.bg)}>
                <p className={cn("text-[10px] font-semibold uppercase tracking-wide", col.text)}>{h.label}</p>
                <p className={cn("mt-1 text-sm font-semibold tabular-nums", col.text)}>
                  {h.balance < 0 ? "−" : ""}₨ {fmt(h.balance)}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Transfer form */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <ArrowLeftRight className="size-4 text-primary" />
          <p className="text-sm font-semibold">Move money between heads</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-end">
          {/* From */}
          <div className="sm:col-span-3">
            <Label className="mb-1 block text-xs text-muted-foreground">From</Label>
            <Select value={fromHead} onValueChange={setFromHead}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {HEAD_OPTIONS.map((h) => <SelectItem key={h.value} value={h.value} className="text-xs">{h.label}</SelectItem>)}
                {FARM_OWNERS.map((o) => (
                  <SelectItem key={o.id} value={ownerValue(o.id)} className="text-xs">
                    {o.name} — personal account
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* An owner's own account has no balance the farm can see. */}
            <p className="mt-1 text-[10px] text-muted-foreground">
              {fromOwner ? "Money coming in from outside the farm" : `Balance: ${balOf(fromHead) < 0 ? "−" : ""}₨ ${fmt(balOf(fromHead))}${fromHead === OWNERS_HEAD ? " · owed to owners" : ""}`}
            </p>
          </div>

          {/* arrow */}
          <div className="hidden items-center justify-center pb-6 sm:col-span-1 sm:flex">
            <ArrowRight className="size-4 text-muted-foreground" />
          </div>

          {/* To */}
          <div className="sm:col-span-3">
            <Label className="mb-1 block text-xs text-muted-foreground">To</Label>
            <Select value={fromOwner ? OWNER_FUNDING_HEAD : toHead} onValueChange={setToHead} disabled={!!fromOwner}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {HEAD_OPTIONS.map((h) => <SelectItem key={h.value} value={h.value} className="text-xs">{h.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {fromOwner ? "Owner funding always lands in HBL" : `Balance: ${balOf(toHead) < 0 ? "−" : ""}₨ ${fmt(balOf(toHead))}${toHead === OWNERS_HEAD ? " · a transfer here repays the owners" : ""}`}
            </p>
          </div>

          {/* Amount */}
          <div className="sm:col-span-2">
            <Label className="mb-1 block text-xs text-muted-foreground">Amount (₨)</Label>
            <Input type="number" min="0" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-9 text-right" />
          </div>

          {/* Date */}
          <div className="sm:col-span-2">
            <Label className="mb-1 block text-xs text-muted-foreground">Date</Label>
            <Input type="date" value={date} max={todayPKTString()} onChange={(e) => setDate(e.target.value)} className="h-9" />
          </div>

          {/* Submit */}
          <div className="sm:col-span-1">
            <Button className="h-9 w-full" onClick={submit} disabled={pending}>Move</Button>
          </div>
        </div>

        <div className="mt-3">
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={fromOwner
              ? "What was this money for? (required) — e.g. feed supplier payment"
              : "Note (optional) — e.g. transferred to bank, withdrawal"}
            className="h-9 text-sm sm:max-w-md"
          />
        </div>

        {amount && parseFloat(amount) > 0 && fromOwner && (
          <p className="mt-2 text-xs text-muted-foreground">
            Recording <span className="font-semibold text-foreground">₨ {fmt(parseFloat(amount))}</span> paid in by{" "}
            <span className="font-medium">{ownerName(fromOwner)}</span> from their own account. It is credited to{" "}
            <span className="font-medium">HBL</span> and the farm will owe them that much — spend it from HBL as normal.
          </p>
        )}
        {amount && parseFloat(amount) > 0 && !fromOwner && fromHead !== toHead && (
          <p className="mt-2 text-xs text-muted-foreground">
            Moving <span className="font-semibold text-foreground">₨ {fmt(parseFloat(amount))}</span> from{" "}
            <span className="font-medium">{fromLabel}</span> <ArrowRight className="inline size-3" />{" "}
            <span className="font-medium">{toLabel}</span>.
          </p>
        )}
      </div>

      {/* Recent transfers */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th
                onClick={() => handleSort("date")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Date
                  <span className={sortKey === "date" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "date" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("fromLabel")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  From
                  <span className={sortKey === "fromLabel" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "fromLabel" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("toLabel")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  To
                  <span className={sortKey === "toLabel" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "toLabel" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("amount")}
                className="border-b border-border px-3 py-2 text-right text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center justify-end gap-1">
                  Amount
                  <span className={sortKey === "amount" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "amount" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("notes")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Note
                  <span className={sortKey === "notes" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "notes" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th className="border-b border-border px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {data.transfers.length === 0 ? (
              <tr><td colSpan={6} className="py-10 text-center text-sm text-muted-foreground">No transfers yet.</td></tr>
            ) : (
              sorted.map((t) => {
                // An owner's personal account is not a head, so it gets its own colour
                // rather than falling through to Cash's and reading like one.
                const fc = t.kind === "owner"
                  ? { bg: "bg-violet-100", text: "text-violet-800" }
                  : HEAD_COLORS[t.fromHead] ?? HEAD_COLORS.CASH;
                const tc = HEAD_COLORS[t.toHead] ?? HEAD_COLORS.CASH;
                return (
                  <tr key={t.id} className="border-b border-border/50 hover:bg-muted/20">
                    <td className="px-3 py-2 text-[11px] text-muted-foreground whitespace-nowrap">{fmtDate(t.date)}</td>
                    <td className="px-3 py-2">
                      <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", fc.bg, fc.text)}>{t.fromLabel}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", tc.bg, tc.text)}>{t.toLabel}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums whitespace-nowrap">₨ {fmt(t.amount)}</td>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground">{t.notes ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => remove(t.id, t.kind)} disabled={pending} className="rounded p-1 text-muted-foreground hover:bg-rose-50 hover:text-rose-600" title="Reverse / delete">
                        <Trash2 className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

