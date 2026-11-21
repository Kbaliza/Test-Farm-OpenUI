import { describe, it, expect } from "vitest";
import {
  subscriptionQtyForDate,
  isBeforeServiceStart,
  isAreaDeliveringOnDate,
  isShiftDeliveringOnDate,
  alternateQtyForIndex,
  weekdayOfDateStr,
} from "@/lib/schedule";
import { pktNoonToUTC, todayPKTString, dateStrRangePKT, toDateStrPKT } from "@/lib/pkt";

const anchor = (s: string) => new Date(s + "T00:00:00Z");

describe("subscriptionQtyForDate — DAILY", () => {
  const cp = { scheduleType: "DAILY", quantity: 3, alternatePattern: [] as number[], weekdays: [] as number[], anchorDate: null, shiftAreas: [] };

  it("delivers the flat quantity every day when no anchor", () => {
    expect(subscriptionQtyForDate(cp, "2026-08-01")).toBe(3);
    expect(subscriptionQtyForDate(cp, "2026-12-25")).toBe(3);
  });

  it("delivers nothing BEFORE the anchor/start date, quantity on/after", () => {
    const withAnchor = { ...cp, anchorDate: anchor("2026-08-01") };
    expect(subscriptionQtyForDate(withAnchor, "2026-07-31")).toBe(0); // before start
    expect(subscriptionQtyForDate(withAnchor, "2026-08-01")).toBe(3); // start day delivered
    expect(subscriptionQtyForDate(withAnchor, "2026-08-05")).toBe(3);
  });
});

describe("subscriptionQtyForDate — ALTERNATE", () => {
  const cp = { scheduleType: "ALTERNATE", quantity: 0, alternatePattern: [2, 0], weekdays: [] as number[], anchorDate: anchor("2026-08-01"), shiftAreas: [] };

  it("cycles the pattern from the anchor", () => {
    expect(subscriptionQtyForDate(cp, "2026-08-01")).toBe(2); // index 0
    expect(subscriptionQtyForDate(cp, "2026-08-02")).toBe(0); // index 1
    expect(subscriptionQtyForDate(cp, "2026-08-03")).toBe(2); // index 0
    expect(subscriptionQtyForDate(cp, "2026-08-04")).toBe(0);
  });

  it("delivers nothing before the anchor even mid-pattern", () => {
    expect(subscriptionQtyForDate(cp, "2026-07-31")).toBe(0);
    expect(subscriptionQtyForDate(cp, "2026-07-01")).toBe(0);
  });

  it("all-zero pattern delivers nothing", () => {
    expect(subscriptionQtyForDate({ ...cp, alternatePattern: [0, 0] }, "2026-08-01")).toBe(0);
  });
});

describe("subscriptionQtyForDate — ALTERNATE steps once per SHIFT, not per day", () => {
  // Every 2nd day from Mon 14 Sep 2026: Mon 14, Wed 16, Fri 18, Sun 20, Tue 22, Thu 24.
  const every2 = [{ scheduleType: "EVERY_N", scheduleInterval: 2, scheduleAnchor: "2026-09-14", customDates: [] }];
  const alt = (pattern: number[], start: string) => ({
    scheduleType: "ALTERNATE", quantity: 0, alternatePattern: pattern, weekdays: [] as number[],
    anchorDate: anchor(start), shiftAreas: every2,
  });
  const run = (cp: ReturnType<typeof alt>) =>
    ["2026-09-14", "2026-09-16", "2026-09-18", "2026-09-20", "2026-09-22", "2026-09-24"].map((d) => subscriptionQtyForDate(cp, d));

  it("[2, 0] → 2 Monday, nothing Wednesday, 2 Friday", () => {
    expect(run(alt([2, 0], "2026-09-14"))).toEqual([2, 0, 2, 0, 2, 0]);
  });

  it("longer patterns follow the shifts in order", () => {
    expect(run(alt([1, 0, 0, 0], "2026-09-14"))).toEqual([1, 0, 0, 0, 1, 0]);
    expect(run(alt([3, 0, 0, 3], "2026-09-14"))).toEqual([3, 0, 0, 3, 3, 0]);
    expect(run(alt([3, 0, 0, 3, 0], "2026-09-14"))).toEqual([3, 0, 0, 3, 0, 3]);
  });

  it("a start date on an off day makes the next shift the first entry", () => {
    expect(run(alt([2, 0], "2026-09-15"))).toEqual([0, 2, 0, 2, 0, 2]); // 14th is before the start
  });

  it("a shift with no areas runs daily, so it counts every day", () => {
    const cp = { ...alt([2, 0], "2026-09-14"), shiftAreas: [] };
    expect(["2026-09-14", "2026-09-15", "2026-09-16"].map((d) => subscriptionQtyForDate(cp, d))).toEqual([2, 0, 2]);
  });
});

