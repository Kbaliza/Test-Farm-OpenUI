import "server-only";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

export type BalanceCutoff = {
  /** The flat delivery-charge fee is cut off by billing period (year/month). */
  year: number;
  month: number;
  /** Deliveries, payments and OTC sales are cut off by their actual date. */
  asOfDate: Date;
};

// Net value actually delivered to each customer, from real DeliveryEntry rows
// (written by the rider app) — the single source of truth for what was delivered.
//   Σ  isReplacement → 0 (free replacement)
//      isReturn      → −(quantity × unitRate)
//      otherwise     → +(quantity × unitRate)
// Bounded by date (`lt` and/or `lte`) when given. DeliveryEntry has no stored
// amount column, so the quantity×rate product is summed in SQL.
/**
 * Who to total up: a specific list, or every customer who is not disabled.
 *
 * LIVE_CUSTOMERS exists for the Customer Bills list, which wants exactly the
 * customers it is already showing. Naming them individually meant sending ~2,200
 * ids down the wire and having Postgres match against that list — measured at
 * 1817ms against 770ms for the same rows selected by a join. Worse, it could only
 * be built AFTER the customer query had come back, which forced this call into a
 * later round of queries instead of running alongside them.
 *
 * The two are the same set by construction: the caller's list IS the customers
 * whose status is not DISABLED.
 */
export const LIVE_CUSTOMERS = "live-customers" as const;
export type CustomerScope = string[] | typeof LIVE_CUSTOMERS;

export async function deliveredValueByCustomer(
  scope: CustomerScope,
  bound?: { gte?: Date; lt?: Date; lte?: Date }
): Promise<Map<string, number>> {
  if (Array.isArray(scope) && !scope.length) return new Map();
  const conds: Prisma.Sql[] = [
    Array.isArray(scope)
      ? Prisma.sql`"customerId" IN (${Prisma.join(scope)})`
      : Prisma.sql`EXISTS (SELECT 1 FROM "Customer" c WHERE c.id = "DeliveryEntry"."customerId" AND c.status <> 'DISABLED')`,
  ];
  if (bound?.gte) conds.push(Prisma.sql`"date" >= ${bound.gte}`);
  if (bound?.lt) conds.push(Prisma.sql`"date" < ${bound.lt}`);
  if (bound?.lte) conds.push(Prisma.sql`"date" <= ${bound.lte}`);
  const where = Prisma.join(conds, " AND ");

  const rows = await db.$queryRaw<{ customerId: string; net: number | null }[]>`
    SELECT "customerId", SUM(
      CASE WHEN "isReplacement" THEN 0
           WHEN "isReturn" THEN -("quantity" * "unitRate")
           ELSE "quantity" * "unitRate" END
    )::float8 AS net
    FROM "DeliveryEntry"
    WHERE ${where}
    GROUP BY "customerId"
  `;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.customerId, Number(r.net ?? 0));
  return m;
}

