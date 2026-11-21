import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createCustomer, snapshotHeads, fundHead, headBal, uniq } from "../helpers";
import {
  confirmRiderCashReceived, undoRiderCashReceived, getRiderCashData,
} from "@/app/(dashboard)/payments/rider-cash/actions";
import { recordPayment } from "@/app/(dashboard)/billing/payment-receiving/actions";
import { createTransfer } from "@/app/(dashboard)/payments/transfers/actions";
import { getLedgerData } from "@/app/(dashboard)/ledgers/actions";

// Rider Cash is a CASHBOX. A collection is recorded the moment the rider takes the
// money — the customer's bill drops straight away — but the money does not enter the
// head until the rider hands it over and a manager confirms receipt. Until then it is
// "cash with riders", in no head at all.

async function riderPayment(handedOver: boolean, amount = 500) {
  const c = await createCustomer();
  const p = await db.payment.create({
    data: {
      head: "RIDER_CASH" as never, amount, customerId: c.id, notes: uniq("rc"),
      handedOverAt: handedOver ? new Date() : null,
    },
  });
  cleanups.push(async () => {
    await db.headTransfer.deleteMany({ where: { notes: { contains: c.name } } }).catch(() => {});
    await db.payment.delete({ where: { id: p.id } }).catch(() => {});
  });
  return Object.assign(p, { customerName: c.name });
}

/** A transfer that undoes itself, so a failed assertion can't leave the head short. */
async function spendFromBox(amount: number, note: string) {
  const res = await createTransfer({
    fromHead: "RIDER_CASH", toHead: "CASH", amount, date: "", notes: note,
  });
  cleanups.push(async () => {
    await db.headTransfer.deleteMany({ where: { notes: note } }).catch(() => {});
  });
  return res;
}

describe("a collection is not in the head until it is handed over", () => {
  it("collecting leaves the Rider Cash head untouched", async () => {
    const delta = await snapshotHeads(["RIDER_CASH", "CASH"]);
    await riderPayment(false, 900);
    // The money is in the rider's pocket, so it is in no head at all.
    expect(await delta("RIDER_CASH")).toBeCloseTo(0, 2);
    expect(await delta("CASH")).toBeCloseTo(0, 2);
  }, 180000);

  it("confirming puts it INTO Rider Cash, and leaves Office Cash alone", async () => {
    const p = await riderPayment(true, 800);
    const delta = await snapshotHeads(["RIDER_CASH", "CASH"]);

    expect((await confirmRiderCashReceived(p.id)).ok).toBe(true);

    expect(await delta("RIDER_CASH")).toBeCloseTo(800, 2);
    // It stays in the box. Depositing to Office Cash is a separate, manual transfer.
    expect(await delta("CASH")).toBeCloseTo(0, 2);
    const fresh = await db.payment.findUnique({ where: { id: p.id } });
    expect(fresh!.receivedAt).not.toBeNull();
  }, 180000);

  it("no sweep transfer is created any more", async () => {
    const p = await riderPayment(true, 700);
    expect((await confirmRiderCashReceived(p.id)).ok).toBe(true);
    // Scoped to this row's own customer — a global count is not safe on a shared DB.
    expect(await db.headTransfer.count({
      where: { fromHead: "RIDER_CASH" as never, notes: { contains: p.customerName } },
    })).toBe(0);
  }, 180000);

  it("shows as cash with riders before confirmation, and stops after", async () => {
    const p = await riderPayment(true, 450);
    const before = (await getRiderCashData()).summary.withRiders;
    expect((await confirmRiderCashReceived(p.id)).ok).toBe(true);
    const after = await getRiderCashData();
    expect(after.summary.withRiders).toBeCloseTo(before - 450, 2);
    // …and the same 450 is now in the box.
    expect(after.summary.riderCashBox).toBeCloseTo(await headBal("RIDER_CASH"), 2);
  }, 180000);
});

describe("cash still with the riders cannot be spent", () => {
  it("an outflow cannot draw on money nobody has handed over", async () => {
    const startBal = await headBal("RIDER_CASH");
    await riderPayment(true, 5000); // collected, NOT confirmed

    // Only the pre-existing balance is available — the 5,000 is with the rider, and
    // the overdraft guard must see the same figure the screens do.
    const res = await spendFromBox(startBal + 4000, uniq("x"));
    expect(res.ok).toBe(false);
  }, 180000);
});

describe("only the rider can start the handover", () => {
  it("refuses to confirm cash the rider has not handed over in the app", async () => {
    // The office confirms that cash ARRIVED; it does not get to assert that a rider
    // handed it over. Without this one person could clear a collection from both
    // ends, and it would silently clear the row from the uncollected-cash alert.
    const p = await riderPayment(false, 300);
    const delta = await snapshotHeads(["RIDER_CASH"]);

    const res = await confirmRiderCashReceived(p.id);
    expect(res.ok).toBe(false);

    const fresh = await db.payment.findUnique({ where: { id: p.id } });
    expect(fresh!.receivedAt).toBeNull();
    // And nothing was stamped on its behalf.
    expect(fresh!.handedOverAt).toBeNull();
    expect(fresh!.handedToName).toBeNull();
    expect(await delta("RIDER_CASH")).toBeCloseTo(0, 2);
  }, 180000);

  it("does not overwrite a handover the rider really did record", async () => {
    const when = new Date(Date.now() - 3 * 3600_000);
    const c = await createCustomer();
    const p = await db.payment.create({
      data: {
        head: "RIDER_CASH" as never, amount: 100, customerId: c.id, notes: uniq("rc"),
        handedOverAt: when, handedToName: "Store Manager",
      },
    });
    cleanups.push(async () => { await db.payment.delete({ where: { id: p.id } }).catch(() => {}); });

    expect((await confirmRiderCashReceived(p.id)).ok).toBe(true);
    const fresh = await db.payment.findUnique({ where: { id: p.id } });
    expect(fresh!.handedOverAt!.getTime()).toBe(when.getTime());
    expect(fresh!.handedToName).toBe("Store Manager");
  }, 180000);
});

