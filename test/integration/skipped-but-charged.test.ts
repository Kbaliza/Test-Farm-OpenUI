import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, uniq } from "../helpers";
import { getRiderShiftReport } from "@/app/(dashboard)/customers/rider-report/actions";
import { getReturnsBoard } from "@/app/(dashboard)/inventory/rider-returns/actions";
import { todayPKTString, pktNoonToUTC } from "@/lib/pkt";

const TODAY = todayPKTString();

// The rider app offers three reasons for not handing milk over. Two of them still
// bill the customer — he was there to deliver, nobody answered or he was turned
// away — and the milk comes home on the van. The third does not.
//
// A charge used to be read as proof of delivery, so those stops read "Delivered"
// on the rider report AND the same milk turned up in returns.

/** A shift with one round, one customer, `planned` litres on the stop. */
async function round(planned: number) {
  const p = await createProduct({ unit: "LITER", defaultRate: 100 });
  const u = await db.user.create({ data: { email: uniq("r") + "@t.local", name: uniq("Rider"), role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const rider = await db.rider.create({ data: { userId: u.id, active: true } });
  const shift = await db.shift.create({ data: { name: uniq("shift"), riderId: rider.id } });
  const customer = await createCustomer({ shiftId: shift.id });
  const route = await db.route.create({ data: { shiftId: shift.id, date: pktNoonToUTC(TODAY), status: "COMPLETED", completedAt: new Date() } });
  const stop = await db.routeStop.create({ data: { routeId: route.id, customerId: customer.id, stopNumber: 1, riderId: rider.id } });
  await db.routeStopItem.create({ data: { routeStopId: stop.id, productId: p.id, plannedQty: planned } });
  cleanups.push(async () => {
    await db.routeStopItem.deleteMany({ where: { routeStopId: stop.id } });
    await db.routeStop.deleteMany({ where: { routeId: route.id } });
    await db.route.delete({ where: { id: route.id } }).catch(() => {});
    await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
    await db.user.delete({ where: { id: u.id } }).catch(() => {});
  });
  return { p, shift, customer, stop, rider };
}

/** What the app writes when it bills a stop it could not deliver. */
const charge = (customerId: string, productId: string, qty: number, riderId: string) =>
  db.deliveryEntry.create({ data: { customerId, productId, quantity: qty, unitRate: 100, riderId, date: new Date() } });

describe("a stop the rider could not deliver but still charged", () => {
  it("is not called delivered on the rider report — it says charged, with the reason", async () => {
    const { p, shift, customer, stop, rider } = await round(4);
    await db.routeStop.update({ where: { id: stop.id }, data: { status: "SKIPPED", skipReason: "Customer unresponsive" } });
    await charge(customer.id, p.id, 4, rider.id);

    const rep = await getRiderShiftReport(shift.id, TODAY);
    expect(rep.ok).toBe(true);
    const row = rep.rows.find((r) => r.customerId === customer.id)!;
    expect(row.status).toBe("charged_not_delivered");
    expect(row.skipReason).toBe("Customer unresponsive");
    expect(row.deliveredTotal).toBeCloseTo(4, 3); // the bill stands

    // …and it is kept out of the delivered figures, which are about milk that arrived.
    expect(rep.stats.chargedNotDeliveredCustomers).toBe(1);
    expect(rep.stats.chargedNotDeliveredQty).toBeCloseTo(4, 3);
    expect(rep.rows.filter((r) => r.status === "delivered")).toHaveLength(0);
  }, 180_000);

  it("counts as expected back on the returns board, not as delivered", async () => {
    const { p, shift, customer, stop, rider } = await round(10);
    await db.routeStop.update({ where: { id: stop.id }, data: { status: "SKIPPED", skipReason: "Customer refused delivery" } });
    await charge(customer.id, p.id, 10, rider.id);

    const board = await getReturnsBoard(TODAY, TODAY);
    const row = board.rows.find((r) => r.riderId === rider.id)!;
    expect(row.delivered[p.id] ?? 0).toBeCloseTo(0, 3);   // nothing reached a customer
    expect(row.chargedBack[p.id]).toBeCloseTo(10, 3);     // it is coming back
    expect(row.got[p.id]).toBeCloseTo(10, 3);
    // Expected return is got − delivered, so all 10 L are still owed back.
    expect(row.got[p.id] - (row.delivered[p.id] ?? 0)).toBeCloseTo(10, 3);
  }, 180_000);

  it("\"customer did not order\" is a plain skip — no charge, and still expected back", async () => {
    const { p, shift, customer, stop, rider } = await round(6);
    await db.routeStop.update({ where: { id: stop.id }, data: { status: "SKIPPED", skipReason: "Customer did not order" } });

    const rep = await getRiderShiftReport(shift.id, TODAY);
    const row = rep.rows.find((r) => r.customerId === customer.id)!;
    expect(row.status).toBe("skipped");
    expect(row.deliveredTotal).toBeCloseTo(0, 3);
    expect(rep.stats.chargedNotDeliveredCustomers).toBe(0);

    const board = await getReturnsBoard(TODAY, TODAY);
    const brow = board.rows.find((r) => r.riderId === rider.id)!;
    expect(brow.chargedBack[p.id] ?? 0).toBeCloseTo(0, 3);
    expect(brow.got[p.id]).toBeCloseTo(6, 3);
  }, 180_000);

  it("a real delivery is still a delivery", async () => {
    const { p, shift, customer, rider } = await round(3);
    await charge(customer.id, p.id, 3, rider.id); // stop stays DELIVERED

    const rep = await getRiderShiftReport(shift.id, TODAY);
    expect(rep.rows.find((r) => r.customerId === customer.id)!.status).toBe("delivered");
    expect(rep.stats.deliveredQty).toBeCloseTo(3, 3);

    const board = await getReturnsBoard(TODAY, TODAY);
    const row = board.rows.find((r) => r.riderId === rider.id)!;
    expect(row.delivered[p.id]).toBeCloseTo(3, 3);
    expect(row.chargedBack[p.id] ?? 0).toBeCloseTo(0, 3);
  }, 180_000);
});
