import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createCustomer, createProduct, onHand, inRetail, sendToRetailFor, uniq } from "../helpers";
import {
  getReturnsBoard, getRiderReturnDetail, saveRiderReturnReview,
  getRetailReturnDetail, getRetailReturnRows, saveRetailReturnReview,
} from "@/app/(dashboard)/inventory/rider-returns/actions";
import { getWastageData } from "@/app/(dashboard)/inventory/wastage/actions";
import { ACCEPTED_AT_PACKAGING } from "@/lib/packaging-stock";
import { END_OF_SHIFT_RETURN_REASON } from "@/lib/rider-stock";
import { RIDER_RETURN_STAGE } from "@/lib/rider-return-math";
import { REVIEW_MISSING_REASON } from "@/lib/missing";
import { todayPKTString, pktNoonToUTC } from "@/lib/pkt";
import { STOCK_RESET_KEY } from "@/lib/stock-reset";

// Returned is not the same as usable. The rider app's returns already count as
// stock; this is the office deciding how much of it really is.

afterEach(() => resetTestRole());

const TODAY = todayPKTString();

async function shiftWithRider() {
  const user = await db.user.create({ data: { email: uniq("rd") + "@t.local", name: uniq("Rider"), role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const rider = await db.rider.create({ data: { userId: user.id } });
  const shift = await db.shift.create({ data: { name: uniq("shift"), riderId: rider.id } });
  cleanups.push(async () => {
    const reviews = await db.riderReturnReview.findMany({ where: { riderId: rider.id }, select: { id: true } });
    await db.inventoryMovement.deleteMany({ where: { reference: { in: reviews.map((r) => r.id) } } });
    await db.riderReturnLine.deleteMany({ where: { reviewId: { in: reviews.map((r) => r.id) } } });
    await db.riderReturnReview.deleteMany({ where: { riderId: rider.id } });
    await db.riderExtraItem.deleteMany({ where: { shiftId: shift.id } });
    await db.route.deleteMany({ where: { shiftId: shift.id } });
    await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return { shift, rider };
}

/** The rider app's own end-of-shift return: it already puts the stock back. */
const appReturn = (productId: string, riderId: string, quantity: number) =>
  db.inventoryMovement.create({
    data: { date: new Date(), type: "RETURNED", productId, quantity, reason: END_OF_SHIFT_RETURN_REASON, riderId },
  });

describe("splitting a rider's returns into stock and wastage", () => {
  it("takes the spoiled part back out, and leaves the usable part in", async () => {
    const p = await createProduct({ unit: "LITER" });
    await db.inventoryMovement.create({ data: { date: new Date(), type: "ARRIVED", productId: p.id, quantity: 100, reason: ACCEPTED_AT_PACKAGING } });
    await sendToRetailFor(p.id, 100);
    const { shift, rider } = await shiftWithRider();

    await appReturn(p.id, rider.id, 30);
    // The app's return is already back in stock — and it comes back to the FARM,
    // not to the retail centre, so it lands in inventory and Retail is untouched.
    expect(await onHand(p.id)).toBeCloseTo(30, 3);
    expect(await inRetail(p.id)).toBeCloseTo(100, 3);

    const detail = await getRiderReturnDetail(rider.id, TODAY);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.specs).toHaveLength(1);
    expect(detail.specs[0]).toMatchObject({ source: "APP", productId: p.id, returnedQty: 30 });

    expect(await saveRiderReturnReview({
      riderId: rider.id, date: TODAY,
      entries: [{ key: p.id, stockQty: 28, wasteQty: 2, wasteReason: "Sour / spoiled" }],
    })).toEqual({ ok: true });

    // 30 came back, 2 are gone: 28 in stock, and Retail still holds its 100.
    expect(await onHand(p.id)).toBeCloseTo(28, 3);
    expect(await inRetail(p.id)).toBeCloseTo(100, 3);

    const waste = await db.inventoryMovement.findMany({ where: { productId: p.id, type: "WASTAGE" } });
    expect(waste).toHaveLength(1);
    expect(Number(waste[0].quantity)).toBeCloseTo(2, 3);
    expect(waste[0].stage).toBe(RIDER_RETURN_STAGE);
    expect(waste[0].reason).toBe("Sour / spoiled");
  }, 240_000);

  it("a short split is accepted, and the rest goes down as missing", async () => {
    const p = await createProduct({ unit: "LITER" });
    const { rider } = await shiftWithRider();
    await appReturn(p.id, rider.id, 10);
    expect(await onHand(p.id)).toBeCloseTo(10, 3);

    // The app said 10 came back; the reviewer received 7. The 3 were never
    // handed over: out of stock, on the Missing log, not on the Wastage log.
    expect((await saveRiderReturnReview({ riderId: rider.id, date: TODAY, entries: [{ key: p.id, stockQty: 7, wasteQty: 0 }] })).ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(7, 3);
    const rows = await db.inventoryMovement.findMany({ where: { productId: p.id, type: "WASTAGE" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe(REVIEW_MISSING_REASON);
    expect(Number(rows[0].quantity)).toBeCloseTo(3, 3);
    const line = await db.riderReturnLine.findFirst({ where: { productId: p.id } });
    expect(Number(line?.missingQty)).toBeCloseTo(3, 3);
    expect((await getWastageData()).entries.some((e) => e.productName === p.name)).toBe(false);
    const board = await getReturnsBoard(TODAY, TODAY, rider.id);
    expect(board.rows.find((r) => r.riderId === rider.id)?.reviewMissing[p.id]).toBeCloseTo(3, 3);
  }, 240_000);

  it("refuses a split that claims more than the return, or wastes without a reason", async () => {
    const p = await createProduct({ unit: "LITER" });
    const { shift, rider } = await shiftWithRider();
    await appReturn(p.id, rider.id, 10);

    const over = await saveRiderReturnReview({ riderId: rider.id, date: TODAY, entries: [{ key: p.id, stockQty: 9, wasteQty: 4 }] });
    expect(over.ok).toBe(false);

    // Wasting something needs a reason, and a negative quantity is refused.
    const noReason = await saveRiderReturnReview({ riderId: rider.id, date: TODAY, entries: [{ key: p.id, stockQty: 8, wasteQty: 2 }] });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error).toMatch(/why it was wasted/);
    const negative = await saveRiderReturnReview({ riderId: rider.id, date: TODAY, entries: [{ key: p.id, stockQty: -1, wasteQty: 11 }] });
    expect(negative.ok).toBe(false);

    // Nothing was written by any of the refusals.
    expect(await db.riderReturnReview.count({ where: { riderId: rider.id } })).toBe(0);
    expect(await db.inventoryMovement.count({ where: { productId: p.id, type: "WASTAGE" } })).toBe(0);
  }, 240_000);

  it("re-splitting the same shift replaces the write-off instead of adding another", async () => {
    const p = await createProduct({ unit: "LITER" });
    await db.inventoryMovement.create({ data: { date: new Date(), type: "ARRIVED", productId: p.id, quantity: 50, reason: ACCEPTED_AT_PACKAGING } });
    await sendToRetailFor(p.id, 50);
    const { shift, rider } = await shiftWithRider();
    await appReturn(p.id, rider.id, 20);

    expect((await saveRiderReturnReview({ riderId: rider.id, date: TODAY, entries: [{ key: p.id, stockQty: 15, wasteQty: 5, wasteReason: "Leaking / damaged" }] })).ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(15, 3);   // 20 back, 5 wasted
    expect(await inRetail(p.id)).toBeCloseTo(50, 3); // the centre still holds what was sent

    // The office changes its mind: only 1 L was really spoiled.
    expect((await saveRiderReturnReview({ riderId: rider.id, date: TODAY, entries: [{ key: p.id, stockQty: 19, wasteQty: 1, wasteReason: "Other" }] })).ok).toBe(true);
    expect(await db.riderReturnReview.count({ where: { riderId: rider.id } })).toBe(1);
    const waste = await db.inventoryMovement.findMany({ where: { productId: p.id, type: "WASTAGE" } });
    expect(waste).toHaveLength(1);
    expect(Number(waste[0].quantity)).toBeCloseTo(1, 3);
    expect(await onHand(p.id)).toBeCloseTo(19, 3); // the 5 L write-off is gone, 1 L in its place
  }, 240_000);

  it("a double submit of the same dialog writes one review, not two", async () => {
    const p = await createProduct({ unit: "LITER" });
    const { shift, rider } = await shiftWithRider();
    await appReturn(p.id, rider.id, 6);
    const token = `tok-${uniq("t")}`;
    const entries = [{ key: p.id, stockQty: 5, wasteQty: 1, wasteReason: "Contamination" }];

    expect((await saveRiderReturnReview({ riderId: rider.id, date: TODAY, entries, clientToken: token })).ok).toBe(true);
    expect((await saveRiderReturnReview({ riderId: rider.id, date: TODAY, entries, clientToken: token })).ok).toBe(true);
    expect(await db.riderReturnReview.count({ where: { riderId: rider.id } })).toBe(1);
    expect(await db.inventoryMovement.count({ where: { productId: p.id, type: "WASTAGE" } })).toBe(1);
  }, 240_000);

  it("receives spare stock back in the same place, and the rest counts as sold", async () => {
    const p = await createProduct({ unit: "LITER" });
    await db.inventoryMovement.create({ data: { date: new Date(), type: "ARRIVED", productId: p.id, quantity: 40, reason: ACCEPTED_AT_PACKAGING } });
    await sendToRetailFor(p.id, 40);
    const { shift, rider } = await shiftWithRider();
    const extra = await db.riderExtraItem.create({
      data: { date: pktNoonToUTC(TODAY), shiftId: shift.id, riderId: rider.id, productId: p.id, givenQty: 10, status: "OUT" },
    });
    expect(await inRetail(p.id)).toBeCloseTo(30, 3); // 10 out with the rider

    const detail = await getRiderReturnDetail(rider.id, TODAY);
    if (!detail.ok) throw new Error(detail.error);
    expect(detail.specs).toEqual([expect.objectContaining({ key: extra.id, source: "EXTRA", returnedQty: 10 })]);

    // 4 sold on the round, 5 back into stock, 1 spoiled.
    expect(await saveRiderReturnReview({
      riderId: rider.id, date: TODAY,
      entries: [{ key: extra.id, stockQty: 5, wasteQty: 1, wasteReason: "Temperature issue" }],
    })).toEqual({ ok: true });

    const row = await db.riderExtraItem.findUniqueOrThrow({ where: { id: extra.id } });
    expect(Number(row.returnedQty)).toBeCloseTo(6, 3); // what was accepted back
    expect(row.status).toBe("RETURNED");
    // The centre is down the whole 10 it handed over; the 6 he brought back is at
    // the farm, less the 1 that was spoiled.
    expect(await inRetail(p.id)).toBeCloseTo(30, 3);
    expect(await onHand(p.id)).toBeCloseTo(5, 3);

    // More than is out with the rider is refused.
    const tooMuch = await saveRiderReturnReview({ riderId: rider.id, date: TODAY, entries: [{ key: extra.id, stockQty: 9, wasteQty: 3, wasteReason: "Other" }] });
    expect(tooMuch.ok).toBe(false);
  }, 240_000);

  it("shows the shift on the board, and the write-off in the Wastage log", async () => {
    const p = await createProduct({ unit: "LITER" });
    const { shift, rider } = await shiftWithRider();
    await appReturn(p.id, rider.id, 12);

    const before = await getReturnsBoard(TODAY, TODAY);
    const pendingRow = before.rows.find((r) => r.riderId === rider.id)!;
    expect(pendingRow).toBeTruthy();
    expect(pendingRow.reviewed).toBe(false);
    expect(pendingRow.returned[p.id]).toBeCloseTo(12, 3);
    expect(pendingRow.riderName).toBeTruthy();

    expect((await saveRiderReturnReview({
      riderId: rider.id, date: TODAY,
      entries: [{ key: p.id, stockQty: 9, wasteQty: 3, wasteReason: "Sour / spoiled" }],
    })).ok).toBe(true);

    const after = await getReturnsBoard(TODAY, TODAY);
    const row = after.rows.find((r) => r.riderId === rider.id)!;
    expect(row.reviewed).toBe(true);
    expect(row.stock[p.id]).toBeCloseTo(9, 3);
    expect(row.waste[p.id]).toBeCloseTo(3, 3);

    const log = (await getWastageData()).entries.filter((e) => e.productName === p.name);
    expect(log).toHaveLength(1);
    expect(log[0].stage).toBe("Rider return");
    expect(log[0].loss).toBeCloseTo(3, 3);

    // Filtering by another rider drops it; filtering by this one keeps it.
    expect((await getReturnsBoard(TODAY, TODAY, "no-such-rider")).rows.some((r) => r.riderId === rider.id)).toBe(false);
    expect((await getReturnsBoard(TODAY, TODAY, rider.id)).rows.some((r) => r.riderId === rider.id)).toBe(true);
  }, 240_000);

  it("counts what the rider actually loaded, not what the round planned", async () => {
    const p = await createProduct({ unit: "PIECE" });
    const { shift, rider } = await shiftWithRider();
    const customer = await createCustomer({ shiftId: shift.id });
    const route = await db.route.create({ data: { shiftId: shift.id, date: pktNoonToUTC(TODAY), status: "IN_PROGRESS" } });
    const stop = await db.routeStop.create({ data: { routeId: route.id, customerId: customer.id, stopNumber: 1 } });
    await db.routeStopItem.create({ data: { routeStopId: stop.id, productId: p.id, plannedQty: 95 } });
    cleanups.push(async () => {
      await db.routeStopItem.deleteMany({ where: { routeStop: { routeId: route.id } } });
      await db.routeStop.deleteMany({ where: { routeId: route.id } });
      await db.route.delete({ where: { id: route.id } }).catch(() => {});
    });

    // The plan said 95. He confirmed 245 in the app — two loads, as a rider with
    // two rounds does — delivered 24, and brought 221 back.
    for (const q of [101, 144]) {
      await db.inventoryMovement.create({
        data: { date: new Date(), type: "HANDED_OVER", productId: p.id, quantity: q, reason: "Load confirmed", riderId: rider.id },
      });
    }
    await db.deliveryEntry.create({ data: { customerId: customer.id, productId: p.id, quantity: 24, unitRate: 10, riderId: rider.id, date: new Date() } });
    await appReturn(p.id, rider.id, 221);

    const row = (await getReturnsBoard(TODAY, TODAY)).rows.find((r) => r.riderId === rider.id)!;
    expect(row.got[p.id]).toBeCloseTo(245, 3);        // what he took, not the 95 planned
    expect(row.delivered[p.id]).toBeCloseTo(24, 3);
    expect(row.returned[p.id]).toBeCloseTo(221, 3);
    // 245 − 24 = 221 due back, and 221 came back: nothing missing, nothing "extra".
    expect(row.got[p.id] - row.delivered[p.id] - row.returned[p.id]).toBeCloseTo(0, 3);
  }, 240_000);

  it("falls back to the round's plan on a day the rider confirmed no load", async () => {
    const p = await createProduct({ unit: "LITER" });
    const { shift, rider } = await shiftWithRider();
    const customer = await createCustomer({ shiftId: shift.id });
    const route = await db.route.create({ data: { shiftId: shift.id, date: pktNoonToUTC(TODAY), status: "IN_PROGRESS" } });
    const stop = await db.routeStop.create({ data: { routeId: route.id, customerId: customer.id, stopNumber: 1 } });
    await db.routeStopItem.create({ data: { routeStopId: stop.id, productId: p.id, plannedQty: 40 } });
    cleanups.push(async () => {
      await db.routeStopItem.deleteMany({ where: { routeStop: { routeId: route.id } } });
      await db.routeStop.deleteMany({ where: { routeId: route.id } });
      await db.route.delete({ where: { id: route.id } }).catch(() => {});
    });
    await appReturn(p.id, rider.id, 5);

    const row = (await getReturnsBoard(TODAY, TODAY)).rows.find((r) => r.riderId === rider.id)!;
    expect(row.got[p.id]).toBeCloseTo(40, 3);
  }, 240_000);

  it("a rider running several shifts hands back ONE lot, on one row", async () => {
    const p = await createProduct({ unit: "LITER" });
    const { shift, rider } = await shiftWithRider();
    // A second and third shift for the same rider — Wajid runs four.
    const shift2 = await db.shift.create({ data: { name: uniq("shift"), riderId: rider.id } });
    const shift3 = await db.shift.create({ data: { name: uniq("shift"), riderId: rider.id } });
    cleanups.push(async () => {
      await db.riderExtraItem.deleteMany({ where: { shiftId: { in: [shift2.id, shift3.id] } } });
      await db.shift.deleteMany({ where: { id: { in: [shift2.id, shift3.id] } } });
    });

    // Spare stock written against two of his shifts — which one is bookkeeping,
    // not fact: he carries it all on the same van.
    for (const s of [shift.id, shift2.id]) {
      await db.riderExtraItem.create({
        data: { date: pktNoonToUTC(TODAY), shiftId: s, riderId: rider.id, productId: p.id, givenQty: 10, status: "OUT" },
      });
    }
    await appReturn(p.id, rider.id, 6);

    // One row for the rider, carrying everything.
    const board = await getReturnsBoard(TODAY, TODAY);
    const mine = board.rows.filter((r) => r.riderId === rider.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].riderName).toBeTruthy();
    expect(mine[0].got[p.id]).toBeCloseTo(20, 3);       // both lots of spare stock
    expect(mine[0].returned[p.id]).toBeCloseTo(6, 3);   // what the app sent back

    // And one dialog, listing the app's return plus both pieces of spare stock.
    const detail = await getRiderReturnDetail(rider.id, TODAY);
    if (!detail.ok) throw new Error(detail.error);
    expect(detail.specs.filter((s) => s.source === "EXTRA")).toHaveLength(2);
    expect(detail.specs.filter((s) => s.source === "APP")).toHaveLength(1);

    // Received in one go: 6 off the round, and both spare lots back.
    expect((await saveRiderReturnReview({
      riderId: rider.id,
      date: TODAY,
      entries: [
        { key: p.id, stockQty: 6, wasteQty: 0 },
        ...detail.specs.filter((s) => s.source === "EXTRA").map((s) => ({ key: s.key, stockQty: 10, wasteQty: 0 })),
      ],
    })).ok).toBe(true);

    expect(await db.riderReturnReview.count({ where: { riderId: rider.id } })).toBe(1);
    const settled = (await getReturnsBoard(TODAY, TODAY)).rows.filter((r) => r.riderId === rider.id);
    expect(settled).toHaveLength(1);
    expect(settled[0].reviewed).toBe(true);
    expect(Object.values(settled[0].extrasOut).every((q) => q < 0.0005)).toBe(true);
  }, 240_000);

  it("is open to packaging staff and refused to everyone else", async () => {
    setTestRole("PACKAGING");
    await expect(getReturnsBoard(TODAY, TODAY)).resolves.toBeTruthy();
    setTestRole("CHECKLIST");
    await expect(getReturnsBoard(TODAY, TODAY)).rejects.toThrow(/permission/i);
    await expect(saveRiderReturnReview({ riderId: "x", date: TODAY, entries: [] })).rejects.toThrow(/permission/i);
  }, 120_000);
});

// ── What the retail centre had left ─────────────────────────────────────────
// Packaging sends the day's load to Retail; the riders take their shifts' share
// from there. What is still with the retail man comes back the same way.

/** The retail split covers EVERY product left at Retail, so a line another test
 *  is holding at the same moment is filled in as "all usable" and left alone. */
async function retailEntries(productId: string, stockQty: number, wasteQty: number, wasteReason?: string) {
  const detail = await getRetailReturnDetail(TODAY);
  if (!detail.ok) throw new Error(detail.error);
  return detail.specs.map((s) =>
    s.productId === productId
      ? { key: s.key, stockQty, wasteQty, wasteReason }
      : { key: s.key, stockQty: s.returnedQty, wasteQty: 0 },
  );
}

/** Remove the day's retail review, so the next run starts from nothing. */
function cleanupRetailReview() {
  cleanups.push(async () => {
    const reviews = await db.retailReturnReview.findMany({ where: { date: pktNoonToUTC(TODAY) }, select: { id: true } });
    await db.inventoryMovement.deleteMany({ where: { reference: { in: reviews.map((r) => r.id) } } });
    await db.retailReturnLine.deleteMany({ where: { reviewId: { in: reviews.map((r) => r.id) } } });
    await db.retailReturnReview.deleteMany({ where: { id: { in: reviews.map((r) => r.id) } } });
  });
}

describe("the retail centre's own leftover", () => {
  it("works out what is left, and moves the usable part back the moment it is handed in", async () => {
    const p = await createProduct({ unit: "LITER" });
    await db.inventoryMovement.create({ data: { date: new Date(), type: "ARRIVED", productId: p.id, quantity: 600, reason: ACCEPTED_AT_PACKAGING } });
    await sendToRetailFor(p.id, 600);
    const { shift } = await shiftWithRider();
    const customer = await createCustomer({ shiftId: shift.id });
    const route = await db.route.create({ data: { shiftId: shift.id, date: pktNoonToUTC(TODAY) } });
    const stop = await db.routeStop.create({ data: { routeId: route.id, customerId: customer.id, stopNumber: 1 } });
    await db.routeStopItem.create({ data: { routeStopId: stop.id, productId: p.id, plannedQty: 560 } });
    // The round has to go before the customer it points at — cleanups run in reverse.
    cleanups.push(async () => {
      await db.routeStopItem.deleteMany({ where: { routeStop: { routeId: route.id } } });
      await db.routeStop.deleteMany({ where: { routeId: route.id } });
      await db.route.delete({ where: { id: route.id } }).catch(() => {});
    });

    // 600 sent, 560 taken by the shift → 40 left with the retail man.
    cleanupRetailReview();
    const detail = await getRetailReturnDetail(TODAY);
    if (!detail.ok) throw new Error(detail.error);
    expect(detail.specs.find((s) => s.productId === p.id)).toMatchObject({ source: "RETAIL", returnedQty: 40 });
    expect(await onHand(p.id)).toBeCloseTo(0, 3);    // all of it is at Retail
    expect(await inRetail(p.id)).toBeCloseTo(40, 3); // less what the shift took

    // He hands back 40: 35 still good, 5 spoiled.
    expect(await saveRetailReturnReview({
      date: TODAY, entries: await retailEntries(p.id, 35, 5, "Temperature issue"),
    })).toEqual({ ok: true });

    expect(await onHand(p.id)).toBeCloseTo(35, 3);  // back at the farm straight away
    expect(await inRetail(p.id)).toBeCloseTo(0, 3); // nothing left at Retail
    const waste = await db.inventoryMovement.findMany({ where: { productId: p.id, type: "WASTAGE" } });
    expect(waste).toHaveLength(1);
    expect(Number(waste[0].quantity)).toBeCloseTo(5, 3);
    expect(waste[0].stage).toBe("Retail return");

    // The board lists the day, and the Wastage log carries the write-off.
    const rows = await getRetailReturnRows(TODAY, TODAY);
    const row = rows.find((r) => r.leftover[p.id] || r.stock[p.id])!;
    expect(row.reviewed).toBe(true);
    expect(row.stock[p.id]).toBeCloseTo(35, 3);
    expect(row.waste[p.id]).toBeCloseTo(5, 3);
    const log = (await getWastageData()).entries.filter((e) => e.productName === p.name);
    expect(log.map((l) => l.stage)).toEqual(["Retail return"]);
  }, 240_000);

  it("a stock reset settles it too — the centre is not asked for milk that was written off", async () => {
    const p = await createProduct({ unit: "LITER" });
    await db.inventoryMovement.create({ data: { date: new Date(), type: "ARRIVED", productId: p.id, quantity: 200, reason: ACCEPTED_AT_PACKAGING } });
    await sendToRetailFor(p.id, 200);
    cleanupRetailReview();
    cleanups.push(async () => { await db.$executeRaw`DELETE FROM "AppSetting" WHERE key = ${STOCK_RESET_KEY}`; });

    // 200 sent, nothing loaded: the centre is holding all of it.
    expect((await getRetailReturnRows(TODAY, TODAY)).find((r) => r.leftover[p.id])?.leftover[p.id]).toBeCloseTo(200, 3);

    // The line is drawn. That milk has been settled with everything else, so it
    // is no longer his to hand back — this page used to keep asking for it.
    const at = new Date().toISOString();
    await db.$executeRaw`
      INSERT INTO "AppSetting" (key, value, "updatedAt") VALUES (${STOCK_RESET_KEY}, ${at}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = NOW()`;
    expect((await getRetailReturnRows(TODAY, TODAY)).find((r) => r.leftover[p.id])).toBeUndefined();
    expect(await inRetail(p.id)).toBeCloseTo(0, 3); // and the Inventory page agrees
  }, 240_000);

  it("counts the extras the riders took, and refuses a split that does not add up", async () => {
    const p = await createProduct({ unit: "LITER" });
    await db.inventoryMovement.create({ data: { date: new Date(), type: "ARRIVED", productId: p.id, quantity: 100, reason: ACCEPTED_AT_PACKAGING } });
    await sendToRetailFor(p.id, 100);
    const { shift, rider } = await shiftWithRider();
    await db.riderExtraItem.create({
      data: { date: pktNoonToUTC(TODAY), shiftId: shift.id, riderId: rider.id, productId: p.id, givenQty: 30, status: "OUT" },
    });

    cleanupRetailReview();
    const detail = await getRetailReturnDetail(TODAY);
    if (!detail.ok) throw new Error(detail.error);
    expect(detail.specs.find((s) => s.productId === p.id)?.returnedQty).toBeCloseTo(70, 3); // 100 − 30 of extras

    const short = await saveRetailReturnReview({ date: TODAY, entries: await retailEntries(p.id, 60, 5, "Other") });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error).toMatch(/add up to 70/);
    expect(await db.retailReturnReview.count({ where: { date: pktNoonToUTC(TODAY) } })).toBe(0);
  }, 240_000);

  it("re-splitting replaces the write-off, and a double submit writes one review", async () => {
    const p = await createProduct({ unit: "LITER" });
    await db.inventoryMovement.create({ data: { date: new Date(), type: "ARRIVED", productId: p.id, quantity: 20, reason: ACCEPTED_AT_PACKAGING } });
    await sendToRetailFor(p.id, 20);
    const token = `rt-${uniq("t")}`;
    cleanupRetailReview();
    const first = await retailEntries(p.id, 12, 8, "Sour / spoiled");

    expect((await saveRetailReturnReview({ date: TODAY, entries: first, clientToken: token })).ok).toBe(true);
    expect((await saveRetailReturnReview({ date: TODAY, entries: first, clientToken: token })).ok).toBe(true);
    expect(await db.retailReturnReview.count({ where: { date: pktNoonToUTC(TODAY) } })).toBe(1);
    expect(await onHand(p.id)).toBeCloseTo(12, 3);

    // Corrected: only 2 L was really spoiled.
    expect((await saveRetailReturnReview({ date: TODAY, entries: await retailEntries(p.id, 18, 2, "Other") })).ok).toBe(true);
    const waste = await db.inventoryMovement.findMany({ where: { productId: p.id, type: "WASTAGE" } });
    expect(waste).toHaveLength(1);
    expect(Number(waste[0].quantity)).toBeCloseTo(2, 3);
    expect(await onHand(p.id)).toBeCloseTo(18, 3);
    expect(await inRetail(p.id)).toBeCloseTo(0, 3);
  }, 240_000);
});

// The rider records TWO things at the end of his round, and they are separate: what
// he is handing back, and what was lost on the way. With 14 L left and 4 L spilled
// he enters return 10 and wastage 4 — so the 4 L is not inside the return, and it is
// not missing either. He has told us where it went.
//
// The board never read his wastage, so it fell straight into "Missing": on
// production, Nazar Ali on 4 October showed 14 L expected, 10 L returned and 4 L
// missing, with the 4 L sitting in the app as declared wastage the whole time.

/** What the rider app writes when he reports a loss on the road: his id, nothing else. */
const appWastage = (productId: string, riderId: string, quantity: number, reason = "Spillage") =>
  db.inventoryMovement.create({
    data: { date: new Date(), type: "WASTAGE", productId, quantity, reason, riderId },
  });

describe("what the rider reported wasting", () => {
  it("is shown on its own, and is not counted as missing", async () => {
    const p = await createProduct({ unit: "LITER" });
    const { rider } = await shiftWithRider();

    // He took 14 L and delivered nothing, so 14 L is expected back.
    await db.inventoryMovement.create({
      data: { date: new Date(), type: "HANDED_OVER", productId: p.id, quantity: 14, reason: "Load confirmed", riderId: rider.id },
    });
    await appReturn(p.id, rider.id, 10);
    await appWastage(p.id, rider.id, 4);

    const board = await getReturnsBoard(TODAY, TODAY);
    const row = board.rows.find((r) => r.riderId === rider.id);
    expect(row).toBeTruthy();
    expect(row!.returned[p.id]).toBeCloseTo(10, 3);
    expect(row!.riderWasted[p.id]).toBeCloseTo(4, 3);

    // got 14 − delivered 0 = 14 expected; 10 handed back + 4 declared = nothing missing.
    const got = row!.got[p.id] ?? 0;
    const delivered = row!.delivered[p.id] ?? 0;
    const missing = got - delivered - (row!.returned[p.id] ?? 0) - (row!.riderWasted[p.id] ?? 0);
    expect(missing).toBeCloseTo(0, 3);
  }, 240_000);

  it("is kept apart from what the office writes off at review", async () => {
    const p = await createProduct({ unit: "LITER" });
    await db.inventoryMovement.create({ data: { date: new Date(), type: "ARRIVED", productId: p.id, quantity: 100, reason: ACCEPTED_AT_PACKAGING } });
    await sendToRetailFor(p.id, 100);
    const { rider } = await shiftWithRider();

    await appReturn(p.id, rider.id, 10);
    await appWastage(p.id, rider.id, 4);

    // The office then judges 3 of the 10 he handed back to be spoilt.
    setTestRole("PACKAGING");
    const saved = await saveRiderReturnReview({
      riderId: rider.id, date: TODAY,
      entries: [{ key: p.id, stockQty: 7, wasteQty: 3, wasteReason: "Leaking / damaged" }],
    });
    expect(saved.ok).toBe(true);
    resetTestRole();

    const board = await getReturnsBoard(TODAY, TODAY);
    const row = board.rows.find((r) => r.riderId === rider.id)!;
    // Two different answers to two different questions — never added together.
    expect(row.riderWasted[p.id]).toBeCloseTo(4, 3);
    expect(row.waste[p.id]).toBeCloseTo(3, 3);
    expect(row.stock[p.id]).toBeCloseTo(7, 3);
    // And the reviewer only ever split the 10 that came back, not the 14.
    expect(row.returned[p.id]).toBeCloseTo(10, 3);
  }, 240_000);

  it("does not pick up the office's own write-offs, which carry a stage and an author", async () => {
    const p = await createProduct({ unit: "LITER" });
    const { rider } = await shiftWithRider();
    await appReturn(p.id, rider.id, 10);
    // A Waste Entry row: same rider, but stamped with a stage and a person.
    const admin = await db.user.findFirst({ where: { email: "__vitest_admin@test.local" }, select: { id: true } });
    await db.inventoryMovement.create({
      data: {
        date: new Date(), type: "WASTAGE", productId: p.id, quantity: 9,
        reason: "Other", stage: RIDER_RETURN_STAGE, riderId: rider.id, enteredById: admin!.id,
      },
    });

    const board = await getReturnsBoard(TODAY, TODAY);
    const row = board.rows.find((r) => r.riderId === rider.id)!;
    // The 9 L is the office's, not the rider's — it must not excuse him.
    expect(row.riderWasted[p.id] ?? 0).toBeCloseTo(0, 3);
  }, 240_000);
});
