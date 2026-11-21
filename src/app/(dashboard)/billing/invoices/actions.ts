"use server";

import { requireRole, requireAdmin, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { computeCustomerOutstanding, deliveredValueByCustomer, LIVE_CUSTOMERS, type CustomerScope } from "@/lib/customer-balance";

// ── Period helpers ──────────────────────────────────────────────────────────────
// Billing runs in two halves each month:
//   half 1 → days 1–15   (generated on the 16th)
//   half 2 → day 16–end  (generated at month end; carries the delivery charge)

const PKT = 5 * 60 * 60 * 1000; // PKT midnight = UTC − 5h

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

type PeriodBounds = {
  startDay: number;
  endDay: number;
  periodStart: Date;
  periodEnd: Date;
};

function periodBounds(year: number, month: number, half: number): PeriodBounds {
  const startDay = half === 1 ? 1 : 16;
  const endDay = half === 1 ? 15 : daysInMonth(year, month);
  const periodStart = new Date(Date.UTC(year, month - 1, startDay) - PKT);
  const periodEnd = new Date(Date.UTC(year, month - 1, endDay + 1) - PKT - 1);
  return { startDay, endDay, periodStart, periodEnd };
}

// "Last date" to pay shown on the bill. Defaults to the month's last day; stored
// at noon so it never shifts a calendar day across timezones.
function defaultDueDate(year: number, month: number): Date {
  return new Date(year, month - 1, daysInMonth(year, month), 12, 0, 0);
}
function parseDueDate(s: string | null | undefined, year: number, month: number): Date {
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  return defaultDueDate(year, month);
}

// Effective period start for an invoice — uses stored value, falls back to
// computed bounds for legacy rows that predate the period columns.
function effStart(inv: { periodStart: Date | null; year: number; month: number; half: number }): Date {
  return inv.periodStart ?? periodBounds(inv.year, inv.month, inv.half).periodStart;
}

// A half can only be billed once it has actually started. `activePeriod` is
// computed for the UI, but it only ever drove a disabled button (billing-client
// `isLocked`) — generateInvoice/bulkGenerate took `half` as an untrusted parameter
// and never checked it. So on 3 February a POST for (2026, 2, half 2) invoiced
// every customer for 16–28 Feb deliveries that hadn't happened, and because
// computeCustomerOutstanding counts invoices immediately, Recovery and the
// WhatsApp reminders would start chasing people for future milk.
//
// Past months stay fully open (both halves are over). Future months are refused
// outright. In the current month, half 2 waits until the 16th.
function periodNotStartedError(year: number, month: number, half: number): string | null {
  const nowPKT = new Date(Date.now() + PKT);
  const y = nowPKT.getUTCFullYear();
  const m = nowPKT.getUTCMonth() + 1;
  const d = nowPKT.getUTCDate();

  if (year < y || (year === y && month < m)) return null;           // a past month
  if (year > y || (year === y && month > m)) {                      // a future month
    return "That month hasn't started yet — its deliveries haven't happened, so it can't be billed.";
  }
  if (half === 2 && d <= 15) {                                      // current month, 2nd half
    return "The second half of this month hasn't started yet (it runs from the 16th), so it can't be billed.";
  }
  return null;
}

// ── Types ────────────────────────────────────────────────────────────────────────

export type InvoiceLineRow = {
  id: string;
  /** The delivery behind this line — what an edit of it writes back to. */
  deliveryEntryId: string | null;
  date: string;
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
  isReturn: boolean;
  isReplacement: boolean;
  /**
   * Charged on a stop the rider marked skipped: nobody in, or the customer turned it
   * away. The bill stands — that is why the line is here — but it never reached them,
   * so the bill must not call it delivered.
   */
  notDelivered: boolean;
};

export type BillingCustomerRow = {
  id: string;
  customerCode: string;
  name: string;
  phone: string;
  shiftName: string;
  shiftId: string | null;
  areaName: string;
  customerStatus: string;
  generated: boolean;
  invoiceId: string | null;
  invoiceStatus: string;
  billSent: boolean;     // this bill was marked sent in the "Send bills" dialog (durable)
  prevBalance: number;
  deliveries: number;
  returns: number;
  deliveryCharge: number;
  discount: number;      // a one-off allowance put on this bill only
  otcAmt: number;        // this period's Over-the-Counter credit purchases (a charge on the bill)
  paymentsAmt: number;
  totalDue: number;
};

export type ShiftOption = { id: string; name: string };

export type BillingOverview = {
  year: number;
  month: number;
  half: number;
  activePeriod: number; // 1 or 2 — which half is current for the selected month
  /**
   * Which halves may be opened at all: [1, 2] for any past month, [1] in the
   * first half of the current month, [] for a future one.
   *
   * activePeriod cannot answer this. It is a single number, so the client could
   * only ever unlock one half — and for a past month it was set to whichever
   * half you happened to be viewing, which locked the other one and left no way
   * back. Both halves of a finished month are over and must both be readable.
   */
  openHalves: number[];
  periodLabel: string;
  customers: BillingCustomerRow[];
  shifts: ShiftOption[];
  totals: {
    billed: number; collected: number; outstanding: number; generated: number; pending: number;
    /** Both fortnights of the month added up — what the period cards cannot show. */
    monthBilled: number; monthCollected: number;
    /**
     * Everything still owed as at the end of this month, across every customer.
     *
     * Not monthBilled less monthCollected: that would ignore the balances carried
     * in from before the month, which are most of what is actually outstanding.
     * It comes from the same helper Payment Receiving, Recovery and the dashboard
     * read, so the four screens cannot quote different totals.
     */
    monthPending: number;
  };
  dbReady: boolean;
};

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

// ── Actual deliveries → invoice lines ─────────────────────────────────────────
// Billing reflects ONLY what the rider app actually recorded as delivered
// (DeliveryEntry) — never the subscription plan. The subscription schedule is a
// delivery *plan*, not a bill: a customer is never billed for days before they
// joined, for future days, or for deliveries that never happened. A customer
// with no recorded deliveries in the period simply has no delivery lines.

type GeneratedLine = {
  date: Date;
  productId: string;
  quantity: number;
  rate: number;
  amount: number;
  isReturn: boolean;
  isReplacement: boolean;
  /** The delivery this line was built from — what an edit of it writes back to. */
  deliveryEntryId?: string | null;
};

type DeliveryRow = {
  id?: string;
  date: Date;
  productId: string;
  quantity: Prisma.Decimal;
  unitRate: Prisma.Decimal;
  isReturn: boolean;
  isReplacement: boolean;
};

function deliveryToLine(e: DeliveryRow): GeneratedLine {
  const quantity = Number(e.quantity);
  const rate = Number(e.unitRate);
  return {
    date: e.date, productId: e.productId, quantity, rate,
    amount: quantity * rate, isReturn: e.isReturn, isReplacement: e.isReplacement,
    deliveryEntryId: e.id ?? null,
  };
}

/**
 * One rebuild of a bill's lines at a time.
 *
 * A bill's lines are rewritten (delete all, write all from the deliveries) every
 * time it is opened, when a discount is set, on a manual edit and on a reset. Two
 * of those overlapping — setting a discount while the page refreshed itself — let
 * the second delete nothing (the first's delete had already gone through) and
 * then both wrote their lines: Iqra Abbas's 1-15 Oct bill ended up with every
 * delivery twice. Every rewrite now takes this lock first, inside its own
 * transaction, so the second waits for the first to finish and then rebuilds on
 * top of it. Released with the transaction.
 */
async function lockInvoice(tx: Prisma.TransactionClient, invoiceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"invoice:" + invoiceId}))`;
}

// One invoice line per actual delivery for the customer within the period.
async function buildLinesFromDeliveries(customerId: string, year: number, month: number, half: number): Promise<GeneratedLine[]> {
  const { periodStart, periodEnd } = periodBounds(year, month, half);
  const entries = await db.deliveryEntry.findMany({
    where: { customerId, date: { gte: periodStart, lte: periodEnd } },
    select: { id: true, date: true, productId: true, quantity: true, unitRate: true, isReturn: true, isReplacement: true },
    orderBy: { date: "asc" },
  });
  return entries.map(deliveryToLine);
}

// The flat delivery charge only applies when the customer actually received at
// least one delivery in the period — never a "delivery fee" for someone who
// wasn't delivered to.
function deliveryChargeFor(lines: GeneratedLine[], half: number, custDeliveryCharge: number, areaDefault: number): number {
  const delivered = lines.some((l) => !l.isReturn && !l.isReplacement && l.quantity > 0);
  return half === 2 && delivered ? (custDeliveryCharge || areaDefault) : 0;
}

// ── Over-the-Counter credit purchases → a charge on the customer's bill ────────
// A REGULAR customer's OTC sale on credit is a real charge for the period it was
// made in — it belongs on that period's bill as due, itemized. Vendor credit
// sales go to Vendor Receivables (not customer bills); cash sales are settled on
// the spot (never due). Only rows dated WITHIN the period are counted here — OTC
// credit from BEFORE the period is already carried in prevBalance, so the two are
// disjoint and nothing is double-counted.

export type OtcCreditSale = { id: string; invoiceNo: string; date: string; amount: number; products: string };

async function customerOtcCreditInPeriod(
  customerId: string, periodStart: Date, periodEnd: Date
): Promise<{ total: number; sales: OtcCreditSale[] }> {
  const rows = await db.otcSale.findMany({
    where: { customerId, customerType: "REGULAR", date: { gte: periodStart, lte: periodEnd } },
    select: {
      id: true, invoiceNo: true, date: true, totalAmount: true, paidAmount: true,
      lines: { select: { quantity: true, unit: true, product: { select: { name: true } } } },
    },
    orderBy: { date: "asc" },
  });
  // The customer is billed only the unpaid remainder of each counter sale. A fully
  // paid one (remainder 0) is not a charge on this invoice, so it drops out.
  const sales: OtcCreditSale[] = rows
    .map((r) => ({
      id: r.id, invoiceNo: r.invoiceNo, date: r.date.toISOString(),
      amount: Number(r.totalAmount) - Number(r.paidAmount),
      products: r.lines.map((l) => `${Number(l.quantity)} ${l.unit} ${l.product.name}`).join(", "),
    }))
    .filter((x) => x.amount > 0.005);
  return { total: sales.reduce((s, x) => s + x.amount, 0), sales };
}

// Batched per-customer total of OTC credit within the period (for the overview /
// bulk generate — one query instead of one per customer).
async function customerOtcCreditByPeriod(
  scope: CustomerScope, periodStart: Date, periodEnd: Date
): Promise<Map<string, number>> {
  if (Array.isArray(scope) && !scope.length) return new Map();
  const groups = await db.otcSale.groupBy({
    by: ["customerId"],
    where: {
      // Same set either way; the relation form needs no id list, so the caller
      // does not have to wait for one. See LIVE_CUSTOMERS in lib/customer-balance.
      ...(Array.isArray(scope)
        ? { customerId: { in: scope } }
        : { customer: { status: { not: "DISABLED" as const } } }),
      customerType: "REGULAR",
      date: { gte: periodStart, lte: periodEnd },
    },
    _sum: { totalAmount: true, paidAmount: true },
  });
  const m = new Map<string, number>();
  // Billed = unpaid remainder (total − paid) across the customer's counter sales.
  for (const g of groups) if (g.customerId) m.set(g.customerId, Number(g._sum.totalAmount ?? 0) - Number(g._sum.paidAmount ?? 0));
  return m;
}

// ── Carry-forward (computed live from primitives, never from stale totals) ─────────
// prevBalance = openingBalance
//             + Σ(ACTUAL deliveries − returns, from DeliveryEntry, before this period)
//             + Σ(delivery-charge fees on invoices that ended before this period)
//             + Σ(unpaid Over-the-Counter sales dated before this period)
//             − Σ(payments dated before this period)
// Same components as computeCustomerOutstanding — deliveries from real
// DeliveryEntry rows, only the flat fee from invoices — so the two never drift.
async function computePrevBalance(customerId: string, periodStart: Date): Promise<number> {
  const [customer, deliveredBefore, invoices, paysBefore, otcCreditBefore] = await Promise.all([
    db.customer.findUnique({ where: { id: customerId }, select: { openingBalance: true } }),
    deliveredValueByCustomer([customerId], { lt: periodStart }),
    db.invoice.findMany({
      where: { customerId },
      select: { deliveryCharge: true, discount: true, periodStart: true, year: true, month: true, half: true },
    }),
    db.payment.aggregate({ where: { customerId, date: { lt: periodStart } }, _sum: { amount: true } }),
    // OTC sales sold to this customer "on credit" are unpaid charges too — same
    // pool payments are drawn from below, since payments here aren't earmarked
    // to a specific invoice/charge (matches how the rest of this function works).
    db.otcSale.aggregate({
      where: { customerId, customerType: "REGULAR", date: { lt: periodStart } },
      _sum: { totalAmount: true, paidAmount: true },
    }),
  ]);

  let charges = deliveredBefore.get(customerId) ?? 0;
  for (const inv of invoices) {
    if (effStart(inv).getTime() < periodStart.getTime()) {
      // Flat fee less any one-off allowance — deliveries come from DeliveryEntry above.
      charges += Number(inv.deliveryCharge) - Number(inv.discount);
    }
  }
  charges += Number(otcCreditBefore._sum.totalAmount ?? 0) - Number(otcCreditBefore._sum.paidAmount ?? 0);
  const opening = Number(customer?.openingBalance ?? 0);
  const paid = Number(paysBefore._sum.amount ?? 0);
  return opening + charges - paid;
}

async function sumPayments(customerId: string, start: Date, end: Date): Promise<number> {
  const agg = await db.payment.aggregate({
    where: { customerId, date: { gte: start, lte: end } },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0);
}

// ── Overview ───────────────────────────────────────────────────────────────────────

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export async function getBillingOverview(year: number, month: number, half: number): Promise<BillingOverview> {
  await requireRole(FULL_ACCESS);
  const { startDay, endDay, periodStart, periodEnd } = periodBounds(year, month, half);
  const periodLabel = `${startDay}–${endDay} ${MONTHS[month - 1]} ${year}`;
  // Determine which period is currently active for this month based on today (PKT).
  const nowPKT = new Date(Date.now() + PKT);
  const todayDay = nowPKT.getUTCDate();
  const todayYear = nowPKT.getUTCFullYear();
  const todayMonth = nowPKT.getUTCMonth() + 1;
  // Only enforce the lock on the current month; past/future months allow both halves.
  const isCurrentMonth = year === todayYear && month === todayMonth;
  const activePeriod = isCurrentMonth ? (todayDay <= 15 ? 1 : 2) : half;
  // Reuses periodNotStartedError so the button and the server agree by
  // construction: a half you cannot open is exactly a half that would be
  // refused, rather than a second copy of the rule that can drift from it.
  const openHalves = [1, 2].filter((h) => periodNotStartedError(year, month, h) === null);

  try {
    // Everything this page needs, in ONE round of queries.
    //
    // It used to be three rounds, because every query after the first named the
    // customers individually — `customerId: { in: custIds } ` — and custIds could
    // only be built once the customer query had come back. So the page waited for
    // customers, then waited again for invoices, then again for deliveries.
    // Measured against production that was 5.3-7.7s for one change of month or
    // fortnight, which is what made the month picker and the period buttons feel
    // broken.
    //
    // None of those queries actually needed the list: "the customers on this page"
    // is just "customers who are not disabled", which Postgres can work out itself
    // from the relation. Saying it that way removes the dependency, so all of it
    // runs at once — and is faster per query besides, with no ~2,200 ids on the
    // wire. Same rows, same figures: 2.1-2.5s measured the same way.
    // The other fortnight of this month, needed inside the batch below.
    const otherHalf = half === 1 ? 2 : 1;
    const otherBounds = periodBounds(year, month, otherHalf);
    const otherStarted = periodNotStartedError(year, month, otherHalf) === null;

    const live = { status: { not: "DISABLED" as const } };
    const [
      customers, invoices, payments, shifts, allInvoices, otcCreditBefore,
      currentDeliveries, priorDelivered, otcWithin, otherDeliveries, otcOther,
      monthPendingMap,
    ] = await Promise.all([
      db.customer.findMany({
        where: live,
        select: {
          id: true, customerCode: true, name: true, phone: true, status: true,
          shiftId: true, deliveryCharge: true, openingBalance: true,
          shift: { select: { name: true } },
          area: { select: { name: true, defaultDeliveryCharge: true } },
        },
        orderBy: { name: "asc" },
      }),
      db.invoice.findMany({ where: { month, year, half } }),
      db.payment.findMany({
        where: { date: { lte: periodBounds(year, month, 2).periodEnd } },
        select: { customerId: true, amount: true, date: true },
      }),
      db.shift.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
      // All invoices for these customers (for carry-forward charges).
      db.invoice.findMany({
        where: { customer: live },
        select: { customerId: true, deliveriesAmt: true, returnsAmt: true, deliveryCharge: true, discount: true, periodStart: true, year: true, month: true, half: true },
      }),
      // Unpaid Over-the-Counter sales before this period are carry-forward charges,
      // exactly as computePrevBalance() treats them. One groupBy for the whole list
      // rather than calling the helper per row, which would be one round-trip per
      // customer. Omitting these made this list disagree with the invoice you open
      // from it — the list showed a lower Prev Balance than the bill the customer
      // actually received.
      db.otcSale.groupBy({
        by: ["customerId"],
        where: { customer: live, date: { lt: periodStart } },
        _sum: { totalAmount: true, paidAmount: true },
      }),
      // Live deliveries this period for EVERY customer (not just ungenerated) — so
      // the list's delivery figure always matches the bill, which rebuilds live too.
      db.deliveryEntry.findMany({
        where: { customer: live, date: { gte: periodStart, lte: periodEnd } },
        select: { customerId: true, date: true, productId: true, quantity: true, unitRate: true, isReturn: true, isReplacement: true },
      }),
      // Everything delivered before this period, for carry-forward.
      deliveredValueByCustomer(LIVE_CUSTOMERS, { lt: periodStart }),
      // This period's OTC credit purchases per customer — a charge on THIS bill.
      customerOtcCreditByPeriod(LIVE_CUSTOMERS, periodStart, periodEnd),
      // The other fortnight of the same month, for the two month-to-date cards.
      // Worked out by the same rule as this one, so "this month" is always the two
      // fortnights added up rather than a second figure arrived at another way.
      otherStarted
        ? db.deliveryEntry.findMany({
            where: { customer: live, date: { gte: otherBounds.periodStart, lte: otherBounds.periodEnd } },
            select: { customerId: true, date: true, productId: true, quantity: true, unitRate: true, isReturn: true, isReplacement: true },
          })
        : Promise.resolve([] as { customerId: string | null; date: Date; productId: string; quantity: Prisma.Decimal; unitRate: Prisma.Decimal; isReturn: boolean; isReplacement: boolean }[]),
      otherStarted
        ? customerOtcCreditByPeriod(LIVE_CUSTOMERS, otherBounds.periodStart, otherBounds.periodEnd)
        : Promise.resolve(new Map<string, number>()),
      // What is still owed as at month end. Deliberately the shared helper rather
      // than a sum of the rows below — those are scoped to the half being viewed,
      // and "pending" is never scoped to a fortnight. In this batch rather than
      // after it: it is five more queries, and waiting for them on their own cost
      // another 1.4-2.9s on top of everything else.
      computeCustomerOutstanding(LIVE_CUSTOMERS, { year, month, asOfDate: periodBounds(year, month, 2).periodEnd }),
    ]);
    const otcBeforeByCust = new Map<string, number>();
    for (const g of otcCreditBefore) {
      if (!g.customerId) continue;
      otcBeforeByCust.set(g.customerId, Number(g._sum.totalAmount ?? 0) - Number(g._sum.paidAmount ?? 0));
    }

    const invByCust = new Map(invoices.map((i) => [i.customerId, i]));

    const deliveriesByCust = new Map<string, GeneratedLine[]>();
    for (const e of currentDeliveries) {
      if (!e.customerId) continue;
      const arr = deliveriesByCust.get(e.customerId) ?? [];
      arr.push(deliveryToLine(e));
      deliveriesByCust.set(e.customerId, arr);
    }

    // Prior delivery-charge FEES only (prior deliveries come from `priorDelivered`).
    const feesByCust = new Map<string, { fee: number; start: Date }[]>();
    for (const inv of allInvoices) {
      const arr = feesByCust.get(inv.customerId) ?? [];
      arr.push({ fee: Number(inv.deliveryCharge) - Number(inv.discount), start: effStart(inv) });
      feesByCust.set(inv.customerId, arr);
    }

    const monthStart = periodBounds(year, month, 1).periodStart;
    const monthEnd = periodBounds(year, month, 2).periodEnd;
    let monthCollected = 0;

    const payBefore = new Map<string, number>();
    const payWithin = new Map<string, number>();
    for (const p of payments) {
      if (!p.customerId) continue; // sample rider-cash payments belong to no customer bill
      const amt = Number(p.amount);
      // The month card counts both halves; the period maps below count only this one.
      if (p.date >= monthStart && p.date <= monthEnd) monthCollected += amt;
      if (p.date.getTime() > periodEnd.getTime()) continue;
      if (p.date.getTime() < periodStart.getTime()) {
        payBefore.set(p.customerId, (payBefore.get(p.customerId) ?? 0) + amt);
      } else {
        payWithin.set(p.customerId, (payWithin.get(p.customerId) ?? 0) + amt);
      }
    }

    let billed = 0, collected = 0, outstanding = 0, generated = 0, pending = 0;

    const rows: BillingCustomerRow[] = customers.map((c) => {
      const inv = invByCust.get(c.id);

      // Carry-forward: prior actual deliveries + prior fees + prior OTC − prior payments.
      let priorFee = 0;
      for (const e of feesByCust.get(c.id) ?? []) {
        if (e.start.getTime() < periodStart.getTime()) priorFee += e.fee;
      }
      // Same formula as computePrevBalance(), just batched — keep them in step.
      const prevBalance =
        Number(c.openingBalance) + (priorDelivered.get(c.id) ?? 0) + priorFee + (otcBeforeByCust.get(c.id) ?? 0) - (payBefore.get(c.id) ?? 0);
      const paymentsAmt = payWithin.get(c.id) ?? 0;

      // Deliveries/returns are computed LIVE from DeliveryEntry for everyone, so a
      // late delivery shows on both the list and the (now live) bill.
      const lines = deliveriesByCust.get(c.id) ?? [];
      const deliveries = lines.reduce((s, l) => s + (l.isReturn || l.isReplacement ? 0 : l.amount), 0);
      const returns = lines.reduce((s, l) => s + (l.isReturn ? l.amount : 0), 0);
      // Worked out from the deliveries as they stand, generated or not. Reading
      // the stored figure for a generated bill meant a bill raised before the
      // first delivery of the half kept a charge of nothing for ever, while the
      // deliveries on it grew — 438 bills this month said the milk arrived and
      // the delivery was complimentary.
      const deliveryCharge = deliveryChargeFor(lines, half, Number(c.deliveryCharge), Number(c.area?.defaultDeliveryCharge ?? 0));
      let invoiceStatus: string;
      if (inv) {
        invoiceStatus = inv.status;
        generated++;
      } else {
        invoiceStatus = "NONE";
        pending++;
      }
      // A one-off allowance the office put on this bill.
      const discount = inv ? Number(inv.discount) : 0;

      // This period's OTC credit purchases are a charge on this bill (both for a
      // generated invoice and a not-yet-generated preview).
      const otcAmt = otcWithin.get(c.id) ?? 0;

      const totalDue = prevBalance + deliveries - returns + deliveryCharge + otcAmt - discount - paymentsAmt;
      billed += deliveries - returns + deliveryCharge + otcAmt - discount;
      collected += paymentsAmt;
      outstanding += totalDue;

      return {
        id: c.id,
        customerCode: c.customerCode,
        name: c.name,
        phone: c.phone,
        shiftName: c.shift?.name ?? "—",
        shiftId: c.shiftId,
        areaName: c.area?.name ?? "—",
        customerStatus: c.status,
        generated: !!inv,
        invoiceId: inv?.id ?? null,
        invoiceStatus,
        billSent: !!inv?.billSentAt,
        prevBalance,
        deliveries,
        returns,
        deliveryCharge,
        discount,
        otcAmt,
        paymentsAmt,
        totalDue,
      };
    });

    // The other fortnight's billing, by the same rule as this one's: what was
    // delivered, less what came back, plus the delivery charge and any counter
    // purchases taken on credit, less a one-off allowance.
    const otherByCust = new Map<string, GeneratedLine[]>();
    for (const e of otherDeliveries) {
      if (!e.customerId) continue;
      const arr = otherByCust.get(e.customerId) ?? [];
      arr.push(deliveryToLine(e));
      otherByCust.set(e.customerId, arr);
    }
    const otherDiscount = new Map<string, number>();
    for (const i of allInvoices) {
      if (i.year === year && i.month === month && i.half === otherHalf) {
        otherDiscount.set(i.customerId, Number(i.discount));
      }
    }
    let monthPending = 0;
    for (const v of monthPendingMap.values()) monthPending += v;

    let otherBilled = 0;
    for (const c of customers) {
      const lines = otherByCust.get(c.id) ?? [];
      const delivered = lines.reduce((sum, l) => sum + (l.isReturn || l.isReplacement ? 0 : l.amount), 0);
      const back = lines.reduce((sum, l) => sum + (l.isReturn ? l.amount : 0), 0);
      const fee = deliveryChargeFor(lines, otherHalf, Number(c.deliveryCharge), Number(c.area?.defaultDeliveryCharge ?? 0));
      otherBilled += delivered - back + fee + (otcOther.get(c.id) ?? 0) - (otherDiscount.get(c.id) ?? 0);
    }

    return {
      year, month, half, activePeriod, openHalves, periodLabel,
      customers: rows,
      shifts,
      totals: {
        billed, collected, outstanding, generated, pending,
        monthBilled: billed + otherBilled,
        monthCollected,
        monthPending,
      },
      dbReady: true,
    };
  } catch (e) {
    console.error("[getBillingOverview]", e);
    return {
      year, month, half, activePeriod, openHalves, periodLabel,
      customers: [], shifts: [],
      totals: { billed: 0, collected: 0, outstanding: 0, generated: 0, pending: 0, monthBilled: 0, monthCollected: 0, monthPending: 0 },
      dbReady: false,
    };
  }
}

// ── Generate ────────────────────────────────────────────────────────────────────────

async function writeInvoice(customerId: string, year: number, month: number, half: number, dueDate?: Date): Promise<string> {
  const cust = await db.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true, deliveryCharge: true,
      area: { select: { defaultDeliveryCharge: true } },
    },
  });
  if (!cust) throw new Error("Customer not found.");

  const pb = periodBounds(year, month, half);
  const lines = await buildLinesFromDeliveries(customerId, year, month, half);
  const deliveriesAmt = lines.reduce((s, l) => s + (l.isReturn || l.isReplacement ? 0 : l.amount), 0);
  const returnsAmt = lines.reduce((s, l) => s + (l.isReturn ? l.amount : 0), 0);
  const deliveryCharge = deliveryChargeFor(lines, half, Number(cust.deliveryCharge), Number(cust.area?.defaultDeliveryCharge ?? 0));

  const prevBalance = await computePrevBalance(customerId, pb.periodStart);
  const paymentsAmt = await sumPayments(customerId, pb.periodStart, pb.periodEnd);
  // This period's OTC credit purchases are a charge on this bill (itemised at view
  // time; here they just need to land in the stored total).
  const { total: otcAmt } = await customerOtcCreditInPeriod(customerId, pb.periodStart, pb.periodEnd);
  const totalDue = prevBalance + deliveriesAmt - returnsAmt + deliveryCharge + otcAmt - paymentsAmt;

  const data = {
    periodStart: pb.periodStart,
    periodEnd: pb.periodEnd,
    prevBalance: new Prisma.Decimal(prevBalance),
    deliveriesAmt: new Prisma.Decimal(deliveriesAmt),
    returnsAmt: new Prisma.Decimal(returnsAmt),
    deliveryCharge: new Prisma.Decimal(deliveryCharge),
    paymentsAmt: new Prisma.Decimal(paymentsAmt),
    totalDue: new Prisma.Decimal(totalDue),
  };

  const invoice = await db.$transaction(async (tx) => {
    const existing = await tx.invoice.findUnique({
      where: { customerId_month_year_half: { customerId, month, year, half } },
      select: { id: true },
    });

    let inv;
    if (existing) {
      await lockInvoice(tx, existing.id);
      await tx.invoiceLine.deleteMany({ where: { invoiceId: existing.id } });
      // Preserve the existing Last Date on rebuild unless a new one is given. A
      // reset is back to the subscriptions, so a one-off discount goes with the
      // manual line edits it sat beside.
      inv = await tx.invoice.update({ where: { id: existing.id }, data: dueDate ? { ...data, dueDate, discount: 0 } : { ...data, discount: 0 } });
    } else {
      inv = await tx.invoice.create({
        data: { customerId, month, year, half, status: "DRAFT", dueDate: dueDate ?? defaultDueDate(year, month), ...data },
      });
    }

    if (lines.length > 0) {
      await tx.invoiceLine.createMany({
        data: lines.map((l) => ({
          invoiceId: inv.id,
          date: l.date,
          productId: l.productId,
          quantity: new Prisma.Decimal(l.quantity),
          rate: new Prisma.Decimal(l.rate),
          amount: new Prisma.Decimal(l.amount),
          isReturn: l.isReturn,
          isReplacement: l.isReplacement,
        })),
      });
    }
    return inv;
  });

  return invoice.id;
}

export async function generateInvoice(customerId: string, year: number, month: number, half: number, dueDateStr?: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    const tooEarly = periodNotStartedError(year, month, half);
    if (tooEarly) return { ok: false, error: tooEarly };
    const due = dueDateStr ? parseDueDate(dueDateStr, year, month) : undefined;
    const id = await writeInvoice(customerId, year, month, half, due);
    revalidatePath("/billing/invoices");
    revalidatePath("/payments/recovery");
    revalidatePath("/"); // dashboard Sales / Profit / Collection / Outstanding tiles
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to generate invoice." };
  }
}

// Generate for every active customer that doesn't yet have an invoice for the
// period (existing invoices are left untouched so manual edits survive).
//
// Set-based: instead of one writeInvoice() per customer (~8 round-trips each),
// load everything once, compute lines/balances in memory, then bulk-insert the
// invoices and their lines. This turns hundreds of customers from minutes into
// a couple of seconds.
export async function bulkGenerate(year: number, month: number, half: number, dueDateStr?: string): Promise<{ ok: boolean; created: number; skipped: number; error?: string }> {
  await requireRole(FULL_ACCESS);
  try {
    const tooEarly = periodNotStartedError(year, month, half);
    if (tooEarly) return { ok: false, created: 0, skipped: 0, error: tooEarly };

    const { periodStart, periodEnd } = periodBounds(year, month, half);
    const dueDate = parseDueDate(dueDateStr, year, month);

    // Wave 1 — customers (+ subscriptions/area) and which already have an invoice.
    const [customers, periodInvoices] = await Promise.all([
      db.customer.findMany({
        where: { status: { not: "DISABLED" } },
        select: {
          id: true, openingBalance: true, deliveryCharge: true,
          area: { select: { defaultDeliveryCharge: true } },
        },
      }),
      db.invoice.findMany({ where: { month, year, half }, select: { customerId: true } }),
    ]);

    const have = new Set(periodInvoices.map((e) => e.customerId));
    const pending = customers.filter((c) => !have.has(c.id));
    if (pending.length === 0) {
      return { ok: true, created: 0, skipped: have.size };
    }
    const custIds = pending.map((c) => c.id);

    // Wave 2 — carry-forward inputs for the pending customers, in three queries.
    const [allInvoices, payments, otcCreditBefore] = await Promise.all([
      db.invoice.findMany({
        where: { customerId: { in: custIds } },
        select: { customerId: true, deliveriesAmt: true, returnsAmt: true, deliveryCharge: true, discount: true, periodStart: true, year: true, month: true, half: true },
      }),
      db.payment.findMany({
        where: { customerId: { in: custIds }, date: { lte: periodEnd } },
        select: { customerId: true, amount: true, date: true },
      }),
      // Unpaid Over-the-Counter sales before this period — carry-forward charges,
      // exactly as computePrevBalance() (used by the single-invoice path) treats
      // them. Batched, since this generates for every pending customer at once.
      // Omitting these meant Bulk Generate PERSISTED a lower prevBalance than
      // Generate did for the same customer and period — two buttons, two
      // different bills, whichever ran last winning.
      db.otcSale.groupBy({
        by: ["customerId"],
        where: { customerId: { in: custIds }, date: { lt: periodStart } },
        _sum: { totalAmount: true, paidAmount: true },
      }),
    ]);
    const otcBeforeByCust = new Map<string, number>();
    for (const g of otcCreditBefore) {
      if (!g.customerId) continue;
      otcBeforeByCust.set(g.customerId, Number(g._sum.totalAmount ?? 0) - Number(g._sum.paidAmount ?? 0));
    }

    // This period's OTC credit purchases per customer — a charge on this bill.
    const otcWithin = await customerOtcCreditByPeriod(custIds, periodStart, periodEnd);

    // Actual deliveries: this period's (→ invoice lines) and everything before it
    // (→ carry-forward), from real DeliveryEntry rows rather than the plan.
    const [currentDeliveries, priorDelivered] = await Promise.all([
      db.deliveryEntry.findMany({
        where: { customerId: { in: custIds }, date: { gte: periodStart, lte: periodEnd } },
        select: { customerId: true, date: true, productId: true, quantity: true, unitRate: true, isReturn: true, isReplacement: true },
        orderBy: { date: "asc" },
      }),
      deliveredValueByCustomer(custIds, { lt: periodStart }),
    ]);
    const deliveriesByCust = new Map<string, GeneratedLine[]>();
    for (const e of currentDeliveries) {
      if (!e.customerId) continue;
      const arr = deliveriesByCust.get(e.customerId) ?? [];
      arr.push(deliveryToLine(e));
      deliveriesByCust.set(e.customerId, arr);
    }

    // Prior delivery-charge FEES (invoices that ended before this period). Prior
    // deliveries themselves come from `priorDelivered` above, never Invoice.deliveriesAmt.
    const feesByCust = new Map<string, { fee: number; start: Date }[]>();
    for (const inv of allInvoices) {
      const arr = feesByCust.get(inv.customerId) ?? [];
      arr.push({ fee: Number(inv.deliveryCharge) - Number(inv.discount), start: effStart(inv) });
      feesByCust.set(inv.customerId, arr);
    }

    // Payments split into before-period (reduce carry-forward) and within-period.
    const payBefore = new Map<string, number>();
    const payWithin = new Map<string, number>();
    for (const p of payments) {
      if (!p.customerId) continue; // sample rider-cash payments belong to no customer bill
      const amt = Number(p.amount);
      if (p.date.getTime() < periodStart.getTime()) {
        payBefore.set(p.customerId, (payBefore.get(p.customerId) ?? 0) + amt);
      } else {
        payWithin.set(p.customerId, (payWithin.get(p.customerId) ?? 0) + amt);
      }
    }

    // Build invoice rows + their lines entirely in memory.
    const invoiceRows: Prisma.InvoiceCreateManyInput[] = [];
    const linesByCust = new Map<string, GeneratedLine[]>();

    for (const c of pending) {
      const lines = deliveriesByCust.get(c.id) ?? [];
      const deliveriesAmt = lines.reduce((s, l) => s + (l.isReturn || l.isReplacement ? 0 : l.amount), 0);
      const returnsAmt = lines.reduce((s, l) => s + (l.isReturn ? l.amount : 0), 0);
      const deliveryCharge = deliveryChargeFor(lines, half, Number(c.deliveryCharge), Number(c.area?.defaultDeliveryCharge ?? 0));

      let priorFee = 0;
      for (const e of feesByCust.get(c.id) ?? []) {
        if (e.start.getTime() < periodStart.getTime()) priorFee += e.fee;
      }
      // Same formula as computePrevBalance(), just batched — keep them in step:
      // prior actual deliveries + prior fees + prior OTC − prior payments.
      const prevBalance =
        Number(c.openingBalance) + (priorDelivered.get(c.id) ?? 0) + priorFee + (otcBeforeByCust.get(c.id) ?? 0) - (payBefore.get(c.id) ?? 0);
      const paymentsAmt = payWithin.get(c.id) ?? 0;
      const otcAmt = otcWithin.get(c.id) ?? 0;
      const totalDue = prevBalance + deliveriesAmt - returnsAmt + deliveryCharge + otcAmt - paymentsAmt;

      invoiceRows.push({
        customerId: c.id, month, year, half, status: "DRAFT",
        periodStart, periodEnd, dueDate,
        prevBalance: new Prisma.Decimal(prevBalance),
        deliveriesAmt: new Prisma.Decimal(deliveriesAmt),
        returnsAmt: new Prisma.Decimal(returnsAmt),
        deliveryCharge: new Prisma.Decimal(deliveryCharge),
        paymentsAmt: new Prisma.Decimal(paymentsAmt),
        totalDue: new Prisma.Decimal(totalDue),
      });
      if (lines.length > 0) linesByCust.set(c.id, lines);
    }

    // Invoices + their lines are one unit of work, so they commit together.
    //
    // This used to double-charge. `createMany(skipDuplicates)` silently skips an
    // invoice another run already made and does NOT throw, but the read-back below
    // returns every invoice for the period — including that other run's — so both
    // runs then inserted the FULL line set against the same invoice. Every delivery
    // was billed twice. The @@unique is on Invoice, not InvoiceLine, so nothing
    // caught it; stored deliveriesAmt still looked right until someone opened the
    // invoice, at which point it recomputed from lines and persisted double.
    //
    // Two defences: an advisory lock that serialises this period against itself
    // (so a double-click / two admins queue instead of interleave), and a
    // lines-already-exist check so a re-run can never append a second set.
    const lockKey = BigInt(year * 10000 + month * 100 + half);
    let insertedLines = 0;

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      await tx.invoice.createMany({ data: invoiceRows, skipDuplicates: true });
      const written = await tx.invoice.findMany({
        where: { month, year, half, customerId: { in: custIds } },
        select: { id: true, customerId: true, _count: { select: { lines: true } } },
      });
      // Only invoices that have no lines yet are ours to fill.
      const invIdByCust = new Map(
        written.filter((w) => w._count.lines === 0).map((w) => [w.customerId, w.id])
      );

      const lineRows: Prisma.InvoiceLineCreateManyInput[] = [];
      for (const [custId, lines] of linesByCust) {
        const invoiceId = invIdByCust.get(custId);
        if (!invoiceId) continue;
        for (const l of lines) {
          lineRows.push({
            invoiceId,
            date: l.date,
            productId: l.productId,
            quantity: new Prisma.Decimal(l.quantity),
            rate: new Prisma.Decimal(l.rate),
            amount: new Prisma.Decimal(l.amount),
            isReturn: l.isReturn,
            isReplacement: l.isReplacement,
          });
        }
      }
      // Chunk to stay well under Postgres' 65535 bind-parameter limit (8 cols/row).
      const CHUNK = 2000;
      for (let i = 0; i < lineRows.length; i += CHUNK) {
        await tx.invoiceLine.createMany({ data: lineRows.slice(i, i + CHUNK) });
      }
      insertedLines = lineRows.length;
    }, { timeout: 120_000 });
    void insertedLines;

    revalidatePath("/billing/invoices");
    revalidatePath("/payments/recovery");
    revalidatePath("/"); // dashboard Sales / Profit / Collection / Outstanding tiles
    return { ok: true, created: pending.length, skipped: have.size };
  } catch (e) {
    return { ok: false, created: 0, skipped: 0, error: e instanceof Error ? e.message : "Bulk generation failed." };
  }
}

// ── Invoice detail (printable) ──────────────────────────────────────────────────────

export type InvoiceDetail = {
  id: string;
  number: string;
  month: number;
  year: number;
  half: number;
  periodLabel: string;
  dueDate: string; // ISO — the "Last date" to pay (defaults to month-end)
  status: string;
  customer: { id: string; code: string; name: string; phone: string; address: string | null };
  lines: InvoiceLineRow[];
  otcSales: OtcCreditSale[];   // this period's Over-the-Counter credit purchases, itemized
  prevBalance: number;
  deliveriesAmt: number;
  returnsAmt: number;
  deliveryCharge: number;
  /** A one-off allowance on this bill only. Taken off the total below. */
  discount: number;
  otcAmt: number;              // total of otcSales — a charge on the bill
  paymentsAmt: number;
  totalDue: number;
  dbReady: boolean;
};

function invNumber(year: number, month: number, half: number, code: string): string {
  return `BD-${year}-${String(month).padStart(2, "0")}-H${half}-${code}`;
}

export async function getInvoiceDetail(invoiceId: string): Promise<InvoiceDetail | null> {
  await requireRole(FULL_ACCESS);
  try {
    // Rebuild the invoice's delivery lines from LIVE DeliveryEntry so a delivery
    // recorded after this bill was generated (mobile app or a manager edit) always
    // appears on it — the invoice is no longer a frozen snapshot. Everything below
    // then reads the freshly-rebuilt lines.
    const head = await db.invoice.findUnique({
      where: { id: invoiceId },
      select: { customerId: true, year: true, month: true, half: true },
    });
    if (!head) return null;
    await db.$transaction(async (tx) => {
      await lockInvoice(tx, invoiceId);
      // Read the deliveries under the lock, so a rebuild that waited its turn sees
      // what the one before it left.
      const liveLines = await buildLinesFromDeliveries(head.customerId, head.year, head.month, head.half);
      await tx.invoiceLine.deleteMany({ where: { invoiceId } });
      if (liveLines.length) {
        await tx.invoiceLine.createMany({
          data: liveLines.map((l) => ({
            invoiceId,
            date: l.date,
            productId: l.productId,
            quantity: new Prisma.Decimal(l.quantity),
            rate: new Prisma.Decimal(l.rate),
            amount: new Prisma.Decimal(l.amount),
            isReturn: l.isReturn,
            isReplacement: l.isReplacement,
            deliveryEntryId: l.deliveryEntryId ?? null,
          })),
        });
      }
    });

    const inv = await db.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        lines: { include: { product: { select: { name: true, unit: true } } }, orderBy: { date: "asc" } },
        customer: { select: { id: true, customerCode: true, name: true, invoiceName: true, phone: true, address: true } },
      },
    });
    if (!inv) return null;

    // Stops the rider marked skipped in this period. The same test the rider report
    // and the returns page use: only a stop actually marked skipped, never one still
    // sitting PENDING, which is a stop nobody has reported on yet.
    const skipBounds = periodBounds(inv.year, inv.month, inv.half);
    const skippedDays = new Set(
      (await db.routeStop.findMany({
        where: {
          customerId: inv.customerId,
          status: { contains: "SKIP", mode: "insensitive" },
          route: { date: { gte: inv.periodStart ?? skipBounds.periodStart, lte: inv.periodEnd ?? skipBounds.periodEnd } },
        },
        select: { route: { select: { date: true } } },
      })).map((x) => x.route.date.toISOString().split("T")[0]),
    );

    const bounds = periodBounds(inv.year, inv.month, inv.half);
    const pb = {
      periodStart: inv.periodStart ?? bounds.periodStart,
      periodEnd: inv.periodEnd ?? bounds.periodEnd,
    };

    // Always recompute payment-driven figures live so late payments are counted.
    // OTC credit purchases are recomputed live too (a sale added/removed after
    // generation is reflected the next time the bill is opened).
    const prevBalance = await computePrevBalance(inv.customerId, pb.periodStart);
    const paymentsAmt = await sumPayments(inv.customerId, pb.periodStart, pb.periodEnd);
    const { total: otcAmt, sales: otcSales } = await customerOtcCreditInPeriod(inv.customerId, pb.periodStart, pb.periodEnd);
    const deliveriesAmt = inv.lines.reduce((s, l) => s + (l.isReturn || l.isReplacement ? 0 : Number(l.amount)), 0);
    const returnsAmt = inv.lines.reduce((s, l) => s + (l.isReturn ? Number(l.amount) : 0), 0);

    // The delivery charge is worked out fresh, from the deliveries as they stand
    // now — the same rule the overview applies, and for the same reason the lines
    // are rebuilt. A bill generated before the first delivery of the half was
    // recorded froze the charge at nothing and stayed that way, so the bill listed
    // a fortnight of milk and then said the delivery was complimentary. There were
    // 438 of those this month.
    const charged = await db.customer.findUnique({
      where: { id: inv.customerId },
      select: { deliveryCharge: true, area: { select: { defaultDeliveryCharge: true } } },
    });
    const deliveryCharge = deliveryChargeFor(
      inv.lines.map((l) => ({
        date: l.date, productId: l.productId, quantity: Number(l.quantity), rate: Number(l.rate),
        amount: Number(l.amount), isReturn: l.isReturn, isReplacement: l.isReplacement,
      })),
      inv.half,
      Number(charged?.deliveryCharge ?? 0),
      Number(charged?.area?.defaultDeliveryCharge ?? 0),
    );
    // A one-off allowance the office put on this bill, for a delivery that went
    // wrong and cannot be put right any other way. It belongs to this bill alone
    // and never carries into the next one.
    const discount = Number(inv.discount);
    const totalDue = prevBalance + deliveriesAmt - returnsAmt + deliveryCharge + otcAmt - discount - paymentsAmt;

    // Persist the refreshed snapshot so the overview + computeCustomerOutstanding
    // stay consistent. The lines were just rebuilt from live DeliveryEntry, so
    // deliveriesAmt/returnsAmt reflect actual deliveries (0 only when there genuinely
    // were none) — no stale-snapshot guard needed.
    await db.invoice.update({
      where: { id: inv.id },
      data: {
        prevBalance: new Prisma.Decimal(prevBalance),
        deliveriesAmt: new Prisma.Decimal(deliveriesAmt),
        returnsAmt: new Prisma.Decimal(returnsAmt),
        // Stored as well as shown: the customer's balance is built from this
        // column, so a charge that only lived on screen would leave the bill and
        // the balance disagreeing.
        deliveryCharge: new Prisma.Decimal(deliveryCharge),
        paymentsAmt: new Prisma.Decimal(paymentsAmt),
        totalDue: new Prisma.Decimal(totalDue),
      },
    });

    return {
      id: inv.id,
      number: invNumber(inv.year, inv.month, inv.half, inv.customer.customerCode),
      month: inv.month,
      year: inv.year,
      half: inv.half,
      periodLabel: `${bounds.startDay}–${bounds.endDay} ${MONTHS[inv.month - 1]} ${inv.year}`,
      dueDate: (inv.dueDate ?? defaultDueDate(inv.year, inv.month)).toISOString(),
      status: inv.status,
      customer: {
        id: inv.customer.id,
        code: inv.customer.customerCode,
        name: inv.customer.invoiceName || inv.customer.name,
        phone: inv.customer.phone,
        address: inv.customer.address,
      },
      discount,
      lines: inv.lines.map((l) => ({
        id: l.id,
        deliveryEntryId: l.deliveryEntryId,
        date: l.date.toISOString(),
        productId: l.productId,
        productName: l.product.name,
        unit: l.product.unit,
        quantity: Number(l.quantity),
        rate: Number(l.rate),
        amount: Number(l.amount),
        isReturn: l.isReturn,
        isReplacement: l.isReplacement,
        notDelivered: !l.isReturn && !l.isReplacement && skippedDays.has(l.date.toISOString().split("T")[0]),
      })),
      otcSales,
      prevBalance,
      deliveriesAmt,
      returnsAmt,
      deliveryCharge,
      otcAmt,
      paymentsAmt,
      totalDue,
      dbReady: true,
    };
  } catch (e) {
    console.error("[getInvoiceDetail]", e);
    return null;
  }
}

// ── Line editing ──────────────────────────────────────────────────────────────────

export type ProductOption = { id: string; name: string; unit: string; defaultRate: number };

export async function getProductOptions(): Promise<ProductOption[]> {
  await requireRole(FULL_ACCESS);
  try {
    const products = await db.product.findMany({
      where: { active: true },
      select: { id: true, name: true, unit: true, defaultRate: true },
      orderBy: { name: "asc" },
    });
    return products.map((p) => ({ id: p.id, name: p.name, unit: p.unit, defaultRate: Number(p.defaultRate) }));
  } catch {
    return [];
  }
}

// Edit actions return the freshly recomputed invoice so the UI shows exact
// server figures immediately — getInvoiceDetail() recomputes totals and persists.
export type DetailActionResult =
  | { ok: true; invoice: InvoiceDetail }
  | { ok: false; error: string };

// Rounds a money input to 2 decimals to avoid float drift in stored amounts.
function money(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

// Replace the entire set of lines for an invoice in one shot (buffered editor's
// Save). Wipes existing lines and recreates them from the client's draft, then
// recomputes & persists the totals via getInvoiceDetail and returns the fresh
// invoice so the UI shows exact server figures.
/**
 * Save an edited bill.
 *
 * The edit is written to the DELIVERIES, not to the bill's own lines. A bill is
 * rebuilt from the live deliveries every time it is opened — that is what makes a
 * delivery recorded after the bill was generated still appear on it — so a line
 * edited in place was overwritten by the rebuild a moment later, and the change
 * looked like it had never been made. It had been made, and then wiped, on every
 * bill anyone tried to correct.
 *
 * Writing through to the delivery means the correction holds, and it means the
 * bill, the customer's balance, the ledger and the rider's own report all say the
 * same thing afterwards — rather than a bill privately disagreeing with the
 * deliveries it was built from.
 *
 * A line the office added by hand becomes a new delivery, dated as typed; a line
 * removed takes its delivery with it. A refund or replacement raised against a
 * complaint is left alone: that credit belongs to the complaint, and is corrected
 * there.
 */
export async function saveInvoiceLines(invoiceId: string, lines: Array<{
  deliveryEntryId?: string | null;
  date: string; productId: string; quantity: number; rate: number; isReturn: boolean; isReplacement: boolean;
}>): Promise<DetailActionResult> {
  // Admins only. A bill line is a delivery, and a changed delivery changes what
  // the customer is charged; managers read bills, they do not rewrite them.
  await requireAdmin();
  try {
    const head = await db.invoice.findUnique({
      where: { id: invoiceId },
      select: { customerId: true, year: true, month: true, half: true },
    });
    if (!head) return { ok: false, error: "That bill is no longer here." };
    const { periodStart, periodEnd } = periodBounds(head.year, head.month, head.half);

    for (const l of lines) {
      const d = new Date(l.date);
      if (Number.isNaN(d.getTime())) return { ok: false, error: "One of the lines has no valid date." };
      if (d < periodStart || d > periodEnd) {
        return { ok: false, error: "A line is dated outside this bill's period. Put it on the bill for that period instead." };
      }
      if (!Number.isFinite(l.quantity) || l.quantity < 0) return { ok: false, error: "Quantities must be 0 or more." };
      if (!Number.isFinite(l.rate) || l.rate < 0) return { ok: false, error: "Rates must be 0 or more." };
    }

    const existing = await db.deliveryEntry.findMany({
      where: { customerId: head.customerId, date: { gte: periodStart, lte: periodEnd } },
      select: { id: true, complaintId: true },
    });
    const protectedIds = new Set(existing.filter((e) => e.complaintId).map((e) => e.id));
    const kept = new Set(lines.map((l) => l.deliveryEntryId).filter((id): id is string => !!id));

    await db.$transaction(async (tx) => {
      await lockInvoice(tx, invoiceId);
      // Gone from the bill: the delivery goes too — unless it is a complaint's
      // credit, which is not this page's to remove.
      const removed = existing.filter((e) => !kept.has(e.id) && !protectedIds.has(e.id)).map((e) => e.id);
      if (removed.length) await tx.deliveryEntry.deleteMany({ where: { id: { in: removed } } });

      for (const l of lines) {
        const qty = money(l.quantity);
        const rate = money(l.rate);
        if (l.deliveryEntryId && protectedIds.has(l.deliveryEntryId)) continue;
        if (l.deliveryEntryId) {
          await tx.deliveryEntry.update({
            where: { id: l.deliveryEntryId },
            data: {
              date: new Date(l.date),
              productId: l.productId,
              quantity: new Prisma.Decimal(qty),
              unitRate: new Prisma.Decimal(rate),
              isReturn: l.isReturn,
              isReplacement: l.isReplacement,
            },
          });
        } else {
          await tx.deliveryEntry.create({
            data: {
              customerId: head.customerId,
              date: new Date(l.date),
              productId: l.productId,
              quantity: new Prisma.Decimal(qty),
              unitRate: new Prisma.Decimal(rate),
              isReturn: l.isReturn,
              isReplacement: l.isReplacement,
              notes: "Added on the bill",
            },
          });
        }
      }
    });

    // Reads the deliveries back and rebuilds the bill from them, so what comes
    // back is exactly what the next person will see.
    const invoice = await getInvoiceDetail(invoiceId);
    for (const p of [
      `/billing/invoices/${invoiceId}`, "/billing/invoices", "/billing/payment-receiving",
      "/customers/rider-report", "/ledgers", "/payments/recovery", "/",
    ]) revalidatePath(p);
    if (!invoice) return { ok: false, error: "Invoice not found after saving." };
    return { ok: true, invoice };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save invoice." };
  }
}

// Mark (or unmark) a bill as "sent" from the Send-bills dialog. Durable + shared
// across the team — replaces the old browser-only checkbox that lost its state on
// refresh. Just a timestamp; the wa.me send itself still happens in WhatsApp.
export async function markBillSent(invoiceId: string, sent: boolean): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.invoice.update({ where: { id: invoiceId }, data: { billSentAt: sent ? new Date() : null } });
    revalidatePath("/billing/invoices");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update sent status." };
  }
}

export async function setInvoiceStatus(invoiceId: string, status: string): Promise<DetailActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.invoice.update({ where: { id: invoiceId }, data: { status: status as never } });
    const invoice = await getInvoiceDetail(invoiceId);
    revalidatePath(`/billing/invoices/${invoiceId}`);
    revalidatePath("/billing/invoices");
    if (!invoice) return { ok: false, error: "Invoice not found." };
    return { ok: true, invoice };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update status." };
  }
}

export async function deleteInvoice(invoiceId: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    const inv = await db.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, customerId: true, periodStart: true, periodEnd: true, year: true, month: true, half: true },
    });
    if (!inv) return { ok: false, error: "Invoice not found." };

    // Payments carry no invoiceId — they're matched to a customer by date — so
    // deleting an invoice removes its CHARGES while every payment against it
    // survives. computeCustomerOutstanding then subtracts payments from charges
    // that no longer exist and the customer flips into a fake credit: delete a
    // settled Rs 30,000 bill and Recovery, WhatsApp, Payment Receiving and the
    // dashboard all start reporting that the farm owes THEM Rs 30,000.
    //
    // So: refuse while money is attached to the period. Regenerating afterwards
    // rebuilds the charges from subscriptions and the balance comes back out
    // right; an invoice with payments has no such safe path.
    const bounds = periodBounds(inv.year, inv.month, inv.half);
    const paid = await db.payment.aggregate({
      _sum: { amount: true },
      where: {
        customerId: inv.customerId,
        date: { gte: inv.periodStart ?? bounds.periodStart, lte: inv.periodEnd ?? bounds.periodEnd },
      },
    });
    const paidAmt = Number(paid._sum.amount ?? 0);
    if (paidAmt > 0.005) {
      return {
        ok: false,
        error:
          `Can't delete — ₨${Math.round(paidAmt).toLocaleString("en-PK")} of payments are recorded against this period. ` +
          `Deleting the bill would leave those payments with nothing to offset and show the customer in credit. ` +
          `Edit the lines instead, or remove the payments first.`,
      };
    }

    await db.invoice.delete({ where: { id: invoiceId } });
    revalidatePath("/billing/invoices");
    revalidatePath("/payments/recovery");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete invoice." };
  }
}

