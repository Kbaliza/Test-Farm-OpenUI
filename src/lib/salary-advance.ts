// A worker's salary balance, carried from one month into the next.
//
// Salaries are worked out a month at a time: what the month earns, less what was
// paid against it. Left there, a month that was underpaid or overpaid simply
// ended — August showed "owed 17,692", and September started again from zero as
// though August had been settled.
//
// The balance now carries, whichever way it points:
//
//   owed   (paid less than earned) → added to what is owed next month
//   extra  (paid more than earned) → taken off what is owed next month
//
// Three rules keep it honest:
//
//   R1  "Balance to pay" never goes negative. Extra that is more than a month can
//       absorb is shown as extra, and keeps carrying.
//   R2  A month's pay never counts below zero. Deductions and checklist penalties
//       can push gross negative — a worker with no wage set and Rs 1,800 of
//       penalties has gross −1,800. That is not money anyone handed over and not a
//       debt the worker owes the farm, so it carries neither as owed nor as extra.
//   R3  A worker's carry starts at their first month with real attendance or a
//       salary payment. The salaries page counts an unmarked day as worked, so a
//       month holding nothing but, say, a bonus row would otherwise be valued as a
//       whole month of wages nobody worked — and carried forward as owed.
//
// Pure and framework-free, so the Salaries page, the server that feeds it and the
// tests all agree on one arithmetic.

/** What one closed month contributed: what was earned, and what was handed over. */
export type MonthTotals = { gross: number; paid: number };

/** An earlier month, and whether anything in it shows the worker worked or was paid. */
export type WorkedMonth = MonthTotals & {
  /** "2026-8" — see monthKey. */
  key: string;
  /** True when the month holds an attendance record or a salary payment. */
  worked: boolean;
};

/** R3: every month from the first one with attendance or a payment. Input oldest first. */
export function fromFirstWorkedMonth(months: WorkedMonth[]): WorkedMonth[] {
  const first = months.findIndex((m) => m.worked);
  return first === -1 ? [] : months.slice(first);
}

/**
 * The balance carried INTO a month, from every month before it.
 *
 *   > 0  still owed to the worker
 *   < 0  extra paid — our money sitting with them
 *
 * Summed as a running account, so an overpayment settles an earlier shortfall
 * before anything is left over: owed 5,000 in August and overpaid 8,000 in
 * September carries 3,000 of extra, not 8,000.
 */
export function balanceBroughtForward(months: MonthTotals[]): number {
  return round2(months.reduce((s, m) => s + Math.max(0, m.gross) - m.paid, 0)); // R2
}

export type MonthOutcome = {
  /** Owed from earlier months, carried in. */
  owedIn: number;
  /** Extra paid in earlier months, carried in. */
  extraIn: number;
  /** Still to hand over, this month plus anything carried. Never negative (R1). */
  balance: number;
  /** Extra that carries on to next month. */
  extraLeft: number;
  /** Paid over this month's own salary, before anything carried in. */
  extraPaidThisMonth: number;
};

/** One month's figures, with the balance brought forward applied. */
export function applyCarry(gross: number, paid: number, carryIn: number): MonthOutcome {
  const earned = Math.max(0, gross); // R2
  const net = earned + carryIn - paid;
  return {
    owedIn: round2(Math.max(0, carryIn)),
    extraIn: round2(Math.max(0, -carryIn)),
    balance: round2(Math.max(0, net)), // R1
    extraLeft: round2(Math.max(0, -net)),
    extraPaidThisMonth: round2(Math.max(0, paid - earned)),
  };
}

