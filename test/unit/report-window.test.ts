import { describe, it, expect } from "vitest";
import {
  resolveWindow, trendBuckets, billingHalves, mondayIndex, daysInMonth, isValidDateStr,
} from "@/lib/report-window";

// PKT midnight = UTC − 5h, so a PKT day starts at 19:00 UTC the previous day.
const iso = (d: Date) => d.toISOString();

describe("report windows — PKT day boundaries", () => {
  it("a day window covers exactly that PKT day", () => {
    const w = resolveWindow("day", "2026-08-17");
    expect(iso(w.start)).toBe("2026-08-16T19:00:00.000Z");
    expect(iso(w.end)).toBe("2026-08-17T18:59:59.999Z");
    expect(w.label).toBe("17 Aug 2026");
  });

  it("a week runs Monday to Sunday around the chosen day", () => {
    // 2026-08-17 is a Monday.
    expect(mondayIndex("2026-08-17")).toBe(0);
    const w = resolveWindow("week", "2026-08-19"); // Wednesday
    expect(w.startStr).toBe("2026-08-17");
    expect(w.endStr).toBe("2026-08-23");
    expect(iso(w.start)).toBe("2026-08-16T19:00:00.000Z");
    expect(iso(w.end)).toBe("2026-08-23T18:59:59.999Z");
  });

  it("a week spanning two months is labelled across both", () => {
    const w = resolveWindow("week", "2026-09-02");
    expect(w.startStr).toBe("2026-08-31");
    expect(w.endStr).toBe("2026-09-06");
    expect(w.label).toMatch(/Aug.*Sep/);
  });

  it("a month window covers the 1st to the last day", () => {
    const w = resolveWindow("month", "2026-08-17");
    expect(w.startStr).toBe("2026-08-01");
    expect(w.endStr).toBe("2026-08-31");
    expect(w.label).toBe("August 2026");
  });

  it("handles February and leap years", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(resolveWindow("month", "2028-02-10").endStr).toBe("2028-02-29");
  });

  it("windows never overlap or leave a gap between consecutive days", () => {
    const a = resolveWindow("day", "2026-08-17");
    const b = resolveWindow("day", "2026-08-18");
    expect(b.start.getTime() - a.end.getTime()).toBe(1);
  });
});

describe("billing halves", () => {
  it("splits the month at the 15th/16th and ends on the real last day", () => {
    const [h1, h2] = billingHalves("2026-08-17");
    expect(h1.half).toBe(1);
    expect(h1.window.startStr).toBe("2026-08-01");
    expect(h1.window.endStr).toBe("2026-08-15");
    expect(h2.half).toBe(2);
    expect(h2.window.startStr).toBe("2026-08-16");
    expect(h2.window.endStr).toBe("2026-08-31");
    expect(h2.label).toMatch(/16th – 31th Aug/);
  });

  it("uses the month of the anchor date, and a short month ends correctly", () => {
    const [, h2] = billingHalves("2026-02-03");
    expect(h2.window.endStr).toBe("2026-02-28");
    expect(h2.year).toBe(2026);
    expect(h2.month).toBe(2);
  });

  it("the two halves together cover the whole month with no gap", () => {
    const [h1, h2] = billingHalves("2026-08-17");
    expect(h2.window.start.getTime() - h1.window.end.getTime()).toBe(1);
  });
});

describe("trend buckets", () => {
  it("day → 7 buckets ending on the selected day", () => {
    const b = trendBuckets("day", "2026-08-17");
    expect(b).toHaveLength(7);
    expect(b[0].key).toBe("2026-08-11");
    expect(b[6].key).toBe("2026-08-17");
  });

  it("week → 8 buckets ending with the selected week", () => {
    const b = trendBuckets("week", "2026-08-19");
    expect(b).toHaveLength(8);
    expect(b[7].key).toBe("2026-08-17"); // Monday of the selected week
  });

  it("month → 12 buckets ending with the selected month, crossing the year", () => {
    const b = trendBuckets("month", "2026-08-17");
    expect(b).toHaveLength(12);
    expect(b[11].key).toBe("2026-08");
    expect(b[0].key).toBe("2025-09");
  });

  it("buckets are contiguous and ordered oldest → newest", () => {
    for (const p of ["day", "week", "month"] as const) {
      const b = trendBuckets(p, "2026-08-17");
      for (let i = 1; i < b.length; i++) {
        expect(b[i].start.getTime()).toBeGreaterThan(b[i - 1].start.getTime());
        expect(b[i].start.getTime() - b[i - 1].end.getTime()).toBe(1);
      }
    }
  });
});

describe("date validation", () => {
  it("accepts only YYYY-MM-DD", () => {
    expect(isValidDateStr("2026-08-17")).toBe(true);
    expect(isValidDateStr("17-08-2026")).toBe(false);
    expect(isValidDateStr("2026-8-1")).toBe(false);
    expect(isValidDateStr("")).toBe(false);
    expect(isValidDateStr("2026-13-45")).toBe(false);
  });
});
