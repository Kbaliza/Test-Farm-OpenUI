/**
 * How an Attendance row's day is keyed, and the days a part month leaves behind.
 *
 * Attendance has a unique (employeeId, date), and every row ever written keyed the
 * day at LOCAL noon — not PKT noon, which is what `pktNoonToUTC` gives and what
 * Employee.leftAt is stored with. The two are different instants, so a row written
 * with the wrong one slips past the unique constraint and reads back as a separate
 * day: the same date would hold two rows and the page would show whichever it
 * happened to find.
 *
 * It lives here, outside the Attendance actions, because the Staff page now writes
 * attendance too — it marks the rest of the month absent when someone leaves. A
 * second copy of this one line is exactly how those two would come to disagree.
 */
export function attendanceDateKey(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

/**
 * Every day AFTER `dateStr` to the end of its own month, as "YYYY-MM-DD".
 *
 * The leaving day itself is not included: they worked it, so whatever it is
 * already marked as stands.
 */
export function daysAfterInMonth(dateStr: string): string[] {
  const [y, m, d] = dateStr.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last of this
  const out: string[] = [];
  for (let day = d + 1; day <= lastDay; day++) {
    out.push(`${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  return out;
}
