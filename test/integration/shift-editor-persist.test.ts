import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, addStock, sendToRetailFor, uniq } from "../helpers";
import { getShiftCustomers, saveRoute, saveDeliveryOrder } from "@/app/(dashboard)/customers/pre-delivery/actions";
import { todayPKTString } from "@/lib/pkt";

async function makeShift() {
  const s = await db.shift.create({ data: { name: uniq("shift") } });
  cleanups.push(async () => {
    await db.route.deleteMany({ where: { shiftId: s.id } }).catch(() => {}); // cascades stops+items
    await db.shift.delete({ where: { id: s.id } }).catch(() => {});
  });
  return s;
}

const DATE = todayPKTString();

describe("shift editor — edited quantity persists across reloads", () => {
  it("a saved route quantity is read back (not reverted to the subscription) — without override", async () => {
    const shift = await makeShift();
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 100);
    await sendToRetailFor(p.id, 100); // today's route draws on Retail, not inventory
    const c = await createCustomer({ shiftId: shift.id });
    await db.customerProduct.create({ data: { customerId: c.id, productId: p.id, quantity: 2, ratePerUnit: 100, scheduleType: "DAILY" } });
    cleanups.push(async () => { await db.route.deleteMany({ where: { shiftId: shift.id } }).catch(() => {}); });

    // Before any save: the plan comes from the subscription (qty 2).
    const before = await getShiftCustomers(shift.id, DATE);
    expect(before.stops.find((s) => s.customerId === c.id)!.products.find((x) => x.productId === p.id)!.quantity).toBe(2);

    // Edit to 5 and save (no override — the shift has no schedule, so it isn't locked).
    expect(await saveRoute({ shiftId: shift.id, date: DATE, stops: [{ customerId: c.id, stopNumber: 1, products: [{ productId: p.id, quantity: 5 }] }] })).toEqual({ ok: true });

    // Reload the way the page does (override omitted): must read 5, not the subscription 2.
    const after = await getShiftCustomers(shift.id, DATE);
    expect(after.stops.find((s) => s.customerId === c.id)!.products.find((x) => x.productId === p.id)!.quantity).toBe(5);
    expect(after.status).toBe("PENDING"); // a fresh saved route is PENDING
  }, 180_000);
});

describe("shift editor — status surfaced + edits freeze once the rider starts", () => {
  it("returns the route status, and saveRoute is rejected for IN_PROGRESS and COMPLETED", async () => {
    const shift = await makeShift();
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 100);
    await sendToRetailFor(p.id, 100); // today's route draws on Retail, not inventory
    const c = await createCustomer({ shiftId: shift.id });
    await db.customerProduct.create({ data: { customerId: c.id, productId: p.id, quantity: 2, ratePerUnit: 100, scheduleType: "DAILY" } });
    cleanups.push(async () => { await db.route.deleteMany({ where: { shiftId: shift.id } }).catch(() => {}); });

    // A PENDING route saves fine.
    expect(await saveRoute({ shiftId: shift.id, date: DATE, stops: [{ customerId: c.id, stopNumber: 1, products: [{ productId: p.id, quantity: 3 }] }] })).toEqual({ ok: true });
    const route = (await db.route.findFirst({ where: { shiftId: shift.id } }))!;

    // Mobile app starts the shift → editor should surface it and refuse edits.
    await db.route.update({ where: { id: route.id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
    const inProg = await getShiftCustomers(shift.id, DATE);
    expect(inProg.status).toBe("IN_PROGRESS");
    expect(inProg.startedAt).toBeTruthy();
    expect((await saveRoute({ shiftId: shift.id, date: DATE, stops: [{ customerId: c.id, stopNumber: 1, products: [{ productId: p.id, quantity: 4 }] }] })).ok).toBe(false);

    // Mobile app completes the shift → still surfaced, still refused.
    await db.route.update({ where: { id: route.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    const done = await getShiftCustomers(shift.id, DATE);
    expect(done.status).toBe("COMPLETED");
    expect(done.completedAt).toBeTruthy();
    expect((await saveRoute({ shiftId: shift.id, date: DATE, stops: [{ customerId: c.id, stopNumber: 1, products: [{ productId: p.id, quantity: 4 }] }] })).ok).toBe(false);
  }, 180_000);
});

describe("shift editor — a list loaded for another shift is never saved", () => {
  it("refuses a save whose customers were loaded for a different shift or day, and writes nothing", async () => {
    const shiftA = await makeShift();
    const shiftB = await makeShift();
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 100);
    await sendToRetailFor(p.id, 100);
    const c = await createCustomer({ shiftId: shiftA.id });
    const stops = [{ customerId: c.id, stopNumber: 1, products: [{ productId: p.id, quantity: 2 }] }];

    // Shift A's list, still on screen after switching to shift B (28 Oct: CBR saved as Bahria 1-6).
    const res = await saveRoute({ shiftId: shiftB.id, date: DATE, stops, loadedFor: { shiftId: shiftA.id, date: DATE } });
    expect(res.ok).toBe(false);
    expect(await db.route.count({ where: { shiftId: shiftB.id } })).toBe(0);

    // Same shift but another day's list.
    expect((await saveRoute({ shiftId: shiftA.id, date: DATE, stops, loadedFor: { shiftId: shiftA.id, date: "2020-01-01" } })).ok).toBe(false);
    expect((await saveDeliveryOrder({ shiftId: shiftB.id, date: DATE, customerIds: [c.id], loadedFor: { shiftId: shiftA.id, date: DATE } })).ok).toBe(false);

    // The shift's own list saves.
    expect(await saveRoute({ shiftId: shiftA.id, date: DATE, stops, loadedFor: { shiftId: shiftA.id, date: DATE } })).toEqual({ ok: true });
  }, 180_000);
});
