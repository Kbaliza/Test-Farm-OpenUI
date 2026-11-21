import { describe, it, expect } from "vitest";
import { db } from "../setup";
import { createProduct, addStock, inRetail, onHand, sendToRetailFor } from "../helpers";
import { getStockComponents } from "@/lib/inventory-onhand";

// A send is Retail's to load only once Retail accepts it. Until then it is on the
// way: off the farm store, not on Retail's shelf — so no route can be saved from it.
describe("In Retail counts only what Retail accepted", () => {
  it("an unaccepted send is on the way, not in Retail; accepting it puts it there", async () => {
    const milk = await createProduct({ unit: "LITER" });
    await addStock(milk.id, 100);
    const ref = await sendToRetailFor(milk.id, 60, false);

    expect(await inRetail(milk.id)).toBeCloseTo(0, 3);
    expect(await onHand(milk.id)).toBeCloseTo(40, 3);
    expect((await getStockComponents()).retail.get(milk.id)!.onTheWay).toBeCloseTo(60, 3);

    await db.retailDispatch.update({ where: { id: ref }, data: { status: "CONFIRMED" } });
    expect(await inRetail(milk.id)).toBeCloseTo(60, 3);
    expect(await onHand(milk.id)).toBeCloseTo(40, 3);
    expect((await getStockComponents()).retail.get(milk.id)!.onTheWay).toBeCloseTo(0, 3);
  }, 300_000);
});