describe("subscriptionQtyForDate — WEEKLY (specific day only)", () => {
  // 2026-08-24 is a Monday; 25 Tue, 26 Wed, 31 Mon.
  const mondays = { scheduleType: "WEEKLY", quantity: 4, alternatePattern: [] as number[], weekdays: [1], anchorDate: null, shiftAreas: [] };

  it("delivers only on the chosen weekday", () => {
    expect(subscriptionQtyForDate(mondays, "2026-08-24")).toBe(4); // Mon
    expect(subscriptionQtyForDate(mondays, "2026-08-25")).toBe(0); // Tue
    expect(subscriptionQtyForDate(mondays, "2026-08-26")).toBe(0); // Wed
    expect(subscriptionQtyForDate(mondays, "2026-08-31")).toBe(4); // next Mon
  });

  it("supports several weekdays", () => {
    const monWedFri = { ...mondays, weekdays: [1, 3, 5] };
    expect(subscriptionQtyForDate(monWedFri, "2026-08-24")).toBe(4); // Mon
    expect(subscriptionQtyForDate(monWedFri, "2026-08-26")).toBe(4); // Wed
    expect(subscriptionQtyForDate(monWedFri, "2026-08-28")).toBe(4); // Fri
    expect(subscriptionQtyForDate(monWedFri, "2026-08-25")).toBe(0); // Tue
  });

  it("no weekday picked delivers nothing (never falls back to daily)", () => {
    expect(subscriptionQtyForDate({ ...mondays, weekdays: [] }, "2026-08-24")).toBe(0);
  });

  it("respects the service start date", () => {
    const started = { ...mondays, anchorDate: anchor("2026-08-25") };
    expect(subscriptionQtyForDate(started, "2026-08-24")).toBe(0); // Mon before start
    expect(subscriptionQtyForDate(started, "2026-08-31")).toBe(4); // Mon after start
  });

  it("only lands on shift days: an every-2nd-day shift serves a weekday fortnightly", () => {
    // Area delivers every 2nd day from Fri 14 Aug → Mondays 24 Aug and 7 Sep, not 31 Aug.
    const area = { scheduleType: "EVERY_N", scheduleInterval: 2, scheduleAnchor: "2026-08-14", customDates: [] };
    const monday = (d: string) => isAreaDeliveringOnDate(area, d) && subscriptionQtyForDate(mondays, d) > 0;
    expect(monday("2026-08-24")).toBe(true);
    expect(monday("2026-08-31")).toBe(false); // shift does not run that Monday
    expect(monday("2026-09-07")).toBe(true);
  });
});

describe("isBeforeServiceStart", () => {
  it("null start → never before", () => {
    expect(isBeforeServiceStart("2020-01-01", null)).toBe(false);
  });
  it("strictly before the anchor day", () => {
    expect(isBeforeServiceStart("2026-07-31", anchor("2026-08-01"))).toBe(true);
    expect(isBeforeServiceStart("2026-08-01", anchor("2026-08-01"))).toBe(false); // same day is NOT before
    expect(isBeforeServiceStart("2026-08-02", anchor("2026-08-01"))).toBe(false);
  });
});

describe("alternateQtyForIndex", () => {
  it("wraps positively for days before the anchor", () => {
    expect(alternateQtyForIndex([5, 9], 0, 0)).toBe(5);
    expect(alternateQtyForIndex([5, 9], 1, 0)).toBe(9);
    expect(alternateQtyForIndex([5, 9], -1, 0)).toBe(9); // (-1 mod 2 + 2) % 2 = 1
    expect(alternateQtyForIndex([], 3, 0)).toBe(0);
  });
});

describe("isAreaDeliveringOnDate", () => {
  it("DAILY delivers every day", () => {
    expect(isAreaDeliveringOnDate({ scheduleType: "DAILY", scheduleInterval: 1, scheduleAnchor: null, customDates: [] }, "2026-08-01")).toBe(true);
  });
  it("EVERY_N (2) delivers on the cycle from the anchor", () => {
    const a = { scheduleType: "EVERY_N", scheduleInterval: 2, scheduleAnchor: "2026-08-01", customDates: [] };
    expect(isAreaDeliveringOnDate(a, "2026-08-01")).toBe(true);
    expect(isAreaDeliveringOnDate(a, "2026-08-02")).toBe(false);
    expect(isAreaDeliveringOnDate(a, "2026-08-03")).toBe(true);
  });
  it("CUSTOM only on listed dates", () => {
    const a = { scheduleType: "CUSTOM", scheduleInterval: 1, scheduleAnchor: null, customDates: ["2026-08-04", "2026-08-09"] };
    expect(isAreaDeliveringOnDate(a, "2026-08-04")).toBe(true);
    expect(isAreaDeliveringOnDate(a, "2026-08-05")).toBe(false);
  });
});

describe("isShiftDeliveringOnDate", () => {
  it("no areas → delivers every day (fail open)", () => {
    expect(isShiftDeliveringOnDate([], "2026-08-01")).toBe(true);
  });
  it("delivers if ANY area does", () => {
    const daily = { scheduleType: "DAILY", scheduleInterval: 1, scheduleAnchor: null, customDates: [] };
    const never = { scheduleType: "CUSTOM", scheduleInterval: 1, scheduleAnchor: null, customDates: [] };
    expect(isShiftDeliveringOnDate([never, daily], "2026-08-01")).toBe(true);
    expect(isShiftDeliveringOnDate([never, never], "2026-08-01")).toBe(false);
  });
});

describe("PKT date helpers", () => {
  it("pktNoonToUTC is a fixed instant regardless of server TZ", () => {
    // PKT noon = 07:00 UTC (PKT = UTC+5)
    expect(pktNoonToUTC("2026-08-01").toISOString()).toBe("2026-08-01T07:00:00.000Z");
  });
  it("todayPKTString is YYYY-MM-DD", () => {
    expect(todayPKTString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("dateStrRangePKT spans one PKT day (gte..lte)", () => {
    const r = dateStrRangePKT("2026-08-01");
    expect(r.gte.toISOString()).toBe("2026-07-31T19:00:00.000Z"); // PKT midnight = 19:00 UTC prev day
    expect(r.lte.getTime()).toBe(r.gte.getTime() + 86_400_000 - 1);
  });
  it("toDateStrPKT round-trips a PKT-noon instant", () => {
    expect(toDateStrPKT(pktNoonToUTC("2026-08-01"))).toBe("2026-08-01");
  });
  it("weekdayOfDateStr has no UTC-boundary drift", () => {
    // 2026-08-01 is a Saturday
    expect(weekdayOfDateStr("2026-08-01")).toBe(6);
  });
});
