import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, createCustomer, addStock, onHand, inRetail, sendToRetailFor, uniq } from "../helpers";
import {
  confirmExtraReturn,
  getRiderReturns,
} from "@/app/(dashboard)/inventory/rider-extras/actions";
import { saveRoute } from "@/app/(dashboard)/customers/pre-delivery/actions";
import { getRiderShiftReport } from "@/app/(dashboard)/customers/rider-report/actions";
import { todayPKTString } from "@/lib/pkt";

afterEach(() => resetTestRole());

/** A shift (with an assigned rider by default) that self-cleans its rider, route and extras. */
async function makeShift(withRider = true) {
  let riderId: string | null = null;
  if (withRider) {
    const user = await db.user.create({ data: { email: uniq("rd") + "@t.local", name: "Test Rider", role: "RIDER", active: true, supabaseId: uniq("sb") } });
    const rider = await db.rider.create({ data: { userId: user.id } });
    riderId = rider.id;
    cleanups.push(async () => {
      await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
      await db.user.delete({ where: { id: user.id } }).catch(() => {});
    });
  }
  const s = await db.shift.create({ data: { name: uniq("shift"), riderId } });
  cleanups.push(async () => {
    await db.riderExtraItem.deleteMany({ where: { shiftId: s.id } }).catch(() => {});
    await db.routeStopItem.deleteMany({ where: { routeStop: { route: { shiftId: s.id } } } }).catch(() => {});
    await db.routeStop.deleteMany({ where: { route: { shiftId: s.id } } }).catch(() => {});
    await db.route.deleteMany({ where: { shiftId: s.id } }).catch(() => {});
    await db.shift.delete({ where: { id: s.id } }).catch(() => {});
  });
  return s;
}

const DATE = todayPKTString();

/** Extras are saved with the shift's route (Save route), no customers needed. */
const giveExtras = (shiftId: string, lines: { productId: string; qty: number }[]) =>
  saveRoute({ shiftId, date: DATE, stops: [], extras: lines, override: true });

describe("rider extras — saved with the route, out of Retail", () => {
  it("takes the exact quantity from Retail, and a confirmed return puts it back", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 100);
    await sendToRetailFor(p.id, 100);
    const shift = await makeShift();
    expect(await inRetail(p.id)).toBeCloseTo(100, 3);
    expect(await onHand(p.id)).toBeCloseTo(0, 3); // all of it went to Retail

    const g = await giveExtras(shift.id, [{ productId: p.id, qty: 40 }]);
    expect(g).toEqual({ ok: true });
    expect(await inRetail(p.id)).toBeCloseTo(60, 3); // 100 − 40 out with rider

    const row = (await db.riderExtraItem.findFirst({ where: { shiftId: shift.id } }))!;
    expect(row.status).toBe("OUT");

    const r = await confirmExtraReturn(row.id, 15);
    expect(r.ok).toBe(true);
    expect(await inRetail(p.id)).toBeCloseTo(75, 3); // 60 + 15 returned = 75 (net 25 sold)
  }, 240_000);
});

describe("rider extras — no loopholes", () => {
  it("cannot take more than Retail holds (writes nothing, not even the route)", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 40);
    await sendToRetailFor(p.id, 40);
    const shift = await makeShift();

    const g = await giveExtras(shift.id, [{ productId: p.id, qty: 50 }]);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toMatch(/Retail/);
    expect(await inRetail(p.id)).toBeCloseTo(40, 3);
    expect(await db.riderExtraItem.count({ where: { shiftId: shift.id } })).toBe(0);
    expect(await db.route.count({ where: { shiftId: shift.id } })).toBe(0);
  }, 240_000);

  it("cannot return more than was given, and cannot double-confirm", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 30);
    await sendToRetailFor(p.id, 30);
    const shift = await makeShift();
    expect((await giveExtras(shift.id, [{ productId: p.id, qty: 10 }])).ok).toBe(true);
    const row = (await db.riderExtraItem.findFirst({ where: { shiftId: shift.id } }))!;

    expect((await confirmExtraReturn(row.id, 20)).ok).toBe(false); // > given
    expect((await confirmExtraReturn(row.id, 4)).ok).toBe(true);
    expect((await confirmExtraReturn(row.id, 4)).ok).toBe(false); // already confirmed — no double restock
    expect(await inRetail(p.id)).toBeCloseTo(24, 3); // 30 − 10 + 4
  }, 240_000);
});

