import { describe, it, expect } from "vitest";
import { milkFlow, type FlowInputs } from "@/lib/reconciliation-flow-math";

// The Summary tab's arithmetic, one made-up range, figure by figure.

const base: FlowInputs = {
  produced: 500, purchased: 100,
  calfUse: 30, kitchenUse: 10, skimUse: 5,
  yoghurtUse: 8, counterSale: 2,
  farmAccepted: 440, packagingTransformUse: 0,
  farmDeclaredAccepted: 446, farmPending: 0,
  toRetail: 480,
  riderLoad: 470, delivered: 440, chargedBack: 3, customerReturns: 2,
  returned: 20,
  waste: { farm: 5, packaging: 4, retail: 6, road: 3, riderReturn: 1, other: 0 },
};

describe("milk flow, farm to customer", () => {
  it("adds up every step from records", () => {
    const f = milkFlow(base);
    expect(f.available).toBe(600);                 // 500 + 100
    expect(f.farmUse).toBe(45);                    // 30 + 10 + 5 — yoghurt is NOT farm use
    expect(f.supposedToPack).toBe(550);            // 600 − 45 − 5 farm wastage
    expect(f.received).toBe(540);                  // 440 accepted + 100 bought in
    expect(f.acceptGap).toBe(10);                  // 550 − 540
    expect(f.packed).toBe(536);                    // 540 − 4 packing wastage
    expect(f.inventoryDifference).toBe(46);        // 536 − 8 yoghurt − 2 sold − 480 to Retail
    expect(f.retailLeftover).toBe(4);              // 480 − 6 Retail wastage − 470 to riders
    expect(f.supposedReturn).toBe(29);             // 470 − 440 + 2 − 3
    expect(f.riderGap).toBe(9);                    // 29 − 20
    expect(f.wasteTotal).toBe(19);
  });

  it("takes the gap before packaging apart, and the parts add back up", () => {
    const f = milkFlow(base);
    const parts = Object.fromEntries(f.acceptParts.map((p) => [p.key, p.amount]));
    expect(parts["not-sent"]).toBe(4);             // (500 − 45 − 5) − 446 declared
    expect(parts["pending"]).toBe(0);
    expect(parts["short-load"]).toBe(6);           // 446 declared − 440 accepted
    expect(f.acceptParts.reduce((t, p) => t + p.amount, 0)).toBeCloseTo(f.acceptGap, 6);

    // A load sent and never accepted is its own part.
    const g = milkFlow({ ...base, farmPending: 4, farmDeclaredAccepted: 442, farmAccepted: 436 });
    const gp = Object.fromEntries(g.acceptParts.map((p) => [p.key, p.amount]));
    expect(gp.pending).toBe(4);
    expect(g.acceptParts.reduce((t, p) => t + p.amount, 0)).toBeCloseTo(g.acceptGap, 6);
  });

  it("counts milk taken off a load for mix as received, not as short", () => {
    // 6 L was mixed off the load before acceptance, so only 434 was accepted —
    // but the mix it made went into inventory, and nothing is missing.
    const f = milkFlow({ ...base, farmAccepted: 434, packagingTransformUse: 6 });
    expect(f.received).toBe(540);
    expect(f.acceptParts.find((p) => p.key === "short-load")!.amount).toBe(6);
    const g = milkFlow({ ...base, farmAccepted: 440, packagingTransformUse: 6, farmDeclaredAccepted: 446 });
    expect(g.acceptParts.find((p) => p.key === "short-load")!.amount).toBe(0);
  });

  it("collective loss is every litre written off plus every litre missing", () => {
    const f = milkFlow(base);
    expect(f.missingParts.map((p) => p.key)).toEqual(["accept", "rider"]);
    expect(f.missingTotal).toBe(19);               // 10 before packaging + 9 on the rounds
    expect(f.collectiveLoss).toBe(38);             // 19 wasted + 19 missing
    expect(f.lossPct).toBe(6.3);                   // 38 of 600
  });

  it("never lets a surplus in one place cancel a loss in another", () => {
    // Riders handed back 5 L more than was due, and packaging received 10 L more
    // than the farm's figures say it had. Neither finds milk lost elsewhere.
    const f = milkFlow({ ...base, returned: 34, farmAccepted: 460, farmDeclaredAccepted: 460 });
    expect(f.riderGap).toBe(-5);
    expect(f.acceptGap).toBe(-10);
    expect(f.missingParts).toEqual([]);
    expect(f.missingTotal).toBe(0);
    expect(f.collectiveLoss).toBe(f.wasteTotal);
  });

  it("inventory kept back and Retail's leftover are not losses", () => {
    const f = milkFlow(base);
    expect(f.inventoryDifference).toBeGreaterThan(0);
    expect(f.retailLeftover).toBeGreaterThan(0);
    expect(f.collectiveLoss).toBe(f.wasteTotal + f.missingTotal);
    // Riders taking more than Retail had shows as a negative leftover — flagged on
    // the page, still not counted as a loss.
    const g = milkFlow({ ...base, riderLoad: 500 });
    expect(g.retailLeftover).toBe(-26);
    expect(g.missingParts.some((p) => p.key === "retail")).toBe(false);
  });

  it("an empty range is all zeros, with no division by zero", () => {
    const zero = milkFlow({
      produced: 0, purchased: 0, calfUse: 0, kitchenUse: 0, skimUse: 0, yoghurtUse: 0, counterSale: 0,
      farmAccepted: 0, packagingTransformUse: 0, farmDeclaredAccepted: 0, farmPending: 0,
      toRetail: 0, riderLoad: 0, delivered: 0, chargedBack: 0, customerReturns: 0, returned: 0,
      waste: { farm: 0, packaging: 0, retail: 0, road: 0, riderReturn: 0, other: 0 },
    });
    expect(zero.collectiveLoss).toBe(0);
    expect(zero.lossPct).toBe(0);
  });
});
