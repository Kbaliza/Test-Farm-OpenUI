import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, addStock, sendToRetailFor, uniq } from "../helpers";
import {
  getShiftCustomers,
  saveRoute,
  getOnCallCustomersForShift,
  searchCustomersForRoute,
} from "@/app/(dashboard)/customers/pre-delivery/actions";
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

describe("on-call customers", () => {
  it("are kept off the automatic route, listed for the shift, and survive a save/reload", async () => {
    const shift = await makeShift();
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 100);
    await sendToRetailFor(p.id, 100); // today's route draws on Retail, not inventory

    const regular = await createCustomer({ shiftId: shift.id });
    await db.customerProduct.create({
      data: { customerId: regular.id, productId: p.id, quantity: 2, ratePerUnit: 100, scheduleType: "DAILY" },
    });

    const onCall = await createCustomer({ shiftId: shift.id, status: "ON_CALL" });
    await db.customerProduct.create({
      data: { customerId: onCall.id, productId: p.id, quantity: 3, ratePerUnit: 100, scheduleType: "DAILY" },
    });
    cleanups.push(async () => { await db.route.deleteMany({ where: { shiftId: shift.id } }).catch(() => {}); });

    // 1. The automatic route contains the regular customer but NOT the on-call one.
    const auto = await getShiftCustomers(shift.id, DATE);
    expect(auto.stops.some((s) => s.customerId === regular.id)).toBe(true);
    expect(auto.stops.some((s) => s.customerId === onCall.id)).toBe(false);

    // 2. They're offered in the route editor's on-call list, with saved quantities.
    const list = await getOnCallCustomersForShift(shift.id);
    const listed = list.find((c) => c.customerId === onCall.id);
    expect(listed).toBeTruthy();
    expect(listed!.products.find((x) => x.productId === p.id)!.quantity).toBe(3);
    // …and the regular customer is not in that list.
    expect(list.some((c) => c.customerId === regular.id)).toBe(false);

    // 3. Search can still find them (they're addable by hand, just not automatic).
    const found = await searchCustomersForRoute(onCall.customerCode, DATE);
    expect(found.some((c) => c.customerId === onCall.id)).toBe(true);

    // 4. Once added and saved, a reload must KEEP them — the saved-route filter used
    //    to drop anyone who wasn't ACTIVE, which silently lost them on reopen.
    expect(
      await saveRoute({
        shiftId: shift.id,
        date: DATE,
        stops: [
          { customerId: regular.id, stopNumber: 1, products: [{ productId: p.id, quantity: 2 }] },
          { customerId: onCall.id, stopNumber: 2, products: [{ productId: p.id, quantity: 3 }] },
        ],
      })
    ).toEqual({ ok: true });

    const reloaded = await getShiftCustomers(shift.id, DATE);
    const stop = reloaded.stops.find((s) => s.customerId === onCall.id);
    expect(stop).toBeTruthy();
    expect(stop!.products.find((x) => x.productId === p.id)!.quantity).toBe(3);
    // Longer timeout: this case makes many sequential round-trips and the staging
    // database answers more slowly than the 30s default allows.
  }, 180_000);

  it("an INACTIVE customer is still dropped from a saved route (unchanged behaviour)", async () => {
    const shift = await makeShift();
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 100);
    await sendToRetailFor(p.id, 100); // today's route draws on Retail, not inventory
    const c = await createCustomer({ shiftId: shift.id });
    await db.customerProduct.create({
      data: { customerId: c.id, productId: p.id, quantity: 1, ratePerUnit: 100, scheduleType: "DAILY" },
    });
    cleanups.push(async () => { await db.route.deleteMany({ where: { shiftId: shift.id } }).catch(() => {}); });

    await saveRoute({
      shiftId: shift.id, date: DATE,
      stops: [{ customerId: c.id, stopNumber: 1, products: [{ productId: p.id, quantity: 1 }] }],
    });
    await db.customer.update({ where: { id: c.id }, data: { status: "INACTIVE" } });

    const reloaded = await getShiftCustomers(shift.id, DATE);
    expect(reloaded.stops.some((s) => s.customerId === c.id)).toBe(false);
  }, 180_000);
});
