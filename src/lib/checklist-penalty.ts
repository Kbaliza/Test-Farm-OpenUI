// The rule for docking someone's pay when they do not do their checklist.
//
// Below 70% of their items for a day, across ALL of their checklists together, is
// Rs 300 off that day. Attendance can excuse it: marked absent, half day or on
// holiday means no penalty. A day with no attendance row still counts, because
// attendance is filled in patchily and waiting for it would make the rule do
// nothing at all.
//
// Pure and dependency-free on purpose, like checklist-retention: the threshold is
// the sort of thing that gets argued about, so it lives in one place with tests
// on the boundary rather than being a magic number three files deep.

export const PENALTY_PER_DAY = 300;

/**
 * The rule does not reach back before this day.
 *
 * Without it the first run would score every day still in the 60-day window and
 * fine people for weeks that happened before anyone told them the rule existed —
 * on the real data that was 101 days and Rs 30,300 spread across eleven people.
 * A penalty nobody could have avoided is not a penalty, it is a surprise deduction.
 *
 * Move this date EARLIER to back-date the rule; the reconciler will fill in the
 * days on its next run. Move it later and nothing before it is scored.
 */
export const PENALTY_START_DAY = "2026-09-06";

/** Whether a day is on or after the day the rule came into force. */
export function isScorable(day: string): boolean {
  return day >= PENALTY_START_DAY;
}

/** Below this fraction of the day's items and the penalty applies. */
export const COMPLIANCE_THRESHOLD = 0.7;

/** Attendance statuses that excuse the day entirely. */
export const EXCUSED_STATUSES = ["ABSENT", "HALF_DAY", "HOLIDAY"] as const;

export function isExcusedStatus(status: string | null | undefined): boolean {
  return !!status && (EXCUSED_STATUSES as readonly string[]).includes(status);
}

/** The share of the day's items that were ticked. 0 items → 1 (nothing to fail). */
export function complianceRatio(done: number, total: number): number {
  if (total <= 0) return 1;
  return done / total;
}

/**
 * Whether this day earns the penalty.
 *
 * A day with no items assigned is never penalised — there was nothing to fall
 * short of, and fining someone because the office never set a list up would be
 * indefensible.
 */
export function isBelowThreshold(done: number, total: number): boolean {
  if (total <= 0) return false;
  // Compared as a product rather than a division so 7/10 is exactly at the line
  // and passes, instead of failing on a floating-point hair.
  return done * 100 < total * COMPLIANCE_THRESHOLD * 100;
}

/** What a day costs: the flat penalty, or nothing. */
export function penaltyForDay(done: number, total: number): number {
  return isBelowThreshold(done, total) ? PENALTY_PER_DAY : 0;
}

/** "6 of 10 items · 60%" — one wording for the salary page and the tooltip. */
export function describeDay(done: number, total: number): string {
  const pct = Math.round(complianceRatio(done, total) * 100);
  return `${done} of ${total} item${total === 1 ? "" : "s"} · ${pct}%`;
}
