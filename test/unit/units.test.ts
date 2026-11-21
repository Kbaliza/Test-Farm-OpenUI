import { describe, it, expect } from "vitest";
import {
  UNITS,
  isPackUnit,
  unitLabel,
  unitSuffix,
  unitOptionLabel,
  unitSortOrder,
  baseUnitOf,
  toBaseQuantity,
  packLabel,
  packQtyLabel,
  equivalentLabel,
  packSizeProblem,
  perUnitLabel,
  qtyLabel,
} from "@/lib/units";

describe("unitLabel", () => {
  it("labels every unit", () => {
    expect(unitLabel("LITER")).toBe("L");
    expect(unitLabel("KG")).toBe("kg");
    expect(unitLabel("PIECE")).toBe("pc");
    expect(unitLabel("MILLILITER")).toBe("ml");
    expect(unitLabel("GRAM")).toBe("g");
  });

  it("passes an already-short label through — rows written before units were stored as the enum still render", () => {
    expect(unitLabel("L")).toBe("L");
    expect(unitLabel("kg")).toBe("kg");
    expect(unitLabel("pc")).toBe("pc");
  });

  it("never renders undefined for something it does not know", () => {
    expect(unitLabel("")).toBe("");
    expect(unitLabel(null)).toBe("");
    expect(unitLabel(undefined)).toBe("");
    expect(unitLabel("DOZEN")).toBe("DOZEN");
  });

  it("suffixes with a leading space, and nothing at all for an empty unit", () => {
    expect(unitSuffix("LITER")).toBe(" L");
    expect(unitSuffix("MILLILITER")).toBe(" ml");
    expect(unitSuffix(null)).toBe("");
  });
});

describe("pack units", () => {
  it("knows which units are packs", () => {
    expect(isPackUnit("MILLILITER")).toBe(true);
    expect(isPackUnit("GRAM")).toBe(true);
    expect(isPackUnit("LITER")).toBe(false);
    expect(isPackUnit("PIECE")).toBe(false);
    expect(isPackUnit(null)).toBe(false);
  });

  it("maps a pack unit to what it converts into", () => {
    expect(baseUnitOf("MILLILITER")).toBe("LITER");
    expect(baseUnitOf("GRAM")).toBe("KG");
    expect(baseUnitOf("LITER")).toBe("LITER");
    expect(baseUnitOf("DOZEN")).toBeNull();
  });
});

describe("toBaseQuantity — packs to litres and kilograms", () => {
  it("the worked example: 40 bottles of 250 ml is 10 L", () => {
    expect(toBaseQuantity("MILLILITER", 250, 40)).toBe(10);
  });

  it("grams to kilograms", () => {
    expect(toBaseQuantity("GRAM", 500, 8)).toBe(4);
  });

  it("leaves an ordinary unit's quantity alone", () => {
    expect(toBaseQuantity("LITER", null, 12)).toBe(12);
    expect(toBaseQuantity("KG", null, 2.5)).toBe(2.5);
    expect(toBaseQuantity("PIECE", null, 30)).toBe(30);
  });

  it("returns null rather than NaN when the pack size is unknown", () => {
    expect(toBaseQuantity("MILLILITER", null, 40)).toBeNull();
    expect(toBaseQuantity("MILLILITER", 0, 40)).toBeNull();
    expect(toBaseQuantity("MILLILITER", -250, 40)).toBeNull();
  });

  it("handles awkward sizes without float noise", () => {
    expect(toBaseQuantity("MILLILITER", 330, 3)).toBe(0.99);
    expect(toBaseQuantity("MILLILITER", 1, 1)).toBe(0.001);
  });

  it("is zero for nothing", () => {
    expect(toBaseQuantity("MILLILITER", 250, 0)).toBe(0);
  });
});

describe("labels for a pack product", () => {
  it("describes the pack", () => {
    expect(packLabel("MILLILITER", 250)).toBe("250 ml");
    expect(packLabel("GRAM", 500)).toBe("500 g");
  });

  it("says nothing about packs for an ordinary unit", () => {
    expect(packLabel("LITER", null)).toBe("");
    expect(packLabel("LITER", 250)).toBe("");
  });

  it("shows size and count together", () => {
    expect(packQtyLabel("MILLILITER", 250, 40)).toBe("250 ml × 40");
  });

  it("falls back to a plain quantity when there is no pack", () => {
    expect(packQtyLabel("LITER", null, 12)).toBe("12 L");
  });

  it("shows the volume those packs add up to", () => {
    expect(equivalentLabel("MILLILITER", 250, 40)).toBe("10 L");
    expect(equivalentLabel("GRAM", 500, 3)).toBe("1.5 kg");
  });

  it("has no equivalent to show for an ordinary unit, or an unknown pack size", () => {
    expect(equivalentLabel("LITER", null, 10)).toBeNull();
    expect(equivalentLabel("MILLILITER", null, 10)).toBeNull();
  });
});

describe("packSizeProblem — the one validation rule", () => {
  it("requires a size for a pack unit", () => {
    expect(packSizeProblem("MILLILITER", 250)).toBeNull();
    expect(packSizeProblem("MILLILITER", null)).toContain("pack size");
    expect(packSizeProblem("MILLILITER", 0)).toContain("pack size");
    expect(packSizeProblem("GRAM", -1)).toContain("pack size");
  });

  it("refuses a size on a unit that has no packs", () => {
    expect(packSizeProblem("LITER", null)).toBeNull();
    expect(packSizeProblem("LITER", 250)).toContain("only applies");
  });
});

describe("display order", () => {
  it("keeps the farm's own units first and packs last", () => {
    const sorted = ["GRAM", "PIECE", "LITER", "MILLILITER", "KG"].sort(
      (a, b) => unitSortOrder(a) - unitSortOrder(b)
    );
    expect(sorted).toEqual(["LITER", "KG", "PIECE", "MILLILITER", "GRAM"]);
  });

  it("puts anything unrecognised at the end", () => {
    expect(unitSortOrder("DOZEN")).toBe(UNITS.length);
  });
});

describe("the admin picker labels", () => {
  it("spells each unit out", () => {
    expect(unitOptionLabel("MILLILITER")).toBe("Milliliter (ml)");
    expect(unitOptionLabel("LITER")).toBe("Liter (L)");
  });
});
describe("what a price is per", () => {
  it("prices a pack product per pack, never per millilitre", () => {
    expect(perUnitLabel("MILLILITER")).toBe("pack");
    expect(perUnitLabel("GRAM")).toBe("pack");
    expect(perUnitLabel("LITER")).toBe("L");
    expect(perUnitLabel(null)).toBe("");
  });

  it("counts packs on an invoice line rather than millilitres", () => {
    expect(qtyLabel("MILLILITER", 40)).toBe("40 packs");
    expect(qtyLabel("MILLILITER", 1)).toBe("1 pack");
    expect(qtyLabel("LITER", 12)).toBe("12 L");
    expect(qtyLabel("PIECE", 30)).toBe("30 pc");
  });
});
