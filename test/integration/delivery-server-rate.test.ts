import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, uniq } from "../helpers";

// The price of a delivery is decided by our records, never by the rider app. A row
// the app saves (signed in as a rider) is priced from the customer's own rate, else
// the product's standard price; a row the website saves keeps the rate it was given.

async function riderOnShift() {
  const supabaseId = randomUUID();
  const user = await db.user.create({ data: { email: uniq("rd") + "@t.local", name: "Rate Rider", role: "RIDER", active: true, supabaseId } });
  const rider = await db.rider.create({ data: { userId: user.id, active: true } });
  const shift = await db.shift.create({ data: { name: uniq("shift"), riderId: rider.id } });
  cleanups.push(async () => {
    await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return { supabaseId, riderId: rider.id, shiftId: shift.id };
}

/** Insert a delivery exactly as the rider app does: as that rider's login, through RLS. */
async function appInsert(sub: string, row: { customerId: string; productId: string; riderId: string; unitRate: number; isReplacement?: boolean }) {
  const id = randomUUID();
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub, role: "authenticated" }));
    await tx.$executeRawUnsafe(`SET LOCAL ROLE authenticated`);
    await tx.$executeRawUnsafe(
      `INSERT INTO "DeliveryEntry" (id, date, "customerId", "productId", "riderId", quantity, "unitRate", "isReturn", "isReplacement") VALUES ($1, now(), $2, $3, $4, 2, $5, false, $6)`,
      id, row.customerId, row.productId, row.riderId, row.unitRate, row.isReplacement ?? false,
    );
  });
  return Number((await db.deliveryEntry.findUniqueOrThrow({ where: { id } })).unitRate);
}

describe("delivery prices come from our records", () => {
  it("the rider app's rate is replaced by the customer's own rate, or the standard price", async () => {
    const { supabaseId, riderId, shiftId } = await riderOnShift();
    const cow = await createProduct({ unit: "LITER", defaultRate: 260 });
    const mix = await createProduct({ unit: "LITER", defaultRate: 280 });
    const c = await createCustomer({ shiftId });
    cleanups.push(async () => { await db.deliveryEntry.deleteMany({ where: { customerId: c.id } }); });
    await db.customerProduct.create({ data: { customerId: c.id, productId: cow.id, quantity: 2, ratePerUnit: 240, scheduleType: "DAILY" } });

    expect(await appInsert(supabaseId, { customerId: c.id, productId: cow.id, riderId, unitRate: 260 })).toBe(240); // her own rate
    expect(await appInsert(supabaseId, { customerId: c.id, productId: mix.id, riderId, unitRate: 999 })).toBe(280); // no rate of her own: standard
    expect(await appInsert(supabaseId, { customerId: c.id, productId: cow.id, riderId, unitRate: 260, isReplacement: true })).toBe(260); // a free replacement is left alone
  });

  it("a delivery the website saves keeps the rate the office gave it", async () => {
    const { shiftId } = await riderOnShift();
    const cow = await createProduct({ unit: "LITER", defaultRate: 260 });
    const c = await createCustomer({ shiftId });
    cleanups.push(async () => { await db.deliveryEntry.deleteMany({ where: { customerId: c.id } }); });
    await db.customerProduct.create({ data: { customerId: c.id, productId: cow.id, quantity: 2, ratePerUnit: 240, scheduleType: "DAILY" } });
    const row = await db.deliveryEntry.create({ data: { customerId: c.id, productId: cow.id, quantity: 2, unitRate: 255, notes: "Added on the bill" } });
    expect(Number(row.unitRate)).toBe(255);
  });
});
