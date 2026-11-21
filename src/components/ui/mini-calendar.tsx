"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

// A month grid you click twice to pick a range: first click sets the start, second
// sets the end, a third starts over. Extracted from the Wastage page so the Rider
// Cash page uses the same one — a second copy of a date picker is how two screens
// quietly start disagreeing about what "this week" means.
//
// Purely presentational: it holds no state and does no filtering. The caller owns
// `rangeStart`/`rangeEnd` and decides what a pick means — Wastage filters rows it
// already has in the browser, Rider Cash pushes the range into the URL so the
// SERVER re-queries. `pickRange` below is the shared two-click rule so those two
// callers cannot drift apart on the fiddly part.

export function MiniCalendar({
  year,
  month,
  datesWithEntries,
  rangeStart,
  rangeEnd,
  maxDate,
  onPick,
  onPrevMonth,
  onNextMonth,
}: {
  year: number;
  month: number;
  datesWithEntries: Set<string>;
  rangeStart: string | null;
  rangeEnd: string | null;
  /**
   * Latest pickable day as YYYY-MM-DD, or undefined for no limit. Rider Cash needs
   * it because the date inputs it replaced carried `max={today}` — a collection
   * cannot have happened tomorrow, and letting one be picked only produces an empty
   * table that looks like a fault.
   */
  maxDate?: string;
  onPick: (d: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
}) {
  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName = new Date(year, month, 1).toLocaleString("default", {
    month: "long",
    year: "numeric",
  });

  // Monday-first offset: Sun(0)→6, Mon(1)→0, Tue(2)→1 ...
  const offset = (firstDay + 6) % 7;
  const cells: (number | null)[] = Array(offset).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  // Effective end while only the start is picked = the start itself.
  const effEnd = rangeEnd ?? rangeStart;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <button
          onClick={onPrevMonth}
          className="rounded p-1 hover:bg-muted transition-colors"
        >
          <ChevronLeft className="size-4" />
        </button>
        <p className="text-sm font-semibold">{monthName}</p>
        <button
          onClick={onNextMonth}
          className="rounded p-1 hover:bg-muted transition-colors"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div className="mb-1 grid grid-cols-7 text-center text-[10px] text-muted-foreground">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-1 text-center">
        {cells.map((day, i) => {
          if (day === null) return <span key={i} />;
          const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const hasEntry = datesWithEntries.has(dateStr);
          const isStart = dateStr === rangeStart;
          const isEnd = !!rangeEnd && dateStr === rangeEnd;
          const isEndpoint = isStart || isEnd;
          const inRange =
            !!rangeStart && !!effEnd && dateStr >= rangeStart && dateStr <= effEnd;
          const isMiddle = inRange && !isEndpoint;
          const tooLate = !!maxDate && dateStr > maxDate;

          return (
            <button
              key={i}
              onClick={() => onPick(dateStr)}
              disabled={tooLate}
              className={`relative mx-auto flex size-7 items-center justify-center text-xs transition-colors
                ${tooLate ? "cursor-not-allowed text-muted-foreground/35" : ""}
                ${isEndpoint ? "rounded-full bg-primary font-semibold text-primary-foreground" : ""}
                ${isMiddle ? "rounded-md bg-primary/15 font-medium text-foreground" : ""}
                ${!inRange && !tooLate ? "rounded-full hover:bg-muted" : ""}
                ${hasEntry && !inRange ? "font-semibold text-foreground" : !inRange && !tooLate ? "text-muted-foreground" : ""}`}
            >
              {day}
              {hasEntry && !inRange && (
                <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 size-1 rounded-full bg-rose-500" />
              )}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-center text-[10px] text-muted-foreground">
        {!rangeStart
          ? "Pick a start date"
          : !rangeEnd
            ? "Now pick an end date"
            : "Range selected · pick again to restart"}
      </p>
    </div>
  );
}

/**
 * The two-click range rule, shared so both callers behave identically.
 *
 * No range yet, or a complete one → start over with this date as the start.
 * A start but no end → this becomes the end, swapping if you picked backwards.
 */
export function pickRange(
  current: { start: string | null; end: string | null },
  dateStr: string
): { start: string; end: string | null } {
  if (!current.start || (current.start && current.end)) return { start: dateStr, end: null };
  if (dateStr < current.start) return { start: dateStr, end: current.start };
  return { start: current.start, end: dateStr };
}

/**
 * What a click means when the half-made start is held SEPARATELY from the range
 * already in force — Rider Cash, where the applied range lives in the URL and is
 * only written once both ends are known.
 *
 * Exists because getting this wrong is invisible: Rider Cash passed the applied
 * `from` here instead of the pending start, so on a page with no range yet every
 * click merely re-set the start and the calendar could be clicked forever without
 * ever filtering. `pickRange` was correct throughout and its own tests passed, so
 * the fault had nowhere to show up. Now it does.
 */
export function nextPick(
  pendingStart: string | null,
  applied: { start: string | null; end: string | null },
  dateStr: string
): { start: string; end: string | null } {
  return pickRange(pendingStart ? { start: pendingStart, end: null } : applied, dateStr);
}
