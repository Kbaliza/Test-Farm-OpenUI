import { describe, it, expect } from "vitest";
import { db } from "../setup";
import { createProduct, createRetailVendor, addStock, onHand, snapshotHeads } from "../helpers";
import {
  addRetailStock,
  createRetailPlacement,
  resolveRetailPlacement,
  recordRetailReceipt,
  voidRetailPlacement,
  getRetailMarts,
} from "@/app/(dashboard)/retail/actions";
import { createOtcSale } from "@/app/(dashboard)/over-the-counter/sale/actions";
import { getDayProductionUsage } from "@/app/(dashboard)/inventory/production/actions";
import { lockedUse } from "@/lib/reconciliation-guard";
import { todayPKTString } from "@/lib/pkt";
import { getCatalog } from "@/app/(dashboard)/customers/actions";
import { getPreDeliveryContext } from "@/app/(dashboard)/customers/pre-delivery/actions";
import { getWastageData } from "@/app/(dashboard)/inventory/wastage/actions";
import { getProductionContext } from "@/app/(dashboard)/inventory/production/actions";
import { getWasteEntryContext } from "@/app/(dashboard)/inventory/waste-entry/actions";
import { getInventorySummary } from "@/app/(dashboard)/inventory/actions";

async function placementIdOf(placementNo: string) {
  const p = await db.retailPlacement.findUnique({ where: { placementNo }, include: { lines: true } });
  if (!p) throw new Error(`placement ${placementNo} not found`);
  return p;
}

describe("dropping product at a mart", () => {
  it("takes the stock out of storage exactly once", async () => {
    const p = await createProduct({ defaultRate: 100 });
    const mart = await createRetailVendor();
    await addStock(p.id, 100);
    const before = await onHand(p.id);

    const res = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 20, rate: 120 }],
    });
    expect(res.ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(before - 20, 3);
  });

  it("writes no inventory movement at all — the line IS the record", async () => {
    const p = await createProduct({ defaultRate: 100 });
    const mart = await createRetailVendor();
    await addStock(p.id, 50);
    const movesBefore = await db.inventoryMovement.count({ where: { productId: p.id } });

    const res = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 10, rate: 120 }],
    });
    expect(res.ok).toBe(true);
    expect(await db.inventoryMovement.count({ where: { productId: p.id } })).toBe(movesBefore);
  });

  it("refuses more than is in storage", async () => {
    const p = await createProduct();
    const mart = await createRetailVendor();
    await addStock(p.id, 5);
    const res = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 50, rate: 120 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Not enough");
  });

  it("counts the same product on two lines together against stock", async () => {
    const p = await createProduct();
    const mart = await createRetailVendor();
    await addStock(p.id, 10);
    const res = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [
        { productId: p.id, quantity: 6, rate: 120 },
        { productId: p.id, quantity: 6, rate: 120 },
      ],
    });
    expect(res.ok).toBe(false);
  });

  it("refuses nonsense quantities and rates", async () => {
    const p = await createProduct();
    const mart = await createRetailVendor();
    await addStock(p.id, 50);
    const bad = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 10, rate: Number.NaN }],
    });
    expect(bad.ok).toBe(false);

    const threeDp = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 10.555, rate: 120 }],
    });
    expect(threeDp.ok).toBe(false);
  });

  it("refuses fractional pieces", async () => {
    const eggs = await createProduct({ unit: "PIECE", defaultRate: 30 });
    const mart = await createRetailVendor();
    await addStock(eggs.id, 100);
    const res = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: eggs.id, quantity: 10.5, rate: 33 }],
    });
    expect(res.ok).toBe(false);
  });
});

