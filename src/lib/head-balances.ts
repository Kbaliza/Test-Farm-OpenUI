import "server-only";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { OWNER_FUNDING_HEAD } from "@/lib/farm-owners";
import { PAYMENT_HEADS, PAYMENT_HEAD_LABELS, OWNERS_HEAD, canReceiveInto } from "@/lib/payment-heads";

// Thrown by guardHeadFundsTx when an outflow would overdraw a head. Callers catch it
// inside their try and turn it into a normal { ok:false } result.
export class InsufficientHeadFunds extends Error {
  constructor(public head: string, public available: number) {
    super(`Insufficient balance in ${HEAD_LABELS[head] ?? head} — available ₨${Math.round(available).toLocaleString("en-PK")}.`);
    this.name = "InsufficientHeadFunds";
  }
}

export const HEAD_LABELS: Record<string, string> = PAYMENT_HEAD_LABELS;

// Every head, in screen order — see lib/payment-heads.
export const VISIBLE_HEADS: string[] = [...PAYMENT_HEADS];

// Heads money can be received INTO from a desk screen.
//
// Rider Cash is missing on purpose. It is the riders' cashbox, and money enters it
// down exactly one path: a rider hands over a collection and a manager confirms it
// (which stamps Payment.receivedAt). A Payment written straight onto RIDER_CASH by
// any other screen would have no receivedAt, so by the rule above it would sit in
// NO head — real money, banked nowhere, invisible on every balance. Outflows are
// unaffected: expenses, salaries, vendor payments and transfers may all still be
// paid out of the box, and use VISIBLE_HEADS.
//
// Meezan is missing too: it is the owners' money, not the farm's, and money goes
// into it only as a repayment to them, by transfer (see OWNERS_HEAD).
export const INFLOW_HEADS = VISIBLE_HEADS.filter(canReceiveInto);

// Note prefix on the RIDER_CASH -> CASH HeadTransfer that confirming a handover
// USED to generate. Confirming no longer creates one — the money now stays in the
// Rider Cash box until someone actually deposits it — but rows written before that
// change still exist, and the Transfers screen still refuses to delete one on its
// own (deleting it alone left receivedAt set, overstating the head for ever).
// Kept for those historic rows and for undoRiderCashReceived's legacy path.
export const RIDER_CASH_RECEIPT_NOTE = "Rider cash received";

// THE rule for what is actually in the Rider Cash head.
//
// A rider's collection is recorded as a Payment the moment they take the money,
// so the customer's bill drops straight away. But that cash is in the rider's
// pocket, not in the farm's box — Rider Cash is a CASHBOX, and money enters it
// only when the rider hands it over and a manager confirms receipt (receivedAt).
//
// Everything else on RIDER_CASH with receivedAt still null is "cash with riders":
// real money owed to the farm, but in no head at all.
//
// This predicate MUST be used by every balance computation. getHeadBalances() and
// guardHeadFundsTx() both apply it; if they ever disagree, the screens would show
// one figure and the overdraft guard would enforce another.
export const HEAD_PAYMENT_WHERE = {
  NOT: { head: "RIDER_CASH" as never, receivedAt: null },
};

// Marker prefixed on BOTH the Payment(+net) and Expense(−net) rows that a vendor
// contra-settlement writes (payments/vendors settleVendorContra). Those two rows
// cancel on the CASH head and are two halves of one non-cash netting — deleting
// either half alone would invent cash and strand a receivable, so deleteExpense
// refuses to delete a row whose description starts with this. Keep both sides in
// step if the wording ever changes.
export const CONTRA_SETTLEMENT_NOTE = "Contra settlement";

export type HeadBalance = { head: string; label: string; balance: number };

// Canonical balance of each payment head:
//   + customer payments in   (rider cash only once confirmed received — see
//                             HEAD_PAYMENT_WHERE)
//   − expenses out
//   − salary payments out
//   − transfers out of the head   + transfers into the head
//   + money an owner put in from their own pocket (OWNER_FUNDING_HEAD only)
//     ...which is also owed back to them, so it takes Meezan (OWNERS_HEAD) into
//     minus by the same amount. Meezan has no other income: its balance is what
//     was paid through it and what the owners put in, less what was repaid.
export async function getHeadBalances(): Promise<HeadBalance[]> {
  const [pay, exp, sal, tIn, tOut, owner] = await Promise.all([
    db.payment.groupBy({ by: ["head"], _sum: { amount: true }, where: HEAD_PAYMENT_WHERE }),
    db.expense.groupBy({ by: ["head"], _sum: { amount: true } }),
    db.salaryPayment.groupBy({ by: ["head"], _sum: { amount: true } }),
    db.headTransfer.groupBy({ by: ["toHead"], _sum: { amount: true } }),
    db.headTransfer.groupBy({ by: ["fromHead"], _sum: { amount: true } }),
    db.ownerContribution.aggregate({ _sum: { amount: true } }),
  ]);

  const m: Record<string, number> = {};
  for (const r of pay) m[r.head] = (m[r.head] ?? 0) + Number(r._sum.amount ?? 0);
  for (const r of exp) m[r.head] = (m[r.head] ?? 0) - Number(r._sum.amount ?? 0);
  for (const r of sal) m[r.head] = (m[r.head] ?? 0) - Number(r._sum.amount ?? 0);
  for (const r of tIn) m[r.toHead] = (m[r.toHead] ?? 0) + Number(r._sum.amount ?? 0);
  for (const r of tOut) m[r.fromHead] = (m[r.fromHead] ?? 0) - Number(r._sum.amount ?? 0);
  // An owner funding the farm is money arriving from outside, so it is an inflow
  // to one head and a debt the farm carries — never a transfer out of anywhere.
  m[OWNER_FUNDING_HEAD] = (m[OWNER_FUNDING_HEAD] ?? 0) + Number(owner._sum.amount ?? 0);
  m[OWNERS_HEAD] = (m[OWNERS_HEAD] ?? 0) - Number(owner._sum.amount ?? 0);

  return VISIBLE_HEADS.map((h) => ({ head: h, label: HEAD_LABELS[h], balance: m[h] ?? 0 }));
}

