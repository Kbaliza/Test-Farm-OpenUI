import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, uniq } from "../helpers";
import { bottleCustomers, bottleLedger, bottleDay } from "@/lib/bottles";
import { recordBottleReturn, adjustBottles, setShiftBottles } from "@/app/(dashboard)/customers/bottles/actions";
import { saveRiderEdits } from "@/app/(dashboard)/customers/rider-report/actions";
import { addDaysToDateStr, pktNoonToUTC, todayPKTString } from "@/lib/pkt";

// One bottle is one litre; a customer holds what was delivered since the shift
// went to bottles, less what came back. A skipped day changes nothing, a visit
// with no milk can still take empties back, and packets from before the switch
// never count.

const T = todayPKTString();
const d = (n: number) => addDaysToDateStr(T, -n);

async function bottleShift(since: string) {
  const shift = await db.shift.create({ data: { name: uniq("bshift"), bottlesSince: pktNoonToUTC(since) } });
  cleanups.push(async () => {
    await db.bottleReturn.deleteMany({ where: { customer: { shiftId: shift.id } } });
    await db.bottleAdjustment.deleteMany({ where: { customer: { shiftId: shift.id } } });
    await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
  });
  return shift;
}
// `bottles` is what the rider app records; left out, the litres went in packets.
const deliver = (customerId: string, productId: string, day: string, qty: number, o: { isReturn?: boolean; bottles?: number | null; notes?: string } = {}) =>
  db.deliveryEntry.create({ data: { date: pktNoonToUTC(day), customerId, productId, quantity: qty, unitRate: 260, isReturn: o.isReturn ?? false, bottles: o.bottles ?? null, notes: o.notes ?? null } });