// The single source of truth for "what does this customer currently owe" —
// replaces what used to be three separately hand-written copies (Recovery,
// WhatsApp reminders, the dashboard KPI) that drifted out of sync.
//
// balance = openingBalance
//         + Σ(ACTUAL deliveries − returns, from DeliveryEntry, dated ≤ cutoff)
//         + Σ(delivery-charge fee on generated invoices, up to the cutoff period)
//         + Σ(OTC sales sold on credit, dated ≤ cutoff)
//         − Σ(payments, dated ≤ cutoff)
//
// Deliveries come from real DeliveryEntry rows, NOT the subscription plan and NOT
// Invoice.deliveriesAmt — a customer only owes for what was actually delivered.
// (Invoices are documents generated from the same DeliveryEntry rows; only their
// flat deliveryCharge fee is read here, never their deliveriesAmt, so nothing is
// double-counted.)
//
// Omit `cutoff` for the live, all-time balance (the common case — Recovery,
// WhatsApp, Payment Receiving). Pass it for a balance "as of" a specific
// month-end (the dashboard's month-over-month KPI).
export async function computeCustomerOutstanding(
  scope: CustomerScope,
  cutoff?: BalanceCutoff
): Promise<Map<string, number>> {
  if (Array.isArray(scope) && !scope.length) return new Map();
  // Same set either way — see LIVE_CUSTOMERS. The relation form lets the Customer
  // Bills list ask for this alongside its other queries instead of after them: with
  // the id list it could not even be started until the customer query had returned,
  // and the round cost 1.4-2.9s on its own.
  const idScope: Prisma.OtcSaleWhereInput & Prisma.PaymentWhereInput & Prisma.InvoiceWhereInput =
    Array.isArray(scope)
      ? { customerId: { in: scope } }
      : { customer: { status: { not: "DISABLED" } } };
  const custScope: Prisma.CustomerWhereInput = Array.isArray(scope)
    ? { id: { in: scope } }
    : { status: { not: "DISABLED" } };

  const [customers, deliveredMap, invoiceFeeGroups, otcCreditGroups, paymentGroups] = await Promise.all([
    db.customer.findMany({ where: custScope, select: { id: true, openingBalance: true } }),
    deliveredValueByCustomer(scope, cutoff ? { lte: cutoff.asOfDate } : undefined),
    db.invoice.groupBy({
      by: ["customerId"],
      where: {
        ...idScope,
        ...(cutoff ? { OR: [{ year: { lt: cutoff.year } }, { year: cutoff.year, month: { lte: cutoff.month } }] } : {}),
      },
      // The flat fee is a charge; a one-off allowance on a bill is the opposite,
      // and has to come off here too or the customer's balance would disagree
      // with the bill they were handed.
      _sum: { deliveryCharge: true, discount: true },
    }),
    // A REGULAR customer is billed the UNPAID remainder of every counter sale:
    // totalAmount − paidAmount. Fully-paid sales contribute 0, fully-credit the
    // whole amount, partials the leftover — so no paymentStatus filter is needed.
    db.otcSale.groupBy({
      by: ["customerId"],
      where: {
        ...idScope,
        ...(cutoff ? { date: { lte: cutoff.asOfDate } } : {}),
      },
      _sum: { totalAmount: true, paidAmount: true },
    }),
    db.payment.groupBy({
      by: ["customerId"],
      where: {
        ...idScope,
        ...(cutoff ? { date: { lte: cutoff.asOfDate } } : {}),
      },
      _sum: { amount: true },
    }),
  ]);

  const openingMap = new Map(customers.map((c) => [c.id, Number(c.openingBalance)]));

  const feeMap = new Map<string, number>();
  for (const g of invoiceFeeGroups) {
    feeMap.set(g.customerId, Number(g._sum.deliveryCharge ?? 0) - Number(g._sum.discount ?? 0));
  }

  const otcMap = new Map<string, number>();
  for (const g of otcCreditGroups) {
    if (!g.customerId) continue;
    otcMap.set(g.customerId, Number(g._sum.totalAmount ?? 0) - Number(g._sum.paidAmount ?? 0));
  }

  const paidMap = new Map<string, number>();
  for (const g of paymentGroups) {
    if (!g.customerId) continue;
    paidMap.set(g.customerId, Number(g._sum.amount ?? 0));
  }

  // Keyed by the ids that were ASKED for when a list was given, so a caller that
  // names an id which no longer exists still finds a 0 rather than nothing — that
  // is how this behaved before and callers rely on it. For LIVE_CUSTOMERS the set
  // is whatever the customer query returned, which is the same thing.
  const outIds = Array.isArray(scope) ? scope : customers.map((c) => c.id);

  const out = new Map<string, number>();
  for (const id of outIds) {
    out.set(
      id,
      (openingMap.get(id) ?? 0) +
        (deliveredMap.get(id) ?? 0) +
        (feeMap.get(id) ?? 0) +
        (otcMap.get(id) ?? 0) -
        (paidMap.get(id) ?? 0)
    );
  }
  return out;
}
