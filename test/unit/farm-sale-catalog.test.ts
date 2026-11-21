import { describe, it, expect } from "vitest";
import {
  FARM_SALE_CATEGORIES, FARM_SALE_BUYER_TYPES, FARM_SALE_WALKIN,
  isFarmSaleCategory, isValidUnit, unitsFor, itemsFor, detailFieldsFor,
  categoryHasTag, categoryLabel, cleanDetails, describeDetails,
} from "@/lib/farm-sale-catalog";

// The browser fills its dropdowns from this and the server validates against it, so
// anything wrong here is wrong in both places at once.

describe("every category is usable", () => {
  it.each(FARM_SALE_CATEGORIES)("$key has units and suggestions", (c) => {
    expect(c.units.length).toBeGreaterThan(0);
    expect(c.items.length).toBeGreaterThan(0);
    expect(c.label.trim()).not.toBe("");
  });

  it("no category key is repeated", () => {
    const keys = FARM_SALE_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("no category asks the same detail twice", () => {
    for (const c of FARM_SALE_CATEGORIES) {
      const ks = c.fields.map((f) => f.k);
      expect(new Set(ks).size, c.key).toBe(ks.length);
    }
  });

  it("only animals carry a tag — it is the one detail with its own column", () => {
    const tagged = FARM_SALE_CATEGORIES.filter((c) => c.hasTag).map((c) => c.key);
    expect(tagged).toEqual(["animal"]);
    expect(categoryHasTag("animal")).toBe(true);
    expect(categoryHasTag("feed")).toBe(false);
  });
});

describe("a unit belongs to its own category", () => {
  it("accepts the units a category offers", () => {
    expect(isValidUnit("animal", "head")).toBe(true);
    expect(isValidUnit("feed", "ton")).toBe(true);
    expect(isValidUnit("feed", "trolley")).toBe(true);
  });

  it("refuses a unit borrowed from another category", () => {
    // Silage is not sold by the head, and a buffalo is not sold by the bag.
    expect(isValidUnit("feed", "head")).toBe(false);
    expect(isValidUnit("animal", "ton")).toBe(false);
    expect(isValidUnit("machinery", "kg")).toBe(false);
  });

  it("refuses anything for an unknown category", () => {
    expect(isValidUnit("spaceship", "unit")).toBe(false);
    expect(unitsFor("spaceship")).toEqual([]);
    expect(itemsFor("spaceship")).toEqual([]);
    expect(detailFieldsFor("spaceship")).toEqual([]);
  });

  it("knows which categories exist", () => {
    expect(isFarmSaleCategory("animal")).toBe(true);
    expect(isFarmSaleCategory("")).toBe(false);
    expect(isFarmSaleCategory("ANIMAL")).toBe(false); // keys are lower-case
    expect(categoryLabel("feed")).toBe("Feed & fodder");
    expect(categoryLabel("unknown")).toBe("unknown"); // falls back, never throws
  });
});

describe("details are cleaned before they are stored", () => {
  it("keeps only what the category actually asked for", () => {
    // `moisture` belongs to feed, not to an animal — it must not ride along.
    const out = cleanDetails("animal", { weight: "420", status: "Dry", moisture: "60" });
    expect(out).toEqual({ weight: "420", status: "Dry" });
  });

  it("drops blanks so an untouched field is absent, not empty", () => {
    expect(cleanDetails("animal", { weight: "  ", status: "Dry" })).toEqual({ status: "Dry" });
  });

  it("returns null when nothing was filled in, so the column stays NULL", () => {
    expect(cleanDetails("animal", {})).toBeNull();
    expect(cleanDetails("animal", { weight: "" })).toBeNull();
    expect(cleanDetails("animal", undefined)).toBeNull();
    expect(cleanDetails("other", null)).toBeNull();
  });

  it("trims what it keeps", () => {
    expect(cleanDetails("machinery", { model: "  Massey 240 " })).toEqual({ model: "Massey 240" });
  });
});

describe("details read back the way a person wrote them", () => {
  it("labels each value and keeps the category's field order", () => {
    expect(describeDetails("animal", { status: "Dry", weight: "420" }))
      .toBe("Weight (kg): 420 · Status: Dry");
  });

  it("says nothing when there is nothing", () => {
    expect(describeDetails("animal", null)).toBe("");
    expect(describeDetails("animal", {})).toBe("");
  });
});

describe("buyer types", () => {
  it("is vendor or cash walk-in, and nothing else", () => {
    expect([...FARM_SALE_BUYER_TYPES]).toEqual(["VENDOR", "CASH"]);
  });

  it("the walk-in ledger sentinel cannot collide with a cuid", () => {
    expect(FARM_SALE_WALKIN).toBe("__walkin__");
  });
});
