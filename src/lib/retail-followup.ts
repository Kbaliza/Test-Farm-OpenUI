// When to go back and ask a shop what sold.
//
// A drop is chased a few days later — three by default, changeable per shop for
// the ones that always take a week. Missing that date is shown, never alarmed
// about beyond the ordinary alerts feed.
//
// Pure, so the page's Due / Overdue / Upcoming tabs and the alerts feed bucket
// identically. Dates are plain "YYYY-MM-DD" PKT day strings throughout, so there
// is no timezone arithmetic to get wrong.

export const FOLLOWUP_DAYS = 3;

export type FollowupBucket = "overdue" | "due" | "upcoming";

/** The day we should go back, as a PKT day string. */
export function dueDateFor(dropDate: string, followUpDays = FOLLOWUP_DAYS): string {
  const days = Number.isFinite(followUpDays) && followUpDays >= 0 ? Math.floor(followUpDays) : FOLLOWUP_DAYS;
  return addDays(dropDate, days);
}

/**
 * Where a drop sits relative to today:
 *   before its date  → upcoming
 *   on its date      → due
 *   after            → overdue
 */
export function bucketFor(dueDate: string, today: string): FollowupBucket {
  if (dueDate > today) return "upcoming";
  if (dueDate === today) return "due";
  return "overdue";
}

/** How many days late, 0 when not yet overdue. */
export function daysOverdue(dueDate: string, today: string): number {
  return Math.max(0, daysBetween(dueDate, today));
}

/** How old a drop is, in days. */
export function ageInDays(dropDate: string, today: string): number {
  return Math.max(0, daysBetween(dropDate, today));
}

/** "YYYY-MM-DD" + n days, as a PKT day string. Calendar-only, no clock involved. */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from a to b (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}
