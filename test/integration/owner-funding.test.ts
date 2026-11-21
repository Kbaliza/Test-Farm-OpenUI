import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { snapshotHeads, headBal, uniq, createEmployee } from "../helpers";
import {
  createOwnerContribution, deleteOwnerContribution, createTransfer, getTransfersPageData,
} from "@/app/(dashboard)/payments/transfers/actions";
import { getLedgerData } from "@/app/(dashboard)/ledgers/actions";
import { addExpense } from "@/app/(dashboard)/payments/expenses/actions";
import { OWNER_FUNDING_HEAD } from "@/lib/farm-owners";
import { todayPKTString } from "@/lib/pkt";

// Sajjad and Moiz sometimes pay farm costs from their own personal accounts. That
// money arrives from OUTSIDE the farm, so it is not a transfer between two heads:
// it credits HBL and leaves the farm owing them. It is a liability, never income.

async function fundFromOwner(owner: string, amount: number, reason = uniq("why")) {
  const res = await createOwnerContribution({ owner, amount, date: todayPKTString(), reason });
  cleanups.push(async () => {
    await db.ownerContribution.deleteMany({ where: { reason } }).catch(() => {});
  });
  return { res, reason };
}

describe("an owner funding the farm credits HBL, and is owed back on Meezan", () => {
  it("raises HBL by the amount, takes Meezan into minus by it, and moves no other account", async () => {
    const delta = await snapshotHeads(["HBL", "MEEZAN", "CASH", "RIDER_CASH", "JAZZCASH", "EASYPAISA"]);
    const { res } = await fundFromOwner("SAJJAD", 50000);
    expect(res.ok).toBe(true);

    expect(await delta("HBL")).toBeCloseTo(50000, 2);
    expect(await delta("MEEZAN")).toBeCloseTo(-50000, 2);
    for (const h of ["CASH", "RIDER_CASH", "JAZZCASH", "EASYPAISA"]) {
      expect(await delta(h), h).toBeCloseTo(0, 2);
    }
  }, 180000);

  it("writes no HeadTransfer — there is no account to move money out of", async () => {
    const before = await db.headTransfer.count();
    const { res } = await fundFromOwner("MOIZ", 1200);
    expect(res.ok).toBe(true);
    expect(await db.headTransfer.count()).toBe(before);
  }, 180000);

  it("refuses an unknown owner, a zero amount and a missing reason", async () => {
    const day = todayPKTString();
    expect((await createOwnerContribution({ owner: "NOBODY", amount: 100, date: day, reason: "x" })).ok).toBe(false);
    expect((await createOwnerContribution({ owner: "SAJJAD", amount: 0, date: day, reason: "x" })).ok).toBe(false);
    expect((await createOwnerContribution({ owner: "SAJJAD", amount: 100, date: day, reason: "   " })).ok).toBe(false);
  }, 180000);
});

describe("the money is immediately spendable, like any other money in HBL", () => {
  it("an expense the head could not have afforded before now goes through", async () => {
    const emp = await createEmployee();
    const cat = await db.expenseCategory.findFirst({ select: { id: true } });
    if (!cat) return; // no categories seeded on this database

    const before = await headBal(OWNER_FUNDING_HEAD);
    await fundFromOwner("SAJJAD", 30000);

    const description = uniq("exp");
    const res = await addExpense({
      date: todayPKTString(), amount: before + 25000, description,
      categoryId: cat.id, head: OWNER_FUNDING_HEAD, chitReceived: false, employeeId: emp.id,
    });
    cleanups.push(async () => {
      await db.salaryPayment.deleteMany({ where: { notes: { contains: description } } }).catch(() => {});
      await db.expense.deleteMany({ where: { description } }).catch(() => {});
    });
    expect(res.ok).toBe(true);
  }, 180000);

  it("the overdraft guard still refuses more than is really there", async () => {
    const box = await headBal(OWNER_FUNDING_HEAD);
    const res = await createTransfer({
      fromHead: OWNER_FUNDING_HEAD, toHead: "CASH",
      amount: box + 1_000_000, date: "", notes: uniq("x"),
    });
    expect(res.ok).toBe(false);
  }, 180000);
});

