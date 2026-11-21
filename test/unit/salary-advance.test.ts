import { describe, it, expect } from "vitest";
import {
  applyCarry,
  attendanceCounts,
  employedDaysInMonth,
  fixedSalaryForDays,
  monthTouchesEmployment,
  payrollStart,
  balanceBroughtForward,
  fromFirstWorkedMonth,
  grossForMonth,
  isBeforeMonth,
  monthKey,
  type WorkedMonth,
} from "@/lib/salary-advance";

describe("the balance brought into a month", () => {
  it("is nothing when every month was paid exactly", () => {
    expect(balanceBroughtForward([{ gross: 30000, paid: 30000 }, { gross: 30000, paid: 30000 }])).toBe(0);
  });

  it("carries OWED forward when a month was underpaid", () => {
    expect(balanceBroughtForward([{ gross: 30000, paid: 10000 }])).toBe(20000);
  });

  it("carries EXTRA forward (negative) when a month was overpaid", () => {
    expect(balanceBroughtForward([{ gross: 30000, paid: 35000 }])).toBe(-5000);
  });

  it("lets an overpayment settle an earlier shortfall first", () => {
    // Owed 5,000 in August, overpaid 8,000 in September → 3,000 extra.
    expect(balanceBroughtForward([{ gross: 30000, paid: 25000 }, { gross: 30000, paid: 38000 }])).toBe(-3000);
  });

  it("adds up shortfalls across months", () => {
    expect(balanceBroughtForward([{ gross: 30000, paid: 25000 }, { gross: 30000, paid: 28000 }])).toBe(7000);
  });

  it("is nothing when there are no earlier months", () => {
    expect(balanceBroughtForward([])).toBe(0);
  });
});

describe("R2 — a negative month counts as zero, not as money", () => {
  it("penalties bigger than the pay carry nothing either way", () => {
    expect(balanceBroughtForward([{ gross: -1800, paid: 0 }])).toBe(0);
  });

  it("does not cancel a real balance from another month", () => {
    expect(balanceBroughtForward([{ gross: -1800, paid: 0 }, { gross: 30000, paid: 35000 }])).toBe(-5000);
    expect(balanceBroughtForward([{ gross: -1800, paid: 0 }, { gross: 30000, paid: 25000 }])).toBe(5000);
  });

  it("money actually paid into a negative month still counts as extra", () => {
    expect(balanceBroughtForward([{ gross: -1800, paid: 500 }])).toBe(-500);
  });
});

describe("R3 — the carry starts at the first month anyone worked or was paid", () => {
  const month = (key: string, gross: number, paid: number, worked: boolean): WorkedMonth => ({ key, gross, paid, worked });

  it("drops a month holding nothing but a bonus", () => {
    // August has only a bonus row — no attendance, no payment. September is real.
    const kept = fromFirstWorkedMonth([month("2026-8", 42332, 0, false), month("2026-9", 30000, 30000, true)]);
    expect(kept.map((m) => m.key)).toEqual(["2026-9"]);
    expect(balanceBroughtForward(kept)).toBe(0);
  });

  it("keeps every month from the first worked one, even a quiet one after it", () => {
    const kept = fromFirstWorkedMonth([
      month("2026-7", 30000, 0, false),
      month("2026-8", 30000, 10000, true),
      month("2026-9", 30000, 0, false),
    ]);
    expect(kept.map((m) => m.key)).toEqual(["2026-8", "2026-9"]);
  });

  it("is empty when nobody ever worked or was paid", () => {
    expect(fromFirstWorkedMonth([month("2026-8", 30000, 0, false)])).toEqual([]);
  });
});

describe("applying the carry to this month", () => {
  it("adds owed from earlier to this month", () => {
    const r = applyCarry(30000, 0, 20000);
    expect(r.owedIn).toBe(20000);
    expect(r.balance).toBe(50000);
    expect(r.extraLeft).toBe(0);
  });

  it("takes extra from earlier off this month", () => {
    const r = applyCarry(30000, 0, -5000);
    expect(r.extraIn).toBe(5000);
    expect(r.balance).toBe(25000);
    expect(r.extraLeft).toBe(0);
  });

  it("R1 — never shows a negative balance; the leftover extra keeps going", () => {
    const r = applyCarry(3000, 0, -5000);
    expect(r.balance).toBe(0);
    expect(r.extraLeft).toBe(2000);
  });

  it("paying off carried owed clears it", () => {
    const r = applyCarry(30000, 50000, 20000);
    expect(r.balance).toBe(0);
    expect(r.extraLeft).toBe(0);
  });

  it("banks a fresh extra when this month is overpaid", () => {
    const r = applyCarry(30000, 34000, 0);
    expect(r.balance).toBe(0);
    expect(r.extraLeft).toBe(4000);
    expect(r.extraPaidThisMonth).toBe(4000);
  });

  it("an ordinary part payment is owed, not extra", () => {
    const r = applyCarry(30000, 12000, 0);
    expect(r.balance).toBe(18000);
    expect(r.extraLeft).toBe(0);
  });

  it("R2 — a negative month with nothing paid owes nothing and is not extra", () => {
    const r = applyCarry(-1800, 0, 0);
    expect(r.balance).toBe(0);
    expect(r.extraLeft).toBe(0);
    expect(r.extraPaidThisMonth).toBe(0);
  });

  it("chaining month by month gives the same answer as summing", () => {
    const months = [{ gross: 30000, paid: 10000 }, { gross: 30000, paid: 45000 }, { gross: 30000, paid: 31000 }];
    let carry = 0;
    for (const m of months) {
      const r = applyCarry(m.gross, m.paid, carry);
      carry = r.balance - r.extraLeft;
    }
    expect(carry).toBe(balanceBroughtForward(months));
  });
});

