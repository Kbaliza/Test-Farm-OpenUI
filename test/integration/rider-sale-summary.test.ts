import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, uniq } from "../helpers";
import { getRiderSaleSummary } from "@/app/(dashboard)/customers/rider-sale-summary/actions";
import { todayPKTString, pktNoonToUTC } from "@/lib/pkt";

const DATE = todayPKTString();
const D = pktNoonToUTC(DATE);

async function makeShift() {
  const user = await db.user.create({ data: { email: uniq("rd") + "@t.local", name: "Rider", role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const rider = await db.rider.create({ data: { userId: user.id } });
  const s = await db.shift.create({ data: { name: uniq("shift"), riderId: rider.id } });
  cleanups.push(async () => {
    await db.shift.delete({ where: { id: s.id } }).catch(() => {});
    await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return s;
}

describe("rider sale summary — shift-wise day roll-up", () => {
  it("aggregates delivered qty, sale, cash, returns and net receivings per shift", async () => {
    const s1 = await makeShift();
    const s2 = await makeShift();
    const p1 = await createProduct({ unit: "LITER" });
    const p2 = await createProduct({ unit: "KG" });
    const c1 = await createCustomer({ shiftId: s1.id });
    const c2 = await createCustomer({ shiftId: s2.id });

    // s1: 10 L delivered @100, 2 L returned @100, cash 500.
    await db.deliveryEntry.create({ data: { customerId: c1.id, productId: p1.id, quantity: 10, unitRate: 100, date: D } });
    await db.deliveryEntry.create({ data: { customerId: c1.id, productId: p1.id, quantity: 2, unitRate: 100, isReturn: true, date: D } });
    await db.payment.create({ data: { customerId: c1.id, head: "RIDER_CASH", amount: 500, date: D } });
    // s2: 5 kg delivered @200, no cash.
    await db.deliveryEntry.create({ data: { customerId: c2.id, productId: p2.id, quantity: 5, unitRate: 200, date: D } });

    const sum = await getRiderSaleSummary(DATE);
    expect(sum.ok).toBe(true);
    expect(sum.products.some((p) => p.id === p1.id) && sum.products.some((p) => p.id === p2.id)).toBe(true);

    const r1 = sum.rows.find((r) => r.shiftId === s1.id)!;
    expect(r1.byProduct[p1.id]).toBeCloseTo(10, 3);
    expect(r1.sale).toBeCloseTo(1000, 2);         // 10 × 100 (returns excluded from sale)
    expect(r1.returns).toBeCloseTo(200, 2);        // 2 × 100
    expect(r1.cash).toBeCloseTo(500, 2);
    expect(r1.netReceivings).toBeCloseTo(300, 2);  // 500 − 200

    const r2 = sum.rows.find((r) => r.shiftId === s2.id)!;
    expect(r2.byProduct[p2.id]).toBeCloseTo(5, 3);
    expect(r2.sale).toBeCloseTo(1000, 2);
    expect(r2.cash).toBeCloseTo(0, 2);
    expect(r2.netReceivings).toBeCloseTo(0, 2);
  });
});
