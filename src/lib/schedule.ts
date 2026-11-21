// Shared shift/area delivery-day scheduling logic. Deliberately NOT a "use
// server" module — it's imported directly (synchronously) by both server
// components/actions and client components, so the lock rule is defined
// exactly once and can't drift between them.

// Same pattern used elsewhere in this codebase (topbar.tsx) to derive a
// weekday from a "YYYY-MM-DD" string without UTC-boundary drift.
export function weekdayOfDateStr(dateStr: string): number {
  return new Date(dateStr + "T12:00:00").getDay();
}

// ── Area delivery schedule ────────────────────────────────────────────────────
// Replaced the old weekday `deliveryDays Int[]` model. An area delivers on a
// date per its schedule; a shift delivers on a date if ANY of its areas does.
// All dates are "YYYY-MM-DD" strings (no timezone conversion — the route planner
// works in date strings too).

export type AreaSchedule = {
  scheduleType: string;          // "DAILY" | "EVERY_N" | "CUSTOM"
  scheduleInterval: number;      // N for EVERY_N (e.g. 2 = every 2nd day)
  scheduleAnchor: string | null; // "YYYY-MM-DD" cycle start for EVERY_N
  customDates: string[];         // "YYYY-MM-DD"[] delivery dates for CUSTOM
};

// Does this area deliver on the given "YYYY-MM-DD" date?
export function isAreaDeliveringOnDate(a: AreaSchedule, dateStr: string): boolean {
  if (a.scheduleType === "EVERY_N") {
    const n = Math.max(1, a.scheduleInterval);
    if (n === 1) return true;
    if (!a.scheduleAnchor) return true; // no cycle start yet → fail open (deliver)
    const diff = dayIndexFromDateStr(dateStr) - dayIndexFromDateStr(a.scheduleAnchor);
    return (((diff % n) + n) % n) === 0;
  }
  if (a.scheduleType === "CUSTOM") return a.customDates.includes(dateStr);
  return true; // DAILY (and any unknown type) → every day
}

// A shift delivers on a date if ANY of its areas does. A shift with NO areas
// delivers every day (fail open — matches the old empty-days rule so a freshly
// created shift isn't permanently inaccessible).
export function isShiftDeliveringOnDate(areas: AreaSchedule[], dateStr: string): boolean {
  if (areas.length === 0) return true;
  return areas.some((a) => isAreaDeliveringOnDate(a, dateStr));
}

// Locked = the shift is NOT delivering on this date.
export function isShiftLockedOnDateStr(areas: AreaSchedule[], dateStr: string): boolean {
  return !isShiftDeliveringOnDate(areas, dateStr);
}

// Human label for an area's schedule ("Daily" / "Every 2nd day" / "Custom (12 days)").
export function describeSchedule(a: AreaSchedule): string {
  if (a.scheduleType === "EVERY_N") {
    return a.scheduleInterval === 2 ? "Every 2nd day"
      : a.scheduleInterval === 3 ? "Every 3rd day"
      : `Every ${a.scheduleInterval} days`;
  }
  if (a.scheduleType === "CUSTOM") return `Custom (${a.customDates.length} day${a.customDates.length !== 1 ? "s" : ""})`;
  return "Daily";
}

