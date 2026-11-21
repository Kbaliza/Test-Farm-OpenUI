import { describe, it, expect } from "vitest";
import {
  preparedBuffalo,
  cowLeft,
  dilutionProblem,
  DILUTION_REASON,
  DILUTION_REASON_STORAGE,
  DILUTION_REASONS,
  splitDilutionSource,
} from "@/lib/buffalo-dilution";
import { allocateAdditions, forwardableWithAdditions } from "@/lib/mix-allocation";

describe("buffalo standardisation arithmetic", () => {
  it("the farm's own example: 100 buffalo + 10 cow", () => {
    expect(preparedBuffalo(100, 10)).toBe(110);
    expect(cowLeft(100, 10)).toBe(90);
  });

  it("conserves milk — nothing is created or lost", () => {
    const buffaloProduced = 100, cowProduced = 100, added = 10;
    const total = preparedBuffalo(buffaloProduced, added) + cowLeft(cowProduced, added);
    expect(total).toBe(buffaloProduced + cowProduced);
  });

  it("handles fractions without float drift", () => {
    expect(preparedBuffalo(100.1, 0.2)).toBe(100.3);
    expect(cowLeft(90.3, 0.1)).toBe(90.2);
  });

  it("adding nothing changes nothing", () => {
    expect(preparedBuffalo(100, 0)).toBe(100);
    expect(cowLeft(100, 0)).toBe(100);
  });

  it("never reports a negative remainder", () => {
    expect(cowLeft(0, 0)).toBe(0);
  });
});

describe("dilutionProblem — the gate", () => {
  it("allows an amount within what is available", () => {
    expect(dilutionProblem({ cowAdded: 10, cowAvailable: 100 })).toBeNull();
    expect(dilutionProblem({ cowAdded: 100, cowAvailable: 100 })).toBeNull();
  });

  it("refuses more cow milk than exists, naming the limit", () => {
    const msg = dilutionProblem({ cowAdded: 120, cowAvailable: 100, cowName: "Cow Milk" });
    expect(msg).toContain("only 100 L is available");
    expect(msg).toContain("cannot add 120 L");
  });

  it("refuses zero, negatives and nonsense", () => {
    expect(dilutionProblem({ cowAdded: 0, cowAvailable: 100 })).not.toBeNull();
    expect(dilutionProblem({ cowAdded: -5, cowAvailable: 100 })).not.toBeNull();
    expect(dilutionProblem({ cowAdded: NaN, cowAvailable: 100 })).not.toBeNull();
  });

  it("refuses everything when no cow milk is left", () => {
    expect(dilutionProblem({ cowAdded: 1, cowAvailable: 0 })).not.toBeNull();
  });

  it("tolerates a floating-point hair over the limit", () => {
    expect(dilutionProblem({ cowAdded: 0.1 + 0.2, cowAvailable: 0.3 })).toBeNull();
  });
});

describe("packaging keeps the load's own arithmetic", () => {
  it("a load gives up cow milk and gains buffalo milk, litre for litre", () => {
    const dispatchedCow = 90, dispatchedBuffalo = 90, added = 10;
    const cowForward = forwardableWithAdditions(dispatchedCow, added, 0);
    const buffaloForward = forwardableWithAdditions(dispatchedBuffalo, 0, added);
    expect(cowForward).toBe(80);
    expect(buffaloForward).toBe(100);
    // Nothing is created at packaging — the load still carries the same total.
    expect(cowForward + buffaloForward).toBe(dispatchedCow + dispatchedBuffalo);
  });

  it("an addition lands on the load that carries that milk", () => {
    const loads = [
      { id: "A", date: new Date(Date.UTC(2026, 7, 25, 6)), items: [{ productId: "cow", quantity: 90 }] },
      { id: "B", date: new Date(Date.UTC(2026, 7, 25, 18)), items: [{ productId: "buf", quantity: 90 }] },
    ];
    const out = allocateAdditions(loads, { buf: 10 });
    expect(out.B).toEqual({ buf: 10 });
    expect(out.A).toEqual({});
  });

  it("never charges an addition twice across two loads", () => {
    const loads = [
      { id: "A", date: new Date(Date.UTC(2026, 7, 25, 6)), items: [{ productId: "buf", quantity: 50 }] },
      { id: "B", date: new Date(Date.UTC(2026, 7, 25, 18)), items: [{ productId: "buf", quantity: 90 }] },
    ];
    const out = allocateAdditions(loads, { buf: 10 });
    expect((out.A.buf ?? 0) + (out.B.buf ?? 0)).toBe(10);
    expect(out.A.buf).toBe(10); // oldest load carrying it
  });

  it("forwardable never goes negative, even if more was taken than dispatched", () => {
    expect(forwardableWithAdditions(5, 25, 0)).toBe(0);
  });
});

describe("the movement reason", () => {
  it("is stable — both halves of an entry are found by it", () => {
    expect(DILUTION_REASON).toBe("Buffalo dilution");
  });
});

describe("splitDilutionSource — inventory first, then today", () => {
  it("takes the whole amount from inventory when inventory covers it", () => {
    expect(splitDilutionSource(50, 100, 200)).toEqual({ fromStorage: 50, fromPackaging: 0 });
  });

  it("the case the farm actually hit: nothing produced today, stock on hand", () => {
    expect(splitDilutionSource(50, 0, 200)).toEqual({ fromStorage: 50, fromPackaging: 0 });
  });

  it("spills over into today's production only once inventory runs out", () => {
    expect(splitDilutionSource(50, 100, 20)).toEqual({ fromStorage: 20, fromPackaging: 30 });
  });

  it("falls back entirely to today when there is no inventory", () => {
    expect(splitDilutionSource(50, 100, 0)).toEqual({ fromStorage: 0, fromPackaging: 50 });
  });

  it("never hands back more than was asked for", () => {
    const s = splitDilutionSource(10, 100, 100);
    expect(s.fromStorage + s.fromPackaging).toBe(10);
  });

  it("never invents milk that is not there", () => {
    const s = splitDilutionSource(500, 100, 50);
    expect(s.fromStorage + s.fromPackaging).toBeLessThanOrEqual(150);
  });

  it("zero and nonsense draw nothing", () => {
    expect(splitDilutionSource(0, 100, 100)).toEqual({ fromStorage: 0, fromPackaging: 0 });
  });
});

describe("both movement reasons", () => {
  it("are distinct, so the two pools can be told apart afterwards", () => {
    expect(DILUTION_REASON_STORAGE).toBe("Buffalo dilution (storage)");
    expect(DILUTION_REASON_STORAGE).not.toBe(DILUTION_REASON);
  });

  it("DILUTION_REASONS carries both — delete and on-hand rely on it", () => {
    expect([...DILUTION_REASONS]).toEqual([DILUTION_REASON, DILUTION_REASON_STORAGE]);
  });
});