// Balance of a single head (uses the canonical computation above).
export async function getHeadBalance(head: string): Promise<number> {
  const all = await getHeadBalances();
  return all.find((b) => b.head === head)?.balance ?? 0;
}

// Overdraft guard: returns an error if paying `amount` out of `head` would push it
// negative. Call before any outflow (expense, salary, vendor payment, transfer-out).
// A tiny epsilon absorbs decimal rounding so an exact-to-the-rupee payout is allowed.
export async function checkHeadFunds(
  head: string,
  amount: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Paying through Meezan is the owners paying: it runs into minus by design.
  if (head === OWNERS_HEAD) return { ok: true };
  const available = await getHeadBalance(head);
  if (amount - available > 0.005) {
    return {
      ok: false,
      error: `Insufficient balance in ${HEAD_LABELS[head] ?? head} — available ₨${Math.round(available).toLocaleString("en-PK")}.`,
    };
  }
  return { ok: true };
}

// Transaction-scoped overdraft guard — the race-free version of checkHeadFunds.
// Call it as the FIRST statement inside the SAME `db.$transaction` that writes the
// outflow, BEFORE any write. It (1) takes a per-head advisory lock so concurrent
// outflows on the same head serialise instead of both reading a stale balance, then
// (2) recomputes the head's balance from inside the transaction and throws
// InsufficientHeadFunds if `amount` would overdraw it. Because the lock is held until
// the transaction commits, no other outflow can slip in between the check and the write.
export async function guardHeadFundsTx(
  tx: Prisma.TransactionClient,
  head: string,
  amount: number
): Promise<void> {
  // Paying through Meezan is the owners paying: it runs into minus by design.
  if (head === OWNERS_HEAD) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"head:" + head}))`;
  const h = head as never; // callers pass a validated head string; cast to the Prisma enum
  // Sequential, NOT Promise.all: parallel queries on a single interactive-transaction
  // connection are a Prisma foot-gun (they can fail under load / through a pooler).
  // Five small aggregates in series are cheap and reliable.
  // AND-ed with the shared predicate rather than re-stated, so this can never drift
  // from getHeadBalances(): un-handed rider cash is not in the head and must not be
  // spendable from it.
  const pay = await tx.payment.aggregate({
    _sum: { amount: true },
    where: { AND: [{ head: h }, HEAD_PAYMENT_WHERE] },
  });
  const exp = await tx.expense.aggregate({ _sum: { amount: true }, where: { head: h } });
  const sal = await tx.salaryPayment.aggregate({ _sum: { amount: true }, where: { head: h } });
  const tIn = await tx.headTransfer.aggregate({ _sum: { amount: true }, where: { toHead: h } });
  const tOut = await tx.headTransfer.aggregate({ _sum: { amount: true }, where: { fromHead: h } });
  // Owner funding is spendable the moment it is recorded, so the guard has to see
  // it too — otherwise an expense paid out of money Sajjad just put in would be
  // refused as an overdraft.
  const owner = head === OWNER_FUNDING_HEAD
    ? await tx.ownerContribution.aggregate({ _sum: { amount: true } })
    : null;
  const available =
    Number(pay._sum?.amount ?? 0) - Number(exp._sum?.amount ?? 0) - Number(sal._sum?.amount ?? 0)
    + Number(tIn._sum?.amount ?? 0) - Number(tOut._sum?.amount ?? 0)
    + Number(owner?._sum?.amount ?? 0);
  if (amount - available > 0.005) throw new InsufficientHeadFunds(head, available);
}

// Cash riders have collected but not yet handed over — the exact complement of
// HEAD_PAYMENT_WHERE. It is NOT a payment head: this money is not at the farm, so
// it must never be spendable, transferable or shown in the head strip. It is money
// owed TO the farm BY the riders, and it lands in the Rider Cash head the moment a
// manager confirms receipt.
export async function getCashWithRiders(): Promise<number> {
  const agg = await db.payment.aggregate({
    _sum: { amount: true },
    where: { head: "RIDER_CASH", receivedAt: null },
  });
  return Number(agg._sum.amount ?? 0);
}

// The Ledgers screen's "every account combined" option. A sentinel rather than a
// real head: it is not a place money sits, it is the sum of the places it sits.
export const ALL_HEADS = "__all_heads__";
