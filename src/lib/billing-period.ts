import "server-only";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

// What a billing half actually billed, worked out live from the deliveries.
//
// One copy of the rule, because there are now three callers: the Payment Receiving
// page, the Customer Bills page it has to agree with, and the rider app's billing
// API. Each of those used to be free to drift, and twice already two of them were
// quoting different figures for the same fortnight.
//
// Everything here is derived, never read from a saved Invoice row. A saved bill is a
// snapshot taken when it was generated: Jamshed Khan's 16-30 September bill sat at
// Rs 4,799 from the 16th until somebody opened it on 2 October, when it became
// Rs 5,399. Deriving it means the figure is right the moment it is asked for.

/** "1–15 Oct 2026" — how a half is written wherever it is shown. */
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function halfLabel(year: number, month: number, half: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return half === 1
    ? `1–15 ${MONTH_SHORT[month - 1]} ${year}`
    : `16–${lastDay} ${MONTH_SHORT[month - 1]} ${year}`;
}

/** The half today falls in, in PKT. */
export function currentHalf(): { year: number; month: number; half: number } {
  const now = new Date(Date.now() + 5 * 60 * 60 * 1000);
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    half: now.getUTCDate() <= 15 ? 1 : 2,
  };
}

/** The half before the one given, crossing a month or a year as needed. */
export function previousHalf(year: number, month: number, half: number): { year: number; month: number; half: number } {
  if (half === 2) return { year, month, half: 1 };
  return month === 1 ? { year: year - 1, month: 12, half: 2 } : { year, month: month - 1, half: 2 };
}

const PKT_MS = 5 * 60 * 60 * 1000;
export function halfBounds(year: number, month: number, half: number): { start: Date; end: Date } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const startDay = half === 1 ? 1 : 16;
  const endDay = half === 1 ? 15 : lastDay;
  return {
    start: new Date(Date.UTC(year, month - 1, startDay) - PKT_MS),
    end: new Date(Date.UTC(year, month - 1, endDay + 1) - PKT_MS - 1),
  };
}

/**
 * The raw pieces a month's billing is worked out from, per customer and per half.
 *
 * Lifted out of getPageData so the previous month can be worked out by the same
 * rule rather than a second implementation of it. Everything comes live from the
 * deliveries, over the same day boundaries Customer Bills uses.
 */
export type MonthPieces = {
  delivered: Map<string, [number, number]>;
  returned: Map<string, [number, number]>;
  /** Whether anything was actually delivered: no delivery, no flat charge. */
  got: Map<string, [boolean, boolean]>;
  otc: Map<string, [number, number]>;
  discount: Map<string, [number, number]>;
};

/** A customer, as far as working out a delivery charge is concerned. */
export type Charged = { id: string; deliveryCharge: Prisma.Decimal; area: { defaultDeliveryCharge: Prisma.Decimal } | null };

export async function billedPieces(
  year: number,
  month: number,
  customerIds?: string[],
): Promise<MonthPieces> {
  const halves = [1, 2].map((h) => halfBounds(year, month, h));
  const scope = customerIds ? { customerId: { in: customerIds } } : null;

  const [entries, invoices, otcHalf1, otcHalf2] = await Promise.all([
    db.deliveryEntry.findMany({
      where: { date: { gte: halves[0].start, lte: halves[1].end }, ...(scope ?? {}) },
      select: { customerId: true, quantity: true, unitRate: true, isReturn: true, isReplacement: true, date: true },
    }),
    db.invoice.findMany({ where: { year, month, ...(scope ?? {}) }, select: { customerId: true, half: true, discount: true } }),
    db.otcSale.groupBy({
      by: ["customerId"],
      where: { customerType: "REGULAR", date: { gte: halves[0].start, lte: halves[0].end }, ...(scope ?? {}) },
      _sum: { totalAmount: true, paidAmount: true },
    }),
    db.otcSale.groupBy({
      by: ["customerId"],
      where: { customerType: "REGULAR", date: { gte: halves[1].start, lte: halves[1].end }, ...(scope ?? {}) },
      _sum: { totalAmount: true, paidAmount: true },
    }),
  ]);

  const delivered = new Map<string, [number, number]>();
  const returned = new Map<string, [number, number]>();
  const got = new Map<string, [boolean, boolean]>();
  for (const e of entries) {
    if (!e.customerId) continue;
    const slot = e.date <= halves[0].end ? 0 : 1;
    const amt = Number(e.quantity) * Number(e.unitRate);
    if (e.isReturn) {
      const cur = returned.get(e.customerId) ?? [0, 0];
      cur[slot] += amt;
      returned.set(e.customerId, cur);
    } else if (!e.isReplacement) {
      const cur = delivered.get(e.customerId) ?? [0, 0];
      cur[slot] += amt;
      delivered.set(e.customerId, cur);
      if (Number(e.quantity) > 0) {
        const g = got.get(e.customerId) ?? [false, false];
        g[slot] = true;
        got.set(e.customerId, g);
      }
    }
  }

  // Counter sales taken on credit are a charge on the fortnight they fall in,
  // exactly as the bill treats them.
  const otc = new Map<string, [number, number]>();
  for (const [slot, rows] of [otcHalf1, otcHalf2].entries()) {
    for (const row of rows) {
      if (!row.customerId) continue;
      const cur = otc.get(row.customerId) ?? [0, 0];
      cur[slot] = Number(row._sum.totalAmount ?? 0) - Number(row._sum.paidAmount ?? 0);
      otc.set(row.customerId, cur);
    }
  }

  // A one-off allowance lives on the bill it was given against.
  const discount = new Map<string, [number, number]>();
  for (const inv of invoices) {
    const cur = discount.get(inv.customerId) ?? [0, 0];
    cur[inv.half === 2 ? 1 : 0] += Number(inv.discount);
    discount.set(inv.customerId, cur);
  }

  return { delivered, returned, got, otc, discount };
}

/**
 * One fortnight's own charges for one customer.
 *
 * The month's delivery charge falls on the second fortnight only, and only when
 * the customer took a delivery in it.
 */
export function billedIn(p: MonthPieces, c: Charged, slot: 0 | 1): number {
  const fee = slot === 1 && (p.got.get(c.id)?.[1] ?? false)
    ? (Number(c.deliveryCharge) || Number(c.area?.defaultDeliveryCharge ?? 0))
    : 0;
  return (p.delivered.get(c.id)?.[slot] ?? 0)
    - (p.returned.get(c.id)?.[slot] ?? 0)
    + fee
    + (p.otc.get(c.id)?.[slot] ?? 0)
    - (p.discount.get(c.id)?.[slot] ?? 0);
}
