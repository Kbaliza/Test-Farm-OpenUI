import { describe, it, expect } from "vitest";
import { db } from "../setup";
import { createVendor, createVendorBill, snapshotHeads, uniq } from "../helpers";
import {
  recordVendorPayment,
  recordVendorReceipt,
  settleVendorContra,
  deleteVendorBill,
} from "@/app/(dashboard)/payments/vendors/actions";
import { deleteExpense } from "@/app/(dashboard)/payments/expenses/actions";
import { CONTRA_SETTLEMENT_NOTE } from "@/lib/head-balances";

async function makeReceivable(vendorId: string, amount: number) {
  return db.vendorReceivable.create({ data: { vendorId, date: new Date(), amount, received: 0, notes: uniq("recv") } });
}

describe("recordVendorPayment", () => {
  it("applies FIFO to bills; overpaying is now allowed and banks an advance", async () => {
    const v = await createVendor();
    await createVendorBill(v.id, 1000);
    const delta = await snapshotHeads(["CASH"]);

    // Overpaying used to be refused because the surplus had nowhere to go. It is
    // now a credit they owe us — covered in depth in vendor-advances.test.ts.
    const ok = await recordVendorPayment({ vendorId: v.id, amount: 600, head: "CASH" });
    expect(ok.ok).toBe(true);
    const bills = await db.vendorBill.findMany({ where: { vendorId: v.id } });
    expect(Number(bills[0].paid)).toBeCloseTo(600, 2);
    expect(await delta("CASH")).toBeCloseTo(-600, 2); // cash left the head
  });
});

describe("settleVendorContra (netting, no cash moves)", () => {
  it("nets the smaller of payable/receivable, leaves cash unchanged, both sides drop", async () => {
    const v = await createVendor();
    await createVendorBill(v.id, 5000);      // we owe 5000
    await makeReceivable(v.id, 3000);        // they owe 3000
    const delta = await snapshotHeads(["CASH"]);

    const res = await settleVendorContra({ vendorId: v.id });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settled).toBeCloseTo(3000, 2);

    const bill = (await db.vendorBill.findFirst({ where: { vendorId: v.id } }))!;
    const recv = (await db.vendorReceivable.findFirst({ where: { vendorId: v.id } }))!;
    expect(Number(bill.paid)).toBeCloseTo(3000, 2);      // payable reduced
    expect(Number(recv.received)).toBeCloseTo(3000, 2);  // receivable reduced
    expect(await delta("CASH")).toBeCloseTo(0, 2);       // NO net cash movement
  });

  it("refuses when there is nothing on one side", async () => {
    const v = await createVendor();
    await createVendorBill(v.id, 5000); // only a payable, no receivable
    expect((await settleVendorContra({ vendorId: v.id })).ok).toBe(false);
  });

  it("CONCURRENT double-click nets only once (idempotent)", async () => {
    const v = await createVendor();
    await createVendorBill(v.id, 5000);
    await makeReceivable(v.id, 3000);
    const delta = await snapshotHeads(["CASH"]);

    await Promise.all([settleVendorContra({ vendorId: v.id }), settleVendorContra({ vendorId: v.id })]);

    const bill = (await db.vendorBill.findFirst({ where: { vendorId: v.id } }))!;
    const recv = (await db.vendorReceivable.findFirst({ where: { vendorId: v.id } }))!;
    expect(Number(bill.paid)).toBeCloseTo(3000, 2);      // not 6000
    expect(Number(recv.received)).toBeCloseTo(3000, 2);  // not 6000
    expect(await delta("CASH")).toBeCloseTo(0, 2);
    // exactly one contra Payment + one contra Expense
    const exp = await db.expense.count({ where: { vendorId: v.id, description: { startsWith: CONTRA_SETTLEMENT_NOTE } } });
    expect(exp).toBe(1);
  });

  it("its contra Expense CANNOT be deleted on its own (would invent cash)", async () => {
    const v = await createVendor();
    await createVendorBill(v.id, 4000);
    await makeReceivable(v.id, 4000);
    await settleVendorContra({ vendorId: v.id });

    const contraExp = (await db.expense.findFirst({ where: { vendorId: v.id, description: { startsWith: CONTRA_SETTLEMENT_NOTE } } }))!;
    expect(contraExp).toBeTruthy();
    const del = await deleteExpense(contraExp.id);
    expect(del.ok).toBe(false); // refused
  });
});

describe("recordVendorReceipt", () => {
  it("applies FIFO to receivables and credits the head", async () => {
    const v = await createVendor();
    await makeReceivable(v.id, 2000);
    const delta = await snapshotHeads(["CASH"]);

    const res = await recordVendorReceipt({ vendorId: v.id, amount: 800, head: "CASH" });
    expect(res.ok).toBe(true);
    const recv = (await db.vendorReceivable.findFirst({ where: { vendorId: v.id } }))!;
    expect(Number(recv.received)).toBeCloseTo(800, 2);
    expect(await delta("CASH")).toBeCloseTo(800, 2); // cash came in
  });
});

describe("deleteVendorBill", () => {
  it("deletes a part-paid bill and turns what was paid into an advance", async () => {
    // This used to be refused outright, which left a wrongly-entered bill as a dead
    // end. The money is not lost: it becomes a credit with that vendor.
    const v = await createVendor();
    const bill = await createVendorBill(v.id, 1000);
    await recordVendorPayment({ vendorId: v.id, amount: 400, head: "CASH" });

    const del = await deleteVendorBill(bill.id);
    expect(del.ok).toBe(true);
    const adv = await db.vendorReceivable.findMany({ where: { vendorId: v.id, kind: "ADVANCE" } });
    expect(adv).toHaveLength(1);
    expect(Number(adv[0].amount)).toBeCloseTo(400, 2);
  });
});
