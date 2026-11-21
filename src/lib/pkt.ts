// Pakistan Standard Time = UTC+5 (no DST)
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

function nowInPKT(): Date {
  return new Date(Date.now() + PKT_OFFSET_MS);
}

/**
 * Creates a UTC timestamp whose PKT representation is `dateStr` (YYYY-MM-DD)
 * at the current PKT time of day. Use this when the user manually picks a date
 * (e.g. yoghurt batch form) so the stored timestamp stays on the correct PKT day
 * regardless of server timezone.
 */
export function pktDateWithCurrentTime(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const pktNow = nowInPKT(); // wall-clock PKT expressed as UTC offset
  return new Date(
    Date.UTC(y, m - 1, d, pktNow.getUTCHours(), pktNow.getUTCMinutes(), pktNow.getUTCSeconds())
    - PKT_OFFSET_MS
  );
}

/**
 * Canonical PKT-noon of a "YYYY-MM-DD" as a fixed UTC instant. Timezone-INDEPENDENT:
 * unlike `new Date(y, m-1, d, 12)` — which resolves in the SERVER'S local timezone
 * and so yields a different instant on a UTC server than on a PKT machine — this is
 * always the same instant for a given calendar day. Used as the canonical key for a
 * Route's `date`, so a route the web saves (server may run in UTC) and the one the
 * rider's mobile app writes (PKT phone) land on the SAME timestamp and the
 * @@unique([date, shiftId]) actually enforces one route per shift per day. Noon
 * keeps it safely away from either day boundary.
 */
export function pktNoonToUTC(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0) - PKT_OFFSET_MS);
}

function pktMidnightToUTC(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d) - PKT_OFFSET_MS);
}

export type DateRangePKT = { gte: Date; lte: Date };

export function todayRangePKT(): DateRangePKT {
  const n = nowInPKT();
  const y = n.getUTCFullYear();
  const m = n.getUTCMonth();
  const d = n.getUTCDate();
  return {
    gte: pktMidnightToUTC(y, m, d),
    lte: new Date(pktMidnightToUTC(y, m, d + 1).getTime() - 1),
  };
}

export function getDateRangePKT(
  period: "today" | "week" | "month"
): DateRangePKT {
  const n = nowInPKT();
  const y = n.getUTCFullYear();
  const m = n.getUTCMonth();
  const d = n.getUTCDate();

  switch (period) {
    case "today":
      return {
        gte: pktMidnightToUTC(y, m, d),
        lte: new Date(pktMidnightToUTC(y, m, d + 1).getTime() - 1),
      };
    case "week": {
      const dow = n.getUTCDay(); // 0 = Sunday
      const toMon = dow === 0 ? -6 : 1 - dow;
      return {
        gte: pktMidnightToUTC(y, m, d + toMon),
        lte: new Date(pktMidnightToUTC(y, m, d + toMon + 7).getTime() - 1),
      };
    }
    case "month":
      return {
        gte: pktMidnightToUTC(y, m, 1),
        lte: new Date(pktMidnightToUTC(y, m + 1, 1).getTime() - 1),
      };
  }
}

// For date-string ("YYYY-MM-DD") passed from a form or URL param
export function dateStrRangePKT(dateStr: string): DateRangePKT {
  const [y, m, d] = dateStr.split("-").map(Number);
  return {
    gte: new Date(Date.UTC(y, m - 1, d) - PKT_OFFSET_MS),
    lte: new Date(Date.UTC(y, m - 1, d + 1) - PKT_OFFSET_MS - 1),
  };
}

// From the start of `from` to the end of `to` (both in PKT "YYYY-MM-DD")
export function dateRangeFromToPKT(from: string, to: string): DateRangePKT {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return {
    gte: new Date(Date.UTC(fy, fm - 1, fd) - PKT_OFFSET_MS),
    lte: new Date(Date.UTC(ty, tm - 1, td + 1) - PKT_OFFSET_MS - 1),
  };
}

// "YYYY-MM-DD" from any Date or ISO string, in PKT
export function toDateStrPKT(d: Date | string): string {
  return new Date(d instanceof Date ? d : d).toLocaleDateString("en-CA", {
    timeZone: "Asia/Karachi",
  });
}

// "YYYY-MM-DD" for today in PKT — safe to use in both server and browser
export function todayPKTString(): string {
  const n = nowInPKT();
  const y = n.getUTCFullYear();
  const mo = String(n.getUTCMonth() + 1).padStart(2, "0");
  const d = String(n.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

// "YYYY-MM-DD" for yesterday in PKT
export function yesterdayPKTString(): string {
  const n = new Date(nowInPKT().getTime() - 86_400_000);
  const y = n.getUTCFullYear();
  const mo = String(n.getUTCMonth() + 1).padStart(2, "0");
  const d = String(n.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

// "YYYY-MM-DD" n days after (or before, if negative) another "YYYY-MM-DD".
// Pure calendar arithmetic on the string itself, so it can never drift a day
// the way adding 86_400_000 to a zoned Date can.
export function addDaysToDateStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const mo = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mo}-${dd}`;
}

// Timezone-consistent formatters (give same output on server & browser)
export function fmtTimePKT(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: "Asia/Karachi",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export function fmtDatePKT(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "Asia/Karachi",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
