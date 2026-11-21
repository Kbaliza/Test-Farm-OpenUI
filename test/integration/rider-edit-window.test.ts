import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, createCustomer, uniq } from "../helpers";
import { getRiderShiftReport, saveRiderEdits, refundSpoiled, replaceSpoiled } from "@/app/(dashboard)/customers/rider-report/actions";
import { todayPKTString, pktNoonToUTC, addDaysToDateStr } from "@/lib/pkt";

// A manager may change a rider's recorded work for 24 hours after the round
// ended; after that only an admin can. The server decides, on every save.

const TODAY = todayPKTString();
const HOUR = 60 * 60 * 1000;

async function shiftWithRound(date: string, completedAt: Date | null) {
  const s = await db.shift.create({ data: { name: uniq("shift") } });
  const c = await createCustomer({ shiftId: s.id });
  const p = await createProduct({ unit: "LITER", defaultRate: 100 });
  await db.customerProduct.create({ data: { customerId: c.id, productId: p.id, quantity: 2, ratePerUnit: 100, scheduleType: "DAILY" } });
  await db.deliveryEntry.create({ data: { customerId: c.id, productId: p.id, quantity: 2, unitRate: 100, date: pktNoonToUTC(date) } });
  if (completedAt !== undefined) {
    await db.route.create({ data: { shiftId: s.id, date: pktNoonToUTC(date), status: completedAt ? "COMPLETED" : "IN_PROGRESS", completedAt } });
  }
  cleanups.push(async () => {
    await db.payment.deleteMany({ where: { customerId: c.id } }).catch(() => {});
    await db.deliveryEntry.deleteMany({ where: { customerId: c.id } }).catch(() => {});
    await db.route.deleteMany({ where: { shiftId: s.id } }).catch(() => {});
    await db.customer.update({ where: { id: c.id }, data: { shiftId: null } }).catch(() => {});
    await db.shift.delete({ where: { id: s.id } }).catch(() => {});
  });
  const edit = (delivered: number) => saveRiderEdits({ customerId: c.id, shiftId: s.id, date, cash: 0, lines: [{ productId: p.id, delivered, returned: 0 }] });
  return { s, c, p, edit };
}

afterEach(() => resetTestRole());

describe("rider report edits — managers have 24 hours", () => {
  it("a manager may edit a round that ended 2 hours ago, and the report says until when", async () => {
    const ended = new Date(Date.now() - 2 * HOUR);
    const { s, edit } = await shiftWithRound(TODAY, ended);
    setTestRole("MANAGER");
    const rep = await getRiderShiftReport(s.id, TODAY);
    expect(new Date(rep.managerEditUntil!).getTime()).toBe(ended.getTime() + 24 * HOUR);
    expect(await edit(3)).toEqual({ ok: true });
  });

  it("a manager is refused 25 hours after the round ended — edit, refund and replacement alike; an admin is not", async () => {
    const { s, c, p, edit } = await shiftWithRound(TODAY, new Date(Date.now() - 25 * HOUR));
    setTestRole("MANAGER");
    const r = await edit(3);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/only an admin/);
    expect((await refundSpoiled(c.id, TODAY, p.id, 1, s.id)).ok).toBe(false);
    expect((await replaceSpoiled(c.id, TODAY, p.id, 1, s.id)).ok).toBe(false);
    // Nothing was written by the refused attempts.
    expect(await db.deliveryEntry.count({ where: { customerId: c.id } })).toBe(1);
    resetTestRole();
    expect(await edit(3)).toEqual({ ok: true });
  });

  it("a round still running, or no round on record, counts from the end of its day", async () => {
    const running = await shiftWithRound(TODAY, null);
    setTestRole("MANAGER");
    expect(await running.edit(3)).toEqual({ ok: true });

    resetTestRole();
    const old = await shiftWithRound(addDaysToDateStr(TODAY, -3), null);
    setTestRole("MANAGER");
    const r = await old.edit(3);
    expect(r.ok).toBe(false);
  });

  it("a refund without a shift is refused to a manager, never guessed", async () => {
    const { c, p } = await shiftWithRound(TODAY, new Date(Date.now() - HOUR));
    setTestRole("MANAGER");
    expect((await refundSpoiled(c.id, TODAY, p.id, 1)).ok).toBe(false);
  });
});
