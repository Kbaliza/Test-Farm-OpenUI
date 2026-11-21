import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Settling money with a vendor, including when the amount does not line up.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 * Paying a vendor more than they were owed used to be refused outright, because a
 * surplus had nowhere to live: the full amount left the head while only what FIFO
 * could apply landed on a bill, so the difference was dropped on the floor. The
 * surplus now becomes a credit on the OPPOSITE side — an ADVANCE row — which the
 * next real document on that side consumes with no cash movement.
 *
 * ── THE INVARIANT ────────────────────────────────────────────────────────────
 * Two independent formulas for "we owe them" exist and must agree: the Vendors page
 * reads `Σ(bill.amount − bill.paid)`, the vendor LEDGER reads
 * `Σ bills − Σ Expense[vendorId]`. They used to agree only while
 * `Σ bill.paid == Σ Expense`, which an overpayment breaks by construction. The
 * generalised rule, which `checkVendorInvariant` asserts and every test calls:
 *
 *   PAYABLE     Σ bill.paid  +  Σ_ADVANCE(recv.amount − recv.received)
 *                  ==  Σ Expense[vendorId]  −  Σ_ADVANCE recv.received
 *
 *   RECEIVABLE  Σ recv.received  +  Σ_ADVANCE(bill.amount − bill.paid)
 *                  ==  Σ Payment[vendorId]   −  Σ_ADVANCE bill.paid
 *
 * ── The rules that keep it true ──────────────────────────────────────────────
 *  R1  Every rupee out to a vendor is exactly one Expense{vendorId}; every rupee
 *      in from one is exactly one Payment{vendorId}.
 *  R2  A payment FIFOs open documents on its own side — TRADE *and* ADVANCE alike,
 *      since an ADVANCE bill is just an open payable, so refunding their
 *      overpayment needs no special case. Only the SURPLUS makes a new ADVANCE.
 *  R3  CONSUMING an advance shrinks that row's `amount`. It never touches its
 *      paid/received — those two columns mean cash, and no cash moved.
 *  R4  settleVendorContra only ever touches kind = TRADE.
 *  R5  bill.paid <= bill.amount and recv.received <= recv.amount, ALWAYS. This is
 *      what keeps the clamped readers (dashboard) and the unclamped ones
 *      (getVendorsData) returning the same number.
 *
 * Every caller takes `pg_advisory_xact_lock(hashtext('vendor:' + vendorId))` first.
 * In the OTC paths, take the `stock:` locks BEFORE the vendor lock or concurrent
 * counter activity can deadlock.
 */

const EPS = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

export type VendorApplication = {
  /** Landed on documents that were already open. */
  applied: number;
  /** Surplus recorded as a credit on the other side. */
  advance: number;
  advanceId: string | null;
};

