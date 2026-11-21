import { describe, it, expect } from "vitest";
import {
  allocateMixUsage,
  forwardableQty,
  mixDeductionsByDispatch,
  additionsByDispatch,
  forwardableWithAdditions,
  loadLoss,
  type AllocatableLoad,
} from "@/lib/mix-allocation";

const load = (id: string, day: number, items: [string, number][]): AllocatableLoad => ({
  id,
  date: new Date(Date.UTC(2026, 7, day)),
  items: items.map(([productId, quantity]) => ({ productId, quantity })),
});

describe("mix-milk allocation across pending loads", () => {
  it("charges a single load with everything it can cover", () => {
    const a = load("A", 1, [["cow", 90], ["buf", 90]]);
    const out = allocateMixUsage([a], { cow: 10, buf: 10 });
    expect(out.A).toEqual({ cow: 10, buf: 10 });
    expect(forwardableQty(90, out.A.cow)).toBe(80);
  });

  it("never charges the same litres to two loads — the reported double-count", () => {
    const a = load("A", 1, [["cow", 194]]);
    const b = load("B", 2, [["cow", 90]]);
    const out = allocateMixUsage([a, b], { cow: 10 });
    // 10 L was mixed once, so exactly 10 L is charged in total.
    const charged = (out.A.cow ?? 0) + (out.B.cow ?? 0);
    expect(charged).toBe(10);
    // Oldest load is consumed first; the newer one stays whole.
    expect(out.A.cow).toBe(10);
    expect(out.B.cow ?? 0).toBe(0);
    expect(forwardableQty(90, out.B.cow ?? 0)).toBe(90);
  });

  it("spills over when one load cannot cover the usage", () => {
    const a = load("A", 1, [["cow", 30]]);
    const b = load("B", 2, [["cow", 90]]);
    const out = allocateMixUsage([a, b], { cow: 50 });
    expect(out.A.cow).toBe(30);
    expect(out.B.cow).toBe(20);
    expect((out.A.cow ?? 0) + (out.B.cow ?? 0)).toBe(50);
  });

  it("never charges a load more than it carried", () => {
    const a = load("A", 1, [["cow", 5]]);
    const out = allocateMixUsage([a], { cow: 999 });
    expect(out.A.cow).toBe(5);
    expect(forwardableQty(5, out.A.cow)).toBe(0);
  });

  it("leaves untouched products and loads alone", () => {
    const a = load("A", 1, [["cow", 90], ["eggs", 500]]);
    const out = allocateMixUsage([a], { cow: 10 });
    expect(out.A).toEqual({ cow: 10 });
    expect(forwardableQty(500, out.A.eggs ?? 0)).toBe(500);
  });

  it("handles no usage and no loads without throwing", () => {
    expect(allocateMixUsage([], { cow: 10 })).toEqual({});
    const a = load("A", 1, [["cow", 90]]);
    expect(allocateMixUsage([a], {})).toEqual({ A: {} });
    expect(forwardableQty(90, 0)).toBe(90);
  });

  it("forwardable never goes negative", () => {
    expect(forwardableQty(10, 25)).toBe(0);
  });
});

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 21, h, m));
const mv = (productId: string, quantity: number, h: number, m = 0) => ({ productId, quantity, date: at(h, m) });

describe("per-dispatch mix milk deductions", () => {
  it("reproduces the reported screen: 90 dispatched, 10 mixed, 80 forwardable", () => {
    const load: AllocatableLoad = {
      id: "D1",
      date: at(18, 1),
      items: [{ productId: "cow", quantity: 90 }, { productId: "buf", quantity: 90 }],
    };
    const out = mixDeductionsByDispatch([load], new Map(), [
      mv("buf", 10, 18, 30),
      mv("cow", 10, 18, 30),
    ]);
    expect(out.D1).toEqual({ buf: 10, cow: 10 });
    expect(forwardableQty(90, out.D1.cow)).toBe(80);
  });

  it("an accepted load keeps its own mixing; a later one is not charged for it", () => {
    const a: AllocatableLoad = { id: "A", date: at(6), items: [{ productId: "cow", quantity: 100 }] };
    const b: AllocatableLoad = { id: "B", date: at(18), items: [{ productId: "cow", quantity: 90 }] };
    const confirmed = new Map([["A", at(7)]]);
    const out = mixDeductionsByDispatch([a, b], confirmed, [mv("cow", 20, 6, 30)]);
    expect(out.A).toEqual({ cow: 20 });
    expect(out.B).toEqual({});
    expect(forwardableQty(90, out.B.cow ?? 0)).toBe(90);
  });

  it("mixing after the last acceptance is charged once, to the oldest waiting load", () => {
    const a: AllocatableLoad = { id: "A", date: at(6), items: [{ productId: "cow", quantity: 194 }] };
    const b: AllocatableLoad = { id: "B", date: at(18), items: [{ productId: "cow", quantity: 90 }] };
    const out = mixDeductionsByDispatch([a, b], new Map(), [mv("cow", 10, 19)]);
    expect((out.A.cow ?? 0) + (out.B.cow ?? 0)).toBe(10);
    expect(out.B.cow ?? 0).toBe(0);
  });

  it("no mixing at all leaves every load whole", () => {
    const a: AllocatableLoad = { id: "A", date: at(6), items: [{ productId: "cow", quantity: 90 }] };
    const out = mixDeductionsByDispatch([a], new Map(), []);
    expect(out.A).toEqual({});
    expect(forwardableQty(90, out.A.cow ?? 0)).toBe(90);
  });
});

