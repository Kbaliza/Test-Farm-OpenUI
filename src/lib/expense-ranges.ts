// The windows the Recent Expenses list can be filtered to.
//
// In its own module, not in expenses/actions.ts, because that file is
// "use server" and such a module may only export ASYNC FUNCTIONS — a plain
// constant or a sync helper there fails the build with "Server Actions must be
// async functions". Typechecking does not catch it; only a real build does.
//
// Living here also means the client can render the buttons and the server can
// resolve the dates from one definition instead of two that drift.

import { todayPKTString, yesterdayPKTString } from "@/lib/pkt";

/**
 * Named rather than a day count so "yesterday" can mean that day ALONE — a
 * plain "2 days" would fold today into it and the two options would look
 * broken sitting next to each other.
 */
export type RecentRange = "today" | "yesterday" | "7d" | "15d" | "30d";

export const RECENT_RANGES: { key: RecentRange; label: string }[] = [
  { key: "today",     label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d",        label: "7D" },
  { key: "15d",       label: "15D" },
  { key: "30d",       label: "30D" },
];

/** What the list opens on. */
export const DEFAULT_RECENT_RANGE: RecentRange = "30d";

/** A From–To window picked on the page, as PKT day strings, inclusive at both ends. */
export type DateWindow = { from: string; to: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The window as PKT day strings, inclusive at both ends — a named range, or a
 * From–To pair. A pair given the wrong way round is turned the right way; one
 * that is not two real dates falls back to the default range.
 */
export function recentRangeDays(range: RecentRange | DateWindow): { from: string; to: string } {
  if (typeof range === "object") {
    const { from, to } = range ?? {};
    if (typeof from === "string" && typeof to === "string" && DAY.test(from) && DAY.test(to)) {
      return from <= to ? { from, to } : { from: to, to: from };
    }
    return recentRangeDays(DEFAULT_RECENT_RANGE);
  }
  const today = todayPKTString();
  if (range === "today") return { from: today, to: today };
  const yday = yesterdayPKTString();
  if (range === "yesterday") return { from: yday, to: yday };
  // Inclusive of today, so 7D is today plus the six before it.
  const back = range === "7d" ? 6 : range === "15d" ? 14 : 29;
  const [y, m, d] = today.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d - back));
  return { from: start.toISOString().slice(0, 10), to: today };
}
