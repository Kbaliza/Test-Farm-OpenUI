import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createVendor, createVendorBill, fundHead, snapshotHeads, headBal, uniq } from "../helpers";
import {
  recordVendorPayment, recordVendorReceipt, deleteVendorReceipt,
  createVendorBill as createBillAction, deleteVendorBill, deleteVendorReceivable,
  settleVendorContra, getVendorsData,
} from "@/app/(dashboard)/payments/vendors/actions";
import { checkVendorInvariant } from "@/lib/vendor-settlement";
import { todayPKTString } from "@/lib/pkt";

// Paying a vendor more than they are owed is now allowed, and the surplus becomes a
// credit on the OTHER side. The thing that makes this safe is one invariant, so it
// is asserted after EVERY mutation below rather than only where it seems risky.

async function expectInvariant(vendorId: string) {
  const res = await checkVendorInvariant(vendorId);
  if (!res.ok) throw new Error("vendor invariant broken — " + res.detail);
  expect(res.ok).toBe(true);
}

/** A vendor plus an open bill for `amount`, with the head funded to pay it. */
async function vendorOwed(amount: number) {
  const v = await createVendor();
  if (amount > 0) await createVendorBill(v.id, amount);
  await fundHead("CASH", amount + 50_000);
  return v;
}

const openAdvanceOut = (vendorId: string) =>
  db.vendorReceivable.findMany({ where: { vendorId, kind: "ADVANCE" } });
const openAdvanceIn = (vendorId: string) =>
  db.vendorBill.findMany({ where: { vendorId, kind: "ADVANCE" } });

async function balances(vendorId: string) {
  const data = await getVendorsData();
  const row = data.vendors.find((v) => v.id === vendorId);
  return { outstanding: row?.outstanding ?? 0, receivable: row?.receivable ?? 0 };
}

