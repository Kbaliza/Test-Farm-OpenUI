// Date windows for the Summary Report, in PKT.
//
// Kept pure (no Prisma, no server-only) so the arithmetic can be unit-tested
// without a database and so the page and its action agree on exactly which days
// a "week" or a "month" covers. Every boundary here is a PKT calendar day
// expressed as a UTC instant, the same convention the rest of the app uses
// (PKT midnight = UTC − 5h).

export type ReportPeriod = "day" | "week" | "month";

export type Window = {
  /** Inclusive UTC instant of the first PKT millisecond in the window. */
  start: Date;
  /** Inclusive UTC instant of the last PKT millisecond in the window. */
  end: Date;
  /** "YYYY-MM-DD" of the first and last PKT day. */
  startStr: string;
  endStr: string;
  label: string;
};

const PKT_MS = 5 * 60 * 60 * 1000;
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function isValidDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

/** "YYYY-MM-DD" → its three numbers. */
function parts(dateStr: string): [number, number, number] {
  const [y, m, d] = dateStr.split("-").map(Number);
  return [y, m - 1, d]; // month 0-based
}

function toStr(y: number, m0: number, d: number): string {
  const t = new Date(Date.UTC(y, m0, d));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** First UTC instant of a PKT calendar day. */
export function pktDayStart(y: number, m0: number, d: number): Date {
  return new Date(Date.UTC(y, m0, d) - PKT_MS);
}

/** A window covering whole PKT days from one date string to another (inclusive). */
export function windowFromDates(fromStr: string, toStr_: string, label: string): Window {
  const [fy, fm, fd] = parts(fromStr);
  const [ty, tm, td] = parts(toStr_);
  return {
    start: pktDayStart(fy, fm, fd),
    end: new Date(pktDayStart(ty, tm, td + 1).getTime() - 1),
    startStr: fromStr,
    endStr: toStr_,
    label,
  };
}

/** Monday-based weekday index (Mon = 0 … Sun = 6) of a PKT date string. */
export function mondayIndex(dateStr: string): number {
  const [y, m, d] = parts(dateStr);
  return (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7;
}

/** Days in a month (month is 1-based here for callers' convenience). */
export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** The window a period + anchor date covers. Weeks run Monday→Sunday. */
export function resolveWindow(period: ReportPeriod, dateStr: string): Window {
  const [y, m, d] = parts(dateStr);
  if (period === "day") {
    return windowFromDates(dateStr, dateStr, `${d} ${MON[m]} ${y}`);
  }
  if (period === "week") {
    const back = mondayIndex(dateStr);
    const monday = toStr(y, m, d - back);
    const sunday = toStr(y, m, d - back + 6);
    const [sy, sm, sd] = parts(monday);
    const [ey, em, ed] = parts(sunday);
    const label =
      sm === em && sy === ey
        ? `${sd}–${ed} ${MON[em]} ${ey}`
        : `${sd} ${MON[sm]} – ${ed} ${MON[em]} ${ey}`;
    return windowFromDates(monday, sunday, label);
  }
  const last = daysInMonth(y, m + 1);
  return windowFromDates(toStr(y, m, 1), toStr(y, m, last), `${MONTHS[m]} ${y}`);
}

/** The two 15-day billing halves of the month containing `dateStr`. */
/** "31st", not "31th" — the label blindly appended "th" to the month end. */
function ordinal(d: number): string {
  const t = d % 10, h = d % 100;
  if (t === 1 && h !== 11) return `${d}st`;
  if (t === 2 && h !== 12) return `${d}nd`;
  if (t === 3 && h !== 13) return `${d}rd`;
  return `${d}th`;
}

/** One billing half, whichever month it falls in. */
function billingHalf(y: number, m0: number, half: 1 | 2): { half: 1 | 2; year: number; month: number; label: string; window: Window } {
  const last = daysInMonth(y, m0 + 1);
  return half === 1
    ? {
        half: 1, year: y, month: m0 + 1,
        label: `1st – 15th ${MON[m0]}`,
        window: windowFromDates(toStr(y, m0, 1), toStr(y, m0, 15), `1–15 ${MON[m0]}`),
      }
    : {
        half: 2, year: y, month: m0 + 1,
        label: `16th – ${ordinal(last)} ${MON[m0]}`,
        window: windowFromDates(toStr(y, m0, 16), toStr(y, m0, last), `16–${last} ${MON[m0]}`),
      };
}

/**
 * The cycle the date falls in, and the one before it — oldest first.
 *
 * This used to return BOTH halves of the anchor's own month, which meant that
 * on the 3rd you were shown a cycle that had barely started next to one that
 * had not started at all, and the cycle actually being chased — the previous
 * one — was not on the page. Recovery happens against the cycle that closed,
 * so that is the one that has to be visible.
 *
 * The previous cycle crosses into last month when the current one is 1–15,
 * which is why each label carries its month.
 */
export function billingHalves(dateStr: string): { half: 1 | 2; year: number; month: number; label: string; window: Window }[] {
  const [y, m, d] = parts(dateStr);
  const current = billingHalf(y, m, d <= 15 ? 1 : 2);
  const previous =
    d <= 15
      ? billingHalf(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1, 2)
      : billingHalf(y, m, 1);
  return [previous, current];
}

export type Bucket = { key: string; label: string; start: Date; end: Date };

/**
 * Trend buckets ending with the selected period: 7 days, 8 weeks or 12 months.
 * The last bucket is always the selected period itself, so the sparkline's final
 * bar is the figure shown in the headline above it.
 */
export function trendBuckets(period: ReportPeriod, dateStr: string): Bucket[] {
  const [y, m, d] = parts(dateStr);
  const out: Bucket[] = [];
  if (period === "day") {
    for (let i = 6; i >= 0; i--) {
      const ds = toStr(y, m, d - i);
      const w = windowFromDates(ds, ds, ds);
      out.push({ key: ds, label: String(Number(ds.slice(8, 10))), start: w.start, end: w.end });
    }
    return out;
  }
  if (period === "week") {
    const back = mondayIndex(dateStr);
    for (let i = 7; i >= 0; i--) {
      const monday = toStr(y, m, d - back - i * 7);
      const sunday = toStr(y, m, d - back - i * 7 + 6);
      const w = windowFromDates(monday, sunday, monday);
      out.push({ key: monday, label: `${Number(monday.slice(8, 10))} ${MON[Number(monday.slice(5, 7)) - 1]}`, start: w.start, end: w.end });
    }
    return out;
  }
  for (let i = 11; i >= 0; i--) {
    const my = y, mm = m - i;
    const t = new Date(Date.UTC(my, mm, 1));
    const yy = t.getUTCFullYear(), m0 = t.getUTCMonth();
    const last = daysInMonth(yy, m0 + 1);
    const w = windowFromDates(toStr(yy, m0, 1), toStr(yy, m0, last), MON[m0]);
    out.push({ key: `${yy}-${String(m0 + 1).padStart(2, "0")}`, label: MON[m0], start: w.start, end: w.end });
  }
  return out;
}

/** Human label for a period + date, e.g. "Daily summary · 17 Aug 2025". */
export function periodSubtitle(period: ReportPeriod, dateStr: string): string {
  const pre = period === "day" ? "Daily summary" : period === "week" ? "Weekly summary" : "Monthly summary";
  return `${pre} · ${resolveWindow(period, dateStr).label}`;
}
