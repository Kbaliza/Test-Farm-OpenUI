import { describe, it, expect } from "vitest";
import {
  CHECKLIST_RETENTION_DAYS,
  retentionCutoff,
  isWithinRetention,
  retentionDays,
} from "@/lib/checklist-retention";

describe("how much checklist history is kept", () => {
  it("keeps 60 days, counting today", () => {
    expect(CHECKLIST_RETENTION_DAYS).toBe(60);
    expect(retentionDays("2026-09-01")).toHaveLength(60);
  });

  it("the cutoff is 59 days back, so today plus 59 earlier days survive", () => {
    expect(retentionCutoff("2026-09-01")).toBe("2026-07-04");
  });

  it("keeps the cutoff day itself and drops the one before it", () => {
    expect(isWithinRetention("2026-07-04", "2026-09-01")).toBe(true);
    expect(isWithinRetention("2026-07-03", "2026-09-01")).toBe(false);
  });

  it("keeps today and yesterday", () => {
    expect(isWithinRetention("2026-09-01", "2026-09-01")).toBe(true);
    expect(isWithinRetention("2026-08-31", "2026-09-01")).toBe(true);
  });

  it("crosses a month boundary without drifting", () => {
    // 60 days back from 1 March 2026 (not a leap year) lands in January.
    expect(retentionCutoff("2026-03-01")).toBe("2026-01-01");
  });

  it("crosses a year boundary", () => {
    expect(retentionCutoff("2026-01-15")).toBe("2025-11-17");
  });

  it("handles a leap year correctly", () => {
    // 2028 is a leap year: 29 February exists, so 60 days back from 1 April
    // lands a day later than it would otherwise.
    expect(retentionCutoff("2028-04-01")).toBe("2028-02-02");
  });

  it("lists the window newest first, with no gaps or repeats", () => {
    const days = retentionDays("2026-09-01", 5);
    expect(days).toEqual(["2026-09-01", "2026-08-31", "2026-08-30", "2026-08-29", "2026-08-28"]);
    expect(new Set(days).size).toBe(5);
  });

  it("a shorter window can be asked for without touching the default", () => {
    expect(retentionCutoff("2026-09-01", 1)).toBe("2026-09-01");
    expect(isWithinRetention("2026-08-31", "2026-09-01", 1)).toBe(false);
  });
});
