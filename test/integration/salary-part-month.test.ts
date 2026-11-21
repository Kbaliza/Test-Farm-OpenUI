import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { uniq } from "../helpers";
import { getSalariesPageData } from "@/app/(dashboard)/payments/salaries/actions";
import { setStaffActive } from "@/app/(dashboard)/staff/actions";
import {
  attendanceCounts,
  daysInMonth,
  employedDaysInMonth,
  fixedSalaryForDays,
} from "@/lib/salary-advance";
import { pktNoonToUTC, todayPKTString } from "@/lib/pkt";

const TODAY = todayPKTString();
const [Y, M] = TODAY.split("-").map(Number);
const DAYS = daysInMonth(Y, M);
const PREV = M === 1 ? { y: Y - 1, m: 12 } : { y: Y, m: M - 1 };
const NEXT = M === 12 ? { y: Y + 1, m: 1 } : { y: Y, m: M + 1 };

const d = (day: number) => pktNoonToUTC(`${Y}-${String(M).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
const dNext = (day: number) =>
  pktNoonToUTC(`${NEXT.y}-${String(NEXT.m).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
const str = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

async function staff(opts: { base?: number; daily?: number | null; joinedAt: Date; leftAt?: Date | null; active?: boolean }) {
  const e = await db.employee.create({
    data: {
      name: uniq("emp"),
      role: "Helper",
      baseSalary: opts.base ?? 0,
      dailyWage: opts.daily ?? null,
      active: opts.active ?? true,
      joinedAt: opts.joinedAt,
      leftAt: opts.leftAt ?? null,
    },
  });
  cleanups.push(async () => {
    await db.attendance.deleteMany({ where: { employeeId: e.id } });
    await db.salaryPayment.deleteMany({ where: { employeeId: e.id } });
    await db.employee.delete({ where: { id: e.id } }).catch(() => {});
  });
  return e;
}

async function row(employeeId: string, year: number, month: number) {
  const data = await getSalariesPageData(month, year);
  return data.employees.find((x) => x.id === employeeId) ?? null;
}

/** What the page itself works out from the row it is handed. */
function payFor(r: { payrollFrom: string; leftAt: string | null; baseSalary: number }, year: number, month: number) {
  const w = { from: r.payrollFrom, to: r.leftAt };
  const employed = employedDaysInMonth(year, month, w);
  return { employed, pay: fixedSalaryForDays(r.baseSalary, employed, daysInMonth(year, month)) };
}

describe("a staff member who joined part way through the month", () => {
  it("is not listed at all in a month before they joined", async () => {
    const e = await staff({ base: 30000, joinedAt: dNext(20) });
    expect(await row(e.id, Y, M)).toBeNull();
    expect(await row(e.id, NEXT.y, NEXT.m)).not.toBeNull();
  }, 180_000);

  it("carries the joining date and the payroll start out to the page", async () => {
    const e = await staff({ base: 30000, joinedAt: d(20) });
    const r = (await row(e.id, Y, M))!;
    expect(r.joinedAt).toBe(str(Y, M, 20));
    expect(r.payrollFrom).toBe(str(Y, M, 20));
    expect(r.leftAt).toBeNull();
  }, 180_000);

  it("a fixed salary is paid for the part of the month worked", async () => {
    const e = await staff({ base: 30000, joinedAt: d(20) });
    const { employed, pay } = payFor((await row(e.id, Y, M))!, Y, M);
    expect(employed).toBe(DAYS - 19); // the 20th onwards
    expect(pay).toBe(Math.round((30000 / 30) * (DAYS - 19) * 100) / 100);
    expect(pay).toBeLessThan(30000);
  }, 180_000);

  it("a wage worker is not paid for the days before they joined", async () => {
    const e = await staff({ daily: 1000, joinedAt: d(20) });
    const r = (await row(e.id, Y, M))!;
    const w = { from: r.payrollFrom, to: r.leftAt };
    const all = attendanceCounts(Y, M, new Map(), `${Y}-12-31`).effectiveDays;
    const mine = attendanceCounts(Y, M, new Map(), `${Y}-12-31`, w).effectiveDays;
    expect(mine).toBeLessThan(all);
    expect(mine).toBeLessThanOrEqual(DAYS - 19);
  }, 180_000);
});

describe("a staff member disabled part way through the month", () => {
  it("stays in that month rather than vanishing from it", async () => {
    const e = await staff({ base: 30000, joinedAt: d(1), leftAt: d(15), active: false });
    const r = await row(e.id, Y, M);
    expect(r).not.toBeNull();
    expect(r!.active).toBe(false);
    expect(r!.leftAt).toBe(str(Y, M, 15));
  }, 180_000);

  it("is paid for the days up to and including the day they left", async () => {
    const e = await staff({ base: 30000, joinedAt: d(1), leftAt: d(15), active: false });
    const { employed, pay } = payFor((await row(e.id, Y, M))!, Y, M);
    expect(employed).toBe(15);
    expect(pay).toBe(15000); // half of 30,000, by the thirtieth
  }, 180_000);

  it("drops out of the months after they left", async () => {
    const e = await staff({ base: 30000, joinedAt: d(1), leftAt: d(15), active: false });
    expect(await row(e.id, NEXT.y, NEXT.m)).toBeNull();
  }, 180_000);

  it("is still listed in a later month if there is a payment recorded there", async () => {
    // A record always wins: money handed over must never be hidden by a date.
    const e = await staff({ base: 30000, joinedAt: d(1), leftAt: d(15), active: false });
    await db.salaryPayment.create({
      data: { employeeId: e.id, amount: 5000, month: NEXT.m, year: NEXT.y, head: "CASH" },
    });
    expect(await row(e.id, NEXT.y, NEXT.m)).not.toBeNull();
  }, 180_000);
});

describe("disabling someone records the day they left", () => {
  it("stamps today, and clears it again when they are taken back on", async () => {
    const e = await staff({ base: 30000, joinedAt: d(1) });

    expect((await setStaffActive(e.id, false)).ok).toBe(true);
    const off = await db.employee.findUniqueOrThrow({ where: { id: e.id }, select: { active: true, leftAt: true } });
    expect(off.active).toBe(false);
    // Stored at PKT noon, so the day cannot slip either side of midnight.
    expect(off.leftAt?.toISOString().split("T")[0]).toBe(TODAY);

    expect((await setStaffActive(e.id, true)).ok).toBe(true);
    const on = await db.employee.findUniqueOrThrow({ where: { id: e.id }, select: { active: true, leftAt: true } });
    expect(on.active).toBe(true);
    expect(on.leftAt).toBeNull();
  }, 180_000);
});

// The joining dates on file are not all real — many are the day the record was typed
// in, and nineteen people were paid a full August salary against a September date. A
// payment is proof the month was worked; a date typed in later is not.
describe("a month a salary was actually paid for belongs to them", () => {
  it("pays it in full even though the joining date is later", async () => {
    const e = await staff({ base: 30000, joinedAt: d(20) });
    await db.salaryPayment.create({
      data: { employeeId: e.id, amount: 30000, month: PREV.m, year: PREV.y, head: "CASH" },
    });

    const r = (await row(e.id, PREV.y, PREV.m))!;
    expect(r).not.toBeNull();
    // Pay starts from the first of the month paid for, not the joining date.
    expect(r.payrollFrom).toBe(str(PREV.y, PREV.m, 1));
    const { employed, pay } = payFor(r, PREV.y, PREV.m);
    expect(employed).toBe(daysInMonth(PREV.y, PREV.m));
    expect(pay).toBe(30000);
  }, 180_000);

  it("but the joining date still stands inside that month", async () => {
    // Paid for this month AND joined on the 20th of it: the first nineteen days are
    // still not theirs. A payment only reaches back to months before the date.
    const e = await staff({ base: 30000, joinedAt: d(20) });
    await db.salaryPayment.create({
      data: { employeeId: e.id, amount: 10000, month: M, year: Y, head: "CASH" },
    });
    const r = (await row(e.id, Y, M))!;
    expect(r.payrollFrom).toBe(str(Y, M, 20));
    expect(payFor(r, Y, M).employed).toBe(DAYS - 19);
  }, 180_000);

  it("leaves someone never paid on their joining date, so no earlier month is owed", async () => {
    // Usman Ali and Zeeshan Khattak: joined late, never paid, and were being credited
    // a whole earlier month that then carried forward as money owed.
    const e = await staff({ base: 42000, joinedAt: d(29) });
    expect(await row(e.id, PREV.y, PREV.m)).toBeNull();
    const r = (await row(e.id, Y, M))!;
    expect(r.payrollFrom).toBe(str(Y, M, 29));
    expect(r.carryIn).toBe(0);
  }, 180_000);
});