describe("reporting what sold", () => {
  it("moves money, never stock", async () => {
    const p = await createProduct({ defaultRate: 100 });
    const mart = await createRetailVendor();
    await addStock(p.id, 100);
    const drop = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 20, rate: 120 }],
    });
    if (!drop.ok) throw new Error("drop failed");
    const placement = await placementIdOf(drop.placementNo);
    const stockAfterDrop = await onHand(p.id);
    const movesAfterDrop = await db.inventoryMovement.count({ where: { productId: p.id } });

    const res = await resolveRetailPlacement({
      placementId: placement.id,
      date: todayPKTString(),
      entries: [{ lineId: placement.lines[0].id, soldQty: 12, wastedQty: 5 }],
    });
    expect(res.ok).toBe(true);

    // The milk left when it was dropped — reporting it changes nothing physical.
    expect(await onHand(p.id)).toBeCloseTo(stockAfterDrop, 3);
    expect(await db.inventoryMovement.count({ where: { productId: p.id } })).toBe(movesAfterDrop);

    // They owe for the sold part only.
    const recv = await db.retailReceivable.findMany({ where: { retailVendorId: mart.id } });
    expect(recv).toHaveLength(1);
    expect(Number(recv[0].amount)).toBeCloseTo(12 * 120, 2);
  });

  it("never lets a shop report more than it was left with", async () => {
    const p = await createProduct();
    const mart = await createRetailVendor();
    await addStock(p.id, 100);
    const drop = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 10, rate: 120 }],
    });
    if (!drop.ok) throw new Error("drop failed");
    const placement = await placementIdOf(drop.placementNo);

    const tooMuch = await resolveRetailPlacement({
      placementId: placement.id,
      date: todayPKTString(),
      entries: [{ lineId: placement.lines[0].id, soldQty: 8, wastedQty: 5 }],
    });
    expect(tooMuch.ok).toBe(false);
    if (!tooMuch.ok) expect(tooMuch.error).toContain("unaccounted");
  });

  it("can be reported in parts, and closes exactly", async () => {
    const p = await createProduct();
    const mart = await createRetailVendor();
    await addStock(p.id, 100);
    const drop = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 10, rate: 100 }],
    });
    if (!drop.ok) throw new Error("drop failed");
    const placement = await placementIdOf(drop.placementNo);
    const lineId = placement.lines[0].id;

    const first = await resolveRetailPlacement({
      placementId: placement.id, date: todayPKTString(),
      entries: [{ lineId, soldQty: 6, wastedQty: 1 }],
    });
    expect(first.ok).toBe(true);

    const second = await resolveRetailPlacement({
      placementId: placement.id, date: todayPKTString(),
      entries: [{ lineId, soldQty: 3, wastedQty: 0 }],
    });
    expect(second.ok).toBe(true);

    const third = await resolveRetailPlacement({
      placementId: placement.id, date: todayPKTString(),
      entries: [{ lineId, soldQty: 1, wastedQty: 0 }],
    });
    expect(third.ok).toBe(false);

    // The running totals and the audit trail agree.
    const line = await db.retailPlacementLine.findUnique({ where: { id: lineId } });
    expect(Number(line!.soldQty)).toBeCloseTo(9, 3);
    expect(Number(line!.wastedQty)).toBeCloseTo(1, 3);
    const trail = await db.retailResolutionLine.findMany({ where: { placementLineId: lineId } });
    expect(trail.reduce((s, r) => s + Number(r.soldQty), 0)).toBeCloseTo(9, 3);
  });

  it("charges nothing when everything expired", async () => {
    const p = await createProduct();
    const mart = await createRetailVendor();
    await addStock(p.id, 50);
    const drop = await createRetailPlacement({
      retailVendorId: mart.id, date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 8, rate: 100 }],
    });
    if (!drop.ok) throw new Error("drop failed");
    const placement = await placementIdOf(drop.placementNo);

    const res = await resolveRetailPlacement({
      placementId: placement.id, date: todayPKTString(),
      entries: [{ lineId: placement.lines[0].id, soldQty: 0, wastedQty: 8 }],
    });
    expect(res.ok).toBe(true);
    expect(await db.retailReceivable.count({ where: { retailVendorId: mart.id } })).toBe(0);
  });

  it("cannot pollute the reconciliation editor", async () => {
    const p = await createProduct();
    const mart = await createRetailVendor();
    await addStock(p.id, 100);
    const day = todayPKTString();

    const usageBefore = (await getDayProductionUsage(day)).find((r) => r.productId === p.id);
    const lockedBefore = usageBefore
      ? lockedUse({ name: p.name, unit: p.unit, producedLinked: usageBefore.producedLinked, yoghurtUse: usageBefore.yoghurtUse, skimUse: usageBefore.skimUse, wastage: usageBefore.wastage, dispatched: usageBefore.dispatched })
      : 0;

    const drop = await createRetailPlacement({
      retailVendorId: mart.id, date: day,
      lines: [{ productId: p.id, quantity: 10, rate: 100 }],
    });
    if (!drop.ok) throw new Error("drop failed");
    const placement = await placementIdOf(drop.placementNo);
    await resolveRetailPlacement({
      placementId: placement.id, date: day,
      entries: [{ lineId: placement.lines[0].id, soldQty: 4, wastedQty: 6 }],
    });

    const usageAfter = (await getDayProductionUsage(day)).find((r) => r.productId === p.id);
    const lockedAfter = usageAfter
      ? lockedUse({ name: p.name, unit: p.unit, producedLinked: usageAfter.producedLinked, yoghurtUse: usageAfter.yoghurtUse, skimUse: usageAfter.skimUse, wastage: usageAfter.wastage, dispatched: usageAfter.dispatched })
      : 0;

    // 6 units expired at the shop, and the farm's own day is untouched by it.
    expect(lockedAfter).toBeCloseTo(lockedBefore, 3);
    expect(usageAfter?.wastage ?? 0).toBeCloseTo(usageBefore?.wastage ?? 0, 3);
  });
});

