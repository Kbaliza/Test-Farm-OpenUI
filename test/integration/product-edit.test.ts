import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, addStock } from "../helpers";
import { addProduct, updateProduct, getProducts } from "@/app/(dashboard)/inventory/products/actions";

afterEach(() => resetTestRole());

/** Read one product straight from the database, past any caching. */
async function row(id: string) {
  const p = await db.product.findUniqueOrThrow({ where: { id } });
  return {
    name: p.name,
    unit: p.unit,
    rate: Number(p.defaultRate),
    retailOnly: p.retailOnly,
    packSize: p.packSize == null ? null : Number(p.packSize),
  };
}

describe("editing a product — the whole form, not just the rate", () => {
  it("renames and re-rates, leaving everything else alone", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    const renamed = `${p.name}_renamed`;

    const res = await updateProduct(p.id, { name: renamed, unit: "LITER", defaultRate: 145 });
    expect(res.ok).toBe(true);
    expect(await row(p.id)).toMatchObject({ name: renamed, unit: "LITER", rate: 145, retailOnly: false });
  });

  it("changes the unit of a stock-tracked product", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    const res = await updateProduct(p.id, { name: p.name, unit: "KG", defaultRate: 100 });
    expect(res.ok).toBe(true);
    expect((await row(p.id)).unit).toBe("KG");
  });

  it("changes a bottle's pack size, and the rate that goes with it", async () => {
    const p = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250, defaultRate: 120 });
    const res = await updateProduct(p.id, {
      name: p.name, unit: "MILLILITER", defaultRate: 150, packSize: 350, retailOnly: true,
    });
    expect(res.ok).toBe(true);
    expect(await row(p.id)).toMatchObject({ unit: "MILLILITER", packSize: 350, rate: 150 });
  });

  it("clears the pack size when the product stops being sold in packs", async () => {
    const p = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250, defaultRate: 120 });
    const res = await updateProduct(p.id, {
      name: p.name, unit: "LITER", defaultRate: 120, packSize: 250, retailOnly: true,
    });
    expect(res.ok).toBe(true);
    expect(await row(p.id)).toMatchObject({ unit: "LITER", packSize: null });
  });

  it("refuses a pack unit on a stock-tracked product, and writes nothing", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    const res = await updateProduct(p.id, { name: p.name, unit: "MILLILITER", defaultRate: 100, packSize: 250 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("etail only");
    expect(await row(p.id)).toMatchObject({ unit: "LITER", packSize: null });
  });

  it("refuses a pack unit with no pack size", async () => {
    const p = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const res = await updateProduct(p.id, {
      name: p.name, unit: "GRAM", defaultRate: 10, packSize: null, retailOnly: true,
    });
    expect(res.ok).toBe(false);
    expect((await row(p.id)).unit).toBe("MILLILITER"); // untouched
  });

  it("refuses an empty name and a negative rate", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    expect((await updateProduct(p.id, { name: "  ", unit: "LITER", defaultRate: 100 })).ok).toBe(false);
    expect((await updateProduct(p.id, { name: p.name, unit: "LITER", defaultRate: -5 })).ok).toBe(false);
    expect(await row(p.id)).toMatchObject({ name: p.name, rate: 100 });
  });

  it("refuses a name another product already has", async () => {
    const a = await createProduct({ unit: "LITER" });
    const b = await createProduct({ unit: "LITER" });
    const res = await updateProduct(b.id, { name: a.name, unit: "LITER", defaultRate: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already exists");
    expect((await row(b.id)).name).toBe(b.name);
  });

  it("refuses to edit a product that is gone", async () => {
    const p = await createProduct({ unit: "LITER" });
    await db.product.delete({ where: { id: p.id } });
    const res = await updateProduct(p.id, { name: "Anything", unit: "LITER", defaultRate: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no longer exists");
  });
});

describe("the retail-only flag settles once stock has moved", () => {
  it("can be turned on while the product has no history", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    const res = await updateProduct(p.id, {
      name: p.name, unit: "LITER", defaultRate: 100, retailOnly: true,
    });
    expect(res.ok).toBe(true);
    expect((await row(p.id)).retailOnly).toBe(true);
  });

  it("is refused once the product has stock history, and nothing else is saved either", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    await addStock(p.id, 50); // an arrival — there is real stock behind it now

    const res = await updateProduct(p.id, {
      name: `${p.name}_x`, unit: "LITER", defaultRate: 999, retailOnly: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("stock history");
    // The whole edit is refused — no half-applied rename or rate.
    expect(await row(p.id)).toMatchObject({ name: p.name, rate: 100, retailOnly: false });
  });

  it("leaving the flag alone never triggers the history check", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    await addStock(p.id, 50);
    // No retailOnly passed at all — an ordinary edit on a product with history.
    const res = await updateProduct(p.id, { name: p.name, unit: "LITER", defaultRate: 130 });
    expect(res.ok).toBe(true);
    expect(await row(p.id)).toMatchObject({ rate: 130, retailOnly: false });
  });
});

describe("the add path still validates the same way", () => {
  it("rejects a pack unit that is not retail-only", async () => {
    setTestRole("ADMIN");
    const res = await addProduct({ name: `__TEST_bad_${Date.now()}`, unit: "MILLILITER", defaultRate: 10 });
    expect(res.ok).toBe(false);
  });

  it("lists a product's pack size back through getProducts", async () => {
    const p = await createProduct({ retailOnly: true, unit: "GRAM", packSize: 500, defaultRate: 80 });
    const { products } = await getProducts();
    expect(products.find((x) => x.id === p.id)).toMatchObject({
      unit: "GRAM", packSize: 500, retailOnly: true,
    });
  });
});