describe("rider extras — planned before a rider is assigned", () => {
  it("saves without a rider on the shift, and still shows on Rider Item Returns", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 50);
    await sendToRetailFor(p.id, 50);
    const shift = await makeShift(false); // no rider on this shift yet
    expect(await giveExtras(shift.id, [{ productId: p.id, qty: 5 }])).toEqual({ ok: true });
    const rows = await db.riderExtraItem.findMany({ where: { shiftId: shift.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].riderId).toBeNull();
    expect(await inRetail(p.id)).toBeCloseTo(45, 3); // it is part of the shift's load

    const grp = (await getRiderReturns()).groups.find((g) => g.shiftId === shift.id)!;
    expect(grp.open).toBe(true);
    expect(grp.items[0].givenQty).toBeCloseTo(5, 3);
  }, 240_000);
});

describe("rider extras — permission guard throws for limited roles", () => {
  it("save/confirm reject a non-FULL_ACCESS role", async () => {
    setTestRole("DOCTOR");
    await expect(saveRoute({ shiftId: "x", date: DATE, stops: [], extras: [{ productId: "y", qty: 1 }] })).rejects.toThrow(/permission/i);
    await expect(confirmExtraReturn("x", 1)).rejects.toThrow(/permission/i);
  }, 240_000);
});

describe("rider returns page — getRiderReturns groups OUT items by rider + shift", () => {
  it("lists a group at the given qty, and confirming restocks it and keeps it as done", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 100);
    await sendToRetailFor(p.id, 100);
    const shift = await makeShift();
    expect((await giveExtras(shift.id, [{ productId: p.id, qty: 12 }])).ok).toBe(true);

    // The new page's loader surfaces this rider+shift group with the item OUT.
    const before = await getRiderReturns();
    expect(before.dbReady).toBe(true);
    const grp = before.groups.find((g) => g.shiftId === shift.id)!;
    expect(grp).toBeTruthy();
    expect(grp.shiftName).toBe(shift.name);
    expect(grp.items).toHaveLength(1);
    expect(grp.items[0].givenQty).toBeCloseTo(12, 3); // pre-fill value the form opens with
    const itemId = grp.items[0].id;

    // Accept it all back → stock returns; the group stays listed, marked done,
    // so the page shows what went out against what came back.
    expect((await confirmExtraReturn(itemId, 12)).ok).toBe(true);
    expect(await inRetail(p.id)).toBeCloseTo(100, 3); // 100 − 12 out + 12 back
    const after = await getRiderReturns();
    const done = after.groups.find((g) => g.shiftId === shift.id)!;
    expect(done.open).toBe(false);
    expect(done.items[0].returnedQty).toBeCloseTo(12, 3);
  }, 240_000);

  it("requires FULL_ACCESS", async () => {
    setTestRole("DOCTOR");
    await expect(getRiderReturns()).rejects.toThrow(/permission/i);
  }, 240_000);
});

describe("rider shift report — planned vs delivered", () => {
  it("marks delivered vs not-delivered and totals quantities", async () => {
    const shift = await makeShift();
    const p = await createProduct({ unit: "LITER" });
    const c1 = await createCustomer({ shiftId: shift.id });
    const c2 = await createCustomer({ shiftId: shift.id });
    // DAILY subscriptions of 2 each (planned); cleaned up with each customer.
    await db.customerProduct.create({ data: { customerId: c1.id, productId: p.id, quantity: 2, ratePerUnit: 100, scheduleType: "DAILY" } });
    await db.customerProduct.create({ data: { customerId: c2.id, productId: p.id, quantity: 2, ratePerUnit: 100, scheduleType: "DAILY" } });
    // c1 actually got delivered; c2 did not.
    await db.deliveryEntry.create({ data: { customerId: c1.id, productId: p.id, quantity: 2, unitRate: 100 } });

    const rep = await getRiderShiftReport(shift.id, DATE);
    expect(rep.ok).toBe(true);
    expect(rep.stats.plannedCustomers).toBe(2);
    expect(rep.stats.deliveredCustomers).toBe(1);

    const r1 = rep.rows.find((r) => r.customerId === c1.id)!;
    const r2 = rep.rows.find((r) => r.customerId === c2.id)!;
    expect(r1.status).toBe("delivered");
    expect(r1.deliveredTotal).toBeCloseTo(2, 3);
    expect(r2.status).toBe("not_delivered");
    expect(r2.plannedTotal).toBeCloseTo(2, 3);
  }, 240_000);

  it("requires FULL_ACCESS", async () => {
    setTestRole("DOCTOR");
    await expect(getRiderShiftReport("x", DATE)).rejects.toThrow(/permission/i);
  }, 240_000);
});
