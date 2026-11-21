import "server-only";
import { db } from "@/lib/db";
import { dateRangeFromToPKT, pktNoonToUTC, toDateStrPKT, todayPKTString } from "@/lib/pkt";
import { shiftsOnRoad } from "@/lib/shift-lock";

// Glass bottles.
//
// On a shift that has gone over to bottles, a customer holds every bottle the
// rider leaves until it is taken back on a later visit. What went out is what
// the rider app records on each delivery — DeliveryEntry.bottles — never the
// litres: a customer can take 2 L in bottles and 1 L in a packet, and a stop
// booked as "Customer unresponsive" / "refused delivery" is billed but no milk
// went out, so it carries no bottles. NULL or 0 means packets. What came back is
// what the rider, or the office, recorded as returned. Nothing is stored for
// "owed": it is always
//
//   held = bottles given since the shift went to bottles
//        − bottles on milk sent back (a bottle that came home full)
//        − empties returned
//        + office corrections (opening counts, bottles written off)
//
// A skipped visit changes nothing — the customer still holds what they held.
// A visit with no milk but bottles handed back is a return with no delivery.
// Both fall out of the arithmetic without a special case.

export type BottleCustomer = {
  customerId: string;
  name: string;
  customerCode: string;
  phone: string;
  address: string | null;
  area: string | null;
  shiftId: string;
  shiftName: string;
  riderId: string | null;
  riderName: string | null;
  status: string;
  /** Bottles given in the window. */
  given: number;
  /** Empties returned in the window. */
  returned: number;
  /** Visits with a delivery in the window. */
  visits: number;
  /** Bottles the customer holds at the end of the window. */
  held: number;
};

export type BottleLedgerRow = {
  date: string;
  /** Bottles given that day. */
  given: number;
  /** Litres of milk delivered that day, bottles and packets together. */
  litres: number;
  milkBack: number;
  returned: number;
  adjusted: number;
  reason: string | null;
  by: string | null;
  /** Held after this day. */
  held: number;
};

export type BottleShift = { id: string; name: string; riderId: string | null; riderName: string | null; bottlesSince: string | null; customers: number; /** Loaded today and not finished: cannot be switched now. */ onRoadSince: string | null };

/** The shifts, and from which day each one counts bottles (null = packets). */
export async function bottleShifts(): Promise<BottleShift[]> {
  const [shifts, onRoad] = await Promise.all([
    db.shift.findMany({
      where: { name: { notIn: ["Samples", "Retail Marts Shift"] } },
      select: { id: true, name: true, riderId: true, bottlesSince: true, rider: { select: { user: { select: { name: true } } } }, _count: { select: { customers: { where: { status: { not: "DISABLED" } } } } } },
      orderBy: { name: "asc" },
    }),
    shiftsOnRoad(),
  ]);
  return shifts.map((s) => ({
    id: s.id, name: s.name, riderId: s.riderId, riderName: s.rider?.user.name ?? null,
    bottlesSince: s.bottlesSince ? toDateStrPKT(s.bottlesSince) : null, customers: s._count.customers,
    onRoadSince: onRoad.get(s.id)?.since ?? null,
  }));
}

type Raw = {
  customers: { id: string; name: string; customerCode: string; phone: string; address: string | null; status: string; shiftId: string; area: { name: string } | null }[];
  shiftOf: Map<string, { name: string; riderId: string | null; riderName: string | null; since: Date }>;
  /** `litres` counts LITER products only (for display); `bottles` is what counts. */
  deliveries: { customerId: string; date: Date; litres: number; bottles: number; isReturn: boolean }[];
  returns: { customerId: string; date: Date; returned: number; by: string | null }[];
  adjustments: { customerId: string; date: Date; bottles: number; reason: string; by: string | null }[];
};

/**
 * Everything bottles are worked out from, for the customers of the bottle shifts
 * (or one customer), from each shift's switch-over day through `upTo`.
 */
