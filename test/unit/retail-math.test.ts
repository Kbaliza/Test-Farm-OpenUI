import { describe, it, expect } from "vitest";
import {
  openQty,
  openValue,
  isFullyResolved,
  resolutionTotals,
  validateResolution,
  martBalance,
  applyFifo,
  round2,
} from "@/lib/retail-math";

const line = (over: Partial<Parameters<typeof openQty>[0]> & { quantity: number }) => ({
  productName: "Yogurt",
  unit: "KG",
  soldQty: 0,
  wastedQty: 0,
  rate: 280,
  ...over,
});

describe("openQty — what is still on their shelf", () => {
  it("is the whole drop before anything is reported", () => {
    expect(openQty(line({ quantity: 10 }))).toBe(10);
  });

  it("comes down by what was reported sold and expired", () => {
    expect(openQty(line({ quantity: 10, soldQty: 6, wastedQty: 1 }))).toBe(3);
  });

  it("is zero once everything is accounted for", () => {
    expect(openQty(line({ quantity: 10, soldQty: 7, wastedQty: 3 }))).toBe(0);
  });

  it("never goes negative", () => {
    expect(openQty(line({ quantity: 10, soldQty: 20, wastedQty: 5 }))).toBe(0);
  });

  it("handles fractional litres without float noise", () => {
    expect(openQty(line({ quantity: 10.5, soldQty: 0.1, wastedQty: 0.2 }))).toBe(10.2);
  });
});

describe("a drop reported over several visits", () => {
  it("10 → 6 sold → 1 expired → 3 open → 3 sold → closed, and a 4th unit is refused", () => {
    const l = { id: "L1", ...line({ quantity: 10 }) };

    // First visit: 6 sold, 1 expired.
    expect(validateResolution([l], [{ lineId: "L1", soldQty: 6, wastedQty: 1 }])).toBeNull();
    l.soldQty = 6;
    l.wastedQty = 1;
    expect(openQty(l)).toBe(3);
    expect(isFullyResolved([l])).toBe(false);

    // Second visit: the remaining 3 sold.
    expect(validateResolution([l], [{ lineId: "L1", soldQty: 3, wastedQty: 0 }])).toBeNull();
    l.soldQty = 9;
    expect(openQty(l)).toBe(0);
    expect(isFullyResolved([l])).toBe(true);

    // A fourth unit was never dropped there.
    expect(validateResolution([l], [{ lineId: "L1", soldQty: 1, wastedQty: 0 }])).toContain(
      "only 0"
    );
  });
});

describe("validateResolution — the binding rule", () => {
  const l = { id: "L1", ...line({ quantity: 10, unit: "LITER", productName: "Pure Buffalo" }) };

  it("accepts sold + expired exactly equal to what is open", () => {
    expect(validateResolution([l], [{ lineId: "L1", soldQty: 7, wastedQty: 3 }])).toBeNull();
  });

  it("refuses more than was left there, naming the product and the remainder", () => {
    const msg = validateResolution([l], [{ lineId: "L1", soldQty: 8, wastedQty: 3 }]);
    expect(msg).toContain("Pure Buffalo");
    expect(msg).toContain("only 10 L");
  });

  it("counts what earlier visits already reported", () => {
    const partly = { ...l, soldQty: 8 };
    expect(validateResolution([partly], [{ lineId: "L1", soldQty: 3, wastedQty: 0 }])).toContain("only 2 L");
  });

  it("refuses negatives and nonsense", () => {
    expect(validateResolution([l], [{ lineId: "L1", soldQty: -1, wastedQty: 0 }])).toContain("negative");
    expect(validateResolution([l], [{ lineId: "L1", soldQty: NaN, wastedQty: 0 }])).toContain("number");
  });

  it("refuses an empty report", () => {
    expect(validateResolution([l], [{ lineId: "L1", soldQty: 0, wastedQty: 0 }])).toContain("Enter how much");
  });

  it("refuses a line that is not part of this drop", () => {
    expect(validateResolution([l], [{ lineId: "OTHER", soldQty: 1, wastedQty: 0 }])).toContain("not part of");
  });

  it("tolerates a floating-point hair over the limit", () => {
    const tiny = { ...l, quantity: 0.3, soldQty: 0, wastedQty: 0 };
    expect(validateResolution([tiny], [{ lineId: "L1", soldQty: 0.1 + 0.2, wastedQty: 0 }])).toBeNull();
  });
});