describe("collecting the money", () => {
  it("credits the head, applies oldest debt first, and refuses over-collection", async () => {
    const p = await createProduct();
    const mart = await createRetailVendor();
    await addStock(p.id, 200);
    const delta = await snapshotHeads(["CASH"]);

    // Two separate sales, so FIFO has something to choose between.
    for (const qty of [5, 4]) {
      const drop = await createRetailPlacement({
        retailVendorId: mart.id, date: todayPKTString(),
        lines: [{ productId: p.id, quantity: qty, rate: 100 }],
      });
      if (!drop.ok) throw new Error("drop failed");
      const placement = await placementIdOf(drop.placementNo);
      await resolveRetailPlacement({
        placementId: placement.id, date: todayPKTString(),
        entries: [{ lineId: placement.lines[0].id, soldQty: qty, wastedQty: 0 }],
      });
    }
    // Owed: 500 then 400.
    const paid = await recordRetailReceipt({ retailVendorId: mart.id, amount: 600, head: "CASH" });
    expect(paid.ok).toBe(true);
    expect(await delta("CASH")).toBeCloseTo(600, 2);

    const rows = await db.retailReceivable.findMany({ where: { retailVendorId: mart.id }, orderBy: { date: "asc" } });
    const settled = rows.map((r) => Number(r.received)).sort((a, b) => b - a);
    expect(settled[0]).toBeCloseTo(500, 2); // oldest filled first
    expect(settled[1]).toBeCloseTo(100, 2);

    const tooMuch = await recordRetailReceipt({ retailVendorId: mart.id, amount: 5000, head: "CASH" });
    expect(tooMuch.ok).toBe(false);
    if (!tooMuch.ok) expect(tooMuch.error).toContain("only owes");
  }, 180_000);

  it("shows the balance on the marts list", async () => {
    const p = await createProduct();
    const mart = await createRetailVendor();
    await addStock(p.id, 100);
    const drop = await createRetailPlacement({
      retailVendorId: mart.id, date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 10, rate: 100 }],
    });
    if (!drop.ok) throw new Error("drop failed");
    const placement = await placementIdOf(drop.placementNo);
    await resolveRetailPlacement({
      placementId: placement.id, date: todayPKTString(),
      entries: [{ lineId: placement.lines[0].id, soldQty: 7, wastedQty: 1 }],
    });

    const data = await getRetailMarts();
    const row = data.marts.find((m) => m.id === mart.id)!;
    expect(row.balanceOwed).toBeCloseTo(700, 2);
    expect(row.stockOutValue).toBeCloseTo(200, 2); // 2 units still on the shelf
  });
});

describe("voiding a drop", () => {
  it("returns the stock exactly", async () => {
    const p = await createProduct();
    const mart = await createRetailVendor();
    await addStock(p.id, 100);
    const before = await onHand(p.id);

    const drop = await createRetailPlacement({
      retailVendorId: mart.id, date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 15, rate: 100 }],
    });
    if (!drop.ok) throw new Error("drop failed");
    const placement = await placementIdOf(drop.placementNo);
    expect(await onHand(p.id)).toBeCloseTo(before - 15, 3);

    const res = await voidRetailPlacement(placement.id, "recorded by mistake");
    expect(res.ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(before, 3);
  });

  it("refuses once the shop has reported on it", async () => {
    const p = await createProduct();
    const mart = await createRetailVendor();
    await addStock(p.id, 100);
    const drop = await createRetailPlacement({
      retailVendorId: mart.id, date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 10, rate: 100 }],
    });
    if (!drop.ok) throw new Error("drop failed");
    const placement = await placementIdOf(drop.placementNo);
    await resolveRetailPlacement({
      placementId: placement.id, date: todayPKTString(),
      entries: [{ lineId: placement.lines[0].id, soldQty: 1, wastedQty: 0 }],
    });

    const res = await voidRetailPlacement(placement.id, "changed my mind");
    expect(res.ok).toBe(false);
  });
});