// ── Last date (due date) ────────────────────────────────────────────────────────

// Per-bill override of the "Last date".
export async function setInvoiceDueDate(invoiceId: string, dueDateStr: string): Promise<DetailActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    const meta = await db.invoice.findUnique({ where: { id: invoiceId }, select: { year: true, month: true } });
    if (!meta) return { ok: false, error: "Invoice not found." };
    await db.invoice.update({ where: { id: invoiceId }, data: { dueDate: parseDueDate(dueDateStr, meta.year, meta.month) } });
    const invoice = await getInvoiceDetail(invoiceId);
    revalidatePath(`/billing/invoices/${invoiceId}`);
    revalidatePath("/billing/invoices");
    if (!invoice) return { ok: false, error: "Invoice not found." };
    return { ok: true, invoice };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to set last date." };
  }
}

// Set the same Last date on every bill in a period (the overview "apply to all").
export async function setPeriodDueDate(year: number, month: number, half: number, dueDateStr: string): Promise<{ ok: boolean; count: number; error?: string }> {
  await requireRole(FULL_ACCESS);
  try {
    const due = parseDueDate(dueDateStr, year, month);
    const res = await db.invoice.updateMany({ where: { year, month, half }, data: { dueDate: due } });
    revalidatePath("/billing/invoices");
    return { ok: true, count: res.count };
  } catch (e) {
    return { ok: false, count: 0, error: e instanceof Error ? e.message : "Failed to update last date." };
  }
}

