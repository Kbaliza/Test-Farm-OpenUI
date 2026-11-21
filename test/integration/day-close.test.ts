import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, onHand, uniq } from "../helpers";
import { closeDay, DAY_CLOSE_REASON } from "@/lib/day-close";
import { computeReturnsBoard } from "@/lib/rider-returns-board";
import { END_OF_SHIFT_RETURN_REASON } from "@/lib/rider-stock";
import { ACCEPTED_AT_PACKAGING, SENT_TO_RETAIL } from "@/lib/packaging-stock";
import { pktNoonToUTC, dateStrRangePKT } from "@/lib/pkt";

// The day-end close, on a made-up day long ago: the tests share a database with
// real days, and a close works on everything dated on the day it closes.
let dayN = 0;
function oldDay() {
  // A different day for each test (and each run), all in 2019.
  const d = new Date(Date.UTC(2019, 0, 1) + ((Date.now() / 1000 + dayN++ * 37) % 360) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function rider() {
  const user = await db.user.create({ data: { email: uniq("dc") + "@t.local", name: uniq("Rider"), role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const r = await db.rider.create({ data: { userId: user.id } });
  const shift = await db.shift.create({ data: { name: uniq("shift"), riderId: r.id } });
  cleanups.push(async () => {
    await db.inventoryMovement.deleteMany({ where: { riderId: r.id } });
    await db.deliveryEntry.deleteMany({ where: { riderId: r.id } });
    await db.routeStopItem.deleteMany({ where: { routeStop: { route: { shiftId: shift.id } } } });
    await db.routeStop.deleteMany({ where: { route: { shiftId: shift.id } } });
    await db.route.deleteMany({ where: { shiftId: shift.id } });
    await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await db.rider.delete({ where: { id: r.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return { r, shift };
}

async function round(shiftId: string, customerId: string, productId: string, planned: number, day: string, status: "PENDING" | "IN_PROGRESS" | "COMPLETED") {
  const route = await db.route.create({ data: { shiftId, date: pktNoonToUTC(day), status } });
  const stop = await db.routeStop.create({ data: { routeId: route.id, customerId, stopNumber: 1 } });
  await db.routeStopItem.create({ data: { routeStopId: stop.id, productId, plannedQty: planned } });
  return route;
}

function cleanRetailDay(day: string) {
  cleanups.push(async () => {
    const rev = await db.retailReturnReview.findUnique({ where: { date: pktNoonToUTC(day) }, select: { id: true } });
    if (rev) {
      await db.inventoryMovement.deleteMany({ where: { reference: rev.id } });
      await db.retailReturnReview.delete({ where: { id: rev.id } });
    }
    await db.inventoryMovement.deleteMany({ where: { date: dateStrRangePKT(day), reason: SENT_TO_RETAIL } });
  });
}

const missingOf = async (day: string, riderId: string, pid: string) => {
  const row = (await computeReturnsBoard(day, day, riderId)).rows.find((x) => x.riderId === riderId)!;
  return Math.round(((row.got[pid] ?? 0) - (row.delivered[pid] ?? 0) - (row.returned[pid] ?? 0) - (row.riderWasted[pid] ?? 0)) * 1000) / 1000;
};
const autoWaste = async (riderId: string) =>
  (await db.inventoryMovement.findMany({ where: { type: "WASTAGE", reason: DAY_CLOSE_REASON, riderId } }))
    .reduce((s, m) => s + Number(m.quantity), 0);

describe("day-end close", () => {
  it("ends a round the rider left open, and writes off what he never brought back", async () => {
    const day = oldDay();
    cleanRetailDay(day);
    const milk = await createProduct({ unit: "LITER" });
    const { r, shift } = await rider();
    const customer = await createCustomer({ shiftId: shift.id });
    const route = await round(shift.id, customer.id, milk.id, 30, day, "IN_PROGRESS");
    const at = pktNoonToUTC(day);
    await db.inventoryMovement.create({ data: { date: at, type: "HANDED_OVER", productId: milk.id, quantity: 30, riderId: r.id, reference: route.id, reason: "Load confirmed" } });
    await db.deliveryEntry.create({ data: { date: at, customerId: customer.id, productId: milk.id, quantity: 20, unitRate: 200, riderId: r.id } as never });
    await db.inventoryMovement.create({ data: { date: at, type: "WASTAGE", productId: milk.id, quantity: 2, riderId: r.id, reference: route.id, reason: "Spillage" } });
    expect(await missingOf(day, r.id, milk.id)).toBeCloseTo(8, 3);

    const res = await closeDay(day);
    expect(res.routesClosed).toBe(1);
    const closed = await db.route.findUniqueOrThrow({ where: { id: route.id } });
    expect(closed.status).toBe("COMPLETED");
    expect(closed.autoClosedAt).not.toBeNull();
    expect(await autoWaste(r.id)).toBeCloseTo(8, 3);
    // Written off, still missing: the board keeps the close's rows apart from
    // what the rider reported wasting.
    expect(await missingOf(day, r.id, milk.id)).toBeCloseTo(8, 3);

    // Again: the same 8, not 16.
    await closeDay(day);
    expect(await autoWaste(r.id)).toBeCloseTo(8, 3);

    // He hands 3 L in late: the write-off drops to 5, nothing is counted twice.
    await db.inventoryMovement.create({ data: { type: "RETURNED", productId: milk.id, quantity: 3, riderId: r.id, reference: route.id, reason: END_OF_SHIFT_RETURN_REASON } });
    await closeDay(day);
    expect(await autoWaste(r.id)).toBeCloseTo(5, 3);
    expect(await missingOf(day, r.id, milk.id)).toBeCloseTo(5, 3);
  }, 300_000);

  it("leaves a round the rider ended alone, and never charges a round nobody started", async () => {
    const day = oldDay();
    cleanRetailDay(day);
    const milk = await createProduct({ unit: "LITER" });
    const { r, shift } = await rider();
    const customer = await createCustomer({ shiftId: shift.id });
    const route = await round(shift.id, customer.id, milk.id, 40, day, "PENDING");

    // Never started: not closed, and the board no longer reads its sheet as "got".
    expect((await computeReturnsBoard(day, day, r.id)).rows.find((x) => x.riderId === r.id)).toBeUndefined();
    const res = await closeDay(day);
    expect(res.routesClosed).toBe(0);
    expect((await db.route.findUniqueOrThrow({ where: { id: route.id } })).status).toBe("PENDING");
    expect(await autoWaste(r.id)).toBe(0);
  }, 300_000);

  it("writes off what Retail still held, so it does not drift back into storage", async () => {
    const day = oldDay();
    cleanRetailDay(day);
    const milk = await createProduct({ unit: "LITER" });
    const { shift } = await rider();
    const customer = await createCustomer({ shiftId: shift.id });
    // Milk accepted at packaging — the way real milk reaches storage. (A counter
    // purchase sits outside the milk-flow part of the formula, where a round's
    // load cannot come off it.)
    const arrived = await db.inventoryMovement.create({ data: { type: "ARRIVED", productId: milk.id, quantity: 100, reason: ACCEPTED_AT_PACKAGING } });
    cleanups.push(async () => { await db.inventoryMovement.delete({ where: { id: arrived.id } }).catch(() => {}); });
    // Packaging sent 100 that day; one finished round took 30.
    await db.inventoryMovement.create({ data: { date: pktNoonToUTC(day), type: "DISPATCHED", productId: milk.id, quantity: 100, reason: SENT_TO_RETAIL } });
    await round(shift.id, customer.id, milk.id, 30, day, "COMPLETED");
    // Before: the 70 left at Retail quietly counts as back in storage.
    expect(await onHand(milk.id)).toBeCloseTo(70, 3);

    const res = await closeDay(day);
    expect(res.retailWaste.find((w) => w.productId === milk.id)?.qty).toBeCloseTo(70, 3);
    const rev = await db.retailReturnReview.findUniqueOrThrow({ where: { date: pktNoonToUTC(day) }, include: { lines: true } });
    expect(rev.reviewedById).toBeNull();
    expect(rev.lines.find((l) => l.productId === milk.id)?.wasteQty.toNumber()).toBeCloseTo(70, 3);
    expect(await onHand(milk.id)).toBeCloseTo(0, 3);

    // Run again: still one write-off of 70.
    await closeDay(day);
    expect(await onHand(milk.id)).toBeCloseTo(0, 3);
  }, 300_000);

  it("keeps a handback the office already saved", async () => {
    const day = oldDay();
    cleanRetailDay(day);
    const milk = await createProduct({ unit: "LITER" });
    const user = await db.user.findFirstOrThrow({ select: { id: true } });
    await db.inventoryMovement.create({ data: { date: pktNoonToUTC(day), type: "DISPATCHED", productId: milk.id, quantity: 50, reason: SENT_TO_RETAIL } });
    await db.retailReturnReview.create({
      data: { date: pktNoonToUTC(day), reviewedById: user.id, reviewedByName: "Office", lines: { create: [{ productId: milk.id, leftoverQty: 50, stockQty: 50, wasteQty: 0 }] } },
    });
    const res = await closeDay(day);
    expect(res.retailWaste).toEqual([]);
    const rev = await db.retailReturnReview.findUniqueOrThrow({ where: { date: pktNoonToUTC(day) }, include: { lines: true } });
    expect(rev.reviewedByName).toBe("Office");
    expect(rev.lines[0].stockQty.toNumber()).toBeCloseTo(50, 3);
  }, 300_000);

  it("refuses to close a day that has not ended", async () => {
    await expect(closeDay(new Date().toISOString().slice(0, 10).replace(/^\d{4}/, "2999"))).rejects.toThrow();
  });
});
