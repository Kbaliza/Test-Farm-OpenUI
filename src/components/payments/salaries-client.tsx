"use client";

import { useState, useEffect, useMemo, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  ChevronDown, Pencil, Plus, Minus,
  ChevronLeft, ChevronRight, Bike,
} from "lucide-react";
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
import { STAFF_CATEGORIES } from "@/lib/staff-category";
import { PAYMENT_HEADS, PAYMENT_HEAD_LABELS, type PaymentHeadName } from "@/lib/payment-heads";
import {
  applyCarry,
  attendanceCounts,
  daysInMonth,
  employedDaysInMonth,
  fixedSalaryForDays,
} from "@/lib/salary-advance";
import {
  type PageData, type EmployeeRow, type HeadBalance, type LoginOption,
  type AttendanceStatus, type AdjEntry, type PayEntry,
  updateEmployee,
  upsertAttendance, addBonus, removeBonus, addDeduction, removeDeduction,
  recordSalaryPayment,
} from "@/app/(dashboard)/payments/salaries/actions";

// ── Constants ─────────────────────────────────────────────────────────────────

const MONTHS = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];

const DAY_NAMES = ["Su","Mo","Tu","We","Th","Fr","Sa"];

const HEAD_LABELS: Record<string, string> = PAYMENT_HEAD_LABELS;

const VISIBLE_HEADS: string[] = [...PAYMENT_HEADS];

const HEAD_COLORS: Record<string, { card: string; text: string; badge: string }> = {
  RIDER_CASH: { card: "bg-sky-50 border-sky-200",    text: "text-sky-800",    badge: "bg-sky-100 text-sky-800"    },
  HBL:        { card: "bg-teal-50 border-teal-200",   text: "text-teal-800",   badge: "bg-teal-100 text-teal-800"   },
  MEEZAN:     { card: "bg-purple-50 border-purple-200", text: "text-purple-800", badge: "bg-purple-100 text-purple-800" },
  JAZZCASH:   { card: "bg-amber-50 border-amber-200",  text: "text-amber-800",  badge: "bg-amber-100 text-amber-800"  },
  EASYPAISA:  { card: "bg-orange-50 border-orange-200",text: "text-orange-800", badge: "bg-orange-100 text-orange-800" },
  CASH:       { card: "bg-slate-50 border-slate-200",  text: "text-slate-700",  badge: "bg-slate-100 text-slate-700"  },
} satisfies Record<PaymentHeadName, { card: string; text: string; badge: string }>;

