"use client";

import { useRef, useState } from "react";
import { ClipboardList, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { getProductTotalsForDate, type TodayTotal } from "@/app/(dashboard)/customers/pre-delivery/actions";
import { addDaysToDateStr, todayPKTString } from "@/lib/pkt";

// Matches the shift-summary pills in pre-delivery-client.tsx (those helpers are
// module-local there, not exported — kept in sync by convention).
const UNIT_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  LITER: { bg: "bg-sky-50", text: "text-sky-800", dot: "bg-sky-400" },
  KG: { bg: "bg-amber-50", text: "text-amber-800", dot: "bg-amber-400" },
  PIECE: { bg: "bg-violet-50", text: "text-violet-800", dot: "bg-violet-400" },
};
const uLabel = (u: string) => (u === "LITER" ? "L" : u === "KG" ? "kg" : "pc");
const xQty = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));

/** Today, tomorrow and the day after. Mirrors LOAD_PREVIEW_DAYS on the server. */
const PREVIEW_DAYS = 3;

type DayResult = { totals: TodayTotal[]; error?: string };

// Dates here are plain "YYYY-MM-DD" calendar days, so format them as UTC —
// formatting in the browser's own zone could name the wrong weekday.
function calendarDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function dayName(dateStr: string, index: number) {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  return calendarDate(dateStr).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
}
function shortDate(dateStr: string) {
  return calendarDate(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
/** "today", "tomorrow", or "Monday" — for use inside a sentence. */
function inSentence(name: string) {
  return name === "Today" || name === "Tomorrow" ? name.toLowerCase() : name;
}

export function TodayTotalsButton() {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [results, setResults] = useState<Record<string, DayResult>>({});
  const inFlight = useRef(new Set<string>());

  // Each day is fetched once, lazily, the first time it is looked at; a failed
  // load is retried the next time that day is picked.
  function load(date: string, known: Record<string, DayResult>) {
    const have = known[date];
    if ((have && !have.error) || inFlight.current.has(date)) return;
    inFlight.current.add(date);
    getProductTotalsForDate(date)
      .then((res) => setResults((prev) => ({ ...prev, [date]: { totals: res.totals, error: res.error } })))
      .catch(() =>
        setResults((prev) => ({ ...prev, [date]: { totals: [], error: "Could not load this day. Try again." } }))
      )
      .finally(() => inFlight.current.delete(date));
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    // Work the week out on every open, so a dialog left on the page past
    // midnight doesn't keep calling yesterday "Today".
    const today = todayPKTString();
    const week = Array.from({ length: PREVIEW_DAYS }, (_, i) => addDaysToDateStr(today, i));
    let known = results;
    if (days[0] !== today) {
      known = {};
      setResults(known);
    }
    setDays(week);
    setSelected(today);
    load(today, known);
  }

  function pick(date: string) {
    setSelected(date);
    load(date, results);
  }

  const index = Math.max(0, days.indexOf(selected));
  const name = selected ? dayName(selected, index) : "Today";
  const result = selected ? results[selected] : undefined;
  const isToday = index === 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          size="lg"
          className="h-14 w-full justify-center gap-2.5 rounded-xl bg-brand text-base font-semibold text-white shadow-md shadow-brand/25 ring-1 ring-brand/20 transition hover:bg-brand/90 hover:shadow-lg sm:w-auto sm:px-8"
        >
          <ClipboardList className="size-5" />
          View today&apos;s total load
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {name}&apos;s load{selected ? ` — ${shortDate(selected)}` : ""}
          </DialogTitle>
          <DialogDescription>
            {isToday
              ? "Total of every product to hand to riders today, across all shifts scheduled today."
              : `Total of every product planned for ${inSentence(name)}, across all shifts scheduled that day. Based on routes, subscriptions and orders as they stand now, so it can still change.`}
          </DialogDescription>
        </DialogHeader>

        {/* The week, in order */}
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Day">
          {days.map((d, i) => {
            const active = d === selected;
            return (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => pick(d)}
                className={`flex shrink-0 flex-col items-center rounded-lg border px-3 py-1.5 text-center transition ${
                  active
                    ? "border-brand bg-brand text-white shadow-sm"
                    : "border-border bg-background text-foreground hover:bg-muted"
                }`}
              >
                <span className="text-xs font-semibold leading-tight">{dayName(d, i)}</span>
                <span className={`text-[10.5px] leading-tight ${active ? "text-white/80" : "text-muted-foreground"}`}>
                  {shortDate(d)}
                </span>
              </button>
            );
          })}
        </div>

        {!result ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Adding up {inSentence(name)}&apos;s shifts…
          </div>
        ) : result.error ? (
          <p className="py-8 text-center text-sm text-rose-600">{result.error}</p>
        ) : result.totals.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing scheduled for delivery {isToday || name === "Tomorrow" ? inSentence(name) : `on ${name}`}.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {result.totals.map((t) => {
              const c = UNIT_COLORS[t.unit] ?? UNIT_COLORS.LITER;
              return (
                <div
                  key={t.productId}
                  className={`rounded-lg p-3 ${c.bg}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`size-1.5 rounded-full ${c.dot}`} />
                    <span className={`truncate text-xs font-medium ${c.text}`}>{t.name}</span>
                  </div>
                  <div className={`mt-1 text-lg font-bold tabular-nums ${c.text}`}>
                    {xQty(t.qty)}
                    <span className="ml-1 text-xs font-medium">{uLabel(t.unit)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