// ── One-off discount ────────────────────────────────────────────────────────────

/**
 * Put a one-off allowance on a single bill.
 *
 * For a delivery that went wrong and cannot be put right any other way: rather
 * than inventing a return line that would misstate what was actually delivered,
 * the amount comes off this bill's total and nothing else. It is stored on the
 * invoice itself, so it applies to that fortnight alone and is never carried into
 * the next bill — the following period starts from the balance this one leaves
 * behind, discount already taken off.
 *
 * Setting it to 0 removes it.
 */
export async function setInvoiceDiscount(invoiceId: string, amount: number): Promise<DetailActionResult> {
  await requireAdmin(); // takes money off a bill — admins only, like editing its lines
  if (!Number.isFinite(amount)) return { ok: false, error: "Enter a discount amount." };
  if (amount < 0) return { ok: false, error: "A discount cannot be less than 0." };
  try {
    // Read it through getInvoiceDetail, which rebuilds the bill from the live
    // deliveries first. Checking the stored snapshot instead would refuse a
    // perfectly good discount on any bill that has not been opened since the
    // fortnight's deliveries were recorded.
    const current = await getInvoiceDetail(invoiceId);
    if (!current) return { ok: false, error: "That bill is no longer here." };

    // A discount is an allowance against THIS fortnight's charges. Letting it run
    // past them would hand the customer credit out of an old balance that nobody
    // on this page is looking at.
    const thisPeriod = current.deliveriesAmt - current.returnsAmt + current.deliveryCharge + current.otcAmt;
    if (money(amount) > money(thisPeriod) + 0.005) {
      return {
        ok: false,
        error: `The discount can't be more than this period's charges (₨${Math.round(thisPeriod).toLocaleString("en-PK")}).`,
      };
    }

    await db.invoice.update({ where: { id: invoiceId }, data: { discount: new Prisma.Decimal(money(amount)) } });
    const invoice = await getInvoiceDetail(invoiceId);
    for (const p of [
      `/billing/invoices/${invoiceId}`, "/billing/invoices", "/billing/payment-receiving",
      "/ledgers", "/payments/recovery", "/",
    ]) revalidatePath(p);
    if (!invoice) return { ok: false, error: "Invoice not found after saving." };
    return { ok: true, invoice };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to set the discount." };
  }
}
