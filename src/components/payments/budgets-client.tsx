"use client";

import { useState, useTransition } from "react";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getMonthlyExpenses,
  type MonthlyExpensesData,
} from "@/app/(dashboard)/payments/expenses/actions";
import { BudgetEditor } from "@/components/payments/monthly-expenses-client";

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function fmt(n: number) {
  return Math.abs(n).toLocaleString("en-PK");
}

// Dedicated, always-available budget editor. Unlike Monthly Expenses (which is
// about what was SPENT), this page exists purely to set each category's limit —
// so it renders the editor no matter what, expenses or not.
export function BudgetsClient({ initial }: { initial: MonthlyExpensesData }) {
  const [data, setData] = useState<MonthlyExpensesData>(initial);
  const [pending, startTransition] = useTransition();

  const isCurrentMonth = data.month === initial.month && data.year === initial.year;

  function load(month: number, year: number) {
    startTransition(async () => {
      setData(await getMonthlyExpenses(month, year));
    });
  }
  function shiftMonth(delta: number) {
    let m = data.month + delta;
    let y = data.year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    load(m, y);
  }
  function reloadData() {
    load(data.month, data.year);
  }

  const totalBudget = data.byCategory.reduce((s, c) => s + c.budget, 0);
  const totalSpent = data.byCategory.reduce((s, c) => s + c.amount, 0);

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* Month switcher + totals */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="size-8" onClick={() => shiftMonth(-1)} disabled={pending} aria-label="Previous month">
            <ChevronLeft className="size-4" />
          </Button>
          <div className="min-w-40 text-center">
            <div className="flex items-center justify-center gap-1.5 text-sm font-semibold">
              <CalendarDays className="size-4 text-muted-foreground" />
              {MONTH_NAMES[data.month - 1]} {data.year}
            </div>
            {!isCurrentMonth && (
              <button onClick={() => load(initial.month, initial.year)} className="text-[11px] text-primary hover:underline" disabled={pending}>
                Jump to this month
              </button>
            )}
          </div>
          <Button variant="outline" size="icon" className="size-8" onClick={() => shiftMonth(1)} disabled={pending} aria-label="Next month">
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <div className="flex gap-6 text-right">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total budget</p>
            <p className="text-xl font-bold tabular-nums">{pending ? "…" : `Rs ${fmt(totalBudget)}`}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Spent</p>
            <p className="text-xl font-bold tabular-nums">{pending ? "…" : `Rs ${fmt(totalSpent)}`}</p>
          </div>
        </div>
      </div>

      {/* The editor — ALWAYS visible, the same form as Monthly Expenses' "Set budgets". */}
      <div className="lg:max-w-2xl">
        {data.byCategory.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No expense categories found — open Payments → Daily Expenses once to restore the default categories, then come back.
          </p>
        ) : (
          <div className="rounded-xl border border-border bg-card p-4">
            {/* Keyed by month so switching months starts the form from that month's budgets. */}
            <BudgetEditor key={`${data.year}-${data.month}`} data={data} onDone={reloadData} />
          </div>
        )}
      </div>
    </div>
  );
}
