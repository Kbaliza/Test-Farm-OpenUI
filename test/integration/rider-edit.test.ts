import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, addStock, onHand, uniq } from "../helpers";
import {
  getRiderShiftReport, saveRiderEdits, refundSpoiled, replaceSpoiled,
} from "@/app/(dashboard)/customers/rider-report/actions";
import { computeCustomerOutstanding } from "@/lib/customer-balance";
import { generateInvoice, getInvoiceDetail, saveInvoiceLines, setInvoiceDiscount } from "@/app/(dashboard)/billing/invoices/actions";
import { getDashboardData } from "@/app/(dashboard)/dashboard-data";
import { todayPKTString, pktNoonToUTC } from "@/lib/pkt";

const DATE = todayPKTString();
const D = pktNoonToUTC(DATE);
const [Y, M] = DATE.split("-").map(Number);
const HALF = Number(DATE.slice(8)) <= 15 ? 1 : 2;

async function makeShift() {
  const user = await db.user.create({ data: { email: uniq("rd") + "@t.local", name: "Test Rider", role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const rider = await db.rider.create({ data: { userId: user.id } });
  const s = await db.shift.create({ data: { name: uniq("shift"), riderId: rider.id } });
  cleanups.push(async () => {
    await db.route.deleteMany({ where: { shiftId: s.id } }).catch(() => {});
    await db.shift.delete({ where: { id: s.id } }).catch(() => {});
    await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return { shift: s, riderId: rider.id };
}

describe("rider report — real cash + skipped", () => {
  it("cash comes from RIDER_CASH payments; a skipped stop is counted", async () => {
    const { shift } = await makeShift();
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    const c1 = await createCustomer({ shiftId: shift.id });
    const c2 = await createCustomer({ shiftId: shift.id });
    for (const c of [c1, c2]) await db.customerProduct.create({ data: { customerId: c.id, productId: p.id, quantity: 2, ratePerUnit: 100, scheduleType: "DAILY" } });
    // c1 delivered + paid cash; c2 skipped (RouteStop status).
    await db.deliveryEntry.create({ data: { customerId: c1.id, productId: p.id, quantity: 2, unitRate: 100, date: D } });
    await db.payment.create({ data: { customerId: c1.id, head: "RIDER_CASH", amount: 500, date: D } });
    await db.route.create({ data: { shiftId: shift.id, date: D, stops: { create: [{ customerId: c2.id, stopNumber: 1, status: "SKIPPED" }] } } });
    // Pushed last → runs first (LIFO), so the RouteStop is gone before the customers.
    cleanups.push(async () => { await db.route.deleteMany({ where: { shiftId: shift.id } }).catch(() => {}); });

    const rep = await getRiderShiftReport(shift.id, DATE);
    expect(rep.ok).toBe(true);
    expect(rep.stats.totalCash).toBeCloseTo(500, 2);       // from the payment, not RouteStop
    expect(rep.stats.skippedCustomers).toBe(1);            // c2, folded into the card
    expect(rep.rows.find((r) => r.customerId === c1.id)!.cashCollected).toBeCloseTo(500, 2);
  });
});

describe("spoilage — refund reduces the bill; replace is free and pulls stock", () => {
  it("refund: outstanding drops by qty×rate via an isReturn entry", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    const c = await createCustomer();
    await db.customerProduct.create({ data: { customerId: c.id, productId: p.id, quantity: 5, ratePerUnit: 100, scheduleType: "DAILY" } });
    await db.deliveryEntry.create({ data: { customerId: c.id, productId: p.id, quantity: 5, unitRate: 100, date: D } });

    const before = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;
    const r = await refundSpoiled(c.id, DATE, p.id, 2);
    expect(r.ok).toBe(true);
    const after = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;
    expect(before - after).toBeCloseTo(200, 2); // 2 × 100 credited back
    const ret = await db.deliveryEntry.findFirst({ where: { customerId: c.id, isReturn: true, notes: "Spoilage refund" } });
    expect(ret).toBeTruthy();
  });

  it("replace: free to the customer, deducts on-hand, blocks over-stock", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    await addStock(p.id, 50);
    const c = await createCustomer();
    await db.customerProduct.create({ data: { customerId: c.id, productId: p.id, quantity: 3, ratePerUnit: 100, scheduleType: "DAILY" } });
    await db.deliveryEntry.create({ data: { customerId: c.id, productId: p.id, quantity: 3, unitRate: 100, date: D } });

    const balBefore = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;
    expect(await onHand(p.id)).toBeCloseTo(50, 3);
    const r = await replaceSpoiled(c.id, DATE, p.id, 3);
    expect(r.ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(47, 3);          // 50 − 3 replacement out
    const balAfter = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;
    expect(balAfter).toBeCloseTo(balBefore, 2);             // replacement costs the customer nothing
    expect((await replaceSpoiled(c.id, DATE, p.id, 1000)).ok).toBe(false); // over-stock blocked
  });
});

describe("saveRiderEdits — reconciles delivered + cash without duplicating", () => {
  it("sets delivered/returned/cash, and re-running replaces rather than stacks", async () => {
    const { shift } = await makeShift();
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    const c = await createCustomer({ shiftId: shift.id });
    await db.customerProduct.create({ data: { customerId: c.id, productId: p.id, quantity: 4, ratePerUnit: 100, scheduleType: "DAILY" } });

    const r1 = await saveRiderEdits({ customerId: c.id, shiftId: shift.id, date: DATE, cash: 300, lines: [{ productId: p.id, delivered: 4, returned: 0 }] });
    expect(r1.ok).toBe(true);
    expect(await db.deliveryEntry.count({ where: { customerId: c.id, isReturn: false, isReplacement: false } })).toBe(1);
    expect(await db.payment.count({ where: { customerId: c.id, head: "RIDER_CASH" } })).toBe(1);

    // Re-edit to a lower delivered + some cash — must reconcile, not add rows.
    const r2 = await saveRiderEdits({ customerId: c.id, shiftId: shift.id, date: DATE, cash: 200, lines: [{ productId: p.id, delivered: 3, returned: 1 }] });
    expect(r2.ok).toBe(true);
    const normal = await db.deliveryEntry.findMany({ where: { customerId: c.id, isReturn: false, isReplacement: false } });
    const rets = await db.deliveryEntry.findMany({ where: { customerId: c.id, isReturn: true } });
    expect(normal).toHaveLength(1);
    expect(Number(normal[0].quantity)).toBeCloseTo(3, 3);
    expect(rets).toHaveLength(1);
    expect(Number(rets[0].quantity)).toBeCloseTo(1, 3);
    const pays = await db.payment.findMany({ where: { customerId: c.id, head: "RIDER_CASH" } });
    expect(pays).toHaveLength(1);
    expect(Number(pays[0].amount)).toBeCloseTo(200, 2);
  });

  it("a manager edit does NOT wipe a spoilage refund", async () => {
    const { shift } = await makeShift();
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    const c = await createCustomer({ shiftId: shift.id });
    await db.customerProduct.create({ data: { customerId: c.id, productId: p.id, quantity: 5, ratePerUnit: 100, scheduleType: "DAILY" } });
    await refundSpoiled(c.id, DATE, p.id, 2); // a spoilage refund (isReturn, tagged)
    await saveRiderEdits({ customerId: c.id, shiftId: shift.id, date: DATE, cash: 0, lines: [{ productId: p.id, delivered: 5, returned: 0 }] });
    // The refund survives; the manager-edit return (0) does not add a rider-return row.
    expect(await db.deliveryEntry.count({ where: { customerId: c.id, isReturn: true, notes: "Spoilage refund" } })).toBe(1);
    expect(await db.deliveryEntry.count({ where: { customerId: c.id, isReturn: true, notes: "Manager edit" } })).toBe(0);
  });
});

describe("bills reflect live deliveries (F4)", () => {
  it("a delivery added after generation shows on the bill when re-opened", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    const c = await createCustomer();
    cleanups.push(async () => { await db.invoiceLine.deleteMany({ where: { invoice: { customerId: c.id } } }).catch(() => {}); await db.invoice.deleteMany({ where: { customerId: c.id } }).catch(() => {}); });

    const gen = await generateInvoice(c.id, Y, M, HALF);
    expect(gen.ok).toBe(true);
    const inv = (await db.invoice.findFirst({ where: { customerId: c.id, year: Y, month: M, half: HALF } }))!;

    // New delivery arrives AFTER generation.
    await db.deliveryEntry.create({ data: { customerId: c.id, productId: p.id, quantity: 4, unitRate: 100, date: D } });
    const detail = await getInvoiceDetail(inv.id);
    expect(detail!.deliveriesAmt).toBeCloseTo(400, 2); // now reflected, no manual regenerate
  });
});

// A bill is rebuilt from the live deliveries every time it is opened. Editing a
// line therefore has to reach the delivery behind it — writing to the line alone
// was wiped by the next rebuild, which is why correcting a bill did nothing at
// all.
describe("editing a bill", () => {
  async function billWith(qty: number, rate: number) {
    const p = await createProduct({ unit: "LITER", defaultRate: rate });
    const c = await createCustomer();
    cleanups.push(async () => {
      await db.invoiceLine.deleteMany({ where: { invoice: { customerId: c.id } } }).catch(() => {});
      await db.invoice.deleteMany({ where: { customerId: c.id } }).catch(() => {});
    });
    await db.deliveryEntry.create({ data: { customerId: c.id, productId: p.id, quantity: qty, unitRate: rate, date: D } });
    expect((await generateInvoice(c.id, Y, M, HALF)).ok).toBe(true);
    const inv = (await db.invoice.findFirst({ where: { customerId: c.id, year: Y, month: M, half: HALF } }))!;
    return { p, c, inv, detail: (await getInvoiceDetail(inv.id))! };
  }

  it("a corrected rate stays corrected, on the bill and on the delivery behind it", async () => {
    const { p, c, inv, detail } = await billWith(5, 100);
    expect(detail.deliveriesAmt).toBeCloseTo(500, 2);

    const line = detail.lines[0];
    expect(line.deliveryEntryId).toBeTruthy();
    const res = await saveInvoiceLines(inv.id, [{ ...line, rate: 120 }]);
    expect(res.ok).toBe(true);

    // What came back, and what the next person to open it will see.
    expect(res.ok && res.invoice.deliveriesAmt).toBeCloseTo(600, 2);
    expect((await getInvoiceDetail(inv.id))!.deliveriesAmt).toBeCloseTo(600, 2);
    // …and the delivery itself, so the ledger and the rider report agree with it.
    const de = await db.deliveryEntry.findFirstOrThrow({ where: { customerId: c.id, productId: p.id } });
    expect(Number(de.unitRate)).toBeCloseTo(120, 2);
  }, 180_000);

  it("a corrected quantity holds too", async () => {
    const { inv, detail } = await billWith(5, 100);
    const res = await saveInvoiceLines(inv.id, [{ ...detail.lines[0], quantity: 8 }]);
    expect(res.ok).toBe(true);
    expect((await getInvoiceDetail(inv.id))!.deliveriesAmt).toBeCloseTo(800, 2);
  }, 180_000);

  it("a line added by hand becomes a delivery, and a line removed takes its delivery with it", async () => {
    const { p, c, inv, detail } = await billWith(2, 50);

    const added = await saveInvoiceLines(inv.id, [
      { ...detail.lines[0] },
      { deliveryEntryId: null, date: D.toISOString(), productId: p.id, quantity: 3, rate: 50, isReturn: false, isReplacement: false },
    ]);
    expect(added.ok).toBe(true);
    expect((await getInvoiceDetail(inv.id))!.deliveriesAmt).toBeCloseTo(250, 2); // 2 + 3 at 50
    expect(await db.deliveryEntry.count({ where: { customerId: c.id } })).toBe(2);

    const back = (await getInvoiceDetail(inv.id))!;
    const removed = await saveInvoiceLines(inv.id, [back.lines[0]]);
    expect(removed.ok).toBe(true);
    expect(await db.deliveryEntry.count({ where: { customerId: c.id } })).toBe(1);
  }, 180_000);

  it("leaves a complaint's refund alone — that credit is corrected on the complaint", async () => {
    const { p, c, inv } = await billWith(4, 100);
    const complaint = await db.customerComplaint.create({
      data: { customerId: c.id, date: D, deliveryDate: D, productId: p.id, quantity: 1, category: "Spoiled", description: "test", resolution: "REFUND", enteredByName: "Test" },
    });
    const refund = await db.deliveryEntry.create({
      data: { customerId: c.id, productId: p.id, quantity: 1, unitRate: 100, date: D, isReturn: true, notes: "Spoilage refund", complaintId: complaint.id },
    });
    cleanups.push(async () => {
      await db.deliveryEntry.delete({ where: { id: refund.id } }).catch(() => {});
      await db.customerComplaint.delete({ where: { id: complaint.id } }).catch(() => {});
    });

    // Save the bill with the refund line left off it entirely.
    const detail = (await getInvoiceDetail(inv.id))!;
    const withoutRefund = detail.lines.filter((l) => l.deliveryEntryId !== refund.id);
    expect((await saveInvoiceLines(inv.id, withoutRefund)).ok).toBe(true);

    expect(await db.deliveryEntry.count({ where: { id: refund.id } })).toBe(1);
  }, 180_000);

  it("a one-off discount comes off this bill and off what the customer owes", async () => {
    const { c, inv } = await billWith(10, 100);
    const before = (await getInvoiceDetail(inv.id))!;
    expect(before.discount).toBeCloseTo(0, 2);

    expect((await setInvoiceDiscount(inv.id, 250)).ok).toBe(true);

    const after = (await getInvoiceDetail(inv.id))!;
    expect(after.discount).toBeCloseTo(250, 2);
    expect(after.deliveriesAmt).toBeCloseTo(1000, 2); // the deliveries are untouched
    expect(after.totalDue).toBeCloseTo(before.totalDue - 250, 2);

    // The balance every other screen reads agrees with the bill.
    const bal = await computeCustomerOutstanding([c.id]);
    expect(bal.get(c.id)).toBeCloseTo(after.totalDue, 2);
  }, 180_000);

  it("a discount belongs to its own bill and never carries into the next one", async () => {
    const { p, c, inv } = await billWith(10, 100);
    expect((await setInvoiceDiscount(inv.id, 300)).ok).toBe(true);

    // The other fortnight of the same month, with its own deliveries.
    const otherHalf = HALF === 1 ? 2 : 1;
    const otherDay = otherHalf === 1 ? 5 : 20;
    const other = new Date(Date.UTC(Y, M - 1, otherDay));
    await db.deliveryEntry.create({ data: { customerId: c.id, productId: p.id, quantity: 4, unitRate: 100, date: other } });
    expect((await generateInvoice(c.id, Y, M, otherHalf)).ok).toBe(true);
    const next = (await db.invoice.findFirstOrThrow({ where: { customerId: c.id, year: Y, month: M, half: otherHalf } }));

    const nextDetail = (await getInvoiceDetail(next.id))!;
    expect(nextDetail.discount).toBeCloseTo(0, 2);
  }, 240_000);

  it("refuses a discount larger than the period’s own charges", async () => {
    const { inv } = await billWith(2, 100);
    const res = await setInvoiceDiscount(inv.id, 5000);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/more than this period/i);
  }, 180_000);

  it("refuses a line dated outside the bill's own period", async () => {
    const { p, inv, detail } = await billWith(1, 100);
    const res = await saveInvoiceLines(inv.id, [
      { ...detail.lines[0] },
      { deliveryEntryId: null, date: pktNoonToUTC(`${Y}-${String(M).padStart(2, "0")}-${HALF === 1 ? "20" : "05"}`).toISOString(), productId: p.id, quantity: 1, rate: 100, isReturn: false, isReplacement: false },
    ]);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/outside this bill/i);
  }, 180_000);
});

describe("outsourced milk on the dashboard (F5)", () => {
  it("COUNTER_PURCHASE milk is counted as outsourced + a chart series", async () => {
    const monthKey = `${Y}-${String(M).padStart(2, "0")}`;
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    // Delta measurement — the shared DB already holds other COUNTER_PURCHASE milk.
    const before = (await getDashboardData(monthKey)).milkInventory.outsourced;
    const mv = await db.inventoryMovement.create({ data: { date: D, type: "COUNTER_PURCHASE", productId: p.id, quantity: 30, reason: uniq("buy") } });
    cleanups.push(async () => { await db.inventoryMovement.delete({ where: { id: mv.id } }).catch(() => {}); });

    const dash = await getDashboardData(monthKey);
    expect(dash.milkInventory.outsourced - before).toBeCloseTo(30, 2);
    expect(dash.milkTypes.some((t) => t.id === "__outsourced__" && t.name === "Outsourced")).toBe(true);
  });
});