describe("deleting a mis-keyed contribution", () => {
  it("takes the money back out of HBL", async () => {
    const { reason } = await fundFromOwner("MOIZ", 4000);
    const row = await db.ownerContribution.findFirstOrThrow({ where: { reason } });
    const delta = await snapshotHeads(["HBL"]);

    expect((await deleteOwnerContribution(row.id)).ok).toBe(true);
    expect(await delta("HBL")).toBeCloseTo(-4000, 2);
  }, 180000);

  it("is refused once the money has been spent, rather than driving HBL negative", async () => {
    const { reason } = await fundFromOwner("SAJJAD", 7000);
    const row = await db.ownerContribution.findFirstOrThrow({ where: { reason } });

    // Move the whole head out, so the contribution is no longer sitting there.
    const box = await headBal(OWNER_FUNDING_HEAD);
    const note = uniq("x");
    const moved = await createTransfer({ fromHead: OWNER_FUNDING_HEAD, toHead: "CASH", amount: box, date: "", notes: note });
    cleanups.push(async () => { await db.headTransfer.deleteMany({ where: { notes: note } }).catch(() => {}); });
    expect(moved.ok).toBe(true);

    expect((await deleteOwnerContribution(row.id)).ok).toBe(false);
    expect(await headBal(OWNER_FUNDING_HEAD)).toBeGreaterThanOrEqual(-0.005);
  }, 180000);
});

describe("what the screens show", () => {
  it("the owner's ledger totals what the farm owes them", async () => {
    const led0 = await getLedgerData("owner", "SAJJAD");
    if (!led0.ok) throw new Error(led0.error);
    const owedBefore = led0.data.rows.length ? led0.data.rows[led0.data.rows.length - 1].balance : 0;

    const { reason } = await fundFromOwner("SAJJAD", 15000);

    const led = await getLedgerData("owner", "SAJJAD");
    if (!led.ok) throw new Error(led.error);
    const last = led.data.rows[led.data.rows.length - 1];
    expect(last.balance).toBeCloseTo(owedBefore + 15000, 2);
    expect(led.data.rows.some((r) => r.description === reason)).toBe(true);
  }, 180000);

  it("one owner's ledger does not include the other's money", async () => {
    const { reason } = await fundFromOwner("MOIZ", 9000);
    const led = await getLedgerData("owner", "SAJJAD");
    if (!led.ok) throw new Error(led.error);
    expect(led.data.rows.some((r) => r.description === reason)).toBe(false);
  }, 180000);

  it("an unknown owner is an error, not an empty ledger", async () => {
    const led = await getLedgerData("owner", "NOBODY");
    expect(led.ok).toBe(false);
  }, 180000);

  it("the HBL ledger shows it, and still closes on the head balance", async () => {
    const { reason } = await fundFromOwner("SAJJAD", 6500);
    const led = await getLedgerData("head", OWNER_FUNDING_HEAD);
    if (!led.ok) throw new Error(led.error);

    const row = led.data.rows.find((r) => r.note === reason);
    expect(row).toBeTruthy();
    expect(row!.credit).toBeCloseTo(6500, 2);
    // The invariant: the ledger's closing figure IS the head balance.
    expect(led.data.rows[led.data.rows.length - 1].balance)
      .toBeCloseTo(await headBal(OWNER_FUNDING_HEAD), 2);
  }, 180000);

  it("it appears in the transfers list, marked as owner funding", async () => {
    const { reason } = await fundFromOwner("MOIZ", 2500);
    const page = await getTransfersPageData();
    const row = page.transfers.find((t) => t.notes === reason);
    expect(row).toBeTruthy();
    expect(row!.kind).toBe("owner");
    expect(row!.toHead).toBe(OWNER_FUNDING_HEAD);
    expect(row!.fromLabel).toContain("Moiz");
  }, 180000);
});
