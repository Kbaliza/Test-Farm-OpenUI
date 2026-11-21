import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createCustomer, createProduct, uniq } from "../helpers";
import {
  getShiftCustomers,
  saveRoute,
  saveRoutePlan,
} from "@/app/(dashboard)/customers/pre-delivery/actions";
import { addDaysToDateStr, pktNoonToUTC, todayPKTString } from "@/lib/pkt";

const TODAY = todayPKTString();
const TOMORROW = addDaysToDateStr(TODAY, 1);
const YESTERDAY = addDaysToDateStr(TODAY, -1);

/** A shift with one subscribed customer: 2 L a day. */
async function shiftWithCustomer() {
  const shift = await db.shift.create({ data: { name: uniq("shift") } });
  const p = await createProduct({ unit: "LITER", defaultRate: 100 });
  const c = await createCustomer({ shiftId: shift.id });
  await db.customerProduct.create({
    data: { customerId: c.id, productId: p.id, quantity: 2, ratePerUnit: 100, scheduleType: "DAILY" },
  });
  // Pushed after the customer, so it runs BEFORE it: stops hold a key to both.
  cleanups.push(async () => {
    await db.routePlan.deleteMany({ where: { shiftId: shift.id } });
    await db.routeStopItem.deleteMany({ where: { routeStop: { route: { shiftId: shift.id } } } });
    await db.routeStop.deleteMany({ where: { route: { shiftId: shift.id } } });
    await db.route.deleteMany({ where: { shiftId: shift.id } });
    await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
  });
  return { shift, p, c };
}

const planStop = (customerId: string, productId: string, quantity: number) => ({
  customerId,
  stopNumber: 1,
  products: [{ productId, quantity }],
});

describe("planning tomorrow never hands it to the rider", () => {
  it("saves the plan and creates no route at all", async () => {
    const { shift, p, c } = await shiftWithCustomer();

    const res = await saveRoutePlan({ shiftId: shift.id, date: TOMORROW, stops: [planStop(c.id, p.id, 7)] });
    expect(res.ok).toBe(true);

    // The rider app reads Route rows. There must not be one.
    expect(await db.route.count({ where: { shiftId: shift.id } })).toBe(0);
    expect(await db.routePlan.count({ where: { shiftId: shift.id } })).toBe(1);
  });

  it("the editor opens tomorrow on the planned quantities", async () => {
    const { shift, p, c } = await shiftWithCustomer();
    await saveRoutePlan({ shiftId: shift.id, date: TOMORROW, stops: [planStop(c.id, p.id, 7)] });

    const res = await getShiftCustomers(shift.id, TOMORROW, true);
    const stop = res.stops.find((s) => s.customerId === c.id)!;
    expect(stop.products[0].quantity).toBe(7);
    expect(res.routeId).toBeNull();
  });

  it("today is untouched by tomorrow's plan", async () => {
    const { shift, p, c } = await shiftWithCustomer();
    await saveRoutePlan({ shiftId: shift.id, date: TOMORROW, stops: [planStop(c.id, p.id, 7)] });

    const res = await getShiftCustomers(shift.id, TODAY, true);
    const stop = res.stops.find((s) => s.customerId === c.id)!;
    expect(stop.products[0].quantity).toBe(2); // their ordinary subscription
  });

  it("refuses to plan today or a past day — those have a real route", async () => {
    const { shift, p, c } = await shiftWithCustomer();
    expect((await saveRoutePlan({ shiftId: shift.id, date: TODAY, stops: [planStop(c.id, p.id, 7)] })).ok).toBe(false);
    expect((await saveRoutePlan({ shiftId: shift.id, date: YESTERDAY, stops: [planStop(c.id, p.id, 7)] })).ok).toBe(false);
    expect(await db.routePlan.count({ where: { shiftId: shift.id } })).toBe(0);
  });

  it("drops a customer who has been stopped since the plan was written", async () => {
    const { shift, p, c } = await shiftWithCustomer();
    await saveRoutePlan({ shiftId: shift.id, date: TOMORROW, stops: [planStop(c.id, p.id, 7)] });
    await db.customer.update({ where: { id: c.id }, data: { status: "INACTIVE" } });

    const res = await getShiftCustomers(shift.id, TOMORROW, true);
    expect(res.stops.find((s) => s.customerId === c.id)).toBeUndefined();
  });
});

describe("the day arrives", () => {
  it("Save route hands over the plan and clears it", async () => {
    const { shift, p, c } = await shiftWithCustomer();
    // A plan written yesterday for today (the guard only allows future days, so this
    // stands in for one that has since come round).
    await db.routePlan.create({
      data: {
        shiftId: shift.id,
        date: pktNoonToUTC(TODAY),
        stops: [planStop(c.id, p.id, 7)],
      },
    });

    // Opening today shows what was prepared, still with no route behind it.
    const before = await getShiftCustomers(shift.id, TODAY, true);
    expect(before.stops.find((s) => s.customerId === c.id)!.products[0].quantity).toBe(7);
    expect(await db.route.count({ where: { shiftId: shift.id } })).toBe(0);

    const saved = await saveRoute({
      shiftId: shift.id,
      date: TODAY,
      stops: [{ customerId: c.id, stopNumber: 1, products: [{ productId: p.id, quantity: 7 }] }],
      override: true,
    });
    expect(saved.ok).toBe(true);

    // Now it is a real route, and the plan is gone — left behind it would shadow
    // the route on the next open, because a plan is read first.
    expect(await db.route.count({ where: { shiftId: shift.id } })).toBe(1);
    expect(await db.routePlan.count({ where: { shiftId: shift.id, date: pktNoonToUTC(TODAY) } })).toBe(0);

    const after = await getShiftCustomers(shift.id, TODAY, true);
    expect(after.routeId).toBeTruthy();
    expect(after.stops.find((s) => s.customerId === c.id)!.products[0].quantity).toBe(7);
  });
});


describe("no further ahead than tomorrow", () => {
  it("refuses a plan for the day after tomorrow, even if a phone lets someone pick it", async () => {
    const { shift, p, c } = await shiftWithCustomer();
    const dayAfter = addDaysToDateStr(TODAY, 2);
    const res = await saveRoutePlan({ shiftId: shift.id, date: dayAfter, stops: [planStop(c.id, p.id, 7)] });
    expect(res.ok).toBe(false);
    expect(await db.routePlan.count({ where: { shiftId: shift.id } })).toBe(0);
    expect(await db.route.count({ where: { shiftId: shift.id } })).toBe(0);
  });
});
