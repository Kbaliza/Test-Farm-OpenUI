import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, addStock, inRetail, onHand, sendToRetailFor, uniq } from "../helpers";
import { getReturnsBoard } from "@/app/(dashboard)/inventory/rider-returns/actions";
import { getReconciliationSummary } from "@/app/(dashboard)/inventory/reconciliation/actions";
import { getRiderShiftReport } from "@/app/(dashboard)/customers/rider-report/actions";
import { END_OF_SHIFT_RETURN_REASON, LOAD_SHORT_REASONS, routeLoads } from "@/lib/rider-stock";
import { todayPKTString, yesterdayPKTString, pktNoonToUTC } from "@/lib/pkt";

// A rider who takes less than the sheet, and a rider who closes an old round late
// — the two things that had the Rider Report, Rider Item Returns and the
// reconciliation disagreeing about the same day.

const TODAY = todayPKTString();
const YESTERDAY = yesterdayPKTString();

async function rider() {
  const user = await db.user.create({ data: { email: uniq("rl") + "@t.local", name: uniq("Rider"), role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const r = await db.rider.create({ data: { userId: user.id } });
  const shift = await db.shift.create({ data: { name: uniq("shift"), riderId: r.id } });
  cleanups.push(async () => {
    await db.inventoryMovement.deleteMany({ where: { riderId: r.id } });
    await db.routeStopItem.deleteMany({ where: { routeStop: { route: { shiftId: shift.id } } } });
    await db.routeStop.deleteMany({ where: { route: { shiftId: shift.id } } });
    await db.route.deleteMany({ where: { shiftId: shift.id } });
    await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await db.rider.delete({ where: { id: r.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return { r, shift };
}

async function round(shiftId: string, customerId: string, productId: string, planned: number, day: string, status = "COMPLETED") {
  const route = await db.route.create({ data: { shiftId, date: pktNoonToUTC(day), status: status as never } });
  const stop = await db.routeStop.create({ data: { routeId: route.id, customerId, stopNumber: 1 } });
  await db.routeStopItem.create({ data: { routeStopId: stop.id, productId, plannedQty: planned } });
  return route;
}

const move = (data: Record<string, unknown>) => db.inventoryMovement.create({ data: { date: new Date(), ...data } as never });

describe("the sheet, the load and what came back — one rule on every page", () => {
  it("milk a rider declines at loading is not wastage, and stays on the retail centre's shelf", async () => {
    const milk = await createProduct({ unit: "LITER" });
    const { r, shift } = await rider();
    const customer = await createCustomer({ shiftId: shift.id });
    await addStock(milk.id, 100);
    await sendToRetailFor(milk.id, 100);
    const route = await round(shift.id, customer.id, milk.id, 40, TODAY);

    // The sheet said 40; he accepted 30, and the app filed the 10 as "wastage".
    await move({ type: "HANDED_OVER", productId: milk.id, quantity: 30, riderId: r.id, reason: "Rider-adjusted load", reference: route.id });
    await move({ type: "WASTAGE", productId: milk.id, quantity: 10, riderId: r.id, reason: LOAD_SHORT_REASONS[0] });
    // 2 L really spilled; 25 delivered; 3 handed back.
    await move({ type: "WASTAGE", productId: milk.id, quantity: 2, riderId: r.id, reason: "Spillage", reference: route.id });
    await db.deliveryEntry.create({ data: { date: new Date(), customerId: customer.id, productId: milk.id, quantity: 25, unitRate: 200, riderId: r.id } as never });
    await move({ type: "RETURNED", productId: milk.id, quantity: 3, riderId: r.id, reason: END_OF_SHIFT_RETURN_REASON, reference: route.id });

    // Rider Item Returns: took 30, wasted 2 (not 12), missing 0.
    const board = await getReturnsBoard(TODAY, TODAY, r.id);
    const row = board.rows.find((x) => x.riderId === r.id)!;
    expect(row.got[milk.id]).toBeCloseTo(30, 3);
    expect(row.riderWasted[milk.id] ?? 0).toBeCloseTo(2, 3);
    expect(row.returned[milk.id]).toBeCloseTo(3, 3);

    // Reconciliation: the same, and the 10 L is Retail's leftover, not a loss.
    const s = await getReconciliationSummary(TODAY, TODAY);
    const leg = s.riders.find((x) => x.riderId === r.id)!;
    expect(leg.milk.got).toBeCloseTo(30, 3);
    expect(leg.milk.wasted).toBeCloseTo(2, 3);
    expect(leg.milk.missing).toBeCloseTo(0, 3);                 // 30 − 25 − 2 − 3
    expect(s.stages.loadShort[milk.id]).toBeCloseTo(10, 3);
    expect(s.stages.riderWasted[milk.id]).toBeCloseTo(2, 3);

    // Stock: the round took 30 out of Retail, not the 40 on the sheet.
    expect(await inRetail(milk.id)).toBeCloseTo(70, 3);
    expect(await onHand(milk.id)).toBeCloseTo(3, 3);             // the return is at the farm store

    // Rider Report: planned 40, took 30, 10 short at load.
    const rep = await getRiderShiftReport(shift.id, TODAY);
    expect(rep.stats.plannedQty).toBeCloseTo(40, 3);
    expect(rep.stats.tookQty).toBeCloseTo(30, 3);
    expect(rep.stats.shortAtLoadQty).toBeCloseTo(10, 3);
    expect(rep.stats.deliveredQty).toBeCloseTo(25, 3);
  }, 300_000);

  it("a return handed in days later belongs to the round it came off", async () => {
    const milk = await createProduct({ unit: "LITER" });
    const { r, shift } = await rider();
    const customer = await createCustomer({ shiftId: shift.id });
    const old = await round(shift.id, customer.id, milk.id, 20, YESTERDAY);
    await move({ date: pktNoonToUTC(YESTERDAY), type: "HANDED_OVER", productId: milk.id, quantity: 20, riderId: r.id, reason: "Load confirmed", reference: old.id });
    await db.deliveryEntry.create({ data: { date: pktNoonToUTC(YESTERDAY), customerId: customer.id, productId: milk.id, quantity: 15, unitRate: 200, riderId: r.id } as never });
    // Closed the next day: the 5 L return is dated today but stamped with yesterday's round.
    await move({ type: "RETURNED", productId: milk.id, quantity: 5, riderId: r.id, reason: END_OF_SHIFT_RETURN_REASON, reference: old.id });

    const y = (await getReturnsBoard(YESTERDAY, YESTERDAY, r.id)).rows.find((x) => x.riderId === r.id)!;
    expect(y.returned[milk.id]).toBeCloseTo(5, 3);
    const t = (await getReturnsBoard(TODAY, TODAY, r.id)).rows.find((x) => x.riderId === r.id);
    expect(t?.returned[milk.id] ?? 0).toBe(0);

    const sy = await getReconciliationSummary(YESTERDAY, YESTERDAY);
    expect(sy.riders.find((x) => x.riderId === r.id)!.milk.returned).toBeCloseTo(5, 3);
    expect(sy.riders.find((x) => x.riderId === r.id)!.milk.missing).toBeCloseTo(0, 3);
    const st = await getReconciliationSummary(TODAY, TODAY);
    expect(st.riders.find((x) => x.riderId === r.id)?.milk.returned ?? 0).toBe(0);
  }, 300_000);

  it("routeLoads: the confirmed load replaces the sheet for that route only", () => {
    const planned = [
      { routeId: "a", productId: "cow", plannedQty: 40 },
      { routeId: "a", productId: "mix", plannedQty: 10 },
      { routeId: "b", productId: "cow", plannedQty: 20 },
    ];
    const confirmed = new Map([["a", new Map([["cow", 30], ["mix", 10], ["eggs", 12]])]]);
    const taken = routeLoads(planned, confirmed).map((t) => `${t.routeId}:${t.productId}=${t.qty}`).sort();
    expect(taken).toEqual(["a:cow=30", "a:eggs=12", "a:mix=10", "b:cow=20"]);
  });
});
