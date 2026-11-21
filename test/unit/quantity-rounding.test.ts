import { describe, it, expect } from "vitest";
import { roundQty, qtyText } from "@/lib/quantity";
import { forwardableWithAdditions } from "@/lib/mix-allocation";

describe("a quantity is written down to three decimals", () => {
  it("rounds float noise away", () => {
    expect(roundQty(299.99999999999994)).toBe(300);
    expect(roundQty(0.1 + 0.2)).toBe(0.3);
    expect(qtyText(399.9999999999999)).toBe("400");
    expect(qtyText(12.5)).toBe("12.5");
    expect(qtyText(0)).toBe("0");
    // A real measurement is kept, not flattened.
    expect(roundQty(10.555)).toBe(10.555);
    expect(qtyText(10.5551)).toBe("10.555");
  });

  it("is applied where the load's figure is worked out", () => {
    // 400 dispatched, 100.00000000000006 taken for mix → 300, not 299.99999999999994.
    expect(forwardableWithAdditions(400, 100.00000000000006, 0)).toBe(300);
    expect(forwardableWithAdditions(300, 0.1, 0.2)).toBe(300.1);
    expect(forwardableWithAdditions(10, 40, 0)).toBe(0);
  });
});
