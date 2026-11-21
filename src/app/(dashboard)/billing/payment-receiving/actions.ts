"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { INFLOW_HEADS } from "@/lib/head-balances";
import { PAYMENT_HEAD_LABELS, type PaymentHeadName } from "@/lib/payment-heads";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { startOfMonth, endOfMonth } from "date-fns";
import { getHeadBalances } from "@/lib/head-balances";
import { computeCustomerOutstanding } from "@/lib/customer-balance";
import { billedIn, billedPieces } from "@/lib/billing-period";

// ── Types ────────────────────────────────────────────────────────────────────

export type HeadBalance = {
  head: string;        // "RIDER_CASH" etc.
  label: string;
  balance: number;
  paymentCount: number;
};

export type PaymentEntry = {
  amount: number;
  head: string;
  label: string;
  date: string;
  notes: string | null;
};

export type CustomerRow = {
  id: string;
  customerCode: string;
  name: string;
  phone: string;
  shiftName: string;
  shiftId: string | null;
  areaName: string;
  customerStatus: string;
  invoiceId: string | null;
  invoiceStatus: string; // DRAFT|SENT|PARTIAL|PAID|OVERDUE|NONE
  bill: number;
  /**
   * What was billed in each fortnight on its own — no carry-forward, so the two
   * added together are the month's own charges. `bill` above is the running
   * balance and stays the page's figure for everything else; these two only feed
   * the Bill column when a half is selected, because bills go out twice a month
   * and "the whole month" is not the bill anyone is being chased for.
   */
  billHalf1: number;
  billHalf2: number;
  /**
   * What the WHOLE of last month billed this customer, by the same rule.
   *
   * A fixed figure to read the growing pending total against: last month is over,
   * so this one stops moving.
   */
  prevMonthBill: number;
  /**
   * What is STILL unpaid, today, of what this customer owed when last month closed.
   *
   * Payments clear the oldest dues first. The 16–30 bill is made on the last day
   * of the month and paid in the first days of the next, so a customer who owed
   * Rs 14,229 on 30 Sep and paid Rs 14,230 on 1 Oct has nothing pending from
   * September — whatever the balance said on the evening of the 30th.
   */
  prevMonthPending: number;
  payments: PaymentEntry[];
  totalPaid: number;
  /**
   * Still owed, by the same rule. For the running month: the live balance. For a
   * month that is over: what was owed when it closed, less what has been paid
   * since — so "September pending" is the September money still not collected.
   * `bill` stays what was owed at month end.
   */
  balance: number;
  /** For a month that is over: paid after it closed, towards what was owed then. */
  paidLater: number;
  /** "01/10" — the last of those later payments. */
  paidLaterOn: string | null;
  callCount: number;   // collection-call escalation (0=none, 1/2/3)
  callNotes: string | null;
  callNotesAt: string | null;
  isOverdue: boolean;  // has a bill, no payment received, past the due date
};

export type Shift = { id: string; name: string };

/**
 * Money received in the month that is attached to no customer account.
 *
 * Two kinds land here: rider cash booked against a free sample, and the
 * August 2026 backfill — cash that arrived while the system was not in use,
 * recorded to the heads only because those customers' dues had already been
 * netted off before their September opening balances were entered. Attaching
 * either to a customer would credit them twice.
 *
 * They were previously dropped on the floor here, so the month's payment total
 * on this page did not agree with the same month's head ledger.
 */
export type OtherReceipt = {
  id: string;
  amount: number;
  head: string;
  label: string;
  date: string;
  notes: string | null;
};

export type PageData = {
  customers: CustomerRow[];
  /** "September 2026" — so the card names the month rather than saying "previous". */
  prevMonthLabel: string;
  otherReceipts: OtherReceipt[];
  headBalances: HeadBalance[];
  shifts: Shift[];
  dbReady: boolean;
};

