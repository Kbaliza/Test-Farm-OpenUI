import { describe, it, expect } from "vitest";
import { hasTooManyDecimals, quantityProblem, stepForUnit, isCountedUnit } from "@/lib/quantity";

describe("quantity rule — decimals capped at 2, eggs whole", () => {
  it("accepts up to two decimal places", () => {
    for (const n of [10, 10.5, 10.6, 10.9, 10.55, 0.01, 123.45]) {
      expect(hasTooManyDecimals(n)).toBe(false);
      expect(quantityProblem("Cow Milk", "LITER", n)).toBeNull();
    }
  });

  it("rejects a third decimal place", () => {
    for (const n of [10.555, 0.001, 99.999]) {
      expect(hasTooManyDecimals(n)).toBe(true);
      expect(quantityProblem("Cow Milk", "LITER", n)).toMatch(/at most 2 decimal places/);
    }
  });

  it("is not fooled by ordinary floating-point noise", () => {
    expect(hasTooManyDecimals(0.1 + 0.2)).toBe(false);   // 0.30000000000000004
    expect(hasTooManyDecimals(1.1 * 3)).toBe(false);      // 3.3000000000000003
    expect(quantityProblem("Cow Milk", "LITER", 0.1 + 0.2)).toBeNull();
  });

  it("still requires whole numbers for counted products", () => {
    expect(isCountedUnit("PIECE")).toBe(true);
    expect(quantityProblem("Desi Eggs", "PIECE", 12)).toBeNull();
    expect(quantityProblem("Desi Eggs", "PIECE", 12.5)).toMatch(/whole pieces/);
    expect(quantityProblem("Desi Eggs", "PIECE", 12.25)).toMatch(/whole pieces/);
  });

  it("rejects negatives", () => {
    expect(quantityProblem("Cow Milk", "LITER", -1)).toMatch(/zero or more/);
  });

  it("steps by unit", () => {
    expect(stepForUnit("PIECE")).toBe("1");
    expect(stepForUnit("LITER")).toBe("0.01");
    expect(stepForUnit("KG")).toBe("0.01");
  });
});
