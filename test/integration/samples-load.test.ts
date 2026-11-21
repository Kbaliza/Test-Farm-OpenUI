import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, addStock, sendToRetailFor, uniq } from "../helpers";
import { createSample } from "@/app/(dashboard)/samples/actions";
import { getShiftCustomers, saveRoute, takeSampleOffShift } from "@/app/(dashboard)/customers/pre-delivery/actions";
import { getReturnsBoard } from "@/app/(dashboard)/inventory/rider-returns/actions";
import { getReconciliationSummary } from "@/app/(dashboard)/inventory/reconciliation/actions";
import { SAMPLES_COUNTED_FROM } from "@/lib/sample-deliveries";
import { todayPKTString, pktNoonToUTC } from "@/lib/pkt";

// Free samples ride a shift's round without being stops on it. They used to be
// left out of the save's stock check, could not be taken off a shift (the ✕ only
// hid them on the screen), and their milk read as missing on the returns board.

const TODAY = todayPKTString();

async function riderShift() {
  const user = await db.user.create({ data: { email: uniq("sl") + "@t.local", name: uniq("Rider"), role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const r = await db.rider.create({ data: { userId: user.id } });
  const shift = await db.shift.create({ data: { name: uniq("shift"), riderId: r.id } });
  cleanups.push(async () => {
    await db.sampleLead.deleteMany({ where: { OR: [{ shiftId: shift.id }, { name: { startsWith: "__TEST_lead" } }] } });
    await db.inventoryMovement.deleteMany({ where: { riderId: r.id } });
    await db.route.deleteMany({ where: { shiftId: shift.id } });
    await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await db.rider.delete({ where: { id: r.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return { r, shift };
}

async function sample(shiftId: string, productId: string, quantity: number) {
  const name = uniq("lead");
  expect((await createSample({ name, phone: "03001234567", shiftId, items: [{ productId, quantity, ratePerUnit: 100 }] })).ok).toBe(true);
  return db.sampleLead.findFirstOrThrow({ where: { name } });
}

describe("free samples on a shift's round", () => {
  it("the ✕ takes a sample off its shift for good — but not once the round has started", async () => {
    const { shift } = await riderShift();
    const milk = await createProduct({ unit: "LITER" });
    const s = await sample(shift.id, milk.id, 2);
    const onEditor = async () => (await getShiftCustomers(shift.id, TODAY, true)).stops.some((x) => x.customerId === `sample:${s.id}`);
    expect(await onEditor()).toBe(true);

    // Started round: refused, and the sample stays.
    const route = await db.route.create({ data: { shiftId: shift.id, date: pktNoonToUTC(TODAY), status: "IN_PROGRESS", startedAt: new Date() } });
    expect((await takeSampleOffShift({ sampleId: s.id, shiftId: shift.id, date: TODAY })).ok).toBe(false);
    expect((await db.sampleLead.findUniqueOrThrow({ where: { id: s.id } })).shiftId).toBe(shift.id);

    // Round not started: off the shift, and it does not come back on the next open.
    await db.route.update({ where: { id: route.id }, data: { status: "PENDING", startedAt: null } });
    expect(await takeSampleOffShift({ sampleId: s.id, shiftId: shift.id, date: TODAY })).toEqual({ ok: true });
    const after = await db.sampleLead.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.shiftId).toBeNull();
    expect(after.status).toBe("ASSIGNED"); // back on the Samples page, ready to send again
    expect(await onEditor()).toBe(false);
  }, 300_000);

  it("Save route counts the shift's samples against the stock", async () => {
    const { shift } = await riderShift();
    const milk = await createProduct({ unit: "LITER" });
    await addStock(milk.id, 10);
    await sendToRetailFor(milk.id, 10);
    const c = await createCustomer({ shiftId: shift.id });
    const s = await sample(shift.id, milk.id, 3);
    const stops = [{ customerId: c.id, stopNumber: 1, products: [{ productId: milk.id, quantity: 8 }] }];

    // 8 for the customer + 3 for the sample > 10 in Retail.
    const refused = await saveRoute({ shiftId: shift.id, date: TODAY, stops, override: true });
    expect(refused.ok).toBe(false);

    // Without the sample it fits.
    expect((await takeSampleOffShift({ sampleId: s.id, shiftId: shift.id, date: TODAY })).ok).toBe(true);
    expect(await saveRoute({ shiftId: shift.id, date: TODAY, stops, override: true })).toEqual({ ok: true });
  }, 300_000);

  it("a delivered sample counts as delivered on the returns board and the reconciliation", async () => {
    const DAY = TODAY >= SAMPLES_COUNTED_FROM ? TODAY : SAMPLES_COUNTED_FROM;
    const { r, shift } = await riderShift();
    const milk = await createProduct({ unit: "LITER" });
    const c = await createCustomer({ shiftId: shift.id });
    const s = await sample(shift.id, milk.id, 3);
    const route = await db.route.create({ data: { shiftId: shift.id, date: pktNoonToUTC(DAY), status: "COMPLETED", completedAt: pktNoonToUTC(DAY) } });
    const stop = await db.routeStop.create({ data: { routeId: route.id, customerId: c.id, stopNumber: 1 } });
    await db.routeStopItem.create({ data: { routeStopId: stop.id, productId: milk.id, plannedQty: 7 } });

    // He loaded 10 (7 + the sample's 3), delivered 7 to the customer and the sample.
    await db.inventoryMovement.create({ data: { date: pktNoonToUTC(DAY), type: "HANDED_OVER", productId: milk.id, quantity: 10, riderId: r.id, reason: "Rider-adjusted load", reference: route.id } });
    await db.deliveryEntry.create({ data: { date: pktNoonToUTC(DAY), customerId: c.id, productId: milk.id, quantity: 7, unitRate: 200, riderId: r.id } as never });
    await db.sampleLead.update({ where: { id: s.id }, data: { status: "DELIVERED", riderOutcome: "DELIVERED", riderOutcomeAt: pktNoonToUTC(DAY), deliveredAt: pktNoonToUTC(DAY) } });

    const row = (await getReturnsBoard(DAY, DAY, r.id)).rows.find((x) => x.riderId === r.id)!;
    expect(row.got[milk.id]).toBeCloseTo(10, 3);
    expect(row.delivered[milk.id]).toBeCloseTo(10, 3); // nothing missing

    const leg = (await getReconciliationSummary(DAY, DAY)).riders.find((x) => x.riderId === r.id)!;
    expect(leg.milk.delivered).toBeCloseTo(10, 3);
  }, 300_000);
});
