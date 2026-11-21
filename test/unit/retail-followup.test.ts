import { describe, it, expect } from "vitest";
import {
  FOLLOWUP_DAYS,
  dueDateFor,
  bucketFor,
  daysOverdue,
  ageInDays,
  addDays,
  daysBetween,
} from "@/lib/retail-followup";

describe("dueDateFor", () => {
  it("chases a drop three days later by default", () => {
    expect(FOLLOWUP_DAYS).toBe(3);
    expect(dueDateFor("2026-08-21")).toBe("2026-08-24");
  });

  it("honours a shop that takes a week", () => {
    expect(dueDateFor("2026-08-21", 7)).toBe("2026-08-28");
  });

  it("crosses a month end", () => {
    expect(dueDateFor("2026-08-30")).toBe("2026-09-02");
  });

  it("crosses a year end", () => {
    expect(dueDateFor("2026-12-30")).toBe("2027-01-02");
  });

  it("handles a leap day", () => {
    expect(dueDateFor("2028-02-27")).toBe("2028-03-01");
  });

  it("falls back to the default on a nonsense interval", () => {
    expect(dueDateFor("2026-08-21", NaN)).toBe("2026-08-24");
    expect(dueDateFor("2026-08-21", -5)).toBe("2026-08-24");
  });

  it("allows a same-day chase", () => {
    expect(dueDateFor("2026-08-21", 0)).toBe("2026-08-21");
  });
});

describe("bucketFor — the three tabs", () => {
  const due = dueDateFor("2026-08-21"); // 2026-08-24

  it("is upcoming before the day", () => {
    expect(bucketFor(due, "2026-08-22")).toBe("upcoming");
    expect(bucketFor(due, "2026-08-23")).toBe("upcoming");
  });

  it("is due on the day", () => {
    expect(bucketFor(due, "2026-08-24")).toBe("due");
  });

  it("is overdue after the day", () => {
    expect(bucketFor(due, "2026-08-25")).toBe("overdue");
    expect(bucketFor(due, "2026-09-10")).toBe("overdue");
  });

  it("does not shift at a month boundary", () => {
    expect(bucketFor("2026-09-01", "2026-08-31")).toBe("upcoming");
    expect(bucketFor("2026-09-01", "2026-09-01")).toBe("due");
    expect(bucketFor("2026-09-01", "2026-09-02")).toBe("overdue");
  });
});

describe("daysOverdue and ageInDays", () => {
  it("counts days late, and nothing before the day", () => {
    expect(daysOverdue("2026-08-24", "2026-08-27")).toBe(3);
    expect(daysOverdue("2026-08-24", "2026-08-24")).toBe(0);
    expect(daysOverdue("2026-08-24", "2026-08-20")).toBe(0);
  });

  it("ages a drop from the day it was left", () => {
    expect(ageInDays("2026-08-21", "2026-08-26")).toBe(5);
    expect(ageInDays("2026-08-21", "2026-08-21")).toBe(0);
  });
});

describe("plain calendar arithmetic", () => {
  it("addDays never drifts on a DST-free timezone key", () => {
    expect(addDays("2026-08-21", 1)).toBe("2026-08-22");
    expect(addDays("2026-08-21", 0)).toBe("2026-08-21");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("daysBetween is signed", () => {
    expect(daysBetween("2026-08-21", "2026-08-24")).toBe(3);
    expect(daysBetween("2026-08-24", "2026-08-21")).toBe(-3);
    expect(daysBetween("2026-08-21", "2026-08-21")).toBe(0);
  });
});