/**
 * The day someone starts being paid from: their joining date, unless a salary was
 * actually paid for an earlier month.
 *
 * The joining dates on file are not all real. Many are the day the record was typed
 * in: twelve staff share 10 September 2026 because that is when the list was
 * entered, and nineteen of them were paid a full August salary — Hanif Rs 28,000,
 * Baba Rs 30,000, Bilal Ahmad Rs 32,000. Taking those dates at face value would have
 * cut August's payroll from Rs 1,511,816 to Rs 426,709 against months already paid,
 * leaving the difference to carry forward as money the farm had overpaid.
 *
 * A payment settles it. Money handed over for August is proof they worked in August,
 * whatever date was typed in later, so the start moves back to cover it. Where there
 * is no payment the joining date stands — which is the case for the people this was
 * reported for: Usman Ali and Zeeshan Khattak both joined in late September, were
 * never paid for August, and were being credited a whole August salary that then
 * carried forward as owed.
 *
 * Attendance deliberately does NOT count. It is marked a month at a time regardless
 * of who started when — Usman Ali has a mark for every day of September including
 * the twenty-eight before he joined — so as evidence of employment it says nothing.
 *
 * @param joinedAt      "YYYY-MM-DD" from the staff record
 * @param firstPaidMonth the earliest month a salary was paid for, or null
 */
export const PAYROLL_HISTORY_BEGINS = "2026-08";

export function payrollStart(
  joinedAt: string,
  firstPaidMonth: { year: number; month: number } | null
): string {
  // Anyone whose date falls in the software's first month was already working here
  // when it was switched on: the farm's history predates it, and the date recorded
  // is the day the record was typed in. Six of them were paid a full August salary
  // against a mid-August date — Dr. Kamran Rs 70,000, Wajid Khan Rs 57,692 — so
  // reading those dates literally would have shown the farm as having overpaid them
  // and quietly taken it off their later pay.
  if (joinedAt.slice(0, 7) <= PAYROLL_HISTORY_BEGINS) return `${PAYROLL_HISTORY_BEGINS}-01`;

  if (!firstPaidMonth) return joinedAt;
  const paidMonth = `${firstPaidMonth.year}-${String(firstPaidMonth.month).padStart(2, "0")}`;
  // Compared by MONTH, not by day. A payment inside the joining month proves nothing
  // about the days before the joining date — a part-month payment is exactly what a
  // mid-month joiner is owed. Zeeshan joined on 14 August and was paid Rs 15,000 for
  // August; comparing by day pulled his start to the 1st and paid him the whole
  // Rs 28,000 when the 14th onwards is Rs 16,800.
  if (paidMonth >= joinedAt.slice(0, 7)) return joinedAt;
  return `${paidMonth}-01`;
}

/**
 * When someone was on the books, as "YYYY-MM-DD" days, both ends inclusive.
 *
 * `to` is null for anyone still working, and also for anyone disabled before a
 * leaving date was recorded — in both cases there is no known end and the month
 * is not shortened, which leaves every historical figure as it was.
 */
export type EmploymentWindow = { from?: string | null; to?: string | null };

