import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, createCustomer, uniq } from "../helpers";
import { getMilkChartData } from "@/app/(dashboard)/milk-chart-actions";
import { OUTSOURCED_KEY } from "@/lib/milk-chart";
import { pktNoonToUTC, todayPKTString, addDaysToDateStr } from "@/lib/pkt";

afterEach(() => resetTestRole());

const TODAY = todayPKTString();
const YESTERDAY = addDaysToDateStr(TODAY, -1);

/** A delivery of `qty` litres on `day`; a return is the credit side of one. */
async function delivered(customerId: string, productId: string, qty: number, day: string, isReturn = false) {
  const e = await db.deliveryEntry.create({
    data: { customerId, productId, quantity: qty, unitRate: 100, isReturn, date: pktNoonToUTC(day) },
  });
  cleanups.push(async () => { await db.deliveryEntry.delete({ where: { id: e.id } }).catch(() => {}); });
}

/** Milk bought in over the counter, which is inventory but not farm arrival. */
async function boughtIn(productId: string, qty: number, day: string) {
  const m = await db.inventoryMovement.create({
    data: { date: pktNoonToUTC(day), type: "COUNTER_PURCHASE", productId, quantity: qty, reason: uniq("test") },
  });
  cleanups.push(async () => { await db.inventoryMovement.delete({ where: { id: m.id } }).catch(() => {}); });
}

describe("the dashboard's milk inventory vs sales", () => {
  it("counts sales net of returns, and bought-in milk as inventory", async () => {
    const p = await createProduct({ unit: "LITER" });
    const c = await createCustomer();
    const before = await getMilkChartData(TODAY, TODAY);

    await delivered(c.id, p.id, 40, TODAY);
    await delivered(c.id, p.id, 5, TODAY, true); // a return comes off the sales
    await boughtIn(p.id, 30, TODAY);

    const after = await getMilkChartData(TODAY, TODAY);
    expect(after.totals.sales - before.totals.sales).toBeCloseTo(35, 3);
    expect(after.totals.outsourced - before.totals.outsourced).toBeCloseTo(30, 3);
    expect(after.days).toHaveLength(1);
    expect(after.days[0].sales[p.id]).toBeCloseTo(35, 3);
    expect(after.days[0].inventory[OUTSOURCED_KEY]).toBeGreaterThanOrEqual(30);
  }, 180_000);

  it("keeps each day separate, and a range returns one entry per day", async () => {
    const p = await createProduct({ unit: "LITER" });
    const c = await createCustomer();
    await delivered(c.id, p.id, 10, TODAY);
    await delivered(c.id, p.id, 25, YESTERDAY);

    const two = await getMilkChartData(YESTERDAY, TODAY);
    expect(two.days).toHaveLength(2);
    expect(two.days[0].sales[p.id]).toBeCloseTo(25, 3);
    expect(two.days[1].sales[p.id]).toBeCloseTo(10, 3);

    const justToday = await getMilkChartData(TODAY, TODAY);
    expect(justToday.days[0].sales[p.id]).toBeCloseTo(10, 3);
  }, 180_000);

  it("tidies up the dates it is given: reversed, future, or nonsense", async () => {
    const reversed = await getMilkChartData(TODAY, YESTERDAY);
    expect([reversed.from, reversed.to]).toEqual([YESTERDAY, TODAY]);

    const future = await getMilkChartData(TODAY, addDaysToDateStr(TODAY, 30));
    expect(future.to).toBe(TODAY);

    const junk = await getMilkChartData("not-a-date", "");
    expect([junk.from, junk.to]).toEqual([TODAY, TODAY]);
  }, 120_000);

  it("is closed to roles that cannot see the dashboard figures", async () => {
    setTestRole("PACKAGING");
    await expect(getMilkChartData(TODAY, TODAY)).rejects.toThrow();
  });
});
