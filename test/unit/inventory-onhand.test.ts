import { describe, it, expect } from "vitest";
import { onHandFromComponents, type OnHandComponents } from "@/lib/inventory-onhand";

const ZERO: OnHandComponents = {
  arrived: 0, yoghurtProduced: 0, yoghurtUse: 0, routePlanned: 0, returned: 0,
  counterPurchase: 0, counterSale: 0, wastage: 0, extraOut: 0, replacement: 0,
  mixStorageUse: 0,
  dilutionStorageUse: 0, retailOut: 0, retailStockIn: 0, retailOnly: false,
};
const farm = (o: Partial<OnHandComponents>) => onHandFromComponents({ ...ZERO, ...o });
const bought = (o: Partial<OnHandComponents>) => onHandFromComponents({ ...ZERO, ...o, retailOnly: true });

describe("retail products get one clamp, not two", () => {
  it("counts stock added by hand", () => {
    expect(bought({ retailStockIn: 100 })).toBe(100);
  });

  it("a round DEDUCTS — the case the split clamp silently swallowed", () => {
    // Under the farm formula routePlanned sits inside max(0, …), so a retail
    // good with no dispatch history computes max(0, -20) = 0 and a rider could
    // take 20 bottles a day for ever against a stock of 100.
    expect(bought({ retailStockIn: 100, routePlanned: 20 })).toBe(80);
    expect(farm({ routePlanned: 20 })).toBe(0); // the farm branch, unchanged
  });

  it("a drop at a shop deducts, and stays deducted", () => {
    expect(bought({ retailStockIn: 100, retailOut: 40 })).toBe(60);
  });

  it("a counter sale deducts", () => {
    expect(bought({ retailStockIn: 100, counterSale: 10 })).toBe(90);
  });

  it("everything that removes stock removes it", () => {
    expect(bought({
      retailStockIn: 100, routePlanned: 10, retailOut: 20, counterSale: 5,
      extraOut: 4, replacement: 1,
    })).toBe(60);
  });

  it("rider returns put stock back", () => {
    expect(bought({ retailStockIn: 100, routePlanned: 20, returned: 5 })).toBe(85);
  });

  it("never goes below zero", () => {
    expect(bought({ retailStockIn: 10, counterSale: 40 })).toBe(0);
  });

  it("with no stock counted in, it is zero and nothing can be taken", () => {
    expect(bought({})).toBe(0);
    expect(bought({ counterSale: 5 })).toBe(0);
  });
});

describe("the farm formula is untouched", () => {
  it("still clamps the milk-flow base before applying counter movements", () => {
    // The whole reason the split exists: a negative base must not swallow a
    // walk-in purchase.
    expect(farm({ routePlanned: 50, counterPurchase: 30 })).toBe(30);
  });

  it("adds and subtracts each term as before", () => {
    expect(farm({ arrived: 100, routePlanned: 30, returned: 5 })).toBe(75);
    expect(farm({ arrived: 100, wastage: 10, extraOut: 5, retailOut: 20 })).toBe(65);
    expect(farm({ arrived: 100, yoghurtProduced: 20, yoghurtUse: 30 })).toBe(90);
    expect(farm({ arrived: 50, mixStorageUse: 20, replacement: 5 })).toBe(25);
  });

  it("ignores the new inbound entirely — it can never mint milk", () => {
    expect(farm({ arrived: 10, retailStockIn: 999 })).toBe(10);
  });
});
