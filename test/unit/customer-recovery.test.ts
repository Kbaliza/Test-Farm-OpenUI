import { describe, it, expect } from "vitest";
import { nextNoAnswer, readReason, fmtInactive, isRecoveryStatus, RECOVERY_STATUSES } from "@/lib/customer-recovery";
import { AUTO_DEACTIVATION_REASON, DEACTIVATION_REASONS } from "@/lib/deactivation-reasons";

describe("customer recovery rules", () => {
  it("a no-answer call steps 1st → 2nd → 3rd, and stays at the 3rd", () => {
    expect(nextNoAnswer("Not Contacted")).toEqual({ status: "No Answer - 1st Call", attempt: 1 });
    expect(nextNoAnswer("Interested")).toEqual({ status: "No Answer - 1st Call", attempt: 1 });
    expect(nextNoAnswer("No Answer - 1st Call")).toEqual({ status: "No Answer - 2nd Call", attempt: 2 });
    expect(nextNoAnswer("No Answer - 2nd Call")).toEqual({ status: "No Answer - 3rd Call", attempt: 3 });
    expect(nextNoAnswer("No Answer - 3rd Call")).toEqual({ status: "No Answer - 3rd Call", attempt: 3 });
  });

  it("reads every recorded reason, and the system's own", () => {
    expect(readReason(AUTO_DEACTIVATION_REASON, "auto")).toEqual({ category: "Auto-Lapsed", potential: "high" });
    expect(readReason("Away Temporarily - Return Date Given", "manual").potential).toBe("high");
    expect(readReason("Moving Out of City", "manual")).toEqual({ category: "Likely Lost", potential: "low" });
    expect(readReason("Defaulter", "manual").category).toBe("Payment / Rate Issue");
    expect(readReason(null, "manual")).toEqual({ category: "No Reason Given", potential: "medium" });
    expect(readReason("something typed by hand", "manual")).toEqual({ category: "Other", potential: "medium" });
    expect(readReason("Moving Out of City", "added").category).toBe("Added for follow-up");
    // Every reason a manager can pick lands in a named category, never "Other".
    for (const r of DEACTIVATION_REASONS) expect(readReason(r, "manual").category).not.toBe("Other");
  });

  it("formats how long someone has been gone", () => {
    expect(fmtInactive(null)).toBe("—");
    expect(fmtInactive(12)).toBe("12d");
    expect(fmtInactive(45)).toBe("1mo");
    expect(fmtInactive(400)).toBe("1y 1m");
  });

  it("knows its own statuses", () => {
    for (const s of RECOVERY_STATUSES) expect(isRecoveryStatus(s)).toBe(true);
    expect(isRecoveryStatus("Recovered ")).toBe(false);
  });
});