describe("a counter sale to a mart", () => {
  it("bills the shop without touching vendor receivables", async () => {
    const p = await createProduct({ defaultRate: 100 });
    const mart = await createRetailVendor();
    await addStock(p.id, 100);
    const vendorRecvBefore = await db.vendorReceivable.count();
    const stockBefore = await onHand(p.id);

    const res = await createOtcSale({
      date: "",
      customerType: "RETAIL",
      retailVendorId: mart.id,
      deliveryCharge: 0,
      paidAmount: 0,
      lines: [{ productId: p.id, unit: "LITER", rate: 100, quantity: 6 }],
    });
    expect(res.ok).toBe(true);

    // An outright sale DOES move stock — unlike a consignment drop, it is sold.
    expect(await onHand(p.id)).toBeCloseTo(stockBefore - 6, 3);
    const recv = await db.retailReceivable.findMany({ where: { retailVendorId: mart.id, source: "OTC" } });
    expect(recv).toHaveLength(1);
    expect(Number(recv[0].amount)).toBeCloseTo(600, 2);
    expect(await db.vendorReceivable.count()).toBe(vendorRecvBefore);
  });
});

describe("retail products are stock-tracked now", () => {
  it("a drop is REFUSED when none has been counted in", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250, defaultRate: 120 });
    const mart = await createRetailVendor();
    expect(await onHand(bottle.id)).toBeCloseTo(0, 3);
    const before = await db.retailPlacement.count();

    const res = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: bottle.id, quantity: 40, rate: 120 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(bottle.name);
    expect(await db.retailPlacement.count()).toBe(before);
  });

  it("once stock is counted in, the same drop goes through and deducts it", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250, defaultRate: 120 });
    const mart = await createRetailVendor();
    expect((await addRetailStock({ productId: bottle.id, quantity: 100 })).ok).toBe(true);
    expect(await onHand(bottle.id)).toBeCloseTo(100, 3);

    const res = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: bottle.id, quantity: 40, rate: 120 }],
    });
    expect(res.ok).toBe(true);
    expect(await onHand(bottle.id)).toBeCloseTo(60, 3);

    const placement = await placementIdOf((res as { placementNo: string }).placementNo);
    // The pack size is still snapshotted, so editing the product cannot rewrite it.
    expect(Number(placement.lines[0].packSize)).toBeCloseTo(250, 3);
  });

  it("refuses a mixed drop when the RETAIL line is the short one", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const milk = await createProduct({ defaultRate: 100 });
    const mart = await createRetailVendor();
    await addRetailStock({ productId: bottle.id, quantity: 10 });
    await addStock(milk.id, 50);
    const before = await db.retailPlacement.count();

    const res = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [
        { productId: bottle.id, quantity: 40, rate: 120 },
        { productId: milk.id, quantity: 20, rate: 120 },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(bottle.name);
    expect(await db.retailPlacement.count()).toBe(before);
    expect(await onHand(milk.id)).toBeCloseTo(50, 3);
  });

  it("refuses a mixed drop when the MILK line is the short one", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const milk = await createProduct({ defaultRate: 100 });
    const mart = await createRetailVendor();
    await addRetailStock({ productId: bottle.id, quantity: 100 });
    await addStock(milk.id, 50);
    const before = await db.retailPlacement.count();

    const res = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [
        { productId: bottle.id, quantity: 40, rate: 120 },
        { productId: milk.id, quantity: 100, rate: 120 },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(milk.name);
    expect(await db.retailPlacement.count()).toBe(before);
    expect(await onHand(bottle.id)).toBeCloseTo(100, 3);
  });

  it("a mixed drop within stock deducts BOTH lines", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const milk = await createProduct({ defaultRate: 100 });
    const mart = await createRetailVendor();
    await addRetailStock({ productId: bottle.id, quantity: 100 });
    await addStock(milk.id, 50);

    const res = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [
        { productId: bottle.id, quantity: 40, rate: 120 },
        { productId: milk.id, quantity: 20, rate: 120 },
      ],
    });
    expect(res.ok).toBe(true);
    expect(await onHand(milk.id)).toBeCloseTo(30, 3);
    expect(await onHand(bottle.id)).toBeCloseTo(60, 3);
  });

  it("the same bottle on two lines is checked on the TOTAL", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const mart = await createRetailVendor();
    await addRetailStock({ productId: bottle.id, quantity: 50 });

    const res = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [
        { productId: bottle.id, quantity: 30, rate: 120 },
        { productId: bottle.id, quantity: 30, rate: 120 },
      ],
    });
    expect(res.ok).toBe(false);
    expect(await onHand(bottle.id)).toBeCloseTo(50, 3);
  });

  it("is counted in whole packs — half a bottle is refused", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const mart = await createRetailVendor();
    await addRetailStock({ productId: bottle.id, quantity: 50 });
    const res = await createRetailPlacement({
      retailVendorId: mart.id,
      date: todayPKTString(),
      lines: [{ productId: bottle.id, quantity: 10.5, rate: 120 }],
    });
    expect(res.ok).toBe(false);
  });

  it("adding stock is refused for farm products, and in part-packs", async () => {
    const milk = await createProduct({ defaultRate: 100 });
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const bad = await addRetailStock({ productId: milk.id, quantity: 10 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("farm stock");
    expect((await addRetailStock({ productId: bottle.id, quantity: 2.5 })).ok).toBe(false);
    expect((await addRetailStock({ productId: bottle.id, quantity: 0 })).ok).toBe(false);
    expect(await onHand(milk.id)).toBeCloseTo(0, 3);
  });

  it("expiry moves money, not stock — and stays off the farm wastage log", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250, defaultRate: 120 });
    const mart = await createRetailVendor();
    await addRetailStock({ productId: bottle.id, quantity: 30 });
    const drop = await createRetailPlacement({
      retailVendorId: mart.id, date: todayPKTString(),
      lines: [{ productId: bottle.id, quantity: 10, rate: 120 }],
    });
    if (!drop.ok) throw new Error("drop failed");
    const placement = await placementIdOf(drop.placementNo);
    expect(await onHand(bottle.id)).toBeCloseTo(20, 3);

    await resolveRetailPlacement({
      placementId: placement.id, date: todayPKTString(),
      entries: [{ lineId: placement.lines[0].id, soldQty: 6, wastedQty: 4 }],
    });
    // The stock left when it was dropped; reporting only decides who owns the money.
    expect(await onHand(bottle.id)).toBeCloseTo(20, 3);

    const wastage = await getWastageData();
    expect(wastage.entries.filter((e) => e.productName === bottle.name)).toHaveLength(0);

    const recv = await db.retailReceivable.findMany({ where: { retailVendorId: mart.id } });
    expect(Number(recv[0].amount)).toBeCloseTo(720, 2);
  });

  it("stays off the milk-pipeline screens", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    await addRetailStock({ productId: bottle.id, quantity: 40 });

    const production = await getProductionContext();
    expect(production.products.some((p) => p.id === bottle.id)).toBe(false);

    const waste = await getWasteEntryContext();
    expect(waste.products.some((p) => p.id === bottle.id)).toBe(false);

    // Not among the milk product rows — those are litres and kilograms — but it
    // does get its own section on the storage screen, with its stock in packs.
    const summary = await getInventorySummary("today");
    expect(summary.products.some((p) => p.productId === bottle.id)).toBe(false);
    const row = summary.retailProducts.find((p) => p.productId === bottle.id);
    expect(row).toBeTruthy();
    expect(row!.inStorage).toBeCloseTo(40, 3);
  });

  it("is never offered for a customer's round", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const milk = await createProduct({ defaultRate: 100 });

    // What a customer can subscribe to.
    const catalog = await getCatalog();
    expect(catalog.products.some((p) => p.id === bottle.id)).toBe(false);
    expect(catalog.products.some((p) => p.id === milk.id)).toBe(true);

    // What the shift editor offers, including its rider-extras dialog.
    const shiftCtx = await getPreDeliveryContext();
    expect(shiftCtx.products.some((p) => p.productId === bottle.id)).toBe(false);
    expect(shiftCtx.products.some((p) => p.productId === milk.id)).toBe(true);
  });
});
