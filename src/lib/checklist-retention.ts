// How long a day's checklist history is kept.
//
// Every tick and every remark is already stored per PKT day, with who did it —
// so the history builds up on its own and would grow for ever. This is the one
// place that decides how much of it is kept, so raising or lowering the window
// is a one-line change with a test behind it.
//
// Pure and date-string based on purpose: no Date arithmetic across timezones, and
// the rule can be tested without a database.

/** Days of history kept, counting back from today inclusive. */
export const CHECKLIST_RETENTION_DAYS = 60;

/** "YYYY-MM-DD" → a UTC-noon Date, the same key checklistDayKey() writes. */
function parseDayStr(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
}

function toDayStr(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * The oldest day still kept, given today. Anything strictly before this is due
 * to be deleted.
 *
 * With a 60-day window and today at 2026-09-01, the cutoff is 2026-07-04: that
 * day and everything after it stays, 2026-07-03 and earlier goes.
 */
export function retentionCutoff(todayStr: string, days = CHECKLIST_RETENTION_DAYS): string {
  const d = parseDayStr(todayStr);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return toDayStr(d);
}

/** Whether a day's history is still inside the window. */
export function isWithinRetention(
  dayStr: string,
  todayStr: string,
  days = CHECKLIST_RETENTION_DAYS
): boolean {
  return dayStr >= retentionCutoff(todayStr, days);
}

/** Every day in the window, newest first — the calendar's full range. */
export function retentionDays(todayStr: string, days = CHECKLIST_RETENTION_DAYS): string[] {
  const out: string[] = [];
  const d = parseDayStr(todayStr);
  for (let i = 0; i < days; i++) {
    out.push(toDayStr(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

export { parseDayStr as checklistDayStrToDate, toDayStr as checklistDateToDayStr };
