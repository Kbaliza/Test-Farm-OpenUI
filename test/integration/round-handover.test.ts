import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, uniq } from "../helpers";
import { computeReturnsBoard } from "@/lib/rider-returns-board";
import { END_OF_SHIFT_RETURN_REASON } from "@/lib/rider-stock";
import { addDaysToDateStr, pktNoonToUTC, todayPKTString } from "@/lib/pkt";

// A round loaded by one rider and handed to another by the office: the milk goes
// with the round, so the returns board counts it against whoever carried it.

const DAY = addDaysToDateStr(todayPKTString(), -2);
const at = (h: number) => new Date(pktNoonToUTC(DAY).getTime() + (h - 12) * 3600e3);

async function rider(name: string) {
  const user = await db.user.create({ data: { email: uniq("rd") + "@t.local", name, role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const r = await db.rider.create({ data: { userId: user.id, active: true } });
  cleanups.push(async () => {
    await db.inventoryMovement.deleteMany({ where: { riderId: r.id } });
    await db.deliveryEntry.deleteMany({ where: { riderId: r.id } });
    await db.rider.delete({ where: { id: r.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return r.id;
}

async function round(riderOnShift: string, customers: number) {
  const shift = await db.shift.create({ data: { name: uniq("shift"), riderId: riderOnShift } });
  const cs: { id: string }[] = [];
  for (let i = 0; i < customers; i++) cs.push(await createCustomer({ shiftId: shift.id }));
  const route = await db.route.create({
    data: { shiftId: shift.id, date: pktNoonToUTC(DAY), status: "COMPLETED", stops: { create: cs.map((c, i) => ({ customerId: c.id, stopNumber: i + 1, status: "DELIVERED" })) } },
  });
  cleanups.push(async () => {
    await db.route.delete({ where: { id: route.id } }).catch(() => {});
    for (const c of cs) await db.customer.update({ where: { id: c.id }, data: { shiftId: null } }).catch(() => {});
    await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
  });
  return { shiftId: shift.id, routeId: route.id, cs };
}

const load = (riderId: string, routeId: string, productId: string, qty: number) =>
  db.inventoryMovement.create({ data: { date: at(7), type: "HANDED_OVER", productId, quantity: qty, riderId, reference: routeId } });
const deliver = (riderId: string, customerId: string, productId: string, qty: number, hour: number) =>
  db.deliveryEntry.create({ data: { date: at(hour), createdAt: at(hour), customerId, productId, quantity: qty, unitRate: 260, riderId } });
const giveBack = (riderId: string, routeId: string, productId: string, qty: number) =>
  db.inventoryMovement.create({ data: { date: at(15), type: "RETURNED", productId, quantity: qty, riderId, reference: routeId, reason: END_OF_SHIFT_RETURN_REASON } });

function missingOf(board: Awaited<ReturnType<typeof computeReturnsBoard>>, riderId: string, pid: string) {
  const r = board.rows.find((x) => x.date === DAY && x.riderId === riderId);
  if (!r) return null;
  return Math.round(((r.got[pid] ?? 0) - (r.delivered[pid] ?? 0) - (r.returned[pid] ?? 0) - (r.riderWasted[pid] ?? 0) + (r.reviewMissing[pid] ?? 0)) * 10) / 10;
}

describe("a round handed to another rider after it was loaded", () => {
  it("handed over whole: the rider who carried it is counted for it, the one who loaded it is not", async () => {
    const zeeshan = await rider("Loader"), ahsan = await rider("Carrier");
    const cow = await createProduct({ unit: "LITER", defaultRate: 260 });
    const { routeId, cs } = await round(ahsan, 2);
    await load(zeeshan, routeId, cow.id, 20);            // Zeeshan confirms the load …
    await deliver(ahsan, cs[0].id, cow.id, 8, 9);         // … the office gives the shift to Ahsan, who delivers it
    await deliver(ahsan, cs[1].id, cow.id, 7, 10);
    await giveBack(ahsan, routeId, cow.id, 4);            // and brings back 4: 1 L really is missing

    const b = await computeReturnsBoard(DAY, DAY);
    expect(missingOf(b, ahsan, cow.id)).toBe(1);          // the shortfall is on whoever had the van
    expect(missingOf(b, zeeshan, cow.id) ?? 0).toBe(0);   // nothing charged to the loader
  }, 300_000);

  it("handed over mid-round: each is counted for his part, the one who finished takes the rest", async () => {
    const zeeshan = await rider("First half"), ahsan = await rider("Second half");
    const cow = await createProduct({ unit: "LITER", defaultRate: 260 });
    const { routeId, cs } = await round(ahsan, 3);
    await load(zeeshan, routeId, cow.id, 30);
    await deliver(zeeshan, cs[0].id, cow.id, 10, 9);      // Zeeshan starts the round
    await deliver(ahsan, cs[1].id, cow.id, 9, 13);        // Ahsan finishes it
    await deliver(ahsan, cs[2].id, cow.id, 8, 14);
    await giveBack(ahsan, routeId, cow.id, 3);            // 30 − 10 − 17 − 3 = 0 missing

    const b = await computeReturnsBoard(DAY, DAY);
    expect(missingOf(b, zeeshan, cow.id)).toBe(0);
    expect(missingOf(b, ahsan, cow.id)).toBe(0);
  }, 300_000);

  it("a round only its loader worked on is counted as before", async () => {
    const wajid = await rider("Only rider");
    const cow = await createProduct({ unit: "LITER", defaultRate: 260 });
    const { routeId, cs } = await round(wajid, 1);
    await load(wajid, routeId, cow.id, 12);
    await deliver(wajid, cs[0].id, cow.id, 10, 9);
    const b = await computeReturnsBoard(DAY, DAY);
    expect(missingOf(b, wajid, cow.id)).toBe(2);
  }, 300_000);
});
