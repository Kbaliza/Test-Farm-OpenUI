import { describe, it, expect } from "vitest";
import { deliveryLineValue } from "@/lib/product-sales";

// The value of one delivered line. It was duplicated in dashboard-data and the
// summary report, which is exactly how two "revenue" figures drift apart.

describe("what one delivery line is worth", () => {
  it("is quantity times rate", () => {
    expect(deliveryLineValue({ quantity: 10, unitRate: 120, isReturn: false, isReplacement: false })).toBe(1200);
  });

  it("a return is a credit, not a sale", () => {
    expect(deliveryLineValue({ quantity: 2, unitRate: 120, isReturn: true, isReplacement: false })).toBe(-240);
  });

  it("a replacement is worth nothing — it is a free swap for a complaint", () => {
    expect(deliveryLineValue({ quantity: 3, unitRate: 120, isReturn: false, isReplacement: true })).toBe(0);
    // Even when flagged as a return as well, free is free.
    expect(deliveryLineValue({ quantity: 3, unitRate: 120, isReturn: true, isReplacement: true })).toBe(0);
  });

  it("copes with zero rate and zero quantity", () => {
    expect(deliveryLineValue({ quantity: 0, unitRate: 120, isReturn: false, isReplacement: false })).toBe(0);
    expect(deliveryLineValue({ quantity: 5, unitRate: 0, isReturn: false, isReplacement: false })).toBe(0);
  });

  it("handles fractional litres without drifting", () => {
    expect(deliveryLineValue({ quantity: 1.5, unitRate: 130, isReturn: false, isReplacement: false })).toBeCloseTo(195, 6);
  });
});
