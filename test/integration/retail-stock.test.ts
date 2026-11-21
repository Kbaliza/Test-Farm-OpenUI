import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, createCustomer, onHand, inRetail, sendToRetailFor, uniq } from "../helpers";
import { sendToRetail } from "@/app/(dashboard)/inventory/farm-arrival/actions";
import {
  saveRoute, saveRoutePlan, saveShiftExtras, getShiftCustomers, getPackagingLoadNeeds, getProductTotalsForDate,
} from "@/app/(dashboard)/customers/pre-delivery/actions";
import { confirmExtraReturn } from "@/app/(dashboard)/inventory/rider-extras/actions";
import { ACCEPTED_AT_PACKAGING, SENT_TO_RETAIL } from "@/lib/packaging-stock";
import { todayPKTString, addDaysToDateStr, pktNoonToUTC } from "@/lib/pkt";

// Inventory (at packaging) → Send to Retail → Retail → the shifts.
// Retail is today's stock only: whatever the shifts did not use is back in
// inventory from tomorrow, with nothing written at midnight.

afterEach(() => resetTestRole());

const TODAY = todayPKTString();
const YESTERDAY = addDaysToDateStr(TODAY, -1);
const TOMORROW = addDaysToDateStr(TODAY, 1);

/** Stock accepted at packaging — the way milk really enters inventory. */
async function accept(productId: string, quantity: number, date = new Date()) {
  await db.inventoryMovement.create({ data: { type: "ARRIVED", productId, quantity, reason: ACCEPTED_AT_PACKAGING, date } });
}

