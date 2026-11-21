import { describe, it, expect } from "vitest";
import {
  PENALTY_PER_DAY, COMPLIANCE_THRESHOLD,
  isBelowThreshold, penaltyForDay, complianceRatio, isExcusedStatus, describeDay,
  isScorable, PENALTY_START_DAY,
} from "@/lib/checklist-penalty";

// Rs 300 off the day below 70% of the day's items. The boundary is the whole
// argument, so it is pinned exactly rather than approximately.

describe("the 70% line", () => {
  it("exactly 70% passes — the threshold is 'below', not 'at or below'", () => {
    expect(isBelowThreshold(7, 10)).toBe(false);
    expect(isBelowThreshold(70, 100)).toBe(false);
    // Thirds are where a naive division would go wrong.
    expect(isBelowThreshold(14, 20)).toBe(false);
  });

  it("one item short of the line fails", () => {
    expect(isBelowThreshold(6, 10)).toBe(true);
    expect(isBelowThreshold(69, 100)).toBe(true);
  });

  it("well above and well below behave", () => {
    expect(isBelowThreshold(10, 10)).toBe(false);
    expect(isBelowThreshold(0, 10)).toBe(true);
  });

  it("a day with no items is never penalised", () => {
    // Nothing to fall short of. Fining someone because the office never set a
    // list up would be indefensible.
    expect(isBelowThreshold(0, 0)).toBe(false);
    expect(penaltyForDay(0, 0)).toBe(0);
    expect(complianceRatio(0, 0)).toBe(1);
  });

  it("small lists still work", () => {
    expect(isBelowThreshold(2, 3)).toBe(true);  // 66.7% — under the line
    expect(isBelowThreshold(3, 4)).toBe(false); // 75%
    expect(isBelowThreshold(1, 2)).toBe(true);  // 50%
    expect(isBelowThreshold(1, 1)).toBe(false); // 100%
  });
});

describe("what a day costs", () => {
  it("is the flat amount or nothing", () => {
    expect(penaltyForDay(6, 10)).toBe(PENALTY_PER_DAY);
    expect(penaltyForDay(7, 10)).toBe(0);
    expect(PENALTY_PER_DAY).toBe(300);
    expect(COMPLIANCE_THRESHOLD).toBe(0.7);
  });
});

describe("attendance can excuse a day", () => {
  it("absent, half day and holiday all excuse it", () => {
    expect(isExcusedStatus("ABSENT")).toBe(true);
    expect(isExcusedStatus("HALF_DAY")).toBe(true);
    expect(isExcusedStatus("HOLIDAY")).toBe(true);
  });

  it("present does not, and neither does a missing row", () => {
    // A missing row must NOT excuse: attendance is filled in patchily, and waiting
    // for it would make the whole rule do nothing.
    expect(isExcusedStatus("PRESENT")).toBe(false);
    expect(isExcusedStatus(null)).toBe(false);
    expect(isExcusedStatus(undefined)).toBe(false);
    expect(isExcusedStatus("")).toBe(false);
  });
});

describe("how a day reads", () => {
  it("says the count and the percentage", () => {
    expect(describeDay(6, 10)).toBe("6 of 10 items · 60%");
    expect(describeDay(1, 1)).toBe("1 of 1 item · 100%");
  });
});

describe("the rule does not reach back before it existed", () => {
  it("scores nothing before the start day", () => {
    // The first run would otherwise have fined eleven people for 101 days that
    // happened before anyone told them the rule existed.
    expect(isScorable("2026-09-05")).toBe(false);
    expect(isScorable("2026-08-01")).toBe(false);
  });

  it("scores the start day itself and everything after", () => {
    expect(isScorable(PENALTY_START_DAY)).toBe(true);
    expect(isScorable("2026-09-07")).toBe(true);
    expect(isScorable("2027-01-01")).toBe(true);
  });
});
