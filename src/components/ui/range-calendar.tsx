"use client";

import { useMemo, useState } from "react";
import { MiniCalendar, nextPick } from "@/components/ui/mini-calendar";

/**
 * A date range picked on a calendar, for every page that used to carry a pair of
 * typed From/To boxes.
 *
 * This exists because the wiring around MiniCalendar is where the mistakes live,
 * not in MiniCalendar itself. Rider Cash held the half-made first click in one
 * place and read it back from another, so its calendar could be clicked forever
 * without ever filtering anything — and because `pickRange` was correct, every
 * test passed while the page was broken. Four more pages were about to be wired
 * by hand the same way. They now share this one, which holds the pending start
 * itself and hands the caller a finished range or nothing at all.
 *
 * The caller decides what a finished range MEANS: Reconciliation and Rider Item
 * Returns re-query the server, Ledgers only fills its boxes and waits for View,
 * Audit Log and Rider Cash push it into the URL. None of them has to think about
 * the two-click rule again.
 */
export function RangeCalendar({
  from,
  to,
  onApply,
  maxDate,
  datesWithEntries,
  className,
}: {
  /** The range in force, as YYYY-MM-DD. Empty string for "not set". */
  from: string;
  to: string;
  /** Called once BOTH ends are known. Never called on the first click. */
  onApply: (from: string, to: string) => void;
  /** Latest pickable day, usually today. */
  maxDate?: string;
  /** Days to mark with a dot, when the caller has the rows to know. */
  datesWithEntries?: Set<string>;
  className?: string;
}) {
  // Holds the start between the two clicks. The caller is deliberately NOT told
  // about it: a half-made range must not re-query or overwrite the boxes.
  const [pendingStart, setPendingStart] = useState<string | null>(null);

  // Seeded once from the range in force so the calendar opens on the right month.
  // It deliberately does not chase `from` afterwards — the preset buttons on
  // Reconciliation and Rider Item Returns would otherwise yank the month out from
  // under someone mid-pick, and the chevrons are right there.
  const [cal, setCal] = useState(() => {
    const d = from ? new Date(from + "T12:00:00") : new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const marks = useMemo(() => datesWithEntries ?? new Set<string>(), [datesWithEntries]);

  return (
    <div className={className}>
      <MiniCalendar
        year={cal.year}
        month={cal.month}
        datesWithEntries={marks}
        rangeStart={pendingStart ?? (from || null)}
        rangeEnd={pendingStart ? null : to && to !== from ? to : null}
        maxDate={maxDate}
        onPick={(d) => {
          const next = nextPick(
            pendingStart,
            { start: from || null, end: to && to !== from ? to : null },
            d,
          );
          if (next.end) {
            setPendingStart(null);
            onApply(next.start, next.end);
          } else {
            setPendingStart(next.start);
          }
        }}
        onPrevMonth={() =>
          setCal((c) => (c.month === 0 ? { year: c.year - 1, month: 11 } : { ...c, month: c.month - 1 }))
        }
        onNextMonth={() =>
          setCal((c) => (c.month === 11 ? { year: c.year + 1, month: 0 } : { ...c, month: c.month + 1 }))
        }
      />
    </div>
  );
}