describe("paying a vendor more than they are owed", () => {
  it("banks the surplus as a credit they owe us", async () => {
    const v = await vendorOwed(1000);
    const delta = await snapshotHeads(["CASH"]);

    const res = await recordVendorPayment({ vendorId: v.id, amount: 1500, head: "CASH" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.applied).toBeCloseTo(1000, 2);
    expect(res.advance).toBeCloseTo(500, 2);

    // The whole 1500 left the head — that is what actually happened.
    expect(await delta("CASH")).toBeCloseTo(-1500, 2);

    const adv = await openAdvanceOut(v.id);
    expect(adv).toHaveLength(1);
    expect(Number(adv[0].amount)).toBeCloseTo(500, 2);
    // Linked to the Expense that created it, so deleting that reverses this.
    expect(adv[0].sourceExpenseId).toBeTruthy();

    const b = await balances(v.id);
    expect(b.outstanding).toBeCloseTo(0, 2);
    expect(b.receivable).toBeCloseTo(500, 2);
    await expectInvariant(v.id);
  }, 180000);

  it("works with no bills at all — the whole amount is an advance", async () => {
    const v = await vendorOwed(0);
    const res = await recordVendorPayment({ vendorId: v.id, amount: 2000, head: "CASH" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.applied).toBeCloseTo(0, 2);
    expect(res.advance).toBeCloseTo(2000, 2);
    await expectInvariant(v.id);
  }, 180000);

  it("still cannot pay with money the head does not hold", async () => {
    const v = await createVendor();
    const box = await headBal("EASYPAISA");
    const res = await recordVendorPayment({ vendorId: v.id, amount: box + 1_000_000, head: "EASYPAISA" });
    expect(res.ok).toBe(false);
    await expectInvariant(v.id);
  }, 180000);
});

describe("an advance settles against the next bill, with no cash moving", () => {
  it("is consumed in full by a larger bill", async () => {
    const v = await vendorOwed(1000);
    expect((await recordVendorPayment({ vendorId: v.id, amount: 1500, head: "CASH" })).ok).toBe(true);

    const delta = await snapshotHeads(["CASH"]);
    const made = await createBillAction({
      vendorId: v.id, date: todayPKTString(), reference: uniq("ref"),
      lines: [{ description: "feed", category: "Feed", amount: 800 }],
    });
    expect(made.ok).toBe(true);

    // No cash moved — the money was already recorded when the advance was created.
    expect(await delta("CASH")).toBeCloseTo(0, 2);
    expect(await openAdvanceOut(v.id)).toHaveLength(0);

    const b = await balances(v.id);
    expect(b.outstanding).toBeCloseTo(300, 2); // 800 bill − 500 credit
    expect(b.receivable).toBeCloseTo(0, 2);
    await expectInvariant(v.id);
  }, 180000);

  it("is only partly consumed by a smaller bill", async () => {
    const v = await vendorOwed(1000);
    expect((await recordVendorPayment({ vendorId: v.id, amount: 1500, head: "CASH" })).ok).toBe(true);
    expect((await createBillAction({
      vendorId: v.id, date: todayPKTString(), reference: uniq("ref"),
      lines: [{ description: "feed", category: "Feed", amount: 300 }],
    })).ok).toBe(true);

    const adv = await openAdvanceOut(v.id);
    expect(adv).toHaveLength(1);
    expect(Number(adv[0].amount) - Number(adv[0].received)).toBeCloseTo(200, 2);
    const b = await balances(v.id);
    expect(b.outstanding).toBeCloseTo(0, 2);
    await expectInvariant(v.id);
  }, 180000);
});

describe("a vendor over-paying us", () => {
  it("leaves a credit we owe them", async () => {
    const v = await createVendor();
    await db.vendorReceivable.create({
      data: { vendorId: v.id, amount: 2000, received: 0, notes: uniq("sale") },
    });
    const delta = await snapshotHeads(["CASH"]);

    const res = await recordVendorReceipt({ vendorId: v.id, amount: 2500, head: "CASH" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.applied).toBeCloseTo(2000, 2);
    expect(res.advance).toBeCloseTo(500, 2);
    expect(await delta("CASH")).toBeCloseTo(2500, 2);

    const adv = await openAdvanceIn(v.id);
    expect(adv).toHaveLength(1);
    expect(adv[0].sourcePaymentId).toBeTruthy();

    const b = await balances(v.id);
    expect(b.receivable).toBeCloseTo(0, 2);
    expect(b.outstanding).toBeCloseTo(500, 2);
    await expectInvariant(v.id);
  }, 180000);

  it("the receipt now carries the vendor, so it can be undone", async () => {
    const v = await createVendor();
    await db.vendorReceivable.create({
      data: { vendorId: v.id, amount: 1000, received: 0, notes: uniq("sale") },
    });
    expect((await recordVendorReceipt({ vendorId: v.id, amount: 1400, head: "CASH" })).ok).toBe(true);

    const pay = await db.payment.findFirstOrThrow({ where: { vendorId: v.id }, orderBy: { createdAt: "desc" } });
    const delta = await snapshotHeads(["CASH"]);
    expect((await deleteVendorReceipt(pay.id)).ok).toBe(true);

    expect(await delta("CASH")).toBeCloseTo(-1400, 2);
    expect(await openAdvanceIn(v.id)).toHaveLength(0);
    const b = await balances(v.id);
    expect(b.receivable).toBeCloseTo(1000, 2); // back to being owed
    await expectInvariant(v.id);
  }, 180000);
});

describe("refunds need no special case", () => {
  it("a receipt clears an advance we are holding with them", async () => {
    const v = await vendorOwed(0);
    expect((await recordVendorPayment({ vendorId: v.id, amount: 700, head: "CASH" })).ok).toBe(true);
    expect(await openAdvanceOut(v.id)).toHaveLength(1);

    // They hand the 700 back.
    const res = await recordVendorReceipt({ vendorId: v.id, amount: 700, head: "CASH" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.applied).toBeCloseTo(700, 2);
    expect(res.advance).toBeCloseTo(0, 2);

    const b = await balances(v.id);
    expect(b.receivable).toBeCloseTo(0, 2);
    await expectInvariant(v.id);
  }, 180000);
});

describe("deleting the payment that created an advance", () => {
  it("removes the advance and un-pays the bill", async () => {
    const v = await vendorOwed(1000);
    expect((await recordVendorPayment({ vendorId: v.id, amount: 1500, head: "CASH" })).ok).toBe(true);

    const exp = await db.expense.findFirstOrThrow({ where: { vendorId: v.id }, orderBy: { createdAt: "desc" } });
    const delta = await snapshotHeads(["CASH"]);
    const { deleteExpense } = await import("@/app/(dashboard)/payments/expenses/actions");
    expect((await deleteExpense(exp.id)).ok).toBe(true);

    expect(await delta("CASH")).toBeCloseTo(1500, 2);
    expect(await openAdvanceOut(v.id)).toHaveLength(0);
    const b = await balances(v.id);
    expect(b.outstanding).toBeCloseTo(1000, 2); // the bill is open again
    await expectInvariant(v.id);
  }, 180000);

  it("works even after the advance was already consumed — the old stranding bug", async () => {
    const v = await vendorOwed(1000);
    expect((await recordVendorPayment({ vendorId: v.id, amount: 1500, head: "CASH" })).ok).toBe(true);
    // The 500 credit is swallowed by a new 800 bill.
    expect((await createBillAction({
      vendorId: v.id, date: todayPKTString(), reference: uniq("ref"),
      lines: [{ description: "feed", category: "Feed", amount: 800 }],
    })).ok).toBe(true);
    expect(await openAdvanceOut(v.id)).toHaveLength(0);

    const exp = await db.expense.findFirstOrThrow({ where: { vendorId: v.id }, orderBy: { createdAt: "desc" } });
    const delta = await snapshotHeads(["CASH"]);
    const { deleteExpense } = await import("@/app/(dashboard)/payments/expenses/actions");
    expect((await deleteExpense(exp.id)).ok).toBe(true);

    // All 1500 comes back and nothing is left half-undone.
    expect(await delta("CASH")).toBeCloseTo(1500, 2);
    const b = await balances(v.id);
    expect(b.outstanding).toBeCloseTo(1800, 2); // both bills open again
    await expectInvariant(v.id);
  }, 180000);
});

describe("the delete guards", () => {
  it("an ADVANCE bill cannot be deleted directly", async () => {
    const v = await createVendor();
    await db.vendorReceivable.create({ data: { vendorId: v.id, amount: 100, received: 0, notes: uniq("s") } });
    expect((await recordVendorReceipt({ vendorId: v.id, amount: 600, head: "CASH" })).ok).toBe(true);
    const adv = (await openAdvanceIn(v.id))[0];

    const res = await deleteVendorBill(adv.id);
    expect(res.ok).toBe(false);
    await expectInvariant(v.id);
  }, 180000);

  it("a part-paid TRADE bill deletes, and what was paid becomes an advance", async () => {
    const v = await vendorOwed(1000);
    expect((await recordVendorPayment({ vendorId: v.id, amount: 400, head: "CASH" })).ok).toBe(true);
    const bill = await db.vendorBill.findFirstOrThrow({ where: { vendorId: v.id, kind: "TRADE" } });

    const delta = await snapshotHeads(["CASH"]);
    expect((await deleteVendorBill(bill.id)).ok).toBe(true);

    expect(await delta("CASH")).toBeCloseTo(0, 2); // no cash moved
    const b = await balances(v.id);
    expect(b.outstanding).toBeCloseTo(0, 2);
    expect(b.receivable).toBeCloseTo(400, 2); // the 400 is now a credit
    await expectInvariant(v.id);
  }, 180000);

  it("an ADVANCE receivable cannot be deleted directly", async () => {
    const v = await vendorOwed(0);
    expect((await recordVendorPayment({ vendorId: v.id, amount: 900, head: "CASH" })).ok).toBe(true);
    const adv = (await openAdvanceOut(v.id))[0];
    expect((await deleteVendorReceivable(adv.id)).ok).toBe(false);
    await expectInvariant(v.id);
  }, 180000);

  it("a part-received receivable cannot be deleted", async () => {
    const v = await createVendor();
    const r = await db.vendorReceivable.create({
      data: { vendorId: v.id, amount: 1000, received: 0, notes: uniq("s") },
    });
    cleanups.push(async () => { await db.vendorReceivable.delete({ where: { id: r.id } }).catch(() => {}); });
    expect((await recordVendorReceipt({ vendorId: v.id, amount: 400, head: "CASH" })).ok).toBe(true);
    expect((await deleteVendorReceivable(r.id)).ok).toBe(false);
    await expectInvariant(v.id);
  }, 180000);
});

describe("the contra ignores advances", () => {
  it("an advance alone is never mistaken for a payable to net against", async () => {
    // Note an advance can never sit alongside an open bill on the other side: the
    // auto-settle consumes it the moment such a bill exists. So the reachable case
    // is an advance-out with nothing owed to them — and the contra must see no
    // payable at all rather than treating the credit as one.
    const v = await vendorOwed(0);
    expect((await recordVendorPayment({ vendorId: v.id, amount: 500, head: "CASH" })).ok).toBe(true);
    await db.vendorReceivable.create({ data: { vendorId: v.id, amount: 400, received: 0, notes: uniq("s") } });

    const res = await settleVendorContra({ vendorId: v.id });
    expect(res.ok).toBe(false); // nothing on the payable side — the advance is not one
    await expectInvariant(v.id);
  }, 180000);

  it("nets the trade documents that remain after an advance is absorbed", async () => {
    const v = await vendorOwed(0);
    expect((await recordVendorPayment({ vendorId: v.id, amount: 500, head: "CASH" })).ok).toBe(true);
    await db.vendorReceivable.create({ data: { vendorId: v.id, amount: 400, received: 0, notes: uniq("s") } });
    // A 900 bill absorbs the 500 credit, leaving a real 400 payable.
    expect((await createBillAction({
      vendorId: v.id, date: todayPKTString(), reference: uniq("ref"),
      lines: [{ description: "feed", category: "Feed", amount: 900 }],
    })).ok).toBe(true);
    expect(await openAdvanceOut(v.id)).toHaveLength(0);

    const mid = await balances(v.id);
    expect(mid.outstanding).toBeCloseTo(400, 2);
    expect(mid.receivable).toBeCloseTo(400, 2);

    const delta = await snapshotHeads(["CASH"]);
    expect((await settleVendorContra({ vendorId: v.id })).ok).toBe(true);

    expect(await delta("CASH")).toBeCloseTo(0, 2); // netting moves no cash
    const after = await balances(v.id);
    expect(after.outstanding).toBeCloseTo(0, 2);
    expect(after.receivable).toBeCloseTo(0, 2);
    await expectInvariant(v.id);
  }, 180000);
});

describe("concurrency", () => {
  it("two simultaneous overpayments produce two advances, never a lost one", async () => {
    const v = await vendorOwed(0);
    const [a, b] = await Promise.all([
      recordVendorPayment({ vendorId: v.id, amount: 300, head: "CASH" }),
      recordVendorPayment({ vendorId: v.id, amount: 400, head: "CASH" }),
    ]);
    expect(a.ok && b.ok).toBe(true);

    const adv = await openAdvanceOut(v.id);
    const total = adv.reduce((s, r) => s + Number(r.amount), 0);
    expect(total).toBeCloseTo(700, 2);
    await expectInvariant(v.id);
  }, 180000);
});
