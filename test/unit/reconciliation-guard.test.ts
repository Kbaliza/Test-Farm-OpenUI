import { describe, it, expect } from "vitest";
import {
  validateDayEdit,
  minProduced,
  lockedUse,
  type DayUsageSnapshot,
} from "@/lib/reconciliation-guard";

const base: DayUsageSnapshot = {
  name: "Cow Milk",
  unit: "LITER",
  producedLinked: 0,
  yoghurtUse: 0,
  skimUse: 0,
  wastage: 0,
  dispatched: 0,
};

describe("reconciliation guard — the admin edit rule", () => {
  it("allows an edit that still covers everything already used", () => {
    const u = { ...base, dispatched: 120 };
    expect(validateDayEdit(u, { produced: 150, calfUse: 0, kitchenUse: 0 })).toBeNull();
    expect(validateDayEdit(u, { produced: 130, calfUse: 0, kitchenUse: 0 })).toBeNull();
    expect(validateDayEdit(u, { produced: 120, calfUse: 0, kitchenUse: 0 })).toBeNull(); // exactly enough
  });

  it("blocks the reported case: dropping production below what was already dispatched", () => {
    const u = { ...base, dispatched: 120 };
    const msg = validateDayEdit(u, { produced: 100, calfUse: 0, kitchenUse: 0 });
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/120L dispatched to packaging/);
    expect(msg).toMatch(/keep production at 120L or more/);
  });

  it("counts calf + kitchen use the admin is typing, not just locked usage", () => {
    const u = { ...base, dispatched: 50 };
    // 50 dispatched + 30 calf + 30 kitchen = 110 > 100
    expect(validateDayEdit(u, { produced: 100, calfUse: 30, kitchenUse: 30 })).toMatch(/110L is already accounted/);
    expect(validateDayEdit(u, { produced: 110, calfUse: 30, kitchenUse: 30 })).toBeNull();
  });

  it("credits production made by a batch against the requirement", () => {
    // 40 made by a mix/yoghurt batch, 100 dispatched → admin only needs to enter 60.
    const u = { ...base, producedLinked: 40, dispatched: 100 };
    expect(minProduced(u)).toBe(60);
    expect(validateDayEdit(u, { produced: 60, calfUse: 0, kitchenUse: 0 })).toBeNull();
    const msg = validateDayEdit(u, { produced: 59, calfUse: 0, kitchenUse: 0 });
    expect(msg).toMatch(/plus 40L made by a batch/);
  });

  it("adds up every locked consumer in the message", () => {
    const u = { ...base, dispatched: 10, skimUse: 20, yoghurtUse: 5, wastage: 5 };
    expect(lockedUse(u)).toBe(40);
    expect(minProduced(u)).toBe(40);
    const msg = validateDayEdit(u, { produced: 0, calfUse: 0, kitchenUse: 0 })!;
    expect(msg).toMatch(/10L dispatched to packaging/);
    expect(msg).toMatch(/20L used by skim milk/);
    expect(msg).toMatch(/5L used by yoghurt/);
    expect(msg).toMatch(/5L wastage/);
  });

  it("rejects negative and non-numeric quantities", () => {
    expect(validateDayEdit(base, { produced: -1, calfUse: 0, kitchenUse: 0 })).toMatch(/zero or more/);
    expect(validateDayEdit(base, { produced: 10, calfUse: -5, kitchenUse: 0 })).toMatch(/zero or more/);
    expect(validateDayEdit(base, { produced: Number.NaN, calfUse: 0, kitchenUse: 0 })).toMatch(/zero or more/);
  });

  it("allows a clean day to be zeroed when nothing has been used", () => {
    expect(minProduced(base)).toBe(0);
    expect(validateDayEdit(base, { produced: 0, calfUse: 0, kitchenUse: 0 })).toBeNull();
  });

  it("tolerates decimal rounding rather than blocking on a floating-point hair", () => {
    const u = { ...base, dispatched: 0.1 + 0.2 }; // 0.30000000000000004
    expect(validateDayEdit(u, { produced: 0.3, calfUse: 0, kitchenUse: 0 })).toBeNull();
  });

  it("labels units correctly for KG products", () => {
    const u = { ...base, name: "Yogurt", unit: "KG", dispatched: 12 };
    expect(validateDayEdit(u, { produced: 5, calfUse: 0, kitchenUse: 0 })).toMatch(/12kg dispatched/);
  });
});
