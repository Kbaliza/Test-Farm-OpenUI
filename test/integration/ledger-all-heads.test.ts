import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createCustomer, headBal, uniq, fundHead } from "../helpers";
import { getLedgerData } from "@/app/(dashboard)/ledgers/actions";
import { createTransfer, createOwnerContribution } from "@/app/(dashboard)/payments/transfers/actions";
import { getHeadBalances, ALL_HEADS, VISIBLE_HEADS } from "@/lib/head-balances";
import { isHeldHead } from "@/lib/payment-heads";
import { OWNER_FUNDING_HEAD } from "@/lib/farm-owners";
import { todayPKTString } from "@/lib/pkt";

// "All Accounts" is every payment head combined. Transfers between heads are left
// out: moving money from HBL to Cash is not money arriving or leaving, and across
// all heads every transfer's two sides cancel exactly. That is what lets the
// closing balance equal the total cash the farm holds.

async function allHeads() {
  const res = await getLedgerData("head", ALL_HEADS);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

const closing = (rows: { balance: number }[]) => (rows.length ? rows[rows.length - 1].balance : 0);

// The money the farm holds — Meezan is owed to the owners, so it is not in it.
async function totalAcrossHeads() {
  return (await getHeadBalances()).filter((h) => isHeldHead(h.head)).reduce((s, h) => s + h.balance, 0);
}

it("the sentinel the picker hard-codes still matches the constant", () => {
  // ledger-client cannot import head-balances (it is server-only), so the id is
  // typed out there. If this ever diverges, the option silently stops working.
  expect(ALL_HEADS).toBe("__all_heads__");
});

describe("the combined ledger closes on the money actually held", () => {
  it("its closing balance equals the sum of every head", async () => {
    const data = await allHeads();
    expect(closing(data.rows)).toBeCloseTo(await totalAcrossHeads(), 2);
  }, 180000);

  it("still does after money moves in", async () => {
    await fundHead("CASH", 3300);
    const data = await allHeads();
    expect(closing(data.rows)).toBeCloseTo(await totalAcrossHeads(), 2);
  }, 180000);

  it("an owner funding the farm is in it, and it still balances", async () => {
    const reason = uniq("why");
    const res = await createOwnerContribution({
      owner: "SAJJAD", amount: 7700, date: todayPKTString(), reason,
    });
    cleanups.push(async () => {
      await db.ownerContribution.deleteMany({ where: { reason } }).catch(() => {});
    });
    expect(res.ok).toBe(true);

    const data = await allHeads();
    expect(data.rows.some((r) => r.note === reason)).toBe(true);
    expect(closing(data.rows)).toBeCloseTo(await totalAcrossHeads(), 2);
  }, 180000);
});

describe("transfers between our own accounts are left out", () => {
  it("moving money head to head adds no row and changes no total", async () => {
    await fundHead("CASH", 5000);
    const before = await allHeads();
    const beforeClose = closing(before.rows);
    const beforeRows = before.rows.length;

    const note = uniq("x");
    const moved = await createTransfer({ fromHead: "CASH", toHead: "HBL", amount: 2000, date: "", notes: note });
    cleanups.push(async () => { await db.headTransfer.deleteMany({ where: { notes: note } }).catch(() => {}); });
    expect(moved.ok).toBe(true);

    const after = await allHeads();
    // Not a rupee more or less: the farm holds the same money, in a different place.
    expect(closing(after.rows)).toBeCloseTo(beforeClose, 2);
    expect(after.rows.length).toBe(beforeRows);
    expect(after.rows.some((r) => r.note === note)).toBe(false);
  }, 180000);

  it("but a single head's ledger still shows that transfer", async () => {
    await fundHead("CASH", 4000);
    const note = uniq("x");
    const moved = await createTransfer({ fromHead: "CASH", toHead: "HBL", amount: 1500, date: "", notes: note });
    cleanups.push(async () => { await db.headTransfer.deleteMany({ where: { notes: note } }).catch(() => {}); });
    expect(moved.ok).toBe(true);

    const one = await getLedgerData("head", "CASH");
    if (!one.ok) throw new Error(one.error);
    expect(one.data.rows.some((r) => r.note === note)).toBe(true);
  }, 180000);
});

describe("rider cash follows the same rule it does everywhere else", () => {
  it("a collection nobody has handed over is not in the combined ledger", async () => {
    const c = await createCustomer();
    const notes = uniq("rc");
    const p = await db.payment.create({
      data: { head: "RIDER_CASH" as never, amount: 1234, customerId: c.id, notes },
    });
    cleanups.push(async () => { await db.payment.delete({ where: { id: p.id } }).catch(() => {}); });

    const data = await allHeads();
    expect(data.rows.some((r) => r.id === p.id)).toBe(false);
    // And the total is untouched — that money is with the rider, in no account.
    expect(closing(data.rows)).toBeCloseTo(await totalAcrossHeads(), 2);
  }, 180000);
});

describe("what the combined view shows", () => {
  it("names the account on every row, so they can be told apart", async () => {
    await fundHead("CASH", 900);
    const data = await allHeads();
    const labels = VISIBLE_HEADS.map((h) => h.replace("_", " "));
    const sample = data.rows.filter((r) => r.id !== "opening").slice(0, 20);
    expect(sample.length).toBeGreaterThan(0);
    for (const r of sample) {
      const named = labels.some(() => / · (Rider Cash|HBL|JazzCash|Easypaisa|Cash)$/.test(r.description));
      expect(named, r.description).toBe(true);
    }
  }, 180000);

  it("a single head's ledger does NOT append the account name", async () => {
    const one = await getLedgerData("head", OWNER_FUNDING_HEAD);
    if (!one.ok) throw new Error(one.error);
    for (const r of one.data.rows.slice(0, 10)) {
      expect(/ · HBL$/.test(r.description), r.description).toBe(false);
    }
  }, 180000);

  it("is titled as all accounts, not as a head", async () => {
    const data = await allHeads();
    expect(data.entityInfo.name).toBe("All Accounts");
  }, 180000);
});

describe("the individual heads are unaffected", () => {
  it("each one still closes on its own balance", async () => {
    for (const h of VISIBLE_HEADS) {
      const res = await getLedgerData("head", h);
      if (!res.ok) throw new Error(res.error);
      expect(closing(res.data.rows), h).toBeCloseTo(await headBal(h), 2);
    }
  }, 180000);
});