/** The day number of a month, as the "YYYY-MM-DD" string the maps are keyed by. */
function dayStr(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Was this day inside the person's employment? */
function employedOn(ds: string, w?: EmploymentWindow): boolean {
  if (w?.from && ds < w.from) return false;
  if (w?.to && ds > w.to) return false;
  return true;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate(); // month is 1-based → last day
}

/**
 * How many of the month's days the person was actually employed for.
 *
 * Deliberately NOT stopped at today, unlike the attendance count below. A fixed
 * salary has always shown in full from the first of the month rather than
 * accruing daily, and that is not what this change is about: the only thing being
 * answered here is "how much of this month were they on the books".
 */
export function employedDaysInMonth(year: number, month: number, w?: EmploymentWindow): number {
  const total = daysInMonth(year, month);
  if (!w?.from && !w?.to) return total;
  let n = 0;
  for (let d = 1; d <= total; d++) if (employedOn(dayStr(year, month, d), w)) n++;
  return n;
}

/**
 * Attendance for one month, counted the way pay is counted.
 *
 * A day with no record is a normal working day (Sunday is a holiday), and the
 * running month stops at today so nobody is paid for days that have not happened.
 * HALF_DAY is worth half a day. `attByDate` is keyed "YYYY-MM-DD".
 *
 * Days outside `window` are skipped entirely: before someone joined and after they
 * left, an unmarked day is not a working day, and counting it as one is what paid
 * a wage worker who started on the 20th for the whole month.
 */
export function attendanceCounts(
  year: number,
  month: number,
  attByDate: Map<string, string>,
  todayStr: string,
  window?: EmploymentWindow
): { present: number; absent: number; half: number; holiday: number; effectiveDays: number } {
  const totalDays = daysInMonth(year, month);
  let present = 0, absent = 0, half = 0, holiday = 0;

  for (let d = 1; d <= totalDays; d++) {
    const ds = dayStr(year, month, d);
    if (ds > todayStr) continue;
    if (!employedOn(ds, window)) continue;
    const dow = new Date(year, month - 1, d).getDay();
    const status = attByDate.get(ds) ?? (dow === 0 ? "HOLIDAY" : "PRESENT");
    if (status === "PRESENT") present++;
    else if (status === "ABSENT") absent++;
    else if (status === "HALF_DAY") half++;
    else if (status === "HOLIDAY") holiday++;
  }

  return { present, absent, half, holiday, effectiveDays: present + half * 0.5 };
}

/**
 * The part of a fixed monthly salary a part month earns.
 *
 * A whole month pays the salary exactly. A part month pays by the thirtieth,
 * which is how the farm has always worked it out by hand — so joining on the 20th
 * of a 31-day month earns twelve thirtieths, and leaving on the 15th earns
 * fifteen. Dividing by the month's own length instead would pay a February
 * half-month more than a March one for the same fortnight of work.
 *
 * A full month is returned untouched rather than as 31/30 of itself, which is
 * what dividing by thirty would otherwise do to the long months.
 */
export function fixedSalaryForDays(baseSalary: number, employedDays: number, monthDays: number): number {
  if (employedDays >= monthDays) return round2(baseSalary);
  return round2((baseSalary / 30) * Math.max(0, employedDays));
}

/**
 * What a month earns: fixed staff earn their salary, daily staff earn days × wage.
 *
 * `employedDays`/`monthDays` pro-rate a fixed salary for someone who joined or left
 * part way through. Leave them out and a fixed salary is paid in full, which is
 * what every caller did before there was a leaving date to split a month at.
 */
export function grossForMonth(args: {
  wageType: "fixed" | "daily";
  baseSalary: number;
  dailyWage: number;
  effectiveDays: number;
  bonusTotal: number;
  dedTotal: number;
  penTotal: number;
  employedDays?: number;
  monthDays?: number;
}): number {
  const base = args.wageType === "fixed"
    ? (args.employedDays !== undefined && args.monthDays !== undefined
        ? fixedSalaryForDays(args.baseSalary, args.employedDays, args.monthDays)
        : args.baseSalary)
    : args.effectiveDays * args.dailyWage;
  return round2(base + args.bonusTotal - args.dedTotal - args.penTotal);
}

/**
 * Does a month fall inside someone's employment at all?
 *
 * A month entirely before they joined, or entirely after they left, is not theirs
 * — which is why a new starter was appearing on every month the farm has ever run.
 */
export function monthTouchesEmployment(year: number, month: number, w?: EmploymentWindow): boolean {
  const first = dayStr(year, month, 1);
  const last = dayStr(year, month, daysInMonth(year, month));
  if (w?.from && w.from > last) return false;
  if (w?.to && w.to < first) return false;
  return true;
}

/** "2026-9" — the key months are grouped by, matching Bonus/Deduction/SalaryPayment. */
export function monthKey(year: number, month: number): string {
  return `${year}-${month}`;
}

/** Is `key` strictly before the given month? */
export function isBeforeMonth(key: string, year: number, month: number): boolean {
  const [y, m] = key.split("-").map(Number);
  return y < year || (y === year && m < month);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