const AVATAR_PALETTE = [
  { bg: "bg-sky-100",    text: "text-sky-700"     },
  { bg: "bg-teal-100",   text: "text-teal-700"    },
  { bg: "bg-violet-100", text: "text-violet-700"  },
  { bg: "bg-amber-100",  text: "text-amber-700"   },
  { bg: "bg-rose-100",   text: "text-rose-700"    },
  { bg: "bg-emerald-100",text: "text-emerald-700" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) { return Math.abs(Math.round(n)).toLocaleString("en-PK"); }

function initials(name: string) {
  return name.split(" ").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
}

type CalcResult = {
  present: number; absent: number; half: number; holiday: number;
  effectiveDays: number; base: number;
  /** Days of the month they were on the books, and how many the month has. */
  employedDays: number; monthDays: number;
  /** They joined or left part way through, so the pay is for part of the month. */
  partMonth: boolean;
  bonusTotal: number; dedTotal: number; penTotal: number;
  gross: number; paid: number; balance: number;
  /** Owed from earlier months, carried in (added to this month). */
  owedIn: number;
  /** Extra paid in earlier months, carried in (taken off this month). */
  extraIn: number;
  /** Extra that carries on to next month. */
  extraLeft: number;
};

function calcSalary(emp: EmployeeRow, month: number, year: number, today: string): CalcResult {
  // Only the days they were actually on the books. Before someone joined and after
  // they left, an unmarked day is not a working day — counting it as one is what
  // paid a wage worker who started on the 20th for the whole month, and listed a
  // new starter against every month the farm has ever run.
  // payrollFrom, not joinedAt: a month a salary was actually paid for is theirs even
  // if the joining date typed in later says otherwise. See payrollStart.
  const window = { from: emp.payrollFrom, to: emp.leftAt };
  const monthDays = daysInMonth(year, month);
  const attMap = new Map(emp.attendance.map((a) => [a.date, a.status]));

  // The one shared arithmetic, rather than a second copy of it here. This page had
  // its own loop, which is exactly how the page and the carry-forward would come to
  // disagree about the same month.
  const { present, absent, half, holiday, effectiveDays } =
    attendanceCounts(year, month, attMap, today, window);
  const employed = employedDaysInMonth(year, month, window);

  // A fixed salary is paid in full for a whole month and by the thirtieth for part
  // of one, so a mid-month joiner or leaver is paid for their part of it.
  const base = emp.wageType === "fixed"
    ? fixedSalaryForDays(emp.baseSalary, employed, monthDays)
    : effectiveDays * emp.dailyWage;
  const bonusTotal = emp.bonuses.reduce((s, b) => s + b.amount, 0);
  const dedTotal   = emp.deductions.reduce((s, d) => s + d.amount, 0);
  // Checklist penalties are their own term rather than folded into deductions:
  // auto-computed money should never be indistinguishable from what a manager
  // typed in. A waived day still shows on the list but stops counting here.
  const penTotal   = emp.penalties.filter((p) => !p.waived).reduce((s, p) => s + p.amount, 0);
  const gross      = base + bonusTotal - dedTotal - penTotal;
  const paid       = emp.payments.reduce((s, p) => s + p.amount, 0);
  // Last month's balance carries in, whichever way it points: owed is added to
  // this month, extra is taken off it. See src/lib/salary-advance.ts.
  const carry      = applyCarry(gross, paid, emp.carryIn ?? 0);
  return {
    present, absent, half, holiday, effectiveDays, base, bonusTotal, dedTotal, penTotal, gross, paid,
    employedDays: employed, monthDays, partMonth: employed < monthDays,
    balance: carry.balance,
    owedIn: carry.owedIn,
    extraIn: carry.extraIn,
    extraLeft: carry.extraLeft,
  };
}

// ── Head card ─────────────────────────────────────────────────────────────────

function HeadCard({ h }: { h: HeadBalance }) {
  const col = HEAD_COLORS[h.head] ?? HEAD_COLORS.CASH;
  return (
    <div className={cn("rounded-lg border p-3", col.card)}>
      <p className={cn("text-[10px] font-semibold uppercase tracking-wide", col.text)}>{h.label}</p>
      <p className={cn("mt-1 text-sm font-bold tabular-nums", col.text)}>{h.balance < 0 ? "−" : ""}₨ {fmt(h.balance)}</p>
    </div>
  );
}

// ── Status pill ───────────────────────────────────────────────────────────────

function SalaryStatus({ balance, paid, extraLeft }: { balance: number; paid: number; extraLeft: number }) {
  if (extraLeft > 0)
    return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Extra paid</span>;
  if (balance <= 0)
    return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Fully paid</span>;
  if (paid > 0)
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Partial</span>;
  return <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">Unpaid</span>;
}

// ── Compact attendance strip (last 7 days) ─────────────────────────────────────

const ATT_STYLE: Record<string, string> = {
  PRESENT:  "bg-emerald-100 text-emerald-700 border-emerald-200 hover:opacity-80 cursor-pointer",
  ABSENT:   "bg-rose-100 text-rose-700 border-rose-200 hover:opacity-80 cursor-pointer",
  HALF_DAY: "bg-amber-100 text-amber-700 border-amber-200 hover:opacity-80 cursor-pointer",
  HOLIDAY:  "bg-slate-100 text-slate-600 border-slate-200 cursor-default",
};
const ATT_LABEL: Record<string, string> = {
  PRESENT: "P", ABSENT: "A", HALF_DAY: "½", HOLIDAY: "H",
};

function AttendanceStrip({
  emp, month, year, today,
  onToggle,
}: {
  emp: EmployeeRow; month: number; year: number; today: string;
  onToggle: (empId: string, dateStr: string, next: AttendanceStatus) => void;
}) {
  const attMap = new Map(emp.attendance.map((a) => [a.date, a.status]));
  const cycle: Record<string, AttendanceStatus> = {
    PRESENT: "ABSENT", ABSENT: "HALF_DAY", HALF_DAY: "PRESENT",
  };

  // Window of the last 7 days, anchored to today (current month) or the
  // month's last day (past months) — all within the displayed month's data.
  const [ty, tm] = today.split("-").map(Number);
  const isCurMonth = ty === year && tm === month;
  const lastDay = daysInMonth(year, month);
  const anchorDay = isCurMonth ? Number(today.slice(8, 10)) : lastDay;
  const startDay = Math.max(1, anchorDay - 6);
  const days = Array.from({ length: anchorDay - startDay + 1 }, (_, i) => startDay + i);

  return (
    <div className="flex items-center gap-1">
      {days.map((d) => {
        const ds = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const dow = new Date(year, month - 1, d).getDay();
        const isSunday = dow === 0;
        const isFuture = ds > today;
        const status = (attMap.get(ds) ?? (isSunday ? "HOLIDAY" : "PRESENT")) as AttendanceStatus;
        const interactive = !isFuture && !isSunday;
        return (
          <div key={d} className="flex flex-col items-center gap-0.5">
            <span className="text-[8px] leading-none text-muted-foreground">{DAY_NAMES[dow]}</span>
            <button
              disabled={!interactive}
              title={`${ds} — ${ATT_LABEL[status]}`}
              onClick={() => interactive && onToggle(emp.id, ds, cycle[status] ?? "PRESENT")}
              className={cn(
                "flex size-6 items-center justify-center rounded border text-[10px] font-semibold leading-none transition-opacity select-none",
                isFuture
                  ? "bg-muted/20 text-muted-foreground/30 border-border/30 cursor-default"
                  : ATT_STYLE[status] ?? ATT_STYLE.PRESENT
              )}
            >
              {isFuture ? "·" : ATT_LABEL[status]}
            </button>
            <span className="text-[8px] leading-none text-muted-foreground/70">{d}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Adj section (bonuses / deductions) ───────────────────────────────────────

function AdjSection({
  emp, month, year,
  onAddBonus, onRemoveBonus, onAddDed, onRemoveDed,
}: {
  emp: EmployeeRow; month: number; year: number;
  onAddBonus: (empId: string, amount: number, desc: string) => void;
  onRemoveBonus: (empId: string, adjId: string) => void;
  onAddDed: (empId: string, amount: number, desc: string) => void;
  onRemoveDed: (empId: string, adjId: string) => void;
}) {
  const [desc, setDesc] = useState("");
  const [amt, setAmt]   = useState("");

  function handleAdd(type: "bonus" | "deduction") {
    const a = parseFloat(amt);
    if (!desc.trim() || !a || a <= 0) { toast.error("Enter description and amount."); return; }
    if (type === "bonus") onAddBonus(emp.id, a, desc.trim());
    else onAddDed(emp.id, a, desc.trim());
    setDesc(""); setAmt("");
  }

  return (
    <div className="space-y-3">
      {/* Existing items */}
      {emp.bonuses.length === 0 && emp.deductions.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No adjustments yet.</p>
      ) : (
        <div className="space-y-1.5">
          {emp.bonuses.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-1.5 text-xs">
              <span className="font-medium text-emerald-700">{b.description}</span>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-emerald-700">+₨ {fmt(b.amount)}</span>
                <button onClick={() => onRemoveBonus(emp.id, b.id)} className="text-muted-foreground hover:text-rose-600 transition-colors"><Minus className="size-3" /></button>
              </div>
            </div>
          ))}
          {emp.deductions.map((d) => (
            <div key={d.id} className="flex items-center justify-between rounded-lg bg-rose-50 border border-rose-200 px-3 py-1.5 text-xs">
              <span className="font-medium text-rose-700">{d.description}</span>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-rose-700">−₨ {fmt(d.amount)}</span>
                <button onClick={() => onRemoveDed(emp.id, d.id)} className="text-muted-foreground hover:text-rose-600 transition-colors"><Minus className="size-3" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      <div className="grid grid-cols-[1fr_100px] gap-2">
        <Input placeholder="Description, e.g. Eid bonus" value={desc} onChange={(e) => setDesc(e.target.value)} className="h-8 text-xs" />
        <Input type="number" min="0" placeholder="Amount" value={amt} onChange={(e) => setAmt(e.target.value)} className="h-8 text-xs text-right" />
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-50" onClick={() => handleAdd("bonus")}>
          <Plus className="size-3" /> Bonus
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs border-rose-300 text-rose-700 hover:bg-rose-50" onClick={() => handleAdd("deduction")}>
          <Minus className="size-3" /> Deduct
        </Button>
      </div>
    </div>
  );
}

// ── Pay section ───────────────────────────────────────────────────────────────

function PaySection({
  emp, headBalances, onPay,
}: {
  emp: EmployeeRow;
  headBalances: HeadBalance[];
  onPay: (empId: string, amount: number, head: string, notes: string) => void;
}) {
  const [amt, setAmt]   = useState("");
  const [head, setHead] = useState("");
  const [note, setNote] = useState("");

  function handlePay() {
    const a = parseFloat(amt);
    if (!a || a <= 0) { toast.error("Enter a valid amount."); return; }
    if (!head)        { toast.error("Select a payment head."); return; }
    onPay(emp.id, a, head, note.trim());
    setAmt(""); setNote("");
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div>
          <Label className="text-[11px]">Amount (₨)</Label>
          <Input type="number" min="0" placeholder="0" value={amt} onChange={(e) => setAmt(e.target.value)} className="mt-0.5 h-8 text-xs text-right" />
        </div>
        <div>
          <Label className="text-[11px]">Pay from head</Label>
          <Select value={head} onValueChange={setHead}>
            <SelectTrigger className="mt-0.5 h-8 text-xs">
              <SelectValue placeholder="— select —" />
            </SelectTrigger>
            <SelectContent>
              {headBalances.map((h) => {
                const col = HEAD_COLORS[h.head];
                return (
                  <SelectItem key={h.head} value={h.head} className="text-xs">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold mr-1", col?.badge)}>
                      {h.label}
                    </span>
                    {h.balance < 0 ? "−" : ""}₨ {fmt(h.balance)}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[11px]">Note</Label>
          <Input placeholder="e.g. advance, full salary" value={note} onChange={(e) => setNote(e.target.value)} className="mt-0.5 h-8 text-xs" />
        </div>
      </div>
      <Button size="sm" onClick={handlePay} className="h-8 text-xs">Pay salary</Button>

      {/* Payment log */}
      {emp.payments.length > 0 && (
        <div className="space-y-1 max-h-28 overflow-y-auto rounded-lg border border-border bg-muted/20 p-2">
          {emp.payments.map((p) => {
            const col = HEAD_COLORS[p.head] ?? HEAD_COLORS.CASH;
            return (
              <div key={p.id} className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{p.paidAt} · {p.notes || "payment"}</span>
                <div className="flex items-center gap-1.5">
                  <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-semibold", col.badge)}>{p.headLabel}</span>
                  <span className="font-semibold text-emerald-600">₨ {fmt(p.amount)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Employee card ─────────────────────────────────────────────────────────────

function EmployeeCard({
  emp, index, expanded, month, year, today, headBalances,
  onExpand, onEdit,
  onAttToggle, onAddBonus, onRemoveBonus, onAddDed, onRemoveDed, onPay,
}: {
  emp: EmployeeRow; index: number; expanded: boolean;
  month: number; year: number; today: string;
  headBalances: HeadBalance[];
  onExpand: (id: string) => void;
  onEdit: (emp: EmployeeRow) => void;
  onAttToggle: (empId: string, dateStr: string, next: AttendanceStatus) => void;
  onAddBonus: (empId: string, amount: number, desc: string) => void;
  onRemoveBonus: (empId: string, adjId: string) => void;
  onAddDed: (empId: string, amount: number, desc: string) => void;
  onRemoveDed: (empId: string, adjId: string) => void;
  onPay: (empId: string, amount: number, head: string, notes: string) => void;
}) {
  const calc = calcSalary(emp, month, year, today);
  const av   = AVATAR_PALETTE[index % AVATAR_PALETTE.length];

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <button
        onClick={() => onExpand(emp.id)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/20 transition-colors border-b border-border/50"
      >
        <div className={cn("size-10 rounded-full flex items-center justify-center text-sm font-semibold shrink-0", av.bg, av.text)}>
          {initials(emp.name)}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight truncate">
            {emp.name}
            {!emp.active && (
              <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Disabled</span>
            )}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {emp.role || "—"} &nbsp;·&nbsp;
            {emp.wageType === "fixed" ? `₨ ${fmt(emp.baseSalary)}/mo` : `₨ ${fmt(emp.dailyWage)}/day`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2.5 shrink-0">
          <SalaryStatus balance={calc.balance} paid={calc.paid} extraLeft={calc.extraLeft} />
          <div className="text-right">
            <p className={cn("text-sm font-bold", calc.balance > 0 ? "text-rose-600" : "text-emerald-600")}>
              {calc.balance > 0
                ? `₨ ${fmt(calc.balance)} owed`
                : calc.extraLeft > 0
                  ? `₨ ${fmt(calc.extraLeft)} extra paid`
                  : "Cleared"}
            </p>
            <p className="text-[10px] text-muted-foreground">Net ₨ {fmt(calc.gross)}</p>
          </div>
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform duration-200", expanded && "rotate-180")} />
        </div>
      </button>

      {/* Expandable body */}
      {expanded && (
        <div className="p-4 space-y-5">

          {/* Attendance */}
          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Last 7 days — tap to toggle
              </p>
              <p className="text-[11px] tabular-nums text-muted-foreground">
                <span className="font-semibold text-emerald-600">{calc.present} P</span>
                <span className="mx-1">·</span>
                <span className="font-semibold text-rose-600">{calc.absent} A</span>
                <span className="mx-1">·</span>
                <span className="font-semibold text-amber-600">{calc.half} ½</span>
                <span className="mx-1">·</span>
                <span className="font-medium">{calc.holiday} H</span>
                <span className="ml-1 text-muted-foreground/70">this month</span>
              </p>
              {calc.partMonth && (
                <p className="mt-0.5 text-[11px] font-medium text-amber-700">
                  {emp.leftAt && emp.leftAt.slice(0, 7) === `${year}-${String(month).padStart(2, "0")}`
                    ? `Left ${emp.leftAt} — paid for ${calc.employedDays} of ${calc.monthDays} days`
                    : `Joined ${emp.joinedAt} — paid for ${calc.employedDays} of ${calc.monthDays} days`}
                </p>
              )}
            </div>
            <AttendanceStrip emp={emp} month={month} year={year} today={today} onToggle={onAttToggle} />
          </section>

          {/* Salary breakdown */}
          <section className="rounded-xl border border-border bg-muted/20 overflow-hidden">
            <div className="divide-y divide-border">
              <div className="flex justify-between px-4 py-2.5 text-sm">
                <span className="text-muted-foreground">
                  {emp.wageType === "fixed"
                    ? calc.partMonth
                      ? `Fixed salary · ${calc.employedDays} of ${calc.monthDays} days (₨ ${fmt(emp.baseSalary)} ÷ 30 × ${calc.employedDays})`
                      : "Fixed monthly salary"
                    : `₨ ${fmt(emp.dailyWage)} × ${calc.effectiveDays} effective days`}
                </span>
                <span className="font-semibold">₨ {fmt(calc.base)}</span>
              </div>
              {calc.bonusTotal > 0 && (
                <div className="flex justify-between px-4 py-2.5 text-sm">
                  <span className="text-emerald-600">Total bonuses</span>
                  <span className="font-semibold text-emerald-600">+₨ {fmt(calc.bonusTotal)}</span>
                </div>
              )}
              {calc.dedTotal > 0 && (
                <div className="flex justify-between px-4 py-2.5 text-sm">
                  <span className="text-rose-600">Total deductions</span>
                  <span className="font-semibold text-rose-600">−₨ {fmt(calc.dedTotal)}</span>
                </div>
              )}
              {calc.penTotal > 0 && (
                <div className="flex justify-between px-4 py-2.5 text-sm">
                  <span className="text-rose-600">
                    Checklist penalties
                    <span className="ml-1.5 text-[11px] text-muted-foreground">
                      {emp.penalties.filter((p) => !p.waived).length} day
                      {emp.penalties.filter((p) => !p.waived).length === 1 ? "" : "s"} under 70%
                    </span>
                  </span>
                  <span className="font-semibold text-rose-600">−₨ {fmt(calc.penTotal)}</span>
                </div>
              )}
              {calc.paid > 0 && (
                <div className="flex justify-between px-4 py-2.5 text-sm">
                  <span className="text-muted-foreground">Already paid</span>
                  <span className="font-semibold text-emerald-600">−₨ {fmt(calc.paid)}</span>
                </div>
              )}
            </div>
            {calc.owedIn > 0 && (
              <div className="flex justify-between items-center border-t border-rose-200 bg-rose-50/70 px-4 py-2">
                <span className="text-xs font-medium text-rose-700">Owed from earlier months</span>
                <span className="text-sm font-semibold tabular-nums text-rose-700">+ ₨ {fmt(calc.owedIn)}</span>
              </div>
            )}
            {calc.extraIn > 0 && (
              <div className="flex justify-between items-center border-t border-emerald-200 bg-emerald-50/70 px-4 py-2">
                <span className="text-xs font-medium text-emerald-700">Extra paid earlier</span>
                <span className="text-sm font-semibold tabular-nums text-emerald-700">− ₨ {fmt(calc.extraIn)}</span>
              </div>
            )}
            <div className={cn("flex justify-between items-center px-4 py-3", calc.balance <= 0 ? "bg-emerald-50 border-t border-emerald-200" : "bg-sky-50 border-t border-sky-200")}>
              <span className={cn("text-sm font-semibold", calc.balance <= 0 ? "text-emerald-700" : "text-sky-700")}>
                {calc.balance > 0 ? "Balance to pay" : calc.extraLeft > 0 ? "Extra paid — adjust next month" : "Fully settled"}
              </span>
              <span className={cn("text-lg font-bold tabular-nums", calc.balance <= 0 ? "text-emerald-700" : "text-sky-700")}>
                {calc.balance > 0
                  ? `₨ ${fmt(calc.balance)}`
                  : calc.extraLeft > 0
                    ? `₨ ${fmt(calc.extraLeft)}`
                    : "✓ Cleared"}
              </span>
            </div>
          </section>

          {/* Bonuses & deductions */}
          <section>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Bonuses & Deductions
            </p>
            <AdjSection
              emp={emp} month={month} year={year}
              onAddBonus={onAddBonus} onRemoveBonus={onRemoveBonus}
              onAddDed={onAddDed}   onRemoveDed={onRemoveDed}
            />
          </section>

          {/* Pay salary */}
          <section>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Pay Salary
            </p>
            <PaySection emp={emp} headBalances={headBalances} onPay={onPay} />
          </section>

          {/* Footer actions */}
          <div className="flex justify-end gap-2 pt-1 border-t border-border">
            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => onEdit(emp)}>
              <Pencil className="size-3" /> Configure salary
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The Select's "not linked" value — Radix does not allow an empty string. */
const NO_LOGIN = "__none__";

// ── Edit dialog ───────────────────────────────────────────────────────────────

function EditDialog({
  open, emp, logins, onClose, onSave,
}: {
  open: boolean;
  emp: EmployeeRow | null;
  logins: LoginOption[];
  onClose: () => void;
  onSave: (id: string, data: { role: string; wageType: "fixed" | "daily"; wage: number; joinedAt: string; userId: string | null }) => void;
}) {
  const [role, setRole]         = useState("");
  const [wageType, setWageType] = useState<"fixed" | "daily">("fixed");
  const [wage, setWage]         = useState("");
  const [joinedAt, setJoinedAt] = useState("");
  const [linked, setLinked]     = useState(NO_LOGIN);

  useEffect(() => {
    if (emp) {
      setRole(emp.role);
      setWageType(emp.wageType);
      setWage(emp.wageType === "fixed" ? String(emp.baseSalary) : String(emp.dailyWage));
      setJoinedAt(emp.joinedAt);
      setLinked(emp.userId ?? NO_LOGIN);
    }
  }, [emp]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">Configure salary — {emp?.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div>
            <Label className="text-xs">Role / designation</Label>
            <Input value={role} onChange={(e) => setRole(e.target.value)} className="mt-1 h-8 text-xs" placeholder="e.g. Rider, Senior Rider" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Wage type</Label>
              <Select value={wageType} onValueChange={(v) => setWageType(v as "fixed" | "daily")}>
                <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed" className="text-xs">Fixed monthly</SelectItem>
                  <SelectItem value="daily" className="text-xs">Per day</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">{wageType === "fixed" ? "Monthly salary (₨)" : "Daily wage (₨)"}</Label>
              <Input type="number" min="0" value={wage} onChange={(e) => setWage(e.target.value)} className="mt-1 h-8 text-xs text-right" />
            </div>
          </div>
          <div>
            <Label className="text-xs">Join date</Label>
            <Input type="date" value={joinedAt} onChange={(e) => setJoinedAt(e.target.value)} className="mt-1 h-8 text-xs" />
          </div>
          <div>
            <Label className="text-xs">Linked login</Label>
            <Select value={linked} onValueChange={setLinked}>
              <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_LOGIN} className="text-xs">— Not linked —</SelectItem>
                {logins.map((l) => {
                  const takenElsewhere = !!l.linkedTo && l.id !== emp?.userId;
                  return (
                    <SelectItem key={l.id} value={l.id} disabled={takenElsewhere} className="text-xs">
                      {l.name}{takenElsewhere ? ` — linked to ${l.linkedTo}` : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Checklist penalties are recorded against a login. Link this person&apos;s login so their penalties come off this salary.
            </p>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => emp && onSave(emp.id, { role, wageType, wage: parseFloat(wage) || 0, joinedAt, userId: linked === NO_LOGIN ? null : linked })}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main client ───────────────────────────────────────────────────────────────

export function SalariesClient({
  data, month, year,
}: {
  data: PageData; month: number; year: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [employees, setEmployees]       = useState<EmployeeRow[]>(data.employees);
  const [headBalances, setHeadBalances] = useState<HeadBalance[]>(data.headBalances);
  const [expandedId, setExpandedId]     = useState<string | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editEmp, setEditEmp]   = useState<EmployeeRow | null>(null);

  // The same category filter the Attendance page has. "ALL" is everyone, "NONE"
  // those not given a category yet. The totals follow it as well as the list, so
  // the payroll figure is the payroll for whoever is on screen.
  const [category, setCategory] = useState<string>("ALL");
  // No show-or-hide for disabled staff any more.
  //
  // There used to be a toggle, because the month a person belonged in was not
  // something the page could work out: disabled staff arrived whether or not the
  // month was theirs, so they were hidden and a button brought them back. The server
  // decides it now — from the month they joined to the month they left, with any
  // record always keeping them — so everyone sent for a month belongs in that month
  // and there is nothing to hide. Disable somebody in August and they appear in
  // August, paid for the days they worked, and in no month after it.
  const shown = useMemo(() => (
    category === "ALL" ? employees
    : category === "NONE" ? employees.filter((e) => !e.category)
    : employees.filter((e) => e.category === category)
  ), [employees, category]);

  const today = todayPKTString();
  const selMonth = `${year}-${String(month).padStart(2, "0")}`;

  // Reset state when server data changes (month navigation)
  useEffect(() => {
    setEmployees(data.employees);
    setHeadBalances(data.headBalances);
  }, [data]);

  // ── Month navigation ────────────────────────────────────────────────────────

  function navigate(dir: -1 | 1) {
    let m = month + dir, y = year;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    router.push(`?m=${y}-${String(m).padStart(2, "0")}`, { scroll: false });
  }

  // ── Summary stats ───────────────────────────────────────────────────────────

  const stats = shown.reduce(
    (acc, e) => {
      const c = calcSalary(e, month, year, today);
      acc.payroll += c.gross;
      acc.paid    += c.paid;
      acc.bonus   += c.bonusTotal;
      acc.ded     += c.dedTotal;
      // Includes what carried in from earlier months, so the card agrees with the rows.
      acc.balance += c.balance;
      return acc;
    },
    { payroll: 0, paid: 0, bonus: 0, ded: 0, balance: 0 }
  );

  // ── Attendance toggle ───────────────────────────────────────────────────────

  function handleAttToggle(empId: string, dateStr: string, next: AttendanceStatus) {
    setEmployees((prev) =>
      prev.map((e) => {
        if (e.id !== empId) return e;
        const has = e.attendance.some((a) => a.date === dateStr);
        return {
          ...e,
          attendance: has
            ? e.attendance.map((a) => a.date === dateStr ? { ...a, status: next } : a)
            : [...e.attendance, { id: "", date: dateStr, status: next }],
        };
      })
    );
    upsertAttendance(empId, dateStr, next).then((res) => {
      if (!res.ok) { toast.error(res.error); router.refresh(); }
      else if (res.id) {
        setEmployees((prev) =>
          prev.map((e) => e.id !== empId ? e : {
            ...e,
            attendance: e.attendance.map((a) =>
              a.date === dateStr && a.id === "" ? { ...a, id: res.id } : a
            ),
          })
        );
      }
    });
  }

  // ── Bonuses ─────────────────────────────────────────────────────────────────

  function handleAddBonus(empId: string, amount: number, desc: string) {
    startTransition(async () => {
      const res = await addBonus(empId, month, year, amount, desc);
      if (!res.ok) { toast.error(res.error); return; }
      setEmployees((prev) =>
        prev.map((e) => e.id !== empId ? e : { ...e, bonuses: [...e.bonuses, res.entry] })
      );
      toast.success("Bonus added.");
    });
  }

  function handleRemoveBonus(empId: string, adjId: string) {
    startTransition(async () => {
      const res = await removeBonus(adjId);
      if (!res.ok) { toast.error(res.error); return; }
      setEmployees((prev) =>
        prev.map((e) => e.id !== empId ? e : { ...e, bonuses: e.bonuses.filter((b) => b.id !== adjId) })
      );
    });
  }

  // ── Deductions ───────────────────────────────────────────────────────────────

  function handleAddDed(empId: string, amount: number, desc: string) {
    startTransition(async () => {
      const res = await addDeduction(empId, month, year, amount, desc);
      if (!res.ok) { toast.error(res.error); return; }
      setEmployees((prev) =>
        prev.map((e) => e.id !== empId ? e : { ...e, deductions: [...e.deductions, res.entry] })
      );
      toast.success("Deduction added.");
    });
  }

  function handleRemoveDed(empId: string, adjId: string) {
    startTransition(async () => {
      const res = await removeDeduction(adjId);
      if (!res.ok) { toast.error(res.error); return; }
      setEmployees((prev) =>
        prev.map((e) => e.id !== empId ? e : { ...e, deductions: e.deductions.filter((d) => d.id !== adjId) })
      );
    });
  }

  // ── Pay salary ───────────────────────────────────────────────────────────────

  function handlePay(empId: string, amount: number, head: string, notes: string) {
    startTransition(async () => {
      const res = await recordSalaryPayment({ employeeId: empId, month, year, amount, head, notes });
      if (!res.ok) { toast.error(res.error); return; }
      setEmployees((prev) =>
        prev.map((e) => e.id !== empId ? e : { ...e, payments: [...e.payments, res.entry] })
      );
      setHeadBalances((prev) =>
        prev.map((h) => h.head === head ? { ...h, balance: h.balance - amount } : h)
      );
      toast.success(`₨ ${fmt(amount)} paid.`);
    });
  }

  // ── Edit rider salary config ─────────────────────────────────────────────────

  function handleSaveEdit(id: string, data: { role: string; wageType: "fixed" | "daily"; wage: number; joinedAt: string; userId: string | null }) {
    startTransition(async () => {
      const res = await updateEmployee(id, data);
      if (!res.ok) { toast.error(res.error); return; }
      setEditOpen(false);
      router.refresh();
      toast.success("Salary configured.");
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 p-4 sm:p-6">

      {/* Month navigator */}
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => navigate(-1)} className="size-8 flex items-center justify-center rounded-lg border border-border bg-background hover:bg-muted/40 transition-colors">
          <ChevronLeft className="size-4" />
        </button>
        <span className="min-w-[130px] text-center text-sm font-semibold">{MONTHS[month - 1]} {year}</span>
        <button onClick={() => navigate(1)} className="size-8 flex items-center justify-center rounded-lg border border-border bg-background hover:bg-muted/40 transition-colors">
          <ChevronRight className="size-4" />
        </button>
        <span className="text-xs text-muted-foreground">{daysInMonth(year, month)} days</span>

        {/* Month input — direct jump */}
        <input
          type="month"
          value={selMonth}
          onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) router.push(`?m=${e.target.value}`); }}
          className="ml-auto h-8 w-36 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          { label: "Total payroll",   value: `₨ ${fmt(stats.payroll)}`,           color: "text-sky-700"     },
          { label: "Total paid out",  value: `₨ ${fmt(stats.paid)}`,              color: "text-emerald-600" },
          { label: "Balance to pay",  value: `₨ ${fmt(stats.balance)}`,           color: "text-rose-600" },
          { label: "Total bonuses",   value: `₨ ${fmt(stats.bonus)}`,             color: "text-emerald-600" },
          { label: "Total deductions",value: `₨ ${fmt(stats.ded)}`,               color: "text-rose-600"    },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-lg border border-border bg-card p-3">
            <p className="text-[10px] text-muted-foreground">{label}</p>
            <p className={cn("mt-1 text-base font-bold tabular-nums", color)}>{value}</p>
            {label === "Total payroll" && (
              <p className="mt-0.5 text-[10px] text-muted-foreground">{shown.length} {shown.length === 1 ? "person" : "people"}</p>
            )}
          </div>
        ))}
      </div>

      {/* Head balances */}
      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Pay from head</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {headBalances.map((h) => <HeadCard key={h.head} h={h} />)}
        </div>
      </div>

      {/* Category pills — one per category with how many people are in it, the
          same filter and the same shape as the Attendance page. */}
      {employees.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
          {[
            { id: "ALL", label: "All" },
            ...STAFF_CATEGORIES.map((c) => ({ id: c.id as string, label: c.label })),
            { id: "NONE", label: "Not set" },
          ].map(({ id, label }) => {
            const pool = employees;
            const count =
              id === "ALL" ? pool.length
              : id === "NONE" ? pool.filter((e) => !e.category).length
              : pool.filter((e) => e.category === id).length;
            const on = category === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setCategory(id)}
                aria-pressed={on}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  count === 0 && !on && "opacity-50",
                )}
              >
                {label}
                <span className={cn("tabular-nums", on ? "text-primary-foreground/80" : "text-muted-foreground/70")}>{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Rider list */}
      {shown.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border text-muted-foreground">
          <Bike className="size-8 opacity-30" />
          <p className="text-sm">
            {employees.length === 0
              ? "Nobody was on the payroll this month."
              : "Nobody in this category. Set a category on the Staff page."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map((emp, i) => (
            <EmployeeCard
              key={emp.id}
              emp={emp}
              index={i}
              expanded={expandedId === emp.id}
              month={month}
              year={year}
              today={today}
              headBalances={headBalances}
              onExpand={(id) => setExpandedId(expandedId === id ? null : id)}
              onEdit={(e) => { setEditEmp(e); setEditOpen(true); }}
              onAttToggle={handleAttToggle}
              onAddBonus={handleAddBonus}
              onRemoveBonus={handleRemoveBonus}
              onAddDed={handleAddDed}
              onRemoveDed={handleRemoveDed}
              onPay={handlePay}
            />
          ))}
        </div>
      )}

      {/* Edit dialog */}
      <EditDialog
        open={editOpen}
        emp={editEmp}
        logins={data.logins}
        onClose={() => { setEditOpen(false); setEditEmp(null); }}
        onSave={handleSaveEdit}
      />
    </div>
  );
}