describe("counting the days a month pays for", () => {
  const EMPTY = new Map<string, string>();

  it("treats an unrecorded weekday as worked and Sunday as a holiday", () => {
    // September 2026: 30 days, Sundays on 6, 13, 20, 27.
    const c = attendanceCounts(2026, 9, EMPTY, "2026-12-31");
    expect(c.present).toBe(26);
    expect(c.holiday).toBe(4);
    expect(c.effectiveDays).toBe(26);
  });

  it("stops at today for the running month", () => {
    const c = attendanceCounts(2026, 9, EMPTY, "2026-09-10");
    expect(c.present + c.holiday).toBe(10);
  });

  it("counts a half day as half, and an absence as none", () => {
    const att = new Map<string, string>([["2026-09-01", "HALF_DAY"], ["2026-09-02", "ABSENT"]]);
    const c = attendanceCounts(2026, 9, att, "2026-09-03");
    expect(c.half).toBe(1);
    expect(c.absent).toBe(1);
    expect(c.present).toBe(1);
    expect(c.effectiveDays).toBe(1.5);
  });
});

describe("what a month earns", () => {
  it("pays fixed staff their salary regardless of days", () => {
    expect(grossForMonth({ wageType: "fixed", baseSalary: 30000, dailyWage: 0, effectiveDays: 3, bonusTotal: 0, dedTotal: 0, penTotal: 0 })).toBe(30000);
  });

  it("pays daily staff for the days they worked", () => {
    expect(grossForMonth({ wageType: "daily", baseSalary: 0, dailyWage: 1000, effectiveDays: 25.5, bonusTotal: 0, dedTotal: 0, penTotal: 0 })).toBe(25500);
  });

  it("adds bonuses and takes off deductions and checklist penalties", () => {
    expect(grossForMonth({ wageType: "fixed", baseSalary: 30000, dailyWage: 0, effectiveDays: 0, bonusTotal: 2000, dedTotal: 500, penTotal: 300 })).toBe(31200);
  });
});

// A new starter used to appear on every month the farm had ever run, with a whole
// salary against each. Somebody disabled mid-month either vanished from that month
// or was paid for all of it. Both come down to the same missing idea: the part of
// the month a person was actually on the books.
describe("the part of a month somebody was employed for", () => {
  const EMPTY = new Map<string, string>();
  const FUTURE = "2026-12-31";

  it("is the whole month when they were here all of it", () => {
    expect(employedDaysInMonth(2026, 9, { from: "2026-08-01", to: null })).toBe(30);
    expect(employedDaysInMonth(2026, 9, {})).toBe(30);
  });

  it("counts from the day they joined, both ends included", () => {
    // Joined 20 September: 20th to 30th is 11 days.
    expect(employedDaysInMonth(2026, 9, { from: "2026-09-20", to: null })).toBe(11);
  });

  it("counts up to the day they left", () => {
    // Left on the 15th: the 15th is still a day worked.
    expect(employedDaysInMonth(2026, 9, { from: "2026-08-01", to: "2026-09-15" })).toBe(15);
  });

  it("is none at all for a month before they joined, or after they left", () => {
    expect(employedDaysInMonth(2026, 8, { from: "2026-09-20", to: null })).toBe(0);
    expect(employedDaysInMonth(2026, 10, { from: "2026-08-01", to: "2026-09-15" })).toBe(0);
  });

  it("decides whether a month belongs to them at all", () => {
    expect(monthTouchesEmployment(2026, 8, { from: "2026-09-20" })).toBe(false); // not yet joined
    expect(monthTouchesEmployment(2026, 9, { from: "2026-09-20" })).toBe(true);  // joined part way
    expect(monthTouchesEmployment(2026, 10, { from: "2026-08-01", to: "2026-09-15" })).toBe(false); // gone
    expect(monthTouchesEmployment(2026, 9, { from: "2026-08-01", to: "2026-09-15" })).toBe(true);   // left part way
    expect(monthTouchesEmployment(2026, 9, {})).toBe(true); // no dates known
  });

  it("does not count the days before someone joined as worked", () => {
    // Joined 20 September. Sundays fall on 20 and 27, so of 20-30: 9 weekdays.
    const c = attendanceCounts(2026, 9, EMPTY, FUTURE, { from: "2026-09-20", to: null });
    expect(c.present).toBe(9);
    expect(c.holiday).toBe(2);
    expect(c.effectiveDays).toBe(9);
  });

  it("does not count the days after someone left as worked", () => {
    // Left 15 September. Sundays on 6 and 13, so of 1-15: 13 weekdays.
    const c = attendanceCounts(2026, 9, EMPTY, FUTURE, { from: null, to: "2026-09-15" });
    expect(c.present).toBe(13);
    expect(c.effectiveDays).toBe(13);
  });

  it("still stops at today as well as at the window", () => {
    const c = attendanceCounts(2026, 9, EMPTY, "2026-09-10", { from: "2026-09-05", to: null });
    // The 5th to the 10th is six days, of which the 6th is a Sunday.
    expect(c.present + c.holiday).toBe(6);
  });
});

