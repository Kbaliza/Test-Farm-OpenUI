import { describe, it, expect } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, uniq } from "../helpers";
import {
  confirmExtraReturn,
  getAppRiderReturns,
  getRiderReturns,
} from "@/app/(dashboard)/inventory/rider-extras/actions";
import { afterEach } from "vitest";

afterEach(() => resetTestRole());

/** A rider's end-of-shift return, exactly as the mobile app writes it. */
async function appReturn(productId: string, quantity: number, riderId: string, when = new Date()) {
  const m = await db.inventoryMovement.create({
    data: { date: when, type: "RETURNED", productId, quantity, reason: "End of shift return", riderId },
  });
  cleanups.push(async () => { await db.inventoryMovement.delete({ where: { id: m.id } }).catch(() => {}); });
  return m;
}

async function rider() {
  const u = await db.user.create({ data: { email: uniq("r") + "@t.local", name: uniq("Rider"), role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const r = await db.rider.create({ data: { userId: u.id, active: true } });
  cleanups.push(async () => {
    await db.rider.delete({ where: { id: r.id } }).catch(() => {});
    await db.user.delete({ where: { id: u.id } }).catch(() => {});
  });
  return { rider: r, name: u.name };
}

describe("end-of-shift returns from the rider app", () => {
  it("are listed for the office, grouped per rider and day (they used to be invisible)", async () => {
    const p = await createProduct({ unit: "LITER" });
    const p2 = await createProduct({ unit: "PIECE" });
    const { rider: r, name } = await rider();
    await appReturn(p.id, 7, r.id);
    await appReturn(p2.id, 36, r.id);

    // A second return later the same evening — the same milk must not be listed twice.
    await appReturn(p.id, 3, r.id, new Date(Date.now() - 60_000));

    const group = (await getAppRiderReturns()).find((g) => g.riderName === name);
    expect(group).toBeTruthy();
    expect(group!.items).toHaveLength(2); // one line per product, not per record
    expect(group!.items.find((i) => i.productName === p.name)!.quantity).toBeCloseTo(10, 3);
  });

  it("leaves out older returns and anything that is not an end-of-shift return", async () => {
    const p = await createProduct({ unit: "LITER" });
    const { rider: r, name } = await rider();
    await appReturn(p.id, 5, r.id, new Date(Date.now() - 30 * 86_400_000));
    // A customer's return, mirrored by the database trigger — not a rider handover.
    const other = await db.inventoryMovement.create({
      data: { date: new Date(), type: "RETURNED", productId: p.id, quantity: 2, reason: "Customer return", riderId: r.id },
    });
    cleanups.push(async () => { await db.inventoryMovement.delete({ where: { id: other.id } }).catch(() => {}); });

    expect((await getAppRiderReturns()).find((g) => g.riderName === name)).toBeUndefined();
  });

  it("packaging staff can read it; other roles cannot", async () => {
    setTestRole("PACKAGING");
    await expect(getAppRiderReturns()).resolves.toBeTruthy();
    setTestRole("CHECKLIST");
    await expect(getAppRiderReturns()).rejects.toThrow();
  });
});

describe("extra stock given to a rider", () => {
  it("stays listed after it is received, showing given, returned and sold", async () => {
    const p = await createProduct({ unit: "LITER" });
    const { rider: r, name } = await rider();
    const shift = await db.shift.create({ data: { name: uniq("shift"), riderId: r.id } });
    const item = await db.riderExtraItem.create({
      data: { date: new Date(), shiftId: shift.id, riderId: r.id, productId: p.id, givenQty: 10, status: "OUT" },
    });
    cleanups.push(async () => {
      await db.riderExtraItem.deleteMany({ where: { shiftId: shift.id } });
      await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
    });

    const mine = async () => (await getRiderReturns()).groups.find((g) => g.riderName === name);
    const out = await mine();
    expect(out?.open).toBe(true);
    expect(out?.items[0].givenQty).toBeCloseTo(10, 3);

    // The office receives 4 L back; 6 L were sold.
    expect((await confirmExtraReturn(item.id, 4)).ok).toBe(true);

    const done = await mine();
    expect(done, "a received group used to vanish from the page").toBeTruthy();
    expect(done!.open).toBe(false);
    expect(done!.items[0].returnedQty).toBeCloseTo(4, 3);
    expect(done!.items[0].givenQty - done!.items[0].returnedQty).toBeCloseTo(6, 3);
  }, 180_000);
});
