import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createVendor, createVendorBill, createEmployee, snapshotHeads, uniq } from "../helpers";
import { addExpense, deleteExpense } from "@/app/(dashboard)/payments/expenses/actions";

async function testCategory() {
  const c = await db.expenseCategory.create({ data: { name: uniq("cat") } });
  cleanups.push(async () => { await db.expense.deleteMany({ where: { categoryId: c.id } }); await db.expenseCategory.delete({ where: { id: c.id } }).catch(() => {}); });
  return c;
}

describe("addExpense", () => {
  it("rejects NaN / non-positive amounts (NaN must not poison a head)", async () => {
    const cat = await testCategory();
    const base = { date: "", description: uniq("d"), categoryId: cat.id, head: "CASH", chitReceived: false };
    expect((await addExpense({ ...base, amount: NaN })).ok).toBe(false);
    expect((await addExpense({ ...base, amount: 0 })).ok).toBe(false);
    expect((await addExpense({ ...base, amount: -5 })).ok).toBe(false);
  });

  it("a blank date falls back to today (no Invalid-Date crash)", async () => {
    const cat = await testCategory();
    const res = await addExpense({ date: "", amount: 50, description: uniq("blankdate"), categoryId: cat.id, head: "CASH", chitReceived: false });
    expect(res).toMatchObject({ ok: true });
  });

  it("normal: debits the paying head", async () => {
    const cat = await testCategory();
    const delta = await snapshotHeads(["CASH"]);
    const res = await addExpense({ date: "2026-08-01", amount: 300, description: uniq("exp"), categoryId: cat.id, head: "CASH", chitReceived: false });
    expect(res).toMatchObject({ ok: true });
    expect(await delta("CASH")).toBeCloseTo(-300, 2);
  });

  it("vendor payment applies FIFO, and deleteExpense reverses both the cash AND the bill", async () => {
    const cat = await testCategory();
    const v = await createVendor();
    await createVendorBill(v.id, 1000);
    const desc = uniq("vpay");
    const delta = await snapshotHeads(["CASH"]);

    const res = await addExpense({ date: "2026-08-01", amount: 400, description: desc, categoryId: cat.id, head: "CASH", chitReceived: false, vendorId: v.id });
    expect(res).toMatchObject({ ok: true });
    let bill = (await db.vendorBill.findFirst({ where: { vendorId: v.id } }))!;
    expect(Number(bill.paid)).toBeCloseTo(400, 2);
    expect(await delta("CASH")).toBeCloseTo(-400, 2);

    const exp = (await db.expense.findFirst({ where: { description: desc } }))!;
    const del = await deleteExpense(exp.id);
    expect(del.ok).toBe(true);
    bill = (await db.vendorBill.findFirst({ where: { vendorId: v.id } }))!;
    expect(Number(bill.paid)).toBeCloseTo(0, 2);      // bill re-opened
    expect(await delta("CASH")).toBeCloseTo(0, 2);    // cash returned
  });

  it("salary via Expenses tab files a SalaryPayment under the chosen period", async () => {
    const cat = await testCategory();
    const e = await createEmployee({ dailyWage: 1000 });
    const delta = await snapshotHeads(["CASH"]);

    const res = await addExpense({ date: "2026-08-01", amount: 5000, description: "sal", categoryId: cat.id, head: "CASH", chitReceived: false, employeeId: e.id, salaryPeriod: "2026-06" });
    expect(res.ok).toBe(true);

    const sp = await db.salaryPayment.findFirst({ where: { employeeId: e.id } });
    expect(sp).toBeTruthy();
    expect(sp!.month).toBe(6);  // the salary PERIOD, not the payment date's month (8)
    expect(sp!.year).toBe(2026);
    expect(await delta("CASH")).toBeCloseTo(-5000, 2); // still debits the head
    // and NO plain Expense row was written for a salary
    const exp = await db.expense.count({ where: { categoryId: cat.id } });
    expect(exp).toBe(0);
  });
});