// Every delivery date of an area within a calendar month ("YYYY-MM-DD"[]) —
// drives the Edit-Area calendar preview and its "N delivery days" summary.
export function deliveryDatesInMonth(a: AreaSchedule, year: number, month1: number): string[] {
  const days = new Date(year, month1, 0).getDate(); // month1 is 1-based
  const out: string[] = [];
  for (let d = 1; d <= days; d++) {
    const ds = `${year}-${String(month1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (isAreaDeliveringOnDate(a, ds)) out.push(ds);
  }
  return out;
}

// ── Alternate-schedule quantity cycling ───────────────────────────────────────
// Shared by billing (invoices) and the pre-delivery route planner so a customer
// is DELIVERED exactly what they are BILLED. Before this was extracted the route
// planner ignored the pattern entirely and delivered the flat `quantity`, so an
// alternate subscription was billed correctly but the rider was told the wrong
// amount every day.

const PKT_MS = 5 * 60 * 60 * 1000; // PKT = UTC + 5h

// Day index (days since epoch) of a Date, matching billing's own pktDayIndex.
// Robust to both stored forms: a UTC-midnight anchorDate and a `Date.UTC(..)-PKT`
// delivery day both land on the same integer (the +PKT fraction floors away).
export function pktDayIndex(d: Date): number {
  return Math.floor((d.getTime() + PKT_MS) / 86_400_000);
}

function dayIndexFromDateStr(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

// True when the "YYYY-MM-DD" delivery date falls strictly BEFORE the PKT calendar
// day of `start` — i.e. service hasn't begun yet. Used as a "deliveries start here"
// gate for both a product's anchorDate and a customer's joinDate. Robust to either
// stored form of `start` (UTC-midnight or Date.UTC()-PKT), same as pktDayIndex.
export function isBeforeServiceStart(dateStr: string, start: Date | null | undefined): boolean {
  if (!start) return false;
  return dayIndexFromDateStr(dateStr) < pktDayIndex(start);
}

// The pattern value for a given day, cycling from the anchor. `[2,0,3,0]` from
// its anchor → 2, skip, 3, skip, repeat. The double-mod keeps the index positive
// for days before the anchor.
export function alternateQtyForIndex(pattern: number[], dayIndex: number, anchorIndex: number): number {
  if (!pattern.length) return 0;
  const offset = dayIndex - anchorIndex;
  const pos = ((offset % pattern.length) + pattern.length) % pattern.length;
  return pattern[pos] ?? 0;
}

// The anchor day-index for a date: the product's explicit anchorDate when set,
// otherwise the start of the billing half containing the date (day 1 for the
// 1st–15th, day 16 for the 16th–end).
function anchorIndexForDateStr(anchorDate: Date | null, dateStr: string): number {
  if (anchorDate) return pktDayIndex(anchorDate);
  const [y, m, d] = dateStr.split("-").map(Number);
  const startDay = d <= 15 ? 1 : 16;
  return Math.floor(Date.UTC(y, m - 1, startDay) / 86_400_000);
}

function dateStrFromDayIndex(i: number): string {
  return new Date(i * 86_400_000).toISOString().slice(0, 10);
}

// How many of the shift's delivery days fall in [fromIndex, toIndex). The alternate
// pattern steps once per SHIFT, not once per calendar day: on an every-2nd-day
// shift, [2, 0] means 2 on Monday, nothing on Wednesday, 2 on Friday. A shift with
// no areas runs every day, so this is then the plain day count.
export function shiftDaysBetween(areas: AreaSchedule[], fromIndex: number, toIndex: number): number {
  let n = 0;
  for (let i = fromIndex; i < toIndex; i++) {
    if (isShiftDeliveringOnDate(areas, dateStrFromDayIndex(i))) n++;
  }
  return n;
}

export type SubscriptionSchedule = {
  scheduleType: string; // "DAILY" | "ALTERNATE" | "WEEKLY"
  quantity: number;
  alternatePattern: number[];
  /** WEEKLY only: JS weekdays (0=Sun … 6=Sat) this product is delivered on.
   *  Required (not optional) so a caller can never forget to pass it and leave a
   *  WEEKLY subscription silently delivering nothing. */
  weekdays: number[];
  anchorDate: Date | null;
  /** The schedule of the customer's shift. ALTERNATE steps one pattern entry per
   *  day this shift runs. Required for the same reason as `weekdays`. */
  shiftAreas: AreaSchedule[];
};

// The quantity a subscription delivers on a specific calendar date ("YYYY-MM-DD").
// DAILY → the flat quantity; ALTERNATE → the pattern entry for that date, one
// entry per shift day counted from the start date (0 = a deliberate skip shift).
export function subscriptionQtyForDate(cp: SubscriptionSchedule, dateStr: string): number {
  // Service start gate: the anchor date is also the day service BEGINS. Nothing is
  // delivered before it — a customer joined with an anchor of 1 Aug must not appear
  // on any route dated 31 Jul or earlier. Applies to every schedule type. (Billing
  // follows actual DeliveryEntry rows, so a customer kept off the route simply never
  // gets billed for pre-anchor days — bill and delivery stay in lock-step.)
  if (isBeforeServiceStart(dateStr, cp.anchorDate)) return 0;
  // WEEKLY: deliver the flat quantity only on the chosen weekday(s). This NARROWS
  // the shift's own schedule — it never adds a delivery on a day the shift does not
  // run, because the route builder only ever asks about the shift's delivery dates.
  // No weekday chosen = never delivers (rather than silently every day).
  if (cp.scheduleType === "WEEKLY") {
    const days = cp.weekdays ?? [];
    if (!days.length) return 0;
    return days.includes(weekdayOfDateStr(dateStr)) ? cp.quantity : 0;
  }
  if (cp.scheduleType !== "ALTERNATE") return cp.quantity;
  const pattern = cp.alternatePattern ?? [];
  if (!pattern.length || !pattern.some((q) => q > 0)) return 0;
  // The first shift day on or after the start date is entry 1. A day the shift does
  // not run (only reachable by an admin override) takes the next shift day's entry.
  const shiftDay = shiftDaysBetween(
    cp.shiftAreas ?? [],
    anchorIndexForDateStr(cp.anchorDate, dateStr),
    dayIndexFromDateStr(dateStr),
  );
  return alternateQtyForIndex(pattern, shiftDay, 0);
}
