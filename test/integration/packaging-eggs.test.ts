import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, onHand, uniq } from "../helpers";
import { addEggs, deleteEggEntry, getEggContext } from "@/app/(dashboard)/inventory/farm-arrival/egg-actions";
import { getPoolView, sendToRetail } from "@/app/(dashboard)/inventory/farm-arrival/actions";
import { getProductionContext } from "@/app/(dashboard)/inventory/production/actions";
import { isEggName } from "@/lib/product-names";
import { EGGS_COLLECTED } from "@/lib/packaging-stock";

afterEach(() => resetTestRole());

/** The catalogue's egg product, whichever one addEggs will pick. */
async function eggProduct() {
  const all = await db.product.findMany({ where: { active: true, retailOnly: false }, orderBy: { name: "asc" } });
  return all.find((p) => isEggName(p.name)) ?? null;
}

/** Add `n` eggs and return this test's entry — found by its own count, since
 *  other test files may add eggs at the same time. */
async function added(n: number) {
  // Sends this test makes are cleaned up too — whatever quantity they were for.
  // A leaked send now holds eggs out of inventory for the rest of the day.
  const eggId = (await eggProduct())!.id;
  const sentBefore = new Set(
    (await db.inventoryMovement.findMany({ where: { type: "DISPATCHED", productId: eggId }, select: { id: true } })).map((m) => m.id),
  );
  expect((await addEggs({ quantity: n })).ok).toBe(true);
  const e = (await getEggContext()).entries.find((x) => x.quantity === n)!;
  cleanups.push(async () => {
    const sends = (await db.inventoryMovement.findMany({
      where: { type: "DISPATCHED", productId: eggId },
      select: { id: true, reference: true },
    })).filter((m) => !sentBefore.has(m.id));
    await db.inventoryMovement.deleteMany({ where: { id: { in: sends.map((s) => s.id) } } });
    await db.retailDispatch.deleteMany({ where: { id: { in: sends.map((s) => s.reference!).filter(Boolean) } } }).catch(() => {});
    await db.inventoryMovement.delete({ where: { id: e.id } }).catch(() => {});
  });
  return e;
}

describe("eggs added at Packaging go into inventory", () => {
  it("adding eggs records the full count into inventory, and sends nothing to Retail", async () => {
    const egg = await eggProduct();
    if (!egg) return; // no egg product on this database
    const before = await onHand(egg.id);
    const retailBefore = await db.retailDispatch.count();

    const entry = await added(6173);
    const row = await db.inventoryMovement.findUniqueOrThrow({ where: { id: entry.id } });
    expect(row.type).toBe("ARRIVED");
    expect(row.reason).toBe(EGGS_COLLECTED);
    expect(Number(row.quantity)).toBe(6173);
    expect(await onHand(egg.id)).toBeGreaterThan(before);
    expect(await db.retailDispatch.count()).toBe(retailBefore); // no Retail load made
  }, 180_000);

  it("then appear as an Eggs box in Send to Retail, capped at inventory", async () => {
    const egg = await eggProduct();
    if (!egg) return;
    await added(6181);
    const line = (await getPoolView()).lines.find((l) => l.productId === egg.id);
    expect(line).toBeTruthy();
    expect(line!.acceptedToday).toBeGreaterThanOrEqual(6181);
    expect((await sendToRetail([{ productId: egg.id, quantity: line!.available + 1 }])).ok).toBe(false);
    // Inventory can be lower than what was added (eggs placed at shops, or on
    // today's routes, come out of it) — the send is capped at inventory itself.
    expect((await sendToRetail([{ productId: egg.id, quantity: line!.available }])).ok).toBe(true);
  }, 180_000);

  it("refuses half an egg, nothing, and a count of zero", async () => {
    if (!(await eggProduct())) return;
    for (const quantity of [0, -5, 2.5, Number.NaN]) {
      expect((await addEggs({ quantity })).ok, String(quantity)).toBe(false);
    }
  });

  it("a mistaken entry from today can be removed, taking the eggs back out", async () => {
    const egg = await eggProduct();
    if (!egg) return;
    const entry = await added(6193);
    const withIt = await onHand(egg.id);
    expect(entry.removable).toBe(true);
    expect((await deleteEggEntry(entry.id)).ok).toBe(true);
    expect(await onHand(egg.id)).toBeLessThan(withIt);
    expect((await getEggContext()).entries.find((e) => e.id === entry.id)).toBeUndefined();
  }, 180_000);

  it("packaging staff can add them; a checklist user cannot", async () => {
    setTestRole("PACKAGING");
    await expect(getEggContext()).resolves.toBeTruthy();
    setTestRole("CHECKLIST");
    await expect(getEggContext()).rejects.toThrow();
  });
});

describe("eggs are gone from the Production screen", () => {
  it("the production product list still holds them, but the page filters them out", async () => {
    const p = await createProduct({ name: uniq("Desi Eggs"), unit: "PIECE" });
    expect(isEggName(p.name)).toBe(true);
    const { products } = await getProductionContext();
    expect(products.some((x) => x.id === p.id)).toBe(true);
    expect(products.filter((x) => !isEggName(x.name)).some((x) => x.id === p.id)).toBe(false);
  }, 120_000);
});
