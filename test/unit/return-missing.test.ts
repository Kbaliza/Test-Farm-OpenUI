import { describe, it, expect } from "vitest";
import { validateReturnLine, returnTotals, missingOf, type ReturnLineSpec } from "@/lib/rider-return-math";

// On an app return, whatever the reviewer does not put into stock or wastage is
// missing — worked out, never typed, and never a reason to refuse the split.
const app: ReturnLineSpec = { key: "p1", source: "APP", productId: "p1", productName: "Cow Milk", unit: "LITER", returnedQty: 15 };
const retail: ReturnLineSpec = { key: "p1", source: "RETAIL", productId: "p1", productName: "Cow Milk", unit: "LITER", returnedQty: 15 };

describe("missing on a return review", () => {
  it("a short split is accepted, and the rest is missing", () => {
    const e = { key: "p1", stockQty: 10, wasteQty: 4, wasteReason: "Sour / spoiled" };
    expect(validateReturnLine(app, e)).toBeNull();
    expect(missingOf(app, e)).toBe(1);
    expect(returnTotals([app], [e])).toEqual({ returned: 15, stock: 10, waste: 4, missing: 1 });
  });
  it("more than was reported is still refused", () => {
    expect(validateReturnLine(app, { key: "p1", stockQty: 14, wasteQty: 2 })).toMatch(/only 15 was reported/);
  });
  it("Retail's leftover still has to be accounted for exactly", () => {
    expect(validateReturnLine(retail, { key: "p1", stockQty: 10, wasteQty: 4 })).toMatch(/must add up to 15/);
    expect(missingOf(retail, { key: "p1", stockQty: 10, wasteQty: 4 })).toBe(0);
  });
});
