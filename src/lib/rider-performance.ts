import "server-only";
import { db } from "@/lib/db";
import { getDateRangePKT, todayPKTString } from "@/lib/pkt";

export type RiderCollectionRow = {
  riderId: string;
  riderName: string;
  expected: number;   // amount the rider was supposed to collect (billed) this month
  collected: number;  // amount actually collected this month
  pct: number;        // collection % achieved (0–100, capped for the bar)
  customers: number;  // how many customers this rider serves
};

export type RiderPerformanceData = {
  month: number;
  year: number;
  riders: RiderCollectionRow[];
  totalExpected: number;
  totalCollected: number;
  dbReady: boolean;
};

// Cash-collection performance per rider for the current PKT month:
//   expected  = Σ billed for the rider's customers (what they should collect)
//   collected = Σ payments received from those customers this month
//
// `expected` is the GROSS bill (carry-forward + deliveries − returns + delivery
// charge), not Invoice.totalDue. totalDue is net of payments received, so using
// it here moved the goalposts: every rupee collected raised `collected` and
// lowered `expected` at the same time, walking the percentage toward 100% on its
// own regardless of how much was actually outstanding.
export async function getRiderPerformance(): Promise<RiderPerformanceData> {
  const [year, month] = todayPKTString().split("-").map(Number);

  try {
    const monthRange = getDateRangePKT("month");

    const [riders, customers, invoices, payments] = await Promise.all([
      db.rider.findMany({
        where: { active: true },
        include: { user: { select: { name: true } } },
      }),
      // A rider serves whoever is on their SHIFT. Customer.riderId is not used
      // here: it is only set at creation, so when a shift is handed to another
      // rider it goes stale and credits the wrong rider (it also silently dropped
      // every customer whose riderId was null).
      db.customer.findMany({
        where: { status: { not: "DISABLED" } },
        select: { id: true, shift: { select: { riderId: true } } },
      }),
      db.invoice.findMany({
        where: { month, year },
        select: {
          customerId: true,
          half: true,
          prevBalance: true,
          deliveriesAmt: true,
          returnsAmt: true,
          deliveryCharge: true,
        },
      }),
      db.payment.findMany({
        where: { date: { gte: monthRange.gte, lte: monthRange.lte } },
        select: { customerId: true, riderId: true, amount: true },
      }),
    ]);

    // customerId → the rider currently running their shift
    const riderByCustomer = new Map<string, string>();
    const custCount = new Map<string, number>();
    for (const c of customers) {
      const riderId = c.shift?.riderId;
      if (!riderId) continue;
      riderByCustomer.set(c.id, riderId);
      custCount.set(riderId, (custCount.get(riderId) ?? 0) + 1);
    }

    // Collapse a customer's invoices for the month into ONE collectible figure:
    //   carry-forward at the START of the month + everything billed during it.
    //
    // Billing is half-monthly, so a customer can have two invoices per month and
    // half 2's prevBalance ALREADY CONTAINS half 1's charges (computePrevBalance
    // sums every earlier invoice). Adding both invoices' prevBalance therefore
    // counts the carry-forward twice and half 1's charges twice. So: take
    // prevBalance from the earliest half only, and sum the charges across halves.
    const perCustomer = new Map<string, { prev: number; prevHalf: number; charges: number }>();
    for (const inv of invoices) {
      const cur = perCustomer.get(inv.customerId) ?? { prev: 0, prevHalf: Infinity, charges: 0 };
      cur.charges +=
        Number(inv.deliveriesAmt) - Number(inv.returnsAmt) + Number(inv.deliveryCharge);
      if (inv.half < cur.prevHalf) {
        cur.prevHalf = inv.half;
        cur.prev = Number(inv.prevBalance);
      }
      perCustomer.set(inv.customerId, cur);
    }

    const expectedByRider = new Map<string, number>();
    for (const [customerId, v] of perCustomer) {
      const riderId = riderByCustomer.get(customerId);
      if (!riderId) continue;
      expectedByRider.set(riderId, (expectedByRider.get(riderId) ?? 0) + v.prev + v.charges);
    }

    const collectedByRider = new Map<string, number>();
    for (const p of payments) {
      if (!p.customerId) continue; // sample rider-cash payments aren't a customer collection
      // Credit the rider stamped on the payment (who actually collected it); fall
      // back to the shift's rider for legacy rows written before the stamp existed.
      const riderId = p.riderId ?? riderByCustomer.get(p.customerId);
      if (!riderId) continue;
      collectedByRider.set(riderId, (collectedByRider.get(riderId) ?? 0) + Number(p.amount));
    }

    const rows: RiderCollectionRow[] = riders.map((r) => {
      const expected = Math.round(expectedByRider.get(r.id) ?? 0);
      const collected = Math.round(collectedByRider.get(r.id) ?? 0);
      const pct = expected > 0 ? Math.round((collected / expected) * 100) : 0;
      return {
        riderId: r.id,
        riderName: r.user?.name ?? "Unnamed rider",
        expected,
        collected,
        pct,
        customers: custCount.get(r.id) ?? 0,
      };
    });

    // Show riders with the most to collect first; idle riders sink to the bottom.
    rows.sort((a, b) => b.expected - a.expected || b.collected - a.collected);

    return {
      month,
      year,
      riders: rows,
      totalExpected: rows.reduce((s, r) => s + r.expected, 0),
      totalCollected: rows.reduce((s, r) => s + r.collected, 0),
      dbReady: true,
    };
  } catch (e) {
    console.error("[getRiderPerformance]", e);
    return { month, year, riders: [], totalExpected: 0, totalCollected: 0, dbReady: false };
  }
}
