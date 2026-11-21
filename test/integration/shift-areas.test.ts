import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createCustomer, uniq } from "../helpers";
import { createShift, updateShift } from "@/app/(dashboard)/customers/areas/actions";
import { todayPKTString, pktNoonToUTC } from "@/lib/pkt";

// A customer carries his own shift, so moving an area between shifts must take
// its customers along — or the new shift opens in the editor with nobody on it.

async function area() {
  const a = await db.area.create({ data: { name: uniq("area") } });
  cleanups.push(async () => { await db.area.delete({ where: { id: a.id } }).catch(() => {}); });
  return a;
}
async function shiftWith(areaIds: string[]) {
  const s = await db.shift.create({ data: { name: uniq("shift"), areas: { connect: areaIds.map((id) => ({ id })) } } });
  cleanups.push(async () => {
    await db.customer.updateMany({ where: { shiftId: s.id }, data: { shiftId: null } });
    await db.shift.delete({ where: { id: s.id } }).catch(() => {});
  });
  return s;
}
async function cust(shiftId: string | null, areaId: string) {
  const c = await createCustomer({ shiftId });
  return db.customer.update({ where: { id: c.id }, data: { areaId } });
}
const base = { type: "MORNING" as const, startTime: null, riderId: null };

describe("shifts and their areas", () => {
  it("an area moved to another shift brings its customers", async () => {
    const moving = await area(), staying = await area();
    const old = await shiftWith([moving.id, staying.id]);
    const c1 = await cust(old.id, moving.id);
    const c2 = await cust(old.id, staying.id);
    const fresh = await shiftWith([]);

    // The old shift gives the area up, the new one takes it.
    expect((await updateShift(old.id, { ...base, name: old.name, areaIds: [staying.id] })).ok).toBe(true);
    const res = await updateShift(fresh.id, { ...base, name: fresh.name, areaIds: [moving.id] });
    expect(res).toEqual({ ok: true, moved: 1, held: 0 });
    expect((await db.customer.findUnique({ where: { id: c1.id } }))!.shiftId).toBe(fresh.id);
    expect((await db.customer.findUnique({ where: { id: c2.id } }))!.shiftId).toBe(old.id);
  });

  it("moved in two saves — added to the new shift first, then taken off the old — still brings them", async () => {
    const moving = await area();
    const old = await shiftWith([moving.id]);
    const c = await cust(old.id, moving.id);
    const fresh = await shiftWith([]);
    // First save: both shifts hold the area, so it is shared and nobody moves yet.
    expect(await updateShift(fresh.id, { ...base, name: fresh.name, areaIds: [moving.id] })).toEqual({ ok: true, moved: 0, held: 0 });
    expect((await db.customer.findUnique({ where: { id: c.id } }))!.shiftId).toBe(old.id);
    // Second save: the old shift gives it up, and the customer follows the area.
    expect(await updateShift(old.id, { ...base, name: old.name, areaIds: [] })).toEqual({ ok: true, moved: 1, held: 0 });
    expect((await db.customer.findUnique({ where: { id: c.id } }))!.shiftId).toBe(fresh.id);
  });

  it("an area given up that no other shift runs keeps its customers where they are", async () => {
    const lonely = await area();
    const s = await shiftWith([lonely.id]);
    const c = await cust(s.id, lonely.id);
    expect(await updateShift(s.id, { ...base, name: s.name, areaIds: [] })).toEqual({ ok: true, moved: 0, held: 0 });
    expect((await db.customer.findUnique({ where: { id: c.id } }))!.shiftId).toBe(s.id);
  });

  it("a customer on a round still running today is held back, and moves on the next save once it is finished", async () => {
    const moving = await area();
    const old = await shiftWith([moving.id]);
    const onRound = await cust(old.id, moving.id);
    const free = await cust(old.id, moving.id);
    const fresh = await shiftWith([]);
    // The old shift gives the area up before its round goes out (a shift on the
    // road cannot be changed at all — see shift-on-road.test.ts).
    expect(await updateShift(old.id, { ...base, name: old.name, areaIds: [] })).toEqual({ ok: true, moved: 0, held: 0 });
    const route = await db.route.create({
      data: { shiftId: old.id, date: pktNoonToUTC(todayPKTString()), status: "IN_PROGRESS", startedAt: new Date(), stops: { create: [{ customerId: onRound.id, stopNumber: 1 }] } },
    });
    cleanups.push(async () => { await db.route.delete({ where: { id: route.id } }).catch(() => {}); });
    // The rider is out with onRound's milk: only the other one moves.
    expect(await updateShift(fresh.id, { ...base, name: fresh.name, areaIds: [moving.id] })).toEqual({ ok: true, moved: 1, held: 1 });
    expect((await db.customer.findUnique({ where: { id: onRound.id } }))!.shiftId).toBe(old.id);
    expect((await db.customer.findUnique({ where: { id: free.id } }))!.shiftId).toBe(fresh.id);
    // Round finished: the same save now moves the one held back.
    await db.route.update({ where: { id: route.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    expect(await updateShift(fresh.id, { ...base, name: fresh.name, areaIds: [moving.id] })).toEqual({ ok: true, moved: 1, held: 0 });
    expect((await db.customer.findUnique({ where: { id: onRound.id } }))!.shiftId).toBe(fresh.id);
  });

  it("an area two shifts share is left alone — it is split customer by customer", async () => {
    const shared = await area();
    const a = await shiftWith([shared.id]);
    const c = await cust(a.id, shared.id);
    const b = await shiftWith([]);
    const res = await updateShift(b.id, { ...base, name: b.name, areaIds: [shared.id] });
    expect(res).toEqual({ ok: true, moved: 0, held: 0 });
    expect((await db.customer.findUnique({ where: { id: c.id } }))!.shiftId).toBe(a.id);
  });

  it("a new shift made with an area nobody runs picks up its customers", async () => {
    const orphan = await area();
    const c = await cust(null, orphan.id);
    const name = uniq("newshift");
    const res = await createShift({ ...base, name, areaIds: [orphan.id] });
    const s = await db.shift.findUniqueOrThrow({ where: { name } });
    cleanups.push(async () => {
      await db.customer.updateMany({ where: { shiftId: s.id }, data: { shiftId: null } });
      await db.shift.delete({ where: { id: s.id } }).catch(() => {});
    });
    expect(res).toEqual({ ok: true, moved: 1, held: 0 });
    expect((await db.customer.findUnique({ where: { id: c.id } }))!.shiftId).toBe(s.id);
  });
});