describe("undo is guarded in the direction the money actually moves", () => {
  it("refuses when the box has already been spent down", async () => {
    const p = await riderPayment(true, 2000);
    expect((await confirmRiderCashReceived(p.id)).ok).toBe(true);

    // Spend the whole box.
    const box = await headBal("RIDER_CASH");
    const spend = await spendFromBox(box, uniq("x"));
    expect(spend.ok).toBe(true);

    // Undoing would hand 2,000 back to the rider out of an empty box.
    const undo = await undoRiderCashReceived(p.id);
    expect(undo.ok).toBe(false);
    expect(await headBal("RIDER_CASH")).toBeGreaterThanOrEqual(-0.005);
  }, 180000);

  it("undoing a confirmed collection takes it back out of the box", async () => {
    const p = await riderPayment(true, 1200);
    expect((await confirmRiderCashReceived(p.id)).ok).toBe(true);
    const delta = await snapshotHeads(["RIDER_CASH"]);
    expect((await undoRiderCashReceived(p.id)).ok).toBe(true);
    expect(await delta("RIDER_CASH")).toBeCloseTo(-1200, 2);
    const fresh = await db.payment.findUnique({ where: { id: p.id } });
    expect(fresh!.receivedAt).toBeNull();
  }, 180000);

  it("a LEGACY row with its sweep transfer still undoes against Cash", async () => {
    // Rows confirmed before the sweep was removed still have a paired transfer;
    // deleting it puts money back on RIDER_CASH and takes it off CASH.
    const c = await createCustomer();
    const p = await db.payment.create({
      data: {
        head: "RIDER_CASH" as never, amount: 400, customerId: c.id, notes: uniq("rc"),
        handedOverAt: new Date(), receivedAt: new Date(), receivedByName: "Old Manager",
      },
    });
    const x = await db.headTransfer.create({
      data: { fromHead: "RIDER_CASH" as never, toHead: "CASH" as never, amount: 400,
              notes: `Rider cash received — legacy · ${c.name}`, date: new Date() },
    });
    cleanups.push(async () => {
      await db.headTransfer.delete({ where: { id: x.id } }).catch(() => {});
      await db.payment.delete({ where: { id: p.id } }).catch(() => {});
    });
    await fundHead("CASH", 1000); // so CASH can afford the reversal

    const delta = await snapshotHeads(["RIDER_CASH", "CASH"]);
    expect((await undoRiderCashReceived(p.id)).ok).toBe(true);
    // The payment leaves the head (−400) and so does the transfer (+400): net zero.
    expect(await delta("RIDER_CASH")).toBeCloseTo(0, 2);
    expect(await delta("CASH")).toBeCloseTo(-400, 2);
    expect(await db.headTransfer.findUnique({ where: { id: x.id } })).toBeNull();
  }, 180000);
});

describe("only a rider handover can put money in the box", () => {
  it("a customer payment cannot be received into Rider Cash", async () => {
    const c = await createCustomer();
    const res = await recordPayment({
      customerId: c.id, amount: 500, head: "RIDER_CASH",
      date: new Date().toISOString().slice(0, 10), notes: uniq("p"),
    } as never);
    expect(res.ok).toBe(false);
  }, 180000);
});

describe("the Rider Cash ledger agrees with the head balance", () => {
  it("un-confirmed collections are absent, and confirming adds exactly one row", async () => {
    const p = await riderPayment(true, 650);

    const before = await getLedgerData("head", "RIDER_CASH");
    if (!before.ok) throw new Error(before.error);
    expect(before.data.rows.some((r) => r.id === p.id)).toBe(false);

    expect((await confirmRiderCashReceived(p.id)).ok).toBe(true);

    const after = await getLedgerData("head", "RIDER_CASH");
    if (!after.ok) throw new Error(after.error);
    expect(after.data.rows.some((r) => r.id === p.id)).toBe(true);
    // The closing balance is the head balance — the whole point of the ledger.
    expect(after.data.rows[after.data.rows.length - 1].balance)
      .toBeCloseTo(await headBal("RIDER_CASH"), 2);
  }, 180000);
});

describe("concurrency", () => {
  it("a double confirm credits the box once, not twice", async () => {
    const p = await riderPayment(true, 600);
    const delta = await snapshotHeads(["RIDER_CASH"]);

    const [a, b] = await Promise.all([
      confirmRiderCashReceived(p.id), confirmRiderCashReceived(p.id),
    ]);
    expect([a, b].filter((r) => r.ok).length).toBe(1);
    expect(await delta("RIDER_CASH")).toBeCloseTo(600, 2);
  }, 180000);
});