describe("resolutionTotals — money", () => {
  const rate = (id: string) => ({ L1: 133.33, L2: 280 })[id as "L1" | "L2"] ?? 0;

  it("charges the sold quantity and values the loss, both to 2 places", () => {
    const t = resolutionTotals([{ lineId: "L1", soldQty: 7, wastedQty: 2 }], rate);
    expect(t.soldAmount).toBe(933.31);
    expect(t.wastedValue).toBe(266.66);
  });

  it("adds up across lines", () => {
    const t = resolutionTotals(
      [
        { lineId: "L1", soldQty: 1, wastedQty: 0 },
        { lineId: "L2", soldQty: 2, wastedQty: 1 },
      ],
      rate
    );
    expect(t.soldAmount).toBe(693.33);
    expect(t.wastedValue).toBe(280);
    expect(t.amounts.L2).toBe(560);
  });

  it("charges nothing for a purely expired report", () => {
    const t = resolutionTotals([{ lineId: "L2", soldQty: 0, wastedQty: 4 }], rate);
    expect(t.soldAmount).toBe(0);
    expect(t.wastedValue).toBe(1120);
  });
});

describe("openValue", () => {
  it("values what is still out at the agreed shop rate", () => {
    expect(openValue([line({ quantity: 10, soldQty: 6, rate: 120 })])).toBe(480);
  });
});

describe("martBalance — never nets one shop's credit against another debt", () => {
  it("adds what is still owed", () => {
    expect(martBalance([{ amount: 1000, received: 400 }, { amount: 500, received: 0 }])).toBe(1100);
  });

  it("clamps an over-received row at zero instead of offsetting", () => {
    expect(martBalance([{ amount: 100, received: 250 }, { amount: 500, received: 0 }])).toBe(500);
  });

  it("is zero when everything is settled", () => {
    expect(martBalance([{ amount: 300, received: 300 }])).toBe(0);
  });
});

describe("applyFifo — oldest debt first", () => {
  const open = [
    { id: "A", amount: 500, received: 0 },
    { id: "B", amount: 300, received: 100 },
  ];

  it("fills the oldest first", () => {
    expect(applyFifo(open, 500)).toEqual([{ id: "A", take: 500 }]);
  });

  it("spills into the next once the first is settled", () => {
    expect(applyFifo(open, 600)).toEqual([
      { id: "A", take: 500 },
      { id: "B", take: 100 },
    ]);
  });

  it("never takes more than is owed in total", () => {
    const taken = applyFifo(open, 99999).reduce((s, x) => s + x.take, 0);
    expect(taken).toBe(700);
  });

  it("skips rows that are already settled", () => {
    expect(applyFifo([{ id: "A", amount: 100, received: 100 }, { id: "B", amount: 50, received: 0 }], 50)).toEqual([
      { id: "B", take: 50 },
    ]);
  });

  it("does nothing with nothing", () => {
    expect(applyFifo(open, 0)).toEqual([]);
  });
});

describe("round2", () => {
  it("kills float noise", () => {
    expect(round2(933.3100000000001)).toBe(933.31);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe("what an expiry actually cost us", () => {
  const line = (id: string, sold: number, wasted: number) => ({ lineId: id, soldQty: sold, wastedQty: wasted });
  const rate = () => 160;

  it("values the loss at cost, and the sales figure at the shop rate", () => {
    const t = resolutionTotals([line("a", 0, 5)], rate, () => 60);
    expect(t.wastedCost).toBe(300);   // what we spent
    expect(t.wastedValue).toBe(800);  // what we would have earned
  });

  it("adds up across lines", () => {
    const cost = (id: string) => (id === "a" ? 60 : 25);
    const t = resolutionTotals([line("a", 0, 5), line("b", 0, 4)], rate, cost);
    expect(t.wastedCost).toBe(400);
  });

  it("is null — not a partial total — when any expired line has no cost", () => {
    const cost = (id: string) => (id === "a" ? 60 : null);
    const t = resolutionTotals([line("a", 0, 5), line("b", 0, 4)], rate, cost);
    expect(t.wastedCost).toBeNull();
    expect(t.wastedValue).toBe(1440); // the rate side is still complete
  });

  it("ignores a missing cost on a line that only SOLD — nothing was lost there", () => {
    const cost = (id: string) => (id === "a" ? 60 : null);
    const t = resolutionTotals([line("a", 0, 5), line("b", 10, 0)], rate, cost);
    expect(t.wastedCost).toBe(300);
  });

  it("is zero when nothing expired", () => {
    expect(resolutionTotals([line("a", 10, 0)], rate, () => 60).wastedCost).toBe(0);
  });

  it("leaves every existing figure alone when no cost lookup is given", () => {
    const withCost = resolutionTotals([line("a", 10, 5)], rate, () => 60);
    const without = resolutionTotals([line("a", 10, 5)], rate);
    expect(without.soldAmount).toBe(withCost.soldAmount);
    expect(without.wastedValue).toBe(withCost.wastedValue);
    expect(without.wastedCost).toBeNull();
  });
});
