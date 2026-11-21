import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, createCustomer, uniq } from "../helpers";
import { updateShift, deleteShift, handOverRound } from "@/app/(dashboard)/customers/areas/actions";
import { saveShiftExtras } from "@/app/(dashboard)/customers/pre-delivery/actions";
import { updateCustomer } from "@/app/(dashboard)/customers/actions";
import { setShiftBottles } from "@/app/(dashboard)/customers/bottles/actions";
import { runningRound } from "@/lib/shift-lock";
import { pktNoonToUTC, todayPKTString } from "@/lib/pkt";

// A shift on the road — its round for today loaded by the rider and not yet
// finished — cannot be changed from the website. Before the load and after the
// round it can, exactly as before. Only an admin's deliberate handover gets past.

const TODAY = todayPKTString();

async function rider(name: string) {
  const user = await db.user.create({ data: { email: uniq("rd") + "@t.local", name, role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const r = await db.rider.create({ data: { userId: user.id, active: true } });
  cleanups.push(async () => {
    await db.inventoryMovement.deleteMany({ where: { riderId: r.id } }).catch(() => {});
    await db.rider.delete({ where: { id: r.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return r.id;
}

async function shiftWithRound(riderId: string) {
  const shift = await db.shift.create({ data: { name: uniq("shift"), riderId } });
  const c = await createCustomer({ shiftId: shift.id });
  const route = await db.route.create({ data: { shiftId: shift.id, date: pktNoonToUTC(TODAY), status: "PENDING", stops: { create: [{ customerId: c.id, stopNumber: 1 }] } } });
  cleanups.push(async () => {
    await db.route.deleteMany({ where: { shiftId: shift.id } }).catch(() => {});
    await db.customer.updateMany({ where: { shiftId: shift.id }, data: { shiftId: null } }).catch(() => {});
    await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
  });
  return { shift, route, customer: c };
}

const base = { type: "MORNING" as const, startTime: null, areaIds: [] as string[] };
const load = (riderId: string, routeId: string, productId: string) =>
  db.inventoryMovement.create({ data: { date: new Date(), type: "HANDED_OVER", productId, quantity: 10, riderId, reference: routeId } });

afterEach(() => resetTestRole());

describe("a shift on the road cannot be changed", () => {
  it("before the load everything works; after it every change is refused; after the round it works again", async () => {
    const a = await rider("Zeeshan T"), b = await rider("Ahsan T");
    const milk = await createProduct({ unit: "LITER", defaultRate: 260 });
    const { shift, route, customer } = await shiftWithRound(a);
    const other = await db.shift.create({ data: { name: uniq("other") } });
    cleanups.push(async () => { await db.shift.delete({ where: { id: other.id } }).catch(() => {}); });

    // Before any load: free.
    expect(await runningRound(shift.id)).toBeNull();
    expect((await updateShift(shift.id, { ...base, name: shift.name, riderId: a })).ok).toBe(true);

    // The rider confirms the load.
    await load(a, route.id, milk.id);
    const road = await runningRound(shift.id);
    expect(road?.routeId).toBe(route.id);
    expect(road?.byName).toBe("Zeeshan T");

    const r1 = await updateShift(shift.id, { ...base, name: shift.name, riderId: b });
    expect(r1.ok).toBe(false);
    expect(!r1.ok && r1.error).toMatch(/on the road/);
    expect((await updateShift(shift.id, { ...base, name: "Renamed", riderId: a })).ok).toBe(false); // not even the name
    expect((await deleteShift(shift.id)).ok).toBe(false);
    expect((await saveShiftExtras({ shiftId: shift.id, date: TODAY, extras: [{ productId: milk.id, qty: 5 }] })).ok).toBe(false);
    expect((await setShiftBottles(shift.id, TODAY)).ok).toBe(false);
    // The customer on the round cannot be moved off it, and nobody can be moved on to it.
    const full = { name: customer.name, invoiceName: "", phone: customer.phone, secondPhone: "", email: "", address: "", locationUrl: "", areaId: "", billingType: "CREDIT", status: "ACTIVE", customerType: "", deliverySequence: null, joinDate: TODAY, creditLimit: 0, deliveryCharge: 0, products: [{ productId: milk.id, quantity: 2, ratePerUnit: 260, scheduleType: "DAILY", alternatePattern: [], weekdays: [], anchorDate: "" }] } as never;
    const off = await updateCustomer(customer.id, { ...(full as object), shiftId: other.id } as never);
    expect(off.ok).toBe(false);
    expect(!off.ok && off.error).toMatch(/on the road/);
    const outsider = await createCustomer({ shiftId: other.id });
    const on = await updateCustomer(outsider.id, { ...(full as object), name: outsider.name, phone: outsider.phone, shiftId: shift.id } as never);
    expect(on.ok).toBe(false);
    // Still on the same shift: nothing to refuse.
    expect(await db.customer.findUnique({ where: { id: customer.id }, select: { shiftId: true } })).toEqual({ shiftId: shift.id });

    // The database says no too, whatever screen asks.
    await expect(db.shift.update({ where: { id: shift.id }, data: { riderId: b } })).rejects.toThrow(/on the road/);

    // The round finishes: free again.
    await db.route.update({ where: { id: route.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    expect(await runningRound(shift.id)).toBeNull();
    expect((await updateShift(shift.id, { ...base, name: shift.name, riderId: b })).ok).toBe(true);
  }, 300_000);

  it("an admin can hand the round over with a reason; a manager cannot; the rider and the customers follow", async () => {
    const a = await rider("Ill rider"), b = await rider("Cover rider");
    const milk = await createProduct({ unit: "LITER", defaultRate: 260 });
    const { shift, route, customer } = await shiftWithRound(a);
    await load(a, route.id, milk.id);

    setTestRole("MANAGER");
    await expect(handOverRound(shift.id, b, "fell ill")).rejects.toThrow(/permission/);
    resetTestRole();
    expect((await handOverRound(shift.id, b, "")).ok).toBe(false);           // a reason is required
    expect(await handOverRound(shift.id, b, "fell ill after loading")).toEqual({ ok: true });
    expect((await db.shift.findUnique({ where: { id: shift.id } }))!.riderId).toBe(b);
    expect((await db.customer.findUnique({ where: { id: customer.id } }))!.riderId).toBe(b);
    // Still on the road — with the new rider; ordinary changes stay refused.
    expect((await updateShift(shift.id, { ...base, name: shift.name, riderId: a })).ok).toBe(false);
  }, 300_000);
});