// The billing day boundaries, identical to periodBounds() on Customer Bills —
// PKT offset included, so a delivery never lands in a different fortnight
// depending on which page is asking.
// halfBounds / billedPieces / billedIn live in src/lib/billing-period.ts, because
// the rider app's billing API needs the same rule and a second copy of it would be
// free to drift from this one.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "September 2026" — for the card that names the month it is reporting. */
function monthName(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

const HEAD_LABELS: Record<string, string> = PAYMENT_HEAD_LABELS;

// ── Main data fetch ──────────────────────────────────────────────────────────

export async function getPageData(month: number, year: number): Promise<PageData> {
  await requireRole(FULL_ACCESS);
  try {
    const monthStart = startOfMonth(new Date(year, month - 1, 1));
    const monthEnd   = endOfMonth(new Date(year, month - 1, 1));

    const [customers, invoices, payments, balances, shifts, callNoteRows] = await Promise.all([
      // Fetch ACTIVE/RECOVERY customers, PLUS disabled ones — a disabled customer who
      // still owes money must remain collectable here, otherwise their debt is counted
      // on the dashboard's Outstanding but appears on no screen you can collect from
      // (disabled rows with a zero balance are dropped after the balance is computed).
      db.customer.findMany({
        include: { shift: true, area: true },
        orderBy: { name: "asc" },
      }),
      db.invoice.findMany({
        where: { month, year },
      }),
      db.payment.findMany({
        where: { date: { gte: monthStart, lte: monthEnd } },
        orderBy: { date: "asc" },
      }),
      // Single source of truth — same canonical balances every other screen uses.
      getHeadBalances(),
      db.shift.findMany({ orderBy: { name: "asc" } }),
      // callNotes / callNotesAt are not in the generated client (prisma generate
      // failed while dev server held the DLL), so fetch them via raw SQL.
      db.$queryRaw<{ id: string; callNotes: string | null; callNotesAt: Date | null }[]>`
        SELECT id, "callNotes", "callNotesAt" FROM "Invoice" WHERE month = ${month} AND year = ${year}
      `,
    ]);

    const callNotesMap = new Map(callNoteRows.map((r) => [r.id, r]));

    // ── What each fortnight billed, this month and last ──────────────
    //
    // Both by the one rule in billedPieces/billedIn, so the previous month's card
    // cannot drift from this month's. Pending climbs every day as deliveries pile
    // on, which is exactly why a settled figure for the month before is worth
    // having beside it.
    const prev = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
    const prevEnd = endOfMonth(new Date(prev.year, prev.month - 1, 1));
    const [thisMonth, prevMonth, paidSincePrevEnd] = await Promise.all([
      billedPieces(year, month),
      billedPieces(prev.year, prev.month),
      // Every customer payment since last month closed — what clears old dues first.
      db.payment.findMany({
        where: { customerId: { not: null }, date: { gt: prevEnd } },
        select: { customerId: true, date: true, amount: true },
      }),
    ]);
    const now = new Date();
    const monthIsOver = monthEnd.getTime() < now.getTime();
    const paidAfterPrev = new Map<string, number>();
    const paidAfterMonth = new Map<string, { amount: number; last: Date }>();
    for (const p of paidSincePrevEnd) {
      const id = p.customerId!;
      const amt = Number(p.amount);
      paidAfterPrev.set(id, (paidAfterPrev.get(id) ?? 0) + amt);
      if (p.date.getTime() > monthEnd.getTime()) {
        const was = paidAfterMonth.get(id);
        paidAfterMonth.set(id, { amount: (was?.amount ?? 0) + amt, last: !was || p.date > was.last ? p.date : was.last });
      }
    }
    // Of what stood at a cutoff, what still stands today, oldest first:
    //   owed   → less what has been paid since, never below nothing;
    //   credit → only as much of it as the customer is still in credit today
    //            (a September credit used up on October's milk, or handed back,
    //            is gone, exactly as a September due paid in October is).

    // Index invoices by customer. Billing is HALF-monthly, so a customer can have
    // two invoices in one month and this Map would silently keep whichever came
    // back last — an arbitrary half. Everything downstream (invoiceId, status,
    // callCount, and the setCallStatus write) then attached to a coin-flip: a
    // manager logging a 3rd call against the second-half bill could have it
    // stamped on the first-half one, and the UI would re-read and show 0.
    // Pin it deterministically to the LATEST half, which is the bill currently
    // being chased.
    const invoiceByCustomer = new Map<string, (typeof invoices)[number]>();
    for (const inv of invoices) {
      const existing = invoiceByCustomer.get(inv.customerId);
      if (!existing || inv.half > existing.half) invoiceByCustomer.set(inv.customerId, inv);
    }

    const paymentsByCustomer = new Map<string, typeof payments>();
    const otherReceipts: OtherReceipt[] = [];
    for (const p of payments) {
      if (!p.customerId) {
        // Not dropped any more — shown in its own panel, so this page's total
        // reconciles with the head ledger for the same month.
        otherReceipts.push({
          id: p.id,
          amount: Number(p.amount),
          head: p.head,
          label: HEAD_LABELS[p.head] ?? p.head,
          date: p.date.toISOString(),
          notes: p.notes,
        });
        continue;
      }
      if (!paymentsByCustomer.has(p.customerId)) paymentsByCustomer.set(p.customerId, []);
      paymentsByCustomer.get(p.customerId)!.push(p);
    }

    // Live balance as of the end of the selected month — via the same shared
    // helper Recovery/WhatsApp/the dashboard use, instead of trusting
    // Invoice.totalDue (a snapshot only refreshed when someone opens that
    // invoice's detail page, so it can go stale relative to a same-period OTC
    // credit sale). This already nets out every payment through month-end, so
    // `balance` below is NOT separately reduced by this month's payments again.
    const outstanding = await computeCustomerOutstanding(
      customers.map((c) => c.id),
      { year, month, asOfDate: monthEnd }
    );
    // The same helper as of last month's end, so "how much of this is old" is answered
    // by the same arithmetic rather than by a second one.
    const prevOutstanding = await computeCustomerOutstanding(
      customers.map((c) => c.id),
      { year: prev.year, month: prev.month, asOfDate: prevEnd }
    );
    // Today's balance — the running month's own figure, or asked for when the
    // month being viewed is over.
    const nowBalance = monthIsOver ? await computeCustomerOutstanding(customers.map((c) => c.id)) : outstanding;
    const stillUnpaid = (id: string, owed: number, paidAfter: number) =>
      owed > 0.005 ? Math.max(0, owed - paidAfter)
      : owed < -0.005 ? Math.min(0, Math.max(owed, nowBalance.get(id) ?? 0))
      : 0;

    // A bill is "overdue" once its due date (the 5th of the following month,
    // matching the invoice's "clear by the 5th" terms) has passed with no payment.
    const dueDate = new Date(year, month, 5); // month is 1-based → 5th of next month
    const pastDue = now > dueDate;

    const rows: CustomerRow[] = customers
      // Everyone currently being served, plus anyone else who still owes.
      //
      // ACTIVE is unconditional — a live customer belongs on the collection sheet
      // whether or not there is a bill this moment. Every other status (ON_CALL,
      // INACTIVE, RECOVERY, DISABLED) only earns a row when money is outstanding,
      // which is the only reason to look at a lapsed account on this page.
      //
      // Math.abs, not > 0: a negative balance is a credit WE owe them, and that
      // has to stay visible or an overpaid account would silently vanish. It is
      // also what keeps this list reconciling with the dashboard total.
      .filter((c) => c.status === "ACTIVE" || Math.abs(outstanding.get(c.id) ?? 0) > 0.005)
      .map((c) => {
      const inv  = invoiceByCustomer.get(c.id);
      const pays = paymentsByCustomer.get(c.id) ?? [];
      const totalPaid = pays.reduce((s, p) => s + Number(p.amount), 0);
      const bill = outstanding.get(c.id) ?? 0;
      const later = monthIsOver ? paidAfterMonth.get(c.id) : undefined;
      const balance = monthIsOver ? stillUnpaid(c.id, bill, later?.amount ?? 0) : bill;
      const paidLater = bill > 0.005 ? Math.min(bill, later?.amount ?? 0) : 0;

      return {
        id: c.id,
        customerCode: c.customerCode,
        name: c.name,
        phone: c.phone,
        shiftName: c.shift?.name ?? "—",
        shiftId: c.shiftId,
        areaName: c.area?.name ?? "—",
        customerStatus: c.status,
        invoiceId: inv?.id ?? null,
        invoiceStatus: inv?.status ?? "NONE",
        bill,
        billHalf1: billedIn(thisMonth, c, 0),
        billHalf2: billedIn(thisMonth, c, 1),
        prevMonthBill: billedIn(prevMonth, c, 0) + billedIn(prevMonth, c, 1),
        prevMonthPending: stillUnpaid(c.id, prevOutstanding.get(c.id) ?? 0, paidAfterPrev.get(c.id) ?? 0),
        payments: pays.map((p) => ({
          amount: Number(p.amount),
          head: p.head,
          label: HEAD_LABELS[p.head] ?? p.head,
          date: p.date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" }),
          notes: p.notes,
        })),
        totalPaid,
        // `bill` already nets out every payment through month end — never take
        // totalPaid off it again. For a month that is over, what was paid AFTER it
        // closed comes off as well, oldest dues first (see `balance`).
        balance,
        paidLater,
        paidLaterOn: paidLater > 0 && later
          ? later.last.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" })
          : null,
        callCount: inv?.callCount ?? 0,
        callNotes: inv ? (callNotesMap.get(inv.id)?.callNotes ?? null) : null,
        callNotesAt: inv ? (callNotesMap.get(inv.id)?.callNotesAt?.toISOString() ?? null) : null,
        isOverdue: balance > 0 && totalPaid === 0 && paidLater === 0 && pastDue,
      };
    });

    // Payment count this month per head (card sub-label only).
    const headPayCount = new Map<string, number>();
    for (const p of payments) {
      headPayCount.set(p.head, (headPayCount.get(p.head) ?? 0) + 1);
    }

    // Balances come from the canonical helper; we just attach this month's count.
    const headBalances: HeadBalance[] = balances.map((b) => ({
      head: b.head,
      label: b.label,
      balance: b.balance,
      paymentCount: headPayCount.get(b.head) ?? 0,
    }));

    return { customers: rows, otherReceipts, headBalances, shifts, prevMonthLabel: monthName(prev.year, prev.month), dbReady: true };
  } catch (e) {
    console.error("[payment-receiving] getPageData failed:", e);
    return { customers: [], otherReceipts: [], headBalances: [], shifts: [], prevMonthLabel: "", dbReady: false };
  }
}

// ── Record a payment ───────────────────────────────────────────────────────────
// Creates a Payment row (counted by billing, ledgers, rider performance and the
// payments column) plus a HEAD ledger credit (drives the head balance cards).

// Money coming IN, so Rider Cash is not on the list — see INFLOW_HEADS.
const VALID_HEADS = INFLOW_HEADS;

export async function recordPayment(data: {
  customerId: string;
  amount: number;
  head: string;
  date: string;   // YYYY-MM-DD
  notes?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  if (!data.customerId) return { ok: false, error: "Select a customer." };
  if (!data.amount || data.amount <= 0) return { ok: false, error: "Enter a valid amount." };
  if (!VALID_HEADS.includes(data.head)) return { ok: false, error: "Select a payment method." };

  try {
    const dt = data.date ? new Date(data.date + "T12:00:00") : new Date();
    const amount = new Prisma.Decimal(data.amount);
    const head = data.head as PaymentHeadName;
    const notes = data.notes?.trim() || null;

    // Stamp the collecting rider on the payment itself (the customer's CURRENT
    // shift rider). Attribution must never be derived later from Customer.riderId:
    // shifts change hands, so that field goes stale and credits the wrong rider.
    const cust = await db.customer.findUnique({
      where: { id: data.customerId },
      select: { shift: { select: { riderId: true } } },
    });

    // Idempotency: a double-click / retry must never double-credit the customer (and
    // double-credit the head). Serialise per-customer with an advisory lock, then skip
    // if an identical payment (same customer, amount, head, notes) was written in the
    // last 15s — the signature of a duplicate submit. Head balances are derived from
    // Payment rows (getHeadBalances), so the payment row is the single record.
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"payment:" + data.customerId}))`;
      const dup = await tx.payment.findFirst({
        where: { customerId: data.customerId, amount, head, notes, createdAt: { gte: new Date(Date.now() - 15_000) } },
        select: { id: true },
      });
      if (dup) return; // duplicate submit within 15s — no-op, no second credit
      await tx.payment.create({
        data: {
          customerId: data.customerId,
          riderId: cust?.shift?.riderId ?? null,
          amount, head, notes, date: dt,
        },
      });
    });

    revalidatePath("/billing/payment-receiving");
    revalidatePath("/billing/invoices");
    revalidatePath("/ledgers");
    revalidatePath("/payments/rider-cash");
    revalidatePath("/"); // dashboard head-balance / collected / pending / outstanding tiles
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to record payment." };
  }
}

// ── Call status / recovery ─────────────────────────────────────────────────────
// Payment status (Paid / Partial / Pending / Overdue) is auto-derived from
// payments + dates, so it's never set here. This only tracks the collection-call
// escalation (1x/2x/3x) and the move to Recovery.

export type ActionResult = { ok: true } | { ok: false; error: string };

const CALL_VALUES: Record<string, number> = { CALL_1: 1, CALL_2: 2, CALL_3: 3 };

export async function setCallStatus(
  customerId: string,
  invoiceId: string | null,
  value: string,  // CALL_1 | CALL_2 | CALL_3 | RECOVERY
  notes?: string
): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    if (value === "RECOVERY") {
      // Same mechanism as the Recovery page's "stop supply": move to RECOVERY
      // (drops them from delivery shifts) and open a recovery case.
      await db.customer.update({ where: { id: customerId }, data: { status: "RECOVERY" } });
      const open = await db.recoveryCase.findFirst({ where: { customerId, status: { not: "CLEARED" } } });
      if (!open) await db.recoveryCase.create({ data: { customerId, status: "IN_RECOVERY" } });
      revalidatePath("/payments/recovery");
      revalidatePath("/customers/pre-delivery");
    } else {
      const n = CALL_VALUES[value];
      if (n === undefined) return { ok: false, error: "Invalid call status." };
      if (!invoiceId) return { ok: false, error: "No invoice to attach the call to." };
      // callNotes / callNotesAt are not in the generated Prisma client yet
      // (prisma generate failed while dev server held the DLL), so use raw SQL.
      if (notes?.trim()) {
        await db.$executeRaw`
          UPDATE "Invoice"
          SET "callCount" = ${n}, "callNotes" = ${notes.trim()}, "callNotesAt" = NOW()
          WHERE id = ${invoiceId}
        `;
      } else {
        await db.$executeRaw`
          UPDATE "Invoice" SET "callCount" = ${n} WHERE id = ${invoiceId}
        `;
      }
    }
    revalidatePath("/billing/payment-receiving");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Update failed" };
  }
}
