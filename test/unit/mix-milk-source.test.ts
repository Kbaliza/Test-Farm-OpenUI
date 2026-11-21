import { describe, it, expect } from "vitest";
import {
  splitMixSource,
  totalMixable,
  MIX_REASONS,
  MIX_REASON_PACKAGING,
  MIX_REASON_STORAGE,
} from "@/lib/mix-milk-source";

describe("totalMixable", () => {
  it("adds the two pools — the ceiling the form offers", () => {
    expect(totalMixable(12, 44)).toBe(56);
    expect(totalMixable(0, 44)).toBe(44);
    expect(totalMixable(12, 0)).toBe(12);
    expect(totalMixable(0, 0)).toBe(0);
  });

  it("treats a negative pool as empty", () => {
    expect(totalMixable(-5, 44)).toBe(44);
  });
});

describe("splitMixSource", () => {
  it("takes from inventory first, leaving today's milk alone", () => {
    expect(splitMixSource(10, 12, 44)).toEqual({ fromPackaging: 0, fromStorage: 10 });
  });

  it("falls back to the dispatch pool only once inventory runs out", () => {
    // 12 at packaging, 44 in inventory: the first 44 come from stock.
    expect(splitMixSource(50, 12, 44)).toEqual({ fromPackaging: 6, fromStorage: 44 });
  });

  it("the farm's worked example: 200 against 120 fresh and 500 in stock", () => {
    const s = splitMixSource(200, 120, 500);
    expect(s).toEqual({ fromPackaging: 0, fromStorage: 200 });
  });

  it("uses both pools completely at the ceiling", () => {
    const s = splitMixSource(56, 12, 44);
    expect(s).toEqual({ fromPackaging: 12, fromStorage: 44 });
    expect(s.fromPackaging + s.fromStorage).toBe(56);
  });

  it("never allocates more than the pools hold", () => {
    const s = splitMixSource(999, 12, 44);
    expect(s.fromPackaging + s.fromStorage).toBe(56);
  });

  it("draws purely from packaging when inventory is empty", () => {
    expect(splitMixSource(10, 12, 0)).toEqual({ fromPackaging: 10, fromStorage: 0 });
  });

  it("draws purely from inventory when nothing was dispatched", () => {
    expect(splitMixSource(20, 0, 44)).toEqual({ fromPackaging: 0, fromStorage: 20 });
  });

  it("allocates nothing from empty pools", () => {
    expect(splitMixSource(10, 0, 0)).toEqual({ fromPackaging: 0, fromStorage: 0 });
  });

  it("handles zero and negative requests", () => {
    expect(splitMixSource(0, 12, 44)).toEqual({ fromPackaging: 0, fromStorage: 0 });
    expect(splitMixSource(-3, 12, 44)).toEqual({ fromPackaging: 0, fromStorage: 0 });
  });

  it("keeps fractional litres to 3 places without drift", () => {
    const s = splitMixSource(12.5, 10.2, 2.3);
    expect(s.fromStorage).toBe(2.3);
    expect(s.fromPackaging).toBe(10.2);
  });
});
