import { describe, it, expect } from "vitest";
import { isYoghurtName, isGheeName, milkLoadOrder } from "@/lib/product-names";

describe("isYoghurtName — tolerates both catalog spellings", () => {
  it("matches the spelling actually used in the catalog", () => {
    // The live catalog row is "Yogurt"; the old code matched only "yogh", which is
    // exactly why the Yoghurt page could not find its own product.
    expect(isYoghurtName("Yogurt")).toBe(true);
    expect(isYoghurtName("yogurt")).toBe(true);
  });

  it("matches the spelling the code/UI was written with", () => {
    expect(isYoghurtName("Yoghurt")).toBe(true);
    expect(isYoghurtName("YOGHURT")).toBe(true);
  });

  it("matches when it is part of a longer product name", () => {
    expect(isYoghurtName("Desi Yogurt 500g")).toBe(true);
    expect(isYoghurtName("Greek Yoghurt")).toBe(true);
  });

  it("does not match other dairy products", () => {
    for (const n of ["Pure Buffalo", "Cow Milk", "Mix Milk", "Desi Eggs", "Desi Ghee", "Skim Milk", "Low Fat Milk", "Cream"]) {
      expect(isYoghurtName(n)).toBe(false);
    }
  });
});

describe("isGheeName — ghee is bought in, never produced at the farm", () => {
  it("matches the catalogue spelling and a bare 'Ghee'", () => {
    expect(isGheeName("Desi Ghee")).toBe(true);
    expect(isGheeName("Ghee")).toBe(true);
    expect(isGheeName("desi ghee")).toBe(true);
  });

  it("does not match anything else on the production page", () => {
    for (const n of ["Pure Buffalo", "Cow Milk", "Mix Milk", "Yogurt", "Desi Eggs", "Skim Milk"]) {
      expect(isGheeName(n)).toBe(false);
    }
  });
});

describe("milkLoadOrder — the order the van is packed in", () => {
  it("puts cow first, then mix, then buffalo", () => {
    expect(milkLoadOrder("Cow Milk")).toBe(0);
    expect(milkLoadOrder("Mix Milk")).toBe(1);
    expect(milkLoadOrder("Pure Buffalo")).toBe(2);
  });

  it("matches the catalogue name, which does not say 'milk' for buffalo at all", () => {
    expect(milkLoadOrder("Pure Buffalo")).toBeLessThan(milkLoadOrder("Desi Eggs"));
  });

  it("sends everything else to the end, skim milk included", () => {
    for (const n of ["Desi Eggs", "Yogurt", "Desi Ghee", "Cream", "Skim Milk"]) {
      expect(milkLoadOrder(n), n).toBe(3);
    }
  });

  it("is case-insensitive", () => {
    expect(milkLoadOrder("COW MILK")).toBe(0);
    expect(milkLoadOrder("buffalo")).toBe(2);
  });

  it("sorts a real catalogue into the asked-for order", () => {
    const sorted = ["Desi Ghee", "Pure Buffalo", "Desi Eggs", "Mix Milk", "Cow Milk"]
      .sort((a, b) => milkLoadOrder(a) - milkLoadOrder(b));
    expect(sorted.slice(0, 3)).toEqual(["Cow Milk", "Mix Milk", "Pure Buffalo"]);
  });
});
