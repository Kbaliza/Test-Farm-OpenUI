import { describe, it, expect, afterEach } from "vitest";
import { resetTestRole } from "../setup";
import { createProduct, addStock, onHand } from "../helpers";
import { getOnHandByProduct, getOnHandComponents, onHandFromComponents } from "@/lib/inventory-onhand";
import { getInventorySummary } from "@/app/(dashboard)/inventory/actions";

afterEach(() => resetTestRole());

// The Inventory Summary used to re-implement the on-hand arithmetic itself, with
// a comment conceding the two copies "must always move together". They are one
// copy now; this is the test that keeps them that way.
describe("the storage column and the stock guards agree", () => {
  it("every product's In storage equals its on-hand, exactly", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 87.5);

    const [summary, byProduct] = await Promise.all([
      getInventorySummary("month"),
      getOnHandByProduct(),
    ]);
    expect(summary.dbReady).toBe(true);
    expect(summary.products.length).toBeGreaterThan(0);

    for (const row of summary.products) {
      expect(row.inStorage, `${row.productName} (${row.productId})`)
        .toBeCloseTo(byProduct.get(row.productId) ?? 0, 3);
    }
  }, 180000);

  it("the components run through the formula give the same number again", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 40);

    const [components, byProduct] = await Promise.all([
      getOnHandComponents(),
      getOnHandByProduct(),
    ]);
    for (const [productId, c] of components) {
      expect(onHandFromComponents(c)).toBeCloseTo(byProduct.get(productId) ?? 0, 3);
    }
    expect(await onHand(p.id)).toBeCloseTo(40, 3);
  }, 180000);

  it("a product the summary hides is still counted by the guards", async () => {
    // The summary filters out retail products and Ghee; on-hand deliberately
    // does not, because the counter can still sell them.
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const summary = await getInventorySummary("month");
    const byProduct = await getOnHandByProduct();

    expect(summary.products.some((r) => r.productId === bottle.id)).toBe(false);
    expect(byProduct.has(bottle.id)).toBe(true);
  }, 180000);
});
