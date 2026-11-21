import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createCustomer, snapshotHeads, fundHead, uniq } from "../helpers";
import { recordPayment } from "@/app/(dashboard)/billing/payment-receiving/actions";
import { addExpense, getRecentExpenses, getMonthlyExpenses } from "@/app/(dashboard)/payments/expenses/actions";
import { createTransfer, deleteTransfer, createOwnerContribution } from "@/app/(dashboard)/payments/transfers/actions";
import { getLedgerData } from "@/app/(dashboard)/ledgers/actions";
import { markSampleDelivered } from "@/app/(dashboard)/samples/actions";
import { getHeadBalances, getHeadBalance, INFLOW_HEADS, VISIBLE_HEADS, ALL_HEADS } from "@/lib/head-balances";
import { isHeldHead } from "@/lib/payment-heads";
import { todayPKTString } from "@/lib/pkt";

// Meezan is the owners' shared account: what Sajjad and Moiz paid for the farm.
// It runs in minus — the amount the farm owes them — and comes back up only when
// the farm repays them by a transfer into it. It is never in the money the farm
// holds, and money is never received into it.

const closing = (rows: { balance: number }[]) => (rows.length ? rows[rows.length - 1].balance : 0);

async function testCategory() {
  const c = await db.expenseCategory.create({ data: { name: uniq("cat") } });
  cleanups.push(async () => { await db.expense.deleteMany({ where: { categoryId: c.id } }); await db.expenseCategory.delete({ where: { id: c.id } }).catch(() => {}); });
  return c;
}

describe("Meezan, the owners' account", () => {
  it("is shown with every head, but money is never received into it", async () => {
    expect(VISIBLE_HEADS).toContain("MEEZAN");
    expect(INFLOW_HEADS).not.toContain("MEEZAN");
    expect((await getHeadBalances()).find((h) => h.head === "MEEZAN")?.label).toBe("Meezan");

    const c = await createCustomer();
    const res = await recordPayment({ customerId: c.id, amount: 500, head: "MEEZAN", date: "", notes: "t-mz-refused" });
    expect(res.ok).toBe(false);
    expect(await db.payment.count({ where: { customerId: c.id } })).toBe(0);
  }, 120000);

  it("an owner's contribution lands in HBL and is owed back on Meezan", async () => {
    const delta = await snapshotHeads(["HBL", "MEEZAN"]);
    const reason = uniq("mz-own");
    const res = await createOwnerContribution({ owner: "MOIZ", amount: 4000, date: todayPKTString(), reason });
    cleanups.push(async () => { await db.ownerContribution.deleteMany({ where: { reason } }).catch(() => {}); });
    expect(res.ok).toBe(true);
    expect(await delta("HBL")).toBeCloseTo(4000, 2);
    expect(await delta("MEEZAN")).toBeCloseTo(-4000, 2);
  }, 120000);

  it("paying through Meezan is the owners paying: never refused, runs into minus, no farm account moves", async () => {
    const cat = await testCategory();
    const delta = await snapshotHeads(["MEEZAN", "HBL", "CASH"]);
    // Far more than Meezan could ever "hold" — there is no limit on it.
    const amount = Math.abs(await getHeadBalance("MEEZAN")) + 250_000;
    const res = await addExpense({ date: "", amount, description: uniq("mz-exp"), categoryId: cat.id, head: "MEEZAN", chitReceived: false });
    expect(res).toMatchObject({ ok: true });
    expect(await delta("MEEZAN")).toBeCloseTo(-amount, 2);
    expect(await delta("HBL")).toBeCloseTo(0, 2);
    expect(await delta("CASH")).toBeCloseTo(0, 2);
  }, 120000);

  it("repaying the owners (HBL → Meezan) brings the minus back up, and a delete reverses it", async () => {
    await fundHead("HBL", 3000);
    const delta = await snapshotHeads(["HBL", "MEEZAN"]);
    const res = await createTransfer({ fromHead: "HBL", toHead: "MEEZAN", amount: 2500, date: "", notes: "t-mz-repay" });
    expect(res.ok).toBe(true);
    expect(await delta("HBL")).toBeCloseTo(-2500, 2);
    expect(await delta("MEEZAN")).toBeCloseTo(2500, 2);

    const t = await db.headTransfer.findFirst({ where: { notes: "t-mz-repay" }, orderBy: { createdAt: "desc" } });
    expect((await deleteTransfer(t!.id)).ok).toBe(true);
    expect(await delta("HBL")).toBeCloseTo(0, 2);
    expect(await delta("MEEZAN")).toBeCloseTo(0, 2);
  }, 120000);

  it("its own ledger closes on its balance; the combined ledger closes on the money held, without it", async () => {
    const own = await getLedgerData("head", "MEEZAN");
    if (!own.ok) throw new Error(own.error);
    expect(closing(own.data.rows)).toBeCloseTo(await getHeadBalance("MEEZAN"), 2);

    const all = await getLedgerData("head", ALL_HEADS);
    if (!all.ok) throw new Error(all.error);
    const held = (await getHeadBalances()).filter((h) => isHeldHead(h.head)).reduce((s, h) => s + h.balance, 0);
    expect(closing(all.data.rows)).toBeCloseTo(held, 2);
  }, 180000);

  it("is not a way a sample is paid", async () => {
    const res = await markSampleDelivered("__no_such_sample__", "MEEZAN");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Choose Cash/);
  });

  it("the expenses list filters by head, and the month counts what went through Meezan", async () => {
    const cat = await testCategory();
    const mzDesc = uniq("mz-list"), cashDesc = uniq("cash-list");
    await fundHead("CASH", 500);
    expect(await addExpense({ date: "", amount: 321, description: mzDesc, categoryId: cat.id, head: "MEEZAN", chitReceived: false })).toMatchObject({ ok: true });
    expect(await addExpense({ date: "", amount: 123, description: cashDesc, categoryId: cat.id, head: "CASH", chitReceived: false })).toMatchObject({ ok: true });

    const mzRows = await getRecentExpenses("today", cat.id, null, "MEEZAN");
    expect(mzRows.map((r) => r.description)).toContain(mzDesc);
    expect(mzRows.map((r) => r.description)).not.toContain(cashDesc);
    expect(mzRows.every((r) => r.headKey === "MEEZAN")).toBe(true);

    const cashRows = await getRecentExpenses("today", cat.id, null, "CASH");
    expect(cashRows.map((r) => r.description)).toEqual([cashDesc]);
    // An unknown head is ignored rather than trusted.
    expect((await getRecentExpenses("today", cat.id, null, "BITCOIN")).length).toBe(2);

    const [y, m] = todayPKTString().split("-").map(Number);
    const month = await getMonthlyExpenses(m, y);
    expect(month.entries.find((e) => e.description === mzDesc)?.headKey).toBe("MEEZAN");
    const through = month.ownerFunding.byOwner.find((o) => o.name === "Through Meezan");
    expect(through?.amount ?? 0).toBeGreaterThanOrEqual(321 - 0.01);
    expect(Array.isArray(month.ownerFunding.contributions)).toBe(true);
  }, 180000);
});