/** A shift with a rider, cleaned up with its routes, plans and extras. */
async function makeShift() {
  const user = await db.user.create({ data: { email: uniq("rd") + "@t.local", name: "Test Rider", role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const rider = await db.rider.create({ data: { userId: user.id } });
  const s = await db.shift.create({ data: { name: uniq("shift"), riderId: rider.id } });
  cleanups.push(async () => {
    await db.riderExtraItem.deleteMany({ where: { shiftId: s.id } });
    await db.routeStopItem.deleteMany({ where: { routeStop: { route: { shiftId: s.id } } } });
    await db.routeStop.deleteMany({ where: { route: { shiftId: s.id } } });
    await db.route.deleteMany({ where: { shiftId: s.id } });
    await db.routePlan.deleteMany({ where: { shiftId: s.id } }).catch(() => {});
    await db.shift.delete({ where: { id: s.id } }).catch(() => {});
    await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return s;
}

/** A shift with one customer on it; the route saves `qty` of the product for them. */
async function shiftWithCustomer(productId: string, dailyQty = 0) {
  const shift = await makeShift();
  const c = await createCustomer({ shiftId: shift.id });
  if (dailyQty > 0) {
    await db.customerProduct.create({ data: { customerId: c.id, productId, quantity: dailyQty, ratePerUnit: 100, scheduleType: "DAILY" } });
  }
  const save = (qty: number, extras?: { productId: string; qty: number }[]) =>
    saveRoute({
      shiftId: shift.id, date: TODAY, override: true, extras,
      stops: [{ customerId: c.id, stopNumber: 1, products: [{ productId, quantity: qty }] }],
    });
  return { shift, customer: c, save };
}

describe("sending moves stock from inventory to Retail", () => {
  it("inventory goes down and Retail goes up by what was sent, capped at inventory", async () => {
    const p = await createProduct();
    await accept(p.id, 50);
    expect(await onHand(p.id)).toBeCloseTo(50, 3);
    expect(await inRetail(p.id)).toBeCloseTo(0, 3);

    await sendToRetailFor(p.id, 20);
    expect(await onHand(p.id)).toBeCloseTo(30, 3);
    expect(await inRetail(p.id)).toBeCloseTo(20, 3);

    // Only what is left in inventory can be sent.
    const over = await sendToRetail([{ productId: p.id, quantity: 31 }]);
    expect(over.ok).toBe(false);
    expect(await onHand(p.id)).toBeCloseTo(30, 3);
  }, 120_000);
});

describe("a shift is assigned only when Retail holds its load", () => {
  it("refuses while Retail is short — and leaves no route behind — then saves once packaging has sent it", async () => {
    const p = await createProduct();
    await accept(p.id, 50); // in inventory, but none of it in Retail yet
    const { shift, save } = await shiftWithCustomer(p.id);

    const refused = await save(10);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/Not enough in Retail/);
    expect(await db.route.count({ where: { shiftId: shift.id } })).toBe(0);

    await sendToRetailFor(p.id, 10);
    expect(await save(10)).toEqual({ ok: true });
    expect(await inRetail(p.id)).toBeCloseTo(0, 3);  // the shift took it all
    expect(await onHand(p.id)).toBeCloseTo(40, 3);   // inventory only lost what was sent

    // Re-saving the same route counts its own load back in, so it is not refused.
    expect(await save(10)).toEqual({ ok: true });
    // …and lowering it frees the difference in Retail.
    expect(await save(6)).toEqual({ ok: true });
    expect(await inRetail(p.id)).toBeCloseTo(4, 3);
  }, 120_000);

  it("two shifts saved at the same moment cannot both take the same Retail stock", async () => {
    const p = await createProduct();
    await accept(p.id, 20);
    await sendToRetailFor(p.id, 10);
    const a = await shiftWithCustomer(p.id);
    const b = await shiftWithCustomer(p.id);

    const [ra, rb] = await Promise.all([a.save(10), b.save(10)]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
    expect(await inRetail(p.id)).toBeCloseTo(0, 3);
  }, 120_000);

  it("a started route can no longer be changed", async () => {
    const p = await createProduct();
    await accept(p.id, 20);
    await sendToRetailFor(p.id, 20);
    const { shift, save } = await shiftWithCustomer(p.id);
    expect((await save(5)).ok).toBe(true);
    await db.route.updateMany({ where: { shiftId: shift.id }, data: { status: "IN_PROGRESS" } });
    const r = await save(6, [{ productId: p.id, qty: 1 }]);
    expect(r.ok).toBe(false);
    expect(await db.riderExtraItem.count({ where: { shiftId: shift.id } })).toBe(0);
  }, 120_000);

  it("a retail (mart) product is still checked against its own stock", async () => {
    const bottle = await createProduct({ unit: "PIECE", retailOnly: true });
    await db.retailStockEntry.create({ data: { productId: bottle.id, quantity: 5, date: new Date() } });
    const { save } = await shiftWithCustomer(bottle.id);
    expect((await save(6)).ok).toBe(false); // only 5 in storage
    expect((await save(5)).ok).toBe(true);  // Retail plays no part for it
  }, 120_000);
});

describe("extras are an open field that counts in the shift's load", () => {
  it("customers plus extras are checked together; extras are saved as rider items", async () => {
    const p = await createProduct();
    await accept(p.id, 50);
    await sendToRetailFor(p.id, 10);
    const { shift, save } = await shiftWithCustomer(p.id);

    const tooMuch = await save(8, [{ productId: p.id, qty: 5 }]); // 13 > 10
    expect(tooMuch.ok).toBe(false);
    expect(await db.riderExtraItem.count({ where: { shiftId: shift.id } })).toBe(0);

    expect(await save(8, [{ productId: p.id, qty: 2 }])).toEqual({ ok: true });
    const rows = await db.riderExtraItem.findMany({ where: { shiftId: shift.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].givenQty)).toBeCloseTo(2, 3);
    expect(rows[0].riderId).toBe(shift.riderId);
    expect(await inRetail(p.id)).toBeCloseTo(0, 3);

    // Changing the extras updates the same row; removing them deletes it.
    expect(await save(8, [{ productId: p.id, qty: 1 }])).toEqual({ ok: true });
    const again = await db.riderExtraItem.findMany({ where: { shiftId: shift.id } });
    expect(again.map((r) => r.id)).toEqual([rows[0].id]);
    expect(Number(again[0].givenQty)).toBeCloseTo(1, 3);
    expect(await save(8, [])).toEqual({ ok: true });
    expect(await db.riderExtraItem.count({ where: { shiftId: shift.id } })).toBe(0);
    expect(await inRetail(p.id)).toBeCloseTo(2, 3);

    // Saving without the extras field leaves them as they are.
    expect(await save(8, [{ productId: p.id, qty: 2 }])).toEqual({ ok: true });
    expect(await save(8)).toEqual({ ok: true });
    expect(await db.riderExtraItem.count({ where: { shiftId: shift.id } })).toBe(1);
  }, 180_000);

  it("an extra already received back is kept as history and not replaced", async () => {
    const p = await createProduct();
    await accept(p.id, 50);
    await sendToRetailFor(p.id, 20);
    const { shift, save } = await shiftWithCustomer(p.id);
    expect((await save(5, [{ productId: p.id, qty: 4 }])).ok).toBe(true);
    const row = (await db.riderExtraItem.findFirst({ where: { shiftId: shift.id } }))!;
    expect((await confirmExtraReturn(row.id, 4)).ok).toBe(true);

    expect((await save(5, [{ productId: p.id, qty: 3 }])).ok).toBe(true);
    const rows = await db.riderExtraItem.findMany({ where: { shiftId: shift.id }, orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("RETURNED");
    expect(Number(rows[1].givenQty)).toBeCloseTo(3, 3);
    expect(await inRetail(p.id)).toBeCloseTo(20 - 5 - 3, 3); // the returned 4 came back in

    const res = await getShiftCustomers(shift.id, TODAY, true);
    expect(res.extras.map((e) => e.qty)).toEqual([3]);
    expect(res.settledExtras.map((e) => e.returnedQty)).toEqual([4]);
  }, 180_000);

  it("tomorrow's plan keeps its extras, and they come back when the plan is opened", async () => {
    const p = await createProduct();
    const { shift, customer } = await shiftWithCustomer(p.id);
    const r = await saveRoutePlan({
      shiftId: shift.id, date: TOMORROW, override: true,
      stops: [{ customerId: customer.id, stopNumber: 1, products: [{ productId: p.id, quantity: 4 }] }],
      extras: [{ productId: p.id, qty: 7 }], // no stock anywhere — a plan is not checked
    });
    expect(r).toEqual({ ok: true });
    const res = await getShiftCustomers(shift.id, TOMORROW, true);
    expect(res.extras).toEqual([expect.objectContaining({ productId: p.id, qty: 7 })]);
    expect(await db.riderExtraItem.count({ where: { shiftId: shift.id } })).toBe(0); // nothing reaches the rider

    const totals = await getProductTotalsForDate(TOMORROW);
    expect(totals.totals.find((t) => t.productId === p.id)?.qty).toBeCloseTo(11, 3); // 4 + 7
  }, 240_000);
});

describe("the extra load is saved on its own, without assigning the shift", () => {
  it("writes no route and takes no stock check — it only adds to what the shift will carry", async () => {
    const p = await createProduct();
    await accept(p.id, 10); // in inventory; NOTHING sent to Retail yet
    const { shift, save } = await shiftWithCustomer(p.id, 6);

    // Whatever is typed is saved, even though Retail holds none of it.
    expect(await saveShiftExtras({ shiftId: shift.id, date: TODAY, extras: [{ productId: p.id, qty: 7 }] })).toEqual({ ok: true });
    expect(await db.route.count({ where: { shiftId: shift.id } })).toBe(0); // nothing assigned
    const rows = await db.riderExtraItem.findMany({ where: { shiftId: shift.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].givenQty)).toBeCloseTo(7, 3);

    // It shows in the shift's load and in what packaging still has to send.
    const res = await getShiftCustomers(shift.id, TODAY, true);
    expect(res.extras).toEqual([expect.objectContaining({ productId: p.id, qty: 7 })]);
    setTestRole("PACKAGING");
    const line = (await getPackagingLoadNeeds(TODAY)).lines.find((l) => l.productId === p.id)!;
    expect(line.needed).toBeCloseTo(13, 3);      // 6 for the customers + 7 extra
    expect(line.stillToSend).toBeCloseTo(13, 3); // none of it is in Retail yet
    resetTestRole();

    // Changing the amount replaces it; clearing it removes it.
    expect(await saveShiftExtras({ shiftId: shift.id, date: TODAY, extras: [{ productId: p.id, qty: 2 }] })).toEqual({ ok: true });
    expect(Number((await db.riderExtraItem.findFirstOrThrow({ where: { shiftId: shift.id } })).givenQty)).toBeCloseTo(2, 3);
    expect(await saveShiftExtras({ shiftId: shift.id, date: TODAY, extras: [] })).toEqual({ ok: true });
    expect(await db.riderExtraItem.count({ where: { shiftId: shift.id } })).toBe(0);

    // Assigning the shift is still gated on Retail holding the whole load.
    expect((await save(6, [{ productId: p.id, qty: 2 }])).ok).toBe(false);
    expect(await db.route.count({ where: { shiftId: shift.id } })).toBe(0);
  }, 240_000);

  it("keeps tomorrow's extras with the plan, without wiping the day's customers", async () => {
    const p = await createProduct();
    const { shift, customer } = await shiftWithCustomer(p.id, 4); // 4 a day by subscription
    expect(await saveShiftExtras({ shiftId: shift.id, date: TOMORROW, extras: [{ productId: p.id, qty: 3 }] })).toEqual({ ok: true });

    const res = await getShiftCustomers(shift.id, TOMORROW, true);
    expect(res.extras).toEqual([expect.objectContaining({ qty: 3 })]);
    // The customer is still on the day — a plan written for the extras alone must
    // not shadow the subscriptions with an empty round.
    expect(res.stops.some((st) => st.customerId === customer.id)).toBe(true);
    expect(await db.riderExtraItem.count({ where: { shiftId: shift.id } })).toBe(0);
  }, 240_000);

  it("refuses a past day and a bad quantity", async () => {
    const p = await createProduct();
    const { shift } = await shiftWithCustomer(p.id);
    expect((await saveShiftExtras({ shiftId: shift.id, date: YESTERDAY, extras: [{ productId: p.id, qty: 1 }] })).ok).toBe(false);
    expect((await saveShiftExtras({ shiftId: shift.id, date: TODAY, extras: [{ productId: p.id, qty: -2 }] })).ok).toBe(false);
  }, 120_000);
});

describe("Retail through the day, and back to inventory after it", () => {
  it("rider returns today go back into Retail, not inventory", async () => {
    const p = await createProduct();
    await accept(p.id, 30);
    await sendToRetailFor(p.id, 10);
    await db.inventoryMovement.create({ data: { type: "RETURNED", productId: p.id, quantity: 3, reason: "End of shift return" } });
    expect(await inRetail(p.id)).toBeCloseTo(13, 3);
    expect(await onHand(p.id)).toBeCloseTo(20, 3);
  }, 120_000);

  it("yesterday's leftover is back in inventory, and yesterday's Retail is gone", async () => {
    const p = await createProduct();
    const y = pktNoonToUTC(YESTERDAY);
    await accept(p.id, 100, y);
    // Yesterday: 20 sent to Retail, a completed round of 15, extras 3 given and 1
    // back, 2 returned by the rider.
    await db.inventoryMovement.create({ data: { type: "DISPATCHED", productId: p.id, quantity: 20, reason: SENT_TO_RETAIL, date: y } });
    const shift = await makeShift();
    const c = await createCustomer({ shiftId: shift.id });
    const route = await db.route.create({ data: { shiftId: shift.id, date: y, status: "COMPLETED", completedAt: y } });
    const stop = await db.routeStop.create({ data: { routeId: route.id, customerId: c.id, stopNumber: 1 } });
    await db.routeStopItem.create({ data: { routeStopId: stop.id, productId: p.id, plannedQty: 15 } });
    await db.riderExtraItem.create({ data: { date: y, shiftId: shift.id, riderId: shift.riderId, productId: p.id, givenQty: 3, returnedQty: 1, status: "RETURNED" } });
    await db.inventoryMovement.create({ data: { type: "RETURNED", productId: p.id, quantity: 2, reason: "End of shift return", date: y } });

    // Only what was used left inventory: 100 − 15 − (3 − 1) + 2 = 85. The 20 sent is
    // not subtracted — whatever the shifts did not take came back.
    expect(await onHand(p.id)).toBeCloseTo(85, 3);
    expect(await inRetail(p.id)).toBeCloseTo(0, 3);
  }, 120_000);
});

describe("packaging sees what the shifts need", () => {
  it("today's load counts customers and extras; still to send falls to 0 as Retail fills and shifts are assigned", async () => {
    const p = await createProduct();
    await accept(p.id, 100);
    const { save } = await shiftWithCustomer(p.id, 6); // 6 a day by subscription
    await sendToRetailFor(p.id, 4);

    setTestRole("PACKAGING");
    const line = async () => (await getPackagingLoadNeeds(TODAY)).lines.find((l) => l.productId === p.id)!;
    let l = await line();
    expect(l.needed).toBeCloseTo(6, 3);
    expect(l.sent).toBeCloseTo(4, 3);
    expect(l.inRetail).toBeCloseTo(4, 3);
    expect(l.stillToSend).toBeCloseTo(2, 3);

    resetTestRole();
    await sendToRetailFor(p.id, 2);
    expect((await save(6, [{ productId: p.id, qty: 3 }])).ok).toBe(false); // 9 > 6 in Retail
    await sendToRetailFor(p.id, 3);
    expect(await save(6, [{ productId: p.id, qty: 3 }])).toEqual({ ok: true });

    setTestRole("PACKAGING");
    l = await line();
    expect(l.needed).toBeCloseTo(9, 3);
    expect(l.inRetail).toBeCloseTo(0, 3);
    expect(l.stillToSend).toBeCloseTo(0, 3);

    // Tomorrow shows what is needed only.
    const t = (await getPackagingLoadNeeds(TOMORROW)).lines.find((x) => x.productId === p.id);
    expect(t?.needed).toBeCloseTo(6, 3);
  }, 300_000);

  it("is refused to roles without packaging access", async () => {
    setTestRole("DOCTOR");
    await expect(getPackagingLoadNeeds(TODAY)).rejects.toThrow(/permission/i);
  });
});