/** Serialises everything that touches one vendor's books. */
export async function lockVendor(tx: Prisma.TransactionClient, vendorId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"vendor:" + vendorId}))`;
}

/**
 * Cash OUT to a vendor: FIFO their open bills, then bank the surplus as a credit
 * they owe us. `expenseId` is the cash row that must already exist (R1).
 */
export async function applyVendorPayment(
  tx: Prisma.TransactionClient,
  args: { vendorId: string; amount: number; expenseId: string; at: Date; vendorName: string }
): Promise<VendorApplication> {
  const bills = await tx.vendorBill.findMany({
    where: { vendorId: args.vendorId },
    orderBy: { date: "asc" },
  });

  let remaining = round2(args.amount);
  let applied = 0;
  for (const b of bills) {
    if (remaining <= EPS) break;
    const unpaid = Number(b.amount) - Number(b.paid);
    if (unpaid <= EPS) continue;
    const take = Math.min(remaining, unpaid);
    await tx.vendorBill.update({
      where: { id: b.id },
      data: { paid: new Prisma.Decimal(round2(Number(b.paid) + take)) },
    });
    remaining = round2(remaining - take);
    applied = round2(applied + take);
  }

  if (remaining <= EPS) return { applied, advance: 0, advanceId: null };

  const adv = await tx.vendorReceivable.create({
    data: {
      vendorId: args.vendorId,
      date: args.at,
      amount: new Prisma.Decimal(remaining),
      received: new Prisma.Decimal(0),
      kind: "ADVANCE",
      sourceExpenseId: args.expenseId,
      notes: `Advance paid to ${args.vendorName} — settles against their next bill`,
    },
    select: { id: true },
  });
  return { applied, advance: remaining, advanceId: adv.id };
}

/** Cash IN from a vendor: the exact mirror. Surplus becomes a credit we owe them. */
export async function applyVendorReceipt(
  tx: Prisma.TransactionClient,
  args: { vendorId: string; amount: number; paymentId: string; at: Date; vendorName: string }
): Promise<VendorApplication> {
  const recvs = await tx.vendorReceivable.findMany({
    where: { vendorId: args.vendorId },
    orderBy: { date: "asc" },
  });

  let remaining = round2(args.amount);
  let applied = 0;
  for (const r of recvs) {
    if (remaining <= EPS) break;
    const open = Number(r.amount) - Number(r.received);
    if (open <= EPS) continue;
    const take = Math.min(remaining, open);
    await tx.vendorReceivable.update({
      where: { id: r.id },
      data: { received: new Prisma.Decimal(round2(Number(r.received) + take)) },
    });
    remaining = round2(remaining - take);
    applied = round2(applied + take);
  }

  if (remaining <= EPS) return { applied, advance: 0, advanceId: null };

  const adv = await tx.vendorBill.create({
    data: {
      vendorId: args.vendorId,
      date: args.at,
      amount: new Prisma.Decimal(remaining),
      paid: new Prisma.Decimal(0),
      kind: "ADVANCE",
      sourcePaymentId: args.paymentId,
      notes: `Advance received from ${args.vendorName} — settles against their next sale`,
    },
    select: { id: true },
  });
  return { applied, advance: remaining, advanceId: adv.id };
}

/**
 * "Settles against their next bill automatically."
 *
 * Nets open ADVANCE documents against open TRADE documents on the opposite side.
 * NO cash moves and NO Payment/Expense is written — the cash was already recorded
 * when the advance was created. Per R3 this shrinks the advance's `amount`.
 *
 * Idempotent: with nothing to net it is a no-op, so it is safe to call after every
 * document that could create something to net against.
 */
export async function applyVendorAdvances(
  tx: Prisma.TransactionClient,
  vendorId: string
): Promise<{ netted: number }> {
  let netted = 0;

  // Advance we hold with them (they owe us) → against open TRADE bills (we owe them).
  const advOut = await tx.vendorReceivable.findMany({
    where: { vendorId, kind: "ADVANCE" },
    orderBy: { date: "asc" },
  });
  const openBills = await tx.vendorBill.findMany({
    where: { vendorId, kind: "TRADE" },
    orderBy: { date: "asc" },
  });
  for (const a of advOut) {
    let credit = round2(Number(a.amount) - Number(a.received));
    if (credit <= EPS) continue;
    for (const b of openBills) {
      if (credit <= EPS) break;
      const unpaid = round2(Number(b.amount) - Number(b.paid));
      if (unpaid <= EPS) continue;
      const take = Math.min(credit, unpaid);
      await tx.vendorBill.update({
        where: { id: b.id },
        data: { paid: new Prisma.Decimal(round2(Number(b.paid) + take)) },
      });
      b.paid = new Prisma.Decimal(round2(Number(b.paid) + take));
      credit = round2(credit - take);
      netted = round2(netted + take);
      await tx.vendorReceivable.update({
        where: { id: a.id },
        data: { amount: new Prisma.Decimal(round2(Number(a.amount) - take)) },
      });
      a.amount = new Prisma.Decimal(round2(Number(a.amount) - take));
    }
  }

  // Advance they hold with us (we owe them) → against open TRADE receivables.
  const advIn = await tx.vendorBill.findMany({
    where: { vendorId, kind: "ADVANCE" },
    orderBy: { date: "asc" },
  });
  const openRecv = await tx.vendorReceivable.findMany({
    where: { vendorId, kind: "TRADE" },
    orderBy: { date: "asc" },
  });
  for (const a of advIn) {
    let credit = round2(Number(a.amount) - Number(a.paid));
    if (credit <= EPS) continue;
    for (const r of openRecv) {
      if (credit <= EPS) break;
      const open = round2(Number(r.amount) - Number(r.received));
      if (open <= EPS) continue;
      const take = Math.min(credit, open);
      await tx.vendorReceivable.update({
        where: { id: r.id },
        data: { received: new Prisma.Decimal(round2(Number(r.received) + take)) },
      });
      r.received = new Prisma.Decimal(round2(Number(r.received) + take));
      credit = round2(credit - take);
      netted = round2(netted + take);
      await tx.vendorBill.update({
        where: { id: a.id },
        data: { amount: new Prisma.Decimal(round2(Number(a.amount) - take)) },
      });
      a.amount = new Prisma.Decimal(round2(Number(a.amount) - take));
    }
  }

  // An advance fully consumed carries no information and would clutter the ledger.
  await tx.vendorReceivable.deleteMany({
    where: { vendorId, kind: "ADVANCE", amount: { lte: new Prisma.Decimal(EPS) } },
  });
  await tx.vendorBill.deleteMany({
    where: { vendorId, kind: "ADVANCE", amount: { lte: new Prisma.Decimal(EPS) } },
  });

  return { netted };
}

/**
 * Un-applies a vendor payment being deleted.
 *
 * The hard case, and the reason this is not a simple reverse-FIFO: overpay 1500
 * against a 1000 bill, the 500 advance is then consumed by a new 800 bill, and now
 * deleting the Expense must claw back 1500 from documents that have moved on. The
 * old code reversed newest-first and simply STOPPED when it ran out, silently
 * leaving the books short. This throws instead, so the transaction rolls back and
 * nothing is half-undone.
 */
export async function reverseVendorPayment(
  tx: Prisma.TransactionClient,
  args: { vendorId: string; amount: number }
): Promise<void> {
  let toReverse = round2(args.amount);

  // 1. Its own advance first, if any of it survives — that is the cheapest undo.
  const advances = await tx.vendorReceivable.findMany({
    where: { vendorId: args.vendorId, kind: "ADVANCE" },
    orderBy: { date: "desc" },
  });
  for (const a of advances) {
    if (toReverse <= EPS) break;
    const credit = round2(Number(a.amount) - Number(a.received));
    if (credit <= EPS) continue;
    const take = Math.min(toReverse, credit);
    if (take >= credit - EPS) await tx.vendorReceivable.delete({ where: { id: a.id } });
    else await tx.vendorReceivable.update({
      where: { id: a.id },
      data: { amount: new Prisma.Decimal(round2(Number(a.amount) - take)) },
    });
    toReverse = round2(toReverse - take);
  }

  // 2. Then un-pay bills, newest first.
  const bills = await tx.vendorBill.findMany({
    where: { vendorId: args.vendorId },
    orderBy: { date: "desc" },
  });
  for (const b of bills) {
    if (toReverse <= EPS) break;
    const paid = Number(b.paid);
    if (paid <= EPS) continue;
    const take = Math.min(toReverse, paid);
    await tx.vendorBill.update({
      where: { id: b.id },
      data: { paid: new Prisma.Decimal(round2(paid - take)) },
    });
    toReverse = round2(toReverse - take);
  }

  if (toReverse > EPS) {
    throw new Error(
      `Can't reverse this payment cleanly — ₨${Math.round(toReverse).toLocaleString("en-PK")} of it has already been settled elsewhere on this vendor's account. Undo that first.`
    );
  }
}

/** The mirror, for deleting a vendor receipt. */
export async function reverseVendorReceipt(
  tx: Prisma.TransactionClient,
  args: { vendorId: string; amount: number }
): Promise<void> {
  let toReverse = round2(args.amount);

  const advances = await tx.vendorBill.findMany({
    where: { vendorId: args.vendorId, kind: "ADVANCE" },
    orderBy: { date: "desc" },
  });
  for (const a of advances) {
    if (toReverse <= EPS) break;
    const credit = round2(Number(a.amount) - Number(a.paid));
    if (credit <= EPS) continue;
    const take = Math.min(toReverse, credit);
    if (take >= credit - EPS) await tx.vendorBill.delete({ where: { id: a.id } });
    else await tx.vendorBill.update({
      where: { id: a.id },
      data: { amount: new Prisma.Decimal(round2(Number(a.amount) - take)) },
    });
    toReverse = round2(toReverse - take);
  }

  const recvs = await tx.vendorReceivable.findMany({
    where: { vendorId: args.vendorId },
    orderBy: { date: "desc" },
  });
  for (const r of recvs) {
    if (toReverse <= EPS) break;
    const got = Number(r.received);
    if (got <= EPS) continue;
    const take = Math.min(toReverse, got);
    await tx.vendorReceivable.update({
      where: { id: r.id },
      data: { received: new Prisma.Decimal(round2(got - take)) },
    });
    toReverse = round2(toReverse - take);
  }

  if (toReverse > EPS) {
    throw new Error(
      `Can't reverse this receipt cleanly — ₨${Math.round(toReverse).toLocaleString("en-PK")} of it has already been settled elsewhere on this vendor's account. Undo that first.`
    );
  }
}

/**
 * Asserts THE INVARIANT for one vendor. Exported so every test can call it after
 * every mutation, and so a future doctor page can sweep every vendor.
 */
export async function checkVendorInvariant(
  vendorId: string
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const [bills, recvs, expenses, payments] = await Promise.all([
    db.vendorBill.findMany({ where: { vendorId } }),
    db.vendorReceivable.findMany({ where: { vendorId } }),
    db.expense.aggregate({ _sum: { amount: true }, where: { vendorId } }),
    db.payment.aggregate({ _sum: { amount: true }, where: { vendorId } }),
  ]);

  const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0));
  const billPaid = sum(bills.map((b) => Number(b.paid)));
  const recvGot = sum(recvs.map((r) => Number(r.received)));
  const advOutOpen = sum(recvs.filter((r) => r.kind === "ADVANCE").map((r) => Number(r.amount) - Number(r.received)));
  const advOutGot = sum(recvs.filter((r) => r.kind === "ADVANCE").map((r) => Number(r.received)));
  const advInOpen = sum(bills.filter((b) => b.kind === "ADVANCE").map((b) => Number(b.amount) - Number(b.paid)));
  const advInPaid = sum(bills.filter((b) => b.kind === "ADVANCE").map((b) => Number(b.paid)));
  const expTotal = Number(expenses._sum.amount ?? 0);
  const payTotal = Number(payments._sum.amount ?? 0);

  const problems: string[] = [];
  const payableL = round2(billPaid + advOutOpen);
  const payableR = round2(expTotal - advOutGot);
  if (Math.abs(payableL - payableR) > EPS) {
    problems.push(`payable identity: ${payableL} != ${payableR} (billPaid ${billPaid}, advOutOpen ${advOutOpen}, expenses ${expTotal}, advOutReceived ${advOutGot})`);
  }
  const recvL = round2(recvGot + advInOpen);
  const recvR = round2(payTotal - advInPaid);
  if (Math.abs(recvL - recvR) > EPS) {
    problems.push(`receivable identity: ${recvL} != ${recvR} (recvReceived ${recvGot}, advInOpen ${advInOpen}, payments ${payTotal}, advInPaid ${advInPaid})`);
  }
  // R5 — the reason clamped and unclamped readers agree.
  for (const b of bills) {
    if (Number(b.paid) - Number(b.amount) > EPS) problems.push(`bill ${b.id} overpaid: ${b.paid} > ${b.amount}`);
  }
  for (const r of recvs) {
    if (Number(r.received) - Number(r.amount) > EPS) problems.push(`receivable ${r.id} over-received: ${r.received} > ${r.amount}`);
  }

  return problems.length ? { ok: false, detail: problems.join("; ") } : { ok: true };
}
