import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, onHand, inRetail, uniq } from "../helpers";
import { STOCK_RESET_KEY } from "@/lib/stock-reset";
import { ACCEPTED_AT_PACKAGING } from "@/lib/packaging-stock";
import { todayPKTString, addDaysToDateStr, pktNoonToUTC } from "@/lib/pkt";

describe("a stock reset settles what came before it", () => {
  it("stops an old round and an old mart drop from holding stock out for ever", async () => {
    const p = await createProduct({ unit: "LITER" });
    const shift = await db.shift.create({ data: { name: uniq("shift") } });
    const customer = await createCustomer({ shiftId: shift.id });
    const old = addDaysToDateStr(todayPKTString(), -3);
    // An old round that was completed, and an old mart drop — both from before.
    const route = await db.route.create({
      data: { shiftId: shift.id, date: pktNoonToUTC(old), createdAt: pktNoonToUTC(old), status: "COMPLETED", completedAt: pktNoonToUTC(old) },
    });
    const stop = await db.routeStop.create({ data: { routeId: route.id, customerId: customer.id, stopNumber: 1 } });
    await db.routeStopItem.create({ data: { routeStopId: stop.id, productId: p.id, plannedQty: 40 } });
    const vendor = await db.retailVendor.create({ data: { name: uniq("mart") } });
    const placement = await db.retailPlacement.create({
      data: { date: pktNoonToUTC(old), createdAt: pktNoonToUTC(old), placementNo: uniq("RP"), retailVendorId: vendor.id },
    });
    await db.retailPlacementLine.create({ data: { placementId: placement.id, productId: p.id, quantity: 25, rate: 100, unit: "LITER" } });
    cleanups.push(async () => {
      await db.$executeRaw`DELETE FROM "AppSetting" WHERE key = ${STOCK_RESET_KEY}`;
      await db.retailPlacementLine.deleteMany({ where: { placementId: placement.id } });
      await db.retailPlacement.delete({ where: { id: placement.id } }).catch(() => {});
      await db.retailVendor.delete({ where: { id: vendor.id } }).catch(() => {});
      await db.routeStopItem.deleteMany({ where: { routeStop: { routeId: route.id } } });
      await db.routeStop.deleteMany({ where: { routeId: route.id } });
      await db.route.delete({ where: { id: route.id } }).catch(() => {});
      await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
    });

    // 50 L that arrived two days ago, and 30 L arriving now. The old round and
    // drop swallow the first on its own — (50 − 40) − 25 → 0 — and leave 15 of
    // the two together. Both arrivals are about to be settled with them.
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const oldArrival = await db.inventoryMovement.create({
      data: { date: twoDaysAgo, createdAt: twoDaysAgo, type: "ARRIVED", productId: p.id, quantity: 50, reason: ACCEPTED_AT_PACKAGING },
    });
    cleanups.push(async () => { await db.inventoryMovement.delete({ where: { id: oldArrival.id } }).catch(() => {}); });
    expect(await onHand(p.id)).toBeCloseTo(0, 3);

    const line = new Date(Date.now() - 60_000); // a minute ago: after the old rows, before the new
    await db.inventoryMovement.create({ data: { date: new Date(), type: "ARRIVED", productId: p.id, quantity: 30, reason: ACCEPTED_AT_PACKAGING } });
    expect(await onHand(p.id)).toBeCloseTo(15, 3); // (80 − 40) − 25

    // Draw the line: the old round, the old drop AND the old arrival are all
    // settled — only the 30 L written since the line is still stock.
    const at = line.toISOString();
    await db.$executeRaw`
      INSERT INTO "AppSetting" (key, value, "updatedAt") VALUES (${STOCK_RESET_KEY}, ${at}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = NOW()`;
    expect(await onHand(p.id)).toBeCloseTo(30, 3);

    // And once it is removed, every one of them counts again — nothing was deleted.
    await db.$executeRaw`DELETE FROM "AppSetting" WHERE key = ${STOCK_RESET_KEY}`;
    expect(await onHand(p.id)).toBeCloseTo(15, 3);
  }, 240_000);

  it("what is recorded AFTER the line still comes off, whatever day it is dated", async () => {
    const p = await createProduct({ unit: "LITER" });
    const shift = await db.shift.create({ data: { name: uniq("shift") } });
    const customer = await createCustomer({ shiftId: shift.id });
    const vendor = await db.retailVendor.create({ data: { name: uniq("mart") } });
    cleanups.push(async () => {
      await db.$executeRaw`DELETE FROM "AppSetting" WHERE key = ${STOCK_RESET_KEY}`;
      await db.retailPlacementLine.deleteMany({ where: { placement: { retailVendorId: vendor.id } } });
      await db.retailPlacement.deleteMany({ where: { retailVendorId: vendor.id } });
      await db.retailVendor.delete({ where: { id: vendor.id } }).catch(() => {});
      await db.routeStopItem.deleteMany({ where: { routeStop: { route: { shiftId: shift.id } } } });
      await db.routeStop.deleteMany({ where: { route: { shiftId: shift.id } } });
      await db.route.deleteMany({ where: { shiftId: shift.id } });
      await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
    });

    // The line is drawn now, and 100 L arrives after it.
    const at = new Date().toISOString();
    await db.$executeRaw`
      INSERT INTO "AppSetting" (key, value, "updatedAt") VALUES (${STOCK_RESET_KEY}, ${at}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = NOW()`;
    await db.inventoryMovement.create({ data: { date: new Date(), type: "ARRIVED", productId: p.id, quantity: 100, reason: ACCEPTED_AT_PACKAGING } });
    expect(await onHand(p.id)).toBeCloseTo(100, 3);

    // Both of these are recorded after the line but DATED today — earlier in the
    // day than the line itself. Under the old day-based rule they fell on the
    // settled side and took nothing out of anyone's stock.
    const placement = await db.retailPlacement.create({
      data: { date: pktNoonToUTC(todayPKTString()), placementNo: uniq("RP"), retailVendorId: vendor.id },
    });
    await db.retailPlacementLine.create({ data: { placementId: placement.id, productId: p.id, quantity: 25, rate: 100, unit: "LITER" } });
    expect(await onHand(p.id)).toBeCloseTo(75, 3); // the mart drop comes off storage

    const route = await db.route.create({
      data: { shiftId: shift.id, date: pktNoonToUTC(todayPKTString()), status: "IN_PROGRESS" },
    });
    const stop = await db.routeStop.create({ data: { routeId: route.id, customerId: customer.id, stopNumber: 1 } });
    await db.routeStopItem.create({ data: { routeStopId: stop.id, productId: p.id, plannedQty: 60 } });
    expect(await inRetail(p.id)).toBeCloseTo(-60, 3); // today's round comes off Retail
  }, 240_000);
});