async function load(upTo: string, customerId?: string): Promise<Raw> {
  const shifts = await db.shift.findMany({
    where: { bottlesSince: { not: null } },
    select: { id: true, name: true, riderId: true, bottlesSince: true, rider: { select: { user: { select: { name: true } } } } },
  });
  const shiftOf = new Map(shifts.map((s) => [s.id, { name: s.name, riderId: s.riderId, riderName: s.rider?.user.name ?? null, since: s.bottlesSince! }]));
  const customers = await db.customer.findMany({
    where: { shiftId: { in: [...shiftOf.keys()] }, ...(customerId ? { id: customerId } : { status: { not: "DISABLED" } }) },
    select: { id: true, name: true, customerCode: true, phone: true, address: true, status: true, shiftId: true, area: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
  const ids = customers.map((c) => c.id);
  // bottlesSince is stored at noon of its day, but the rider app stamps a delivery
  // with the moment it was made — most go out before noon. So the switch-over is
  // the whole DAY: from midnight (PKT) of bottlesSince, compared by day below.
  const earliestNoon = shifts.reduce((m, s) => (s.bottlesSince! < m ? s.bottlesSince! : m), new Date("2999-01-01"));
  const earliest = dateRangeFromToPKT(toDateStrPKT(earliestNoon), toDateStrPKT(earliestNoon)).gte;
  const end = dateRangeFromToPKT(upTo, upTo).lte;
  if (!ids.length) return { customers: [], shiftOf, deliveries: [], returns: [], adjustments: [] };
  const [deliveries, returns, adjustments] = await Promise.all([
    db.deliveryEntry.findMany({
      where: {
        customerId: { in: ids }, date: { gte: earliest, lte: end }, isReplacement: false, complaintId: null,
        OR: [{ bottles: { gt: 0 } }, { product: { unit: "LITER" } }],
      },
      select: { customerId: true, date: true, quantity: true, bottles: true, isReturn: true, product: { select: { unit: true } } },
    }),
    db.bottleReturn.findMany({ where: { customerId: { in: ids }, date: { lte: end } }, select: { customerId: true, date: true, returned: true, enteredByName: true, source: true, rider: { select: { user: { select: { name: true } } } } } }),
    db.bottleAdjustment.findMany({ where: { customerId: { in: ids }, date: { lte: end } }, select: { customerId: true, date: true, bottles: true, reason: true, enteredByName: true } }),
  ]);
  // A delivery dated before the customer's own shift switched is a packet.
  const since = new Map(customers.map((c) => [c.id, toDateStrPKT(shiftOf.get(c.shiftId!)!.since)]));
  return {
    customers: customers as Raw["customers"],
    shiftOf,
    deliveries: deliveries.filter((d) => toDateStrPKT(d.date) >= since.get(d.customerId)!).map((d) => ({
      customerId: d.customerId, date: d.date, isReturn: d.isReturn,
      litres: d.product.unit === "LITER" ? Number(d.quantity) : 0,
      bottles: Math.max(0, d.bottles ?? 0),
    })),
    returns: returns.map((r) => ({ customerId: r.customerId, date: r.date, returned: r.returned, by: r.source === "rider" ? r.rider?.user.name ?? "Rider" : r.enteredByName })),
    adjustments: adjustments.map((a) => ({ customerId: a.customerId, date: a.date, bottles: a.bottles, reason: a.reason, by: a.enteredByName })),
  };
}

/** Every customer on a bottle shift: what they took and gave back in [from, to], and what they hold at `to`. */
export async function bottleCustomers(from: string, to: string): Promise<BottleCustomer[]> {
  const raw = await load(to);
  const lo = dateRangeFromToPKT(from, from).gte;
  const agg = new Map<string, { given: number; returned: number; visits: number; held: number }>();
  const at = (id: string) => { let a = agg.get(id); if (!a) { a = { given: 0, returned: 0, visits: 0, held: 0 }; agg.set(id, a); } return a; };
  const visitDays = new Map<string, Set<string>>();
  for (const d of raw.deliveries) {
    const a = at(d.customerId);
    a.held += d.isReturn ? -d.bottles : d.bottles;
    if (d.date >= lo && !d.isReturn) {
      a.given += d.bottles;
      const days = visitDays.get(d.customerId) ?? new Set<string>();
      days.add(toDateStrPKT(d.date));
      visitDays.set(d.customerId, days);
    }
  }
  for (const r of raw.returns) { const a = at(r.customerId); a.held -= r.returned; if (r.date >= lo) a.returned += r.returned; }
  for (const x of raw.adjustments) at(x.customerId).held += x.bottles;
  return raw.customers.map((c) => {
    const a = agg.get(c.id) ?? { given: 0, returned: 0, visits: 0, held: 0 };
    const sh = raw.shiftOf.get(c.shiftId)!;
    return {
      customerId: c.id, name: c.name, customerCode: c.customerCode, phone: c.phone, address: c.address, area: c.area?.name ?? null,
      shiftId: c.shiftId, shiftName: sh.name, riderId: sh.riderId, riderName: sh.riderName, status: c.status,
      given: Math.round(a.given), returned: a.returned, visits: visitDays.get(c.id)?.size ?? 0, held: Math.round(a.held),
    };
  });
}

/** One customer's bottle history, day by day, newest first, with the running count held. */
export async function bottleLedger(customerId: string): Promise<{ since: string | null; rows: BottleLedgerRow[]; held: number }> {
  const raw = await load(todayPKTString(), customerId);
  const c = raw.customers[0];
  if (!c) return { since: null, rows: [], held: 0 };
  const days = new Map<string, BottleLedgerRow>();
  const day = (d: Date) => { const k = toDateStrPKT(d); let r = days.get(k); if (!r) { r = { date: k, given: 0, litres: 0, milkBack: 0, returned: 0, adjusted: 0, reason: null, by: null, held: 0 }; days.set(k, r); } return r; };
  for (const d of raw.deliveries) { const r = day(d.date); if (d.isReturn) r.milkBack += d.bottles; else { r.given += d.bottles; r.litres += d.litres; } }
  for (const x of raw.returns) { const r = day(x.date); r.returned += x.returned; r.by = x.by ?? r.by; }
  for (const x of raw.adjustments) { const r = day(x.date); r.adjusted += x.bottles; r.reason = [r.reason, x.reason].filter(Boolean).join("; ") || null; r.by = x.by ?? r.by; }
  const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  let held = 0;
  for (const r of rows) { r.litres = Math.round(r.litres * 10) / 10; held += r.given - r.milkBack - r.returned + r.adjusted; r.held = held; }
  return { since: toDateStrPKT(raw.shiftOf.get(c.shiftId)!.since), rows: rows.reverse(), held };
}

/** The day key a return or adjustment is stored under. */
export const bottleDay = (dateStr: string) => pktNoonToUTC(dateStr);