describe("glass bottles", () => {
  it("counts what a customer holds across deliveries, skips, returns and corrections", async () => {
    const milk = await createProduct({ unit: "LITER" });
    const eggs = await createProduct({ unit: "PIECE" });
    const shift = await bottleShift(d(5));
    const c = await createCustomer({ shiftId: shift.id });
    cleanups.push(async () => { await db.deliveryEntry.deleteMany({ where: { customerId: c.id } }); });

    await deliver(c.id, milk.id, d(7), 5, { bottles: 5 }); // before the switch: never counted
    await deliver(c.id, milk.id, d(5), 5, { bottles: 5 }); // 5 bottles out
    await deliver(c.id, eggs.id, d(5), 12);                 // eggs are not bottles
    await deliver(c.id, milk.id, d(4), 3, { bottles: 3 }); // took 3, gave back 5
    expect((await recordBottleReturn({ customerId: c.id, date: d(4), returned: 5 })).ok).toBe(true);
    // d(3): skipped — nothing recorded, still holds 3
    expect((await recordBottleReturn({ customerId: c.id, date: d(2), returned: 2 })).ok).toBe(true); // no milk, 2 empties back
    await deliver(c.id, milk.id, d(1), 4, { bottles: 4 });                 // holds 1 + 4 = 5
    await deliver(c.id, milk.id, d(1), 1, { isReturn: true, bottles: 1 }); // a bottle sent back full: 4

    const row = (await bottleCustomers(d(5), T)).find((x) => x.customerId === c.id)!;
    expect(row.given).toBe(12);        // 5 + 3 + 4
    expect(row.returned).toBe(7);      // 5 + 2
    expect(row.visits).toBe(3);
    expect(row.held).toBe(4);          // 12 − 1 (milk back) − 7

    // The window narrows given/returned but not what is held.
    const narrow = (await bottleCustomers(d(1), T)).find((x) => x.customerId === c.id)!;
    expect(narrow.given).toBe(4);
    expect(narrow.returned).toBe(0);
    expect(narrow.held).toBe(4);

    // Two bottles broke: written off.
    expect((await adjustBottles({ customerId: c.id, date: T, bottles: -2, reason: "broken" })).ok).toBe(true);
    const led = await bottleLedger(c.id);
    expect(led.held).toBe(2);
    expect(led.since).toBe(d(5));
    expect(led.rows[0].date).toBe(T);
    expect(led.rows[0].adjusted).toBe(-2);
    // Running count, oldest to newest: 5, 3, 3?, 1, 4, 2 — skipped day has no row.
    expect([...led.rows].reverse().map((r) => `${r.date}:${r.held}`)).toEqual([`${d(5)}:5`, `${d(4)}:3`, `${d(2)}:1`, `${d(1)}:4`, `${T}:2`]);

    // Recording 0 removes the day's return.
    expect((await recordBottleReturn({ customerId: c.id, date: d(2), returned: 0 })).ok).toBe(true);
    expect((await bottleLedger(c.id)).held).toBe(4);
  }, 300_000);

  it("a shift on packets is not on the page, and switching it on starts from the chosen day", async () => {
    const milk = await createProduct({ unit: "LITER" });
    const shift = await db.shift.create({ data: { name: uniq("pshift") } });
    cleanups.push(async () => { await db.shift.delete({ where: { id: shift.id } }).catch(() => {}); });
    const c = await createCustomer({ shiftId: shift.id });
    cleanups.push(async () => { await db.deliveryEntry.deleteMany({ where: { customerId: c.id } }); });
    await deliver(c.id, milk.id, d(3), 6, { bottles: 6 });
    await deliver(c.id, milk.id, d(1), 2, { bottles: 2 });
    expect((await bottleCustomers(d(9), T)).some((x) => x.customerId === c.id)).toBe(false);

    expect((await setShiftBottles(shift.id, d(2))).ok).toBe(true);
    const row = (await bottleCustomers(d(9), T)).find((x) => x.customerId === c.id)!;
    expect(row.held).toBe(2);  // the 6 L on d(3) were packets
    expect((await setShiftBottles(shift.id, null)).ok).toBe(true);
    expect((await bottleCustomers(d(9), T)).some((x) => x.customerId === c.id)).toBe(false);
    void bottleDay;
  }, 300_000);

  it("counts the bottles the rider recorded, not the litres — packets and refused stops hold nothing", async () => {
    const milk = await createProduct({ unit: "LITER" });
    const shift = await bottleShift(d(3));
    const c = await createCustomer({ shiftId: shift.id });
    cleanups.push(async () => { await db.deliveryEntry.deleteMany({ where: { customerId: c.id } }); });

    await deliver(c.id, milk.id, d(3), 3, { bottles: 2 });  // 2 L in bottles + 1 L in a packet
    await deliver(c.id, milk.id, d(2), 2);                   // all packets (bottles left empty)
    await deliver(c.id, milk.id, d(2), 1, { bottles: 0 });   // 0 = packets too
    await deliver(c.id, milk.id, d(1), 3, { notes: "Customer refused delivery" }); // billed, no milk went out

    const row = (await bottleCustomers(d(3), T)).find((x) => x.customerId === c.id)!;
    expect(row.given).toBe(2);
    expect(row.held).toBe(2);

    const led = await bottleLedger(c.id);
    const first = led.rows.find((r) => r.date === d(3))!;
    expect(first.given).toBe(2);
    expect(first.litres).toBe(3);      // the page still shows the milk that went
    expect(led.rows.find((r) => r.date === d(2))!.given).toBe(0);
    expect(led.held).toBe(2);
  }, 300_000);

  it("a delivery made in the morning of the switch-over day counts — the day starts at midnight, not noon", async () => {
    const milk = await createProduct({ unit: "LITER" });
    const shift = await bottleShift(d(1));
    const c = await createCustomer({ shiftId: shift.id });
    cleanups.push(async () => { await db.deliveryEntry.deleteMany({ where: { customerId: c.id } }); });
    // 8 AM PKT on the first day, as the rider app stamps it; and 11 PM the day before.
    const at8am = new Date(pktNoonToUTC(d(1)).getTime() - 4 * 60 * 60 * 1000);
    const dayBefore11pm = new Date(pktNoonToUTC(d(2)).getTime() + 11 * 60 * 60 * 1000);
    await db.deliveryEntry.create({ data: { date: at8am, customerId: c.id, productId: milk.id, quantity: 2, unitRate: 260, bottles: 2 } });
    await db.deliveryEntry.create({ data: { date: dayBefore11pm, customerId: c.id, productId: milk.id, quantity: 5, unitRate: 260, bottles: 5 } });
    const row = (await bottleCustomers(d(1), T)).find((x) => x.customerId === c.id)!;
    expect(row.given).toBe(2);
    expect(row.held).toBe(2);
  }, 300_000);

  it("a manager's edit on the rider report keeps the bottles the rider recorded", async () => {
    const milk = await createProduct({ unit: "LITER", defaultRate: 260 });
    const shift = await bottleShift(d(2));
    const c = await createCustomer({ shiftId: shift.id });
    cleanups.push(async () => { await db.deliveryEntry.deleteMany({ where: { customerId: c.id } }); await db.payment.deleteMany({ where: { customerId: c.id } }); });
    await deliver(c.id, milk.id, d(1), 3, { bottles: 3 });

    // Same litres: the 3 bottles stay. Fewer litres: never more bottles than litres.
    expect((await saveRiderEdits({ customerId: c.id, shiftId: shift.id, date: d(1), cash: 0, lines: [{ productId: milk.id, delivered: 3, returned: 0 }] })).ok).toBe(true);
    expect((await bottleCustomers(d(2), T)).find((x) => x.customerId === c.id)!.held).toBe(3);
    expect((await saveRiderEdits({ customerId: c.id, shiftId: shift.id, date: d(1), cash: 0, lines: [{ productId: milk.id, delivered: 2, returned: 0 }] })).ok).toBe(true);
    expect((await bottleCustomers(d(2), T)).find((x) => x.customerId === c.id)!.held).toBe(2);
  }, 300_000);
});