describe("a fixed salary for part of a month", () => {
  it("pays the whole salary for a whole month, not thirty-one thirtieths", () => {
    expect(fixedSalaryForDays(30000, 31, 31)).toBe(30000);
    expect(fixedSalaryForDays(30000, 28, 28)).toBe(30000);
  });

  it("pays by the thirtieth for part of a month", () => {
    // Left on the 15th of a 30-day month: half.
    expect(fixedSalaryForDays(30000, 15, 30)).toBe(15000);
    // Joined on the 20th of a 30-day month: 11 days.
    expect(fixedSalaryForDays(30000, 11, 30)).toBe(11000);
  });

  it("values a fortnight the same in a short month as a long one", () => {
    // Fifteen days is fifteen thirtieths whether the month has 28 or 31.
    expect(fixedSalaryForDays(30000, 15, 28)).toBe(15000);
    expect(fixedSalaryForDays(30000, 15, 31)).toBe(15000);
  });

  it("pays nothing for a month they were not here for", () => {
    expect(fixedSalaryForDays(30000, 0, 30)).toBe(0);
  });

  it("flows through the month's gross, bonuses and deductions included", () => {
    // Joined on the 20th of September: 11 days of a 30,000 salary, plus a 2,000 bonus.
    expect(grossForMonth({
      wageType: "fixed", baseSalary: 30000, dailyWage: 0, effectiveDays: 9,
      bonusTotal: 2000, dedTotal: 0, penTotal: 0,
      employedDays: 11, monthDays: 30,
    })).toBe(13000);
  });

  it("is paid in full when no window is given, as every caller used to", () => {
    expect(grossForMonth({
      wageType: "fixed", baseSalary: 30000, dailyWage: 0, effectiveDays: 3,
      bonusTotal: 0, dedTotal: 0, penTotal: 0,
    })).toBe(30000);
  });
});

// The joining dates on file are not all real: many are the day the record was typed
// in. A salary actually paid for an earlier month settles it — that month was worked,
// whatever the date says. Attendance does not, because it is marked a month at a time
// regardless of who started when.
describe("the day pay starts from", () => {
  it("is the joining date when no salary was ever paid", () => {
    expect(payrollStart("2026-09-29", null)).toBe("2026-09-29");
  });

  it("moves back to cover a month a salary was paid for", () => {
    // Hanif: typed in on 10 September, paid a full August salary.
    expect(payrollStart("2026-09-10", { year: 2026, month: 8 })).toBe("2026-08-01");
  });

  it("keeps the joining date when the payment is for that same month", () => {
    // A part-month payment says nothing about the days before the joining date.
    expect(payrollStart("2026-09-14", { year: 2026, month: 9 })).toBe("2026-09-14");
  });

  it("treats a date in the software's first month as predating the software", () => {
    // Six people were paid a full August salary against a mid-August date. The farm
    // ran before the software did; those dates are when the records were typed in.
    expect(payrollStart("2026-08-20", { year: 2026, month: 8 })).toBe("2026-08-01");
    expect(payrollStart("2026-08-14", null)).toBe("2026-08-01");
    expect(payrollStart("2026-08-01", null)).toBe("2026-08-01");
    // And anything genuinely earlier, if such a record ever appears.
    expect(payrollStart("2026-07-03", null)).toBe("2026-08-01");
  });

  it("but a date after that first month is taken at its word", () => {
    expect(payrollStart("2026-09-29", null)).toBe("2026-09-29");
  });

  it("keeps the joining date when every payment is later", () => {
    expect(payrollStart("2026-09-22", { year: 2026, month: 10 })).toBe("2026-09-22");
  });

  it("crosses a year end correctly", () => {
    expect(payrollStart("2027-01-10", { year: 2026, month: 12 })).toBe("2026-12-01");
  });
});

describe("month keys", () => {
  it("orders months across a year boundary", () => {
    expect(monthKey(2026, 9)).toBe("2026-9");
    expect(isBeforeMonth("2025-12", 2026, 1)).toBe(true);
    expect(isBeforeMonth("2026-1", 2026, 1)).toBe(false);
    expect(isBeforeMonth("2026-2", 2026, 1)).toBe(false);
    expect(isBeforeMonth("2026-8", 2026, 9)).toBe(true);
  });
});