describe("packaging additions and consumption on the same load", () => {
  const at2 = (h: number) => new Date(Date.UTC(2026, 7, 25, h));

  it("a load gives cow milk to the buffalo and forwards both, litre for litre", () => {
    const load: AllocatableLoad = {
      id: "D1",
      date: at2(18),
      items: [
        { productId: "cow", quantity: 90 },
        { productId: "buf", quantity: 90 },
      ],
    };
    const out = mixDeductionsByDispatch([load], new Map(), [
      { productId: "cow", quantity: 10, date: at2(19) },
    ]);
    const added = additionsByDispatch([load], new Map(), [
      { productId: "buf", quantity: 10, date: at2(19) },
    ]);

    const cow = forwardableWithAdditions(90, out.D1.cow ?? 0, added.D1.cow ?? 0);
    const buf = forwardableWithAdditions(90, out.D1.buf ?? 0, added.D1.buf ?? 0);
    expect(cow).toBe(80);
    expect(buf).toBe(100);
    expect(cow + buf).toBe(180); // nothing created, nothing lost
  });

  it("mixing and standardising stack on the same product without double-counting", () => {
    const load: AllocatableLoad = { id: "D1", date: at2(18), items: [{ productId: "cow", quantity: 90 }] };
    const mix = mixDeductionsByDispatch([load], new Map(), [{ productId: "cow", quantity: 10, date: at2(19) }]);
    const dil = mixDeductionsByDispatch([load], new Map(), [{ productId: "cow", quantity: 15, date: at2(20) }]);
    const forward = forwardableWithAdditions(90, (mix.D1.cow ?? 0) + (dil.D1.cow ?? 0), 0);
    expect(forward).toBe(65);
  });

  it("an accepted load keeps what was stirred into it; a later one is untouched", () => {
    const a: AllocatableLoad = { id: "A", date: at2(6), items: [{ productId: "buf", quantity: 100 }] };
    const b: AllocatableLoad = { id: "B", date: at2(18), items: [{ productId: "buf", quantity: 90 }] };
    const added = additionsByDispatch(
      [a, b],
      new Map([["A", at2(7)]]),
      [{ productId: "buf", quantity: 10, date: at2(6) }]
    );
    expect(added.A).toEqual({ buf: 10 });
    expect(added.B).toEqual({});
  });
});

describe("loadLoss — only real spillage counts", () => {
  it("the reported case: cow gave 10 to the buffalo and 10 to mix milk, 70 forwarded", () => {
    expect(loadLoss(90, 70, { mixUsed: 10, dilutionOut: 10 })).toBe(0);
  });

  it("buffalo took 10 in and gave 10 to mix milk, 90 forwarded", () => {
    expect(loadLoss(90, 90, { mixUsed: 10, dilutionIn: 10 })).toBe(0);
  });

  it("still catches genuine loss on top of processing", () => {
    expect(loadLoss(90, 65, { mixUsed: 10, dilutionOut: 10 })).toBe(5);
  });

  it("plain shortfall with no processing at all", () => {
    expect(loadLoss(100, 95)).toBe(5);
    expect(loadLoss(100, 100)).toBe(0);
  });

  it("never reports a negative loss when more arrives than expected", () => {
    expect(loadLoss(90, 100, { dilutionIn: 10 })).toBe(0);
    expect(loadLoss(90, 120, { dilutionIn: 10 })).toBe(0);
  });
});
