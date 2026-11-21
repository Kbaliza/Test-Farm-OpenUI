import { describe, it, expect, afterEach } from "vitest";
import { db, resetTestRole } from "../setup";
import { createProduct, createRetailVendor, addStock, onHand } from "../helpers";
import { getLedgerData, type LedgerRow } from "@/app/(dashboard)/ledgers/actions";
import { addRetailStock, createRetailPlacement } from "@/app/(dashboard)/retail/actions";
import { createOtcSale } from "@/app/(dashboard)/over-the-counter/sale/actions";
import { todayPKTString } from "@/lib/pkt";

afterEach(() => resetTestRole());

async function rowsFor(productId: string) {
  const res = await getLedgerData("product", productId);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

describe("the product ledger accounts for retail stock", () => {
  it("shows stock counted in, and a drop at a shop going out", async () => {
    const bottle = await createProduct({
      retailOnly: true, unit: "MILLILITER", packSize: 250, defaultRate: 120,
    });
    const mart = await createRetailVendor();

    await addRetailStock({ productId: bottle.id, quantity: 100 });
    const drop = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: bottle.id, quantity: 40, rate: 120 }],
    });
    expect(drop.ok).toBe(true);

    const led = await rowsFor(bottle.id);
    const inRow = led.rows.find((r: LedgerRow) => r.description.includes("Counted into retail stock"));
    const outRow = led.rows.find((r: LedgerRow) => r.description.includes("Dropped at"));
    expect(inRow?.credit).toBeCloseTo(100, 3);
    expect(outRow?.debit).toBeCloseTo(40, 3);

    // The running balance lands on what the stock screens say.
    expect(led.rows[led.rows.length - 1].balance).toBeCloseTo(60, 3);
    expect(await onHand(bottle.id)).toBeCloseTo(60, 3);
  }, 180000);

  it("a counter sale leaves the ledger too, so the balance keeps up", async () => {
    const bottle = await createProduct({
      retailOnly: true, unit: "MILLILITER", packSize: 250, defaultRate: 120,
    });
    await addRetailStock({ productId: bottle.id, quantity: 50 });
    const sale = await createOtcSale({
      date: "", customerType: "CASH", cashName: "Walk-in", deliveryCharge: 0,
      paidAmount: 10 * 120, paymentHead: "CASH",
      lines: [{ productId: bottle.id, unit: "MILLILITER", rate: 120, quantity: 10 }],
    });
    expect(sale.ok).toBe(true);

    const led = await rowsFor(bottle.id);
    expect(led.rows[led.rows.length - 1].balance).toBeCloseTo(40, 3);
    expect(await onHand(bottle.id)).toBeCloseTo(40, 3);
  }, 180000);

  it("a voided stock entry is not in the ledger at all", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    await addRetailStock({ productId: bottle.id, quantity: 30, note: "keep" });
    const entry = await db.retailStockEntry.findFirstOrThrow({ where: { productId: bottle.id } });
    await db.retailStockEntry.update({
      where: { id: entry.id },
      data: { voidedAt: new Date(), voidReason: "typo" },
    });

    const led = await rowsFor(bottle.id);
    expect(led.rows.some((r: LedgerRow) => r.description.includes("Counted into retail stock"))).toBe(false);
  }, 180000);
});

describe("the ledger no longer loses milk that left storage", () => {
  it("a mart drop of a farm product appears as stock out", async () => {
    const milk = await createProduct({ defaultRate: 100 });
    const mart = await createRetailVendor();
    await addStock(milk.id, 80);

    const drop = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: milk.id, quantity: 30, rate: 110 }],
    });
    expect(drop.ok).toBe(true);

    const led = await rowsFor(milk.id);
    const outRow = led.rows.find((r: LedgerRow) => r.description.includes("Dropped at"));
    expect(outRow).toBeTruthy();
    expect(outRow!.debit).toBeCloseTo(30, 3);
    expect(led.rows[led.rows.length - 1].balance).toBeCloseTo(50, 3);
    expect(await onHand(milk.id)).toBeCloseTo(50, 3);
  }, 180000);

  it("an ordinary purchase and sale still read the way they always did", async () => {
    const milk = await createProduct({ defaultRate: 100 });
    await addStock(milk.id, 25);
    const led = await rowsFor(milk.id);
    const inRow = led.rows.find((r: LedgerRow) => r.credit > 0);
    expect(inRow).toBeTruthy();
    expect(led.rows[led.rows.length - 1].balance).toBeCloseTo(25, 3);
  }, 180000);
});
