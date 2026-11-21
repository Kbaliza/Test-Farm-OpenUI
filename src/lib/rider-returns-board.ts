import "server-only";

// The Rider Item Returns board and the retail centre's day-end leftover, worked
// out from the records. Kept out of the page's server actions so the day-end
// close can use exactly the same figures without anyone signed in — and so
// these, which do not check who is asking, are never callable from a browser.

import { db } from "@/lib/db";
import type { Unit } from "@/lib/units";
import { dateRangeFromToPKT, dateStrRangePKT, toDateStrPKT, todayPKTString } from "@/lib/pkt";
import { SENT_TO_RETAIL } from "@/lib/packaging-stock";
import { END_OF_SHIFT_RETURN_REASON, isLoadShortfall, routeLoads } from "@/lib/rider-stock";
import { getOnHandByProduct, heldCommitmentWhere, confirmedLoadsByRoute } from "@/lib/inventory-onhand";
import { getStockResetAt } from "@/lib/stock-reset";
import { isEggName } from "@/lib/product-names";
import { isMissingReason } from "@/lib/missing";
import { sampleDeliveries } from "@/lib/sample-deliveries";

const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export type ReturnProduct = { id: string; name: string; unit: Unit; retailOnly: boolean };

/** One rider's day on the board. */
export type RiderReturnRow = {
  key: string;            // `${date}:${riderId}`
  date: string;           // "YYYY-MM-DD" PKT
  riderId: string | null;
  riderName: string;
  /** What he took out across all his rounds: the loads plus the spare stock. */
  got: Record<string, number>;
  /** What reached the customers. */
  delivered: Record<string, number>;
  /** Charged, but never handed over: the rider found nobody in, or the customer
   *  turned it away. The bill stands and the milk comes back on the van, so it
   *  belongs with what is expected back, not with what was delivered. */
  chargedBack: Record<string, number>;
  /** Per product id. `returned` is everything that came back — the app's
   *  end-of-shift returns plus spare stock received back. */
  returned: Record<string, number>;
  /**
   * What the RIDER said he wasted on the road, from the app.
   *
   * He records two separate things at the end of his round: what he is handing
   * back, and what was lost on the way. With 14 L left and 4 L spilled he enters
   * return 10 and wastage 4 — so the 4 L is NOT inside `returned`, and it is not
   * missing either. He has accounted for it.
   *
   * This board never read it, so it fell straight into `missing`: a rider who
   * declared everything honestly still showed up 4 L short, every day.
   *
   * Not the same thing as `waste` below, which is the REVIEWER's decision about
   * milk that did come back and turned out to be spoilt.
   */
  riderWasted: Record<string, number>;
  /** What the day-end close wrote off as missing for this rider-day — it is out
   *  of stock, but it is still missing, so it does not count as his wastage. */
  writtenOff: Record<string, number>;
  /** The reviewer's split of what was handed back: usable stock, and spoilt. */
  stock: Record<string, number>;
  waste: Record<string, number>;
  /** Part of the app's return the reviewer never received. */
  reviewMissing: Record<string, number>;
  /** Still out with the rider — spare stock nobody has received back yet. */
  extrasOut: Record<string, number>;
  reviewed: boolean;
  reviewedByName: string | null;
  /** Nothing came back and nothing is out: there is nothing to review. */
  empty: boolean;
};

/** Where a product stands now, and how much of that came back from the riders. */
export type InventoryLevel = {
  productId: string;
  name: string;
  unit: Unit;
  onHand: number;
  /** Accepted back into stock from the returns in these dates. */
  fromReturns: number;
};

export type ReturnsBoard = {
  from: string;
  to: string;
  rows: RiderReturnRow[];
  products: ReturnProduct[];
  levels: InventoryLevel[];
  dbReady: boolean;
  error?: string;
};

/**
 * The board: every rider who has something to hand back, in a date range.
 *
 * No sign-in check here — getReturnsBoard (the page's server action) makes it,
 * and the day-end close (src/lib/day-close.ts) runs with no one signed in.
 */
type Handover = { date: string; got: Map<string, Map<string, number>> };

/**
 * Rounds that changed hands after they were loaded, and who carried which part.
 *
 * The app charges a round's load to the rider who confirmed loading it. When the
 * office then gives the shift to someone else, the milk goes with the round but the
 * load stays on the first rider: on 18 October Zeeshan Khattak confirmed loading
 * Islamabad Suzuki at 7:49 and the shift went to Ahsan the same minute; Ahsan
 * delivered all of it, so Zeeshan read 76 L of cow milk "missing" and Ahsan 76 L
 * "extra". Four rounds since 1 October, the same way.
 *
 * Here a round loaded by one rider is split by what each rider actually did on it —
 * deliveries to its customers that day, returns and road wastage stamped with it:
 * every rider but the one who finished the round is counted for exactly what he
 * accounted for, and the one who finished it (latest delivery) gets the rest of the
 * load, so any real shortfall or surplus stays with whoever had the van at the end.
 * A round only one rider worked on is not touched.
 */
async function roundHandovers(
  handed: { date: Date; productId: string; quantity: unknown; riderId: string | null; reference: string | null }[],
  returns: { productId: string; quantity: unknown; riderId: string | null; reference: string | null }[],
  wasted: { productId: string; quantity: unknown; riderId: string | null; reason: string | null; reference: string | null }[],
  deliveries: { date: Date; productId: string; quantity: unknown; isReturn: boolean; isReplacement: boolean; riderId: string | null; complaintId: string | null; customerId: string; createdAt: Date; customer: { shiftId: string | null } | null }[],
  skippedStops: Set<string>,
  routes: { id: string; shiftId: string; date: Date }[],
): Promise<Map<string, Handover>> {
  const out = new Map<string, Handover>();
  const loads = new Map<string, { loader: string | null; mixed: boolean; date: string; qty: Map<string, number> }>();
  for (const m of handed) {
    if (!m.riderId || !m.reference) continue;
    const l = loads.get(m.reference) ?? { loader: m.riderId, mixed: false, date: toDateStrPKT(m.date), qty: new Map<string, number>() };
    if (l.loader !== m.riderId) l.mixed = true; // two riders both confirmed: each keeps his own
    l.qty.set(m.productId, r3((l.qty.get(m.productId) ?? 0) + Number(m.quantity)));
    loads.set(m.reference, l);
  }
  if (!loads.size) return out;
  const routeIds = [...loads.keys()];
  const stops = await db.routeStop.findMany({ where: { routeId: { in: routeIds } }, select: { routeId: true, customerId: true } });
  const routeOf = new Map<string, string>();
  const routeById = new Map(routes.map((r) => [r.id, r] as const));
  for (const st of stops) {
    const rt = routeById.get(st.routeId);
    const day = loads.get(st.routeId)?.date ?? (rt ? toDateStrPKT(rt.date) : null);
    if (day) routeOf.set(`${day}:${st.customerId}`, st.routeId);
  }
  // What each rider accounted for on each round, and when he last delivered on it.
  const acc = new Map<string, Map<string, Map<string, number>>>();
  const lastAt = new Map<string, Map<string, number>>();
  const credit = (routeId: string, riderId: string, pid: string, q: number) => {
    const byRider = acc.get(routeId) ?? acc.set(routeId, new Map()).get(routeId)!;
    const byProduct = byRider.get(riderId) ?? byRider.set(riderId, new Map()).get(riderId)!;
    byProduct.set(pid, r3((byProduct.get(pid) ?? 0) + q));
  };
  for (const d of deliveries) {
    if (d.isReturn || d.isReplacement || d.complaintId || !d.riderId) continue;
    const day = toDateStrPKT(d.date);
    const routeId = routeOf.get(`${day}:${d.customerId}`);
    if (!routeId || !loads.has(routeId)) continue;
    // A charged stop he skipped comes back as a return — counted there, not here.
    if (d.customer?.shiftId && skippedStops.has(`${day}:${d.customer.shiftId}:${d.customerId}`)) continue;
    credit(routeId, d.riderId, d.productId, Number(d.quantity));
    const t = lastAt.get(routeId) ?? lastAt.set(routeId, new Map()).get(routeId)!;
    t.set(d.riderId, Math.max(t.get(d.riderId) ?? 0, d.createdAt.getTime()));
  }
  for (const m of returns) if (m.riderId && m.reference && loads.has(m.reference)) credit(m.reference, m.riderId, m.productId, Number(m.quantity));
  for (const m of wasted) {
    if (!m.riderId || !m.reference || !loads.has(m.reference)) continue;
    if (isLoadShortfall(m.reason) || isMissingReason(m.reason)) continue;
    credit(m.reference, m.riderId, m.productId, Number(m.quantity));
  }
  for (const [routeId, l] of loads) {
    const byRider = acc.get(routeId);
    if (l.mixed || !l.loader || !byRider) continue;
    const others = [...byRider.keys()].filter((r) => r !== l.loader);
    if (!others.length) continue; // only the loader worked it
    const times = lastAt.get(routeId) ?? new Map<string, number>();
    const finisher = [...times.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? l.loader;
    const got = new Map<string, Map<string, number>>();
    const riders = new Set([l.loader, ...byRider.keys()]);
    for (const pid of l.qty.keys()) {
      let given = 0;
      for (const r of riders) {
        if (r === finisher) continue;
        const q = Math.min(byRider.get(r)?.get(pid) ?? 0, Math.max(0, (l.qty.get(pid) ?? 0) - given));
        given = r3(given + q);
        (got.get(r) ?? got.set(r, new Map()).get(r)!).set(pid, q);
      }
      (got.get(finisher) ?? got.set(finisher, new Map()).get(finisher)!).set(pid, r3(Math.max(0, (l.qty.get(pid) ?? 0) - given)));
    }
    out.set(routeId, { date: l.date, got });
  }
  return out;
}

export async function computeReturnsBoard(from: string, to: string, riderId?: string | null): Promise<ReturnsBoard> {
  const blank: ReturnsBoard = { from, to, rows: [], products: [], levels: [], dbReady: true };
  if (!isValidDate(from) || !isValidDate(to)) return { ...blank, error: "Choose a valid date range." };
  const [lo, hi] = from <= to ? [from, to] : [to, from];

  try {
    const range = dateRangeFromToPKT(lo, hi);
    const [products, shifts, returnRows, riderWasteRows, handedRows, extras, routes, reviews, skipRows, routeItems, deliveries, onHand] = await Promise.all([
      db.product.findMany({ where: { active: true }, select: { id: true, name: true, unit: true, retailOnly: true }, orderBy: { name: "asc" } }),
      db.shift.findMany({ select: { id: true, name: true, riderId: true, rider: { select: { user: { select: { name: true } } } } } }),
      db.inventoryMovement.findMany({
        where: { type: "RETURNED", reason: END_OF_SHIFT_RETURN_REASON, date: range },
        select: { id: true, date: true, productId: true, quantity: true, riderId: true, reference: true },
      }),
      // What the rider declared wasted on the road, written by the app itself.
      //
      // Told apart from the office's own write-offs by what the app does NOT set:
      // it stamps the rider and nothing else, so `stage` and `enteredById` are both
      // empty. Every wastage entered on the Waste Entry page carries a stage, and
      // the reviewer's own decision carries the person who made it — so this picks
      // up the rider's rows and only his.
      db.inventoryMovement.findMany({
        where: {
          type: "WASTAGE", date: range,
          riderId: { not: null }, stage: null, enteredById: null,
        },
        select: { id: true, date: true, productId: true, quantity: true, riderId: true, reason: true, reference: true },
      }),
      // What the rider confirmed he loaded in the app. This is the fact; the
      // round's quantities are the office's plan, and riders routinely take more
      // — 245 eggs against a plan of 95, on one day this was checked.
      db.inventoryMovement.findMany({
        where: { type: "HANDED_OVER", date: range, riderId: { not: null } },
        select: { date: true, productId: true, quantity: true, riderId: true, reference: true },
      }),
      db.riderExtraItem.findMany({
        where: { date: range },
        select: { id: true, date: true, shiftId: true, riderId: true, productId: true, givenQty: true, returnedQty: true, status: true },
      }),
      db.route.findMany({
        where: { date: range },
        select: { id: true, shiftId: true, date: true, startedAt: true, completedAt: true },
      }),
      db.riderReturnReview.findMany({
        where: { date: range },
        select: { date: true, riderId: true, reviewedByName: true, lines: { select: { productId: true, returnedQty: true, stockQty: true, wasteQty: true, missingQty: true } } },
      }),
      // Stops the rider marked skipped, with the reason. A skipped stop can still
      // carry a charge — "customer unresponsive" and "customer refused delivery"
      // both bill the customer — and that milk is on its way back.
      // Only stops the rider actually marked skipped — the same test the rider
      // report uses. A stop still sitting PENDING is not a skip; it is a stop
      // nobody has reported on yet, and its delivery counts as one.
      db.routeStop.findMany({
        where: { route: { date: range }, status: { contains: "SKIP", mode: "insensitive" } },
        select: { customerId: true, route: { select: { date: true, shiftId: true } } },
      }),
      db.routeStopItem.findMany({
        where: { routeStop: { route: { date: range } } },
        select: {
          productId: true, plannedQty: true,
          routeStop: { select: { route: { select: { id: true, date: true, shiftId: true, status: true } } } },
        },
      }),
      db.deliveryEntry.findMany({
        where: { date: range },
        select: {
          date: true, productId: true, quantity: true, isReturn: true, isReplacement: true, riderId: true,
          complaintId: true, customerId: true, createdAt: true, customer: { select: { shiftId: true } },
        },
      }),
      // What is in stock right now, so the page can show what the returns fed back.
      getOnHandByProduct(),
    ]);

    // Every stop the rider did not deliver, keyed by the day, shift and customer.
    const skippedStops = new Set(
      skipRows.map((s) => `${toDateStrPKT(s.route.date)}:${s.route.shiftId}:${s.customerId}`),
    );

    // A return or a spillage belongs to the ROUND it came off, not to the day the
    // rider pressed the button. Wajid Khan closed a 6 October round on the 10th:
    // its 15 L return landed on the 10th, where it read as 15 L more than he had
    // taken, while the 6th still showed it missing. The app stamps these rows with
    // the route, so they are placed on the route's day — rows dated outside the
    // range but belonging to a round inside it are fetched, and rows dated inside
    // the range but belonging to a round outside it are left out.
    const routeDay = new Map(routes.map((r) => [r.id, toDateStrPKT(r.date)] as const));
    const late = await db.inventoryMovement.findMany({
      where: {
        type: { in: ["RETURNED", "WASTAGE"] }, reference: { in: routes.map((r) => r.id) }, NOT: { date: range },
      },
      select: { id: true, type: true, date: true, productId: true, quantity: true, riderId: true, reason: true, reference: true, stage: true, enteredById: true },
    });
    for (const m of late) {
      if (m.type === "RETURNED" && m.reason === END_OF_SHIFT_RETURN_REASON) returnRows.push(m);
      else if (m.type === "WASTAGE" && m.riderId && !m.stage && !m.enteredById) riderWasteRows.push(m);
    }
    const strayRefs = [...new Set([...returnRows, ...riderWasteRows].map((m) => m.reference).filter((x): x is string => !!x && !routeDay.has(x)))];
    if (strayRefs.length) {
      for (const r of await db.route.findMany({ where: { id: { in: strayRefs } }, select: { id: true, date: true } })) routeDay.set(r.id, toDateStrPKT(r.date));
    }
    const dayOf = (m: { date: Date; reference: string | null }) => (m.reference && routeDay.get(m.reference)) || toDateStrPKT(m.date);
    const inRange = (day: string) => day >= lo && day <= hi;

    const shiftsOfRider = new Map<string, { id: string; name: string }[]>();
    for (const s of shifts) {
      if (!s.riderId) continue;
      shiftsOfRider.set(s.riderId, [...(shiftsOfRider.get(s.riderId) ?? []), { id: s.id, name: s.name }]);
    }
    const shiftById = new Map(shifts.map((s) => [s.id, s] as const));

    const riderName = new Map<string, string>();
    for (const s of shifts) if (s.riderId) riderName.set(s.riderId, s.rider?.user?.name ?? "Rider");

    const rows = new Map<string, RiderReturnRow>();
    /** The rider's row for that day. Work with no rider on it lands in one bucket. */
    const rowFor = (date: string, riderId: string | null): RiderReturnRow => {
      const key = `${date}:${riderId ?? "norider"}`;
      if (!rows.has(key)) {
        rows.set(key, {
          key, date, riderId,
          riderName: riderId ? riderName.get(riderId) ?? "Rider" : "No rider",
          got: {}, delivered: {}, chargedBack: {}, returned: {}, riderWasted: {}, writtenOff: {}, stock: {}, waste: {}, reviewMissing: {}, extrasOut: {},
          reviewed: false, reviewedByName: null, empty: true,
        });
      }
      return rows.get(key)!;
    };
    const riderOfShift = (shiftId: string) => shiftById.get(shiftId)?.riderId ?? null;
    const add = (m: Record<string, number>, pid: string, q: number) => { m[pid] = r3((m[pid] ?? 0) + q); };

    // What the app said came back. It carries the rider, which is all this needs.
    for (const m of returnRows) {
      if (!m.riderId) continue;
      const day = dayOf(m);
      if (!inRange(day)) continue;
      const row = rowFor(day, m.riderId);
      add(row.returned, m.productId, Number(m.quantity));
      row.empty = false;
    }

    // What he said he lost on the way. Accounted for, so it must not land in
    // `missing` — he told us about it.
    for (const m of riderWasteRows) {
      if (!m.riderId) continue;
      // Accepting less than the sheet is not wastage — see LOAD_SHORT_REASONS. The
      // milk is still at the retail centre, and "got" below already counts only
      // what he confirmed taking.
      if (isLoadShortfall(m.reason)) continue;
      const day = dayOf(m);
      if (!inRange(day)) continue;
      const row = rowFor(day, m.riderId);
      // The day-end close's write-off is not something he reported: it is the
      // missing milk itself, taken out of stock. Kept apart so "missing" still
      // reads as missing the morning after.
      add(isMissingReason(m.reason) ? row.writtenOff : row.riderWasted, m.productId, Number(m.quantity));
      row.empty = false;
    }

    // Spare stock still out with the rider. It is given against a shift, but it is
    // the rider who carries it and the rider who brings it back.
    for (const e of extras) {
      const date = toDateStrPKT(e.date);
      const row = rowFor(date, e.riderId ?? riderOfShift(e.shiftId));
      const out = r3(Number(e.givenQty) - Number(e.returnedQty));
      add(row.got, e.productId, Number(e.givenQty));
      if (Number(e.returnedQty) > 0) add(row.returned, e.productId, Number(e.returnedQty));
      if (Number(e.givenQty) > 0) row.empty = false;
      if (e.status === "OUT" && out > 0.0005) {
        add(row.extrasOut, e.productId, out);
        row.empty = false;
      }
    }

    // What went out with him.
    //
    // The app's confirmed load is what he actually took, so it wins outright for
    // any day he confirmed one. Reading the round's planned quantities instead
    // understated what he owed back by everything he took on top of the plan,
    // and the difference came back looking like a surplus he could not explain.
    // A route with no confirmed load falls back to the plan, which is all there is.
    //
    // Per ROUTE, not per rider-day: the app stamps each confirmation with the route
    // it was loaded for, and a route is not always loaded by the rider whose shift
    // it is. On 1 October Kamran Khan and Wajid Khan loaded Ahsan's two routes; by
    // rider-day Ahsan had confirmed nothing, so his 420 L of plans were charged to
    // him as well — milk he never took, owed back by him on this page.
    const confirmedRoutes = new Set<string>();
    const confirmedRiderDays = new Set<string>(); // a confirmation with no route on it
    const handover = await roundHandovers(handedRows, returnRows, riderWasteRows, deliveries, skippedStops, routes);
    for (const m of handedRows) {
      if (!m.riderId) continue;
      const date = toDateStrPKT(m.date);
      if (m.reference) confirmedRoutes.add(m.reference);
      else confirmedRiderDays.add(`${date}:${m.riderId}`);
      if (m.reference && handover.has(m.reference)) continue; // split below
      const row = rowFor(date, m.riderId);
      add(row.got, m.productId, Number(m.quantity));
      row.empty = false;
    }
    // A round the office handed to another rider after it was loaded: the milk went
    // with the round, so it is counted against whoever carried it (see roundHandovers).
    for (const [, split] of handover) {
      for (const [riderId, byProduct] of split.got) {
        const row = rowFor(split.date, riderId);
        for (const [pid, q] of byProduct) if (q > 0.0005) add(row.got, pid, q);
        row.empty = false;
      }
    }
    const today = todayPKTString();
    for (const it of routeItems) {
      const { id: routeId, date: rDate, shiftId, status } = it.routeStop.route;
      const date = toDateStrPKT(rDate);
      const rider = riderOfShift(shiftId);
      if (confirmedRoutes.has(routeId) || confirmedRiderDays.has(`${date}:${rider}`)) continue;
      // A round still PENDING once its day is over never ran: nobody took its milk,
      // which stock already counts as back on the shelf (heldCommitmentWhere). Read
      // as "got", it showed the shift's rider owing back a load he never had.
      if (status === "PENDING" && date < today) continue;
      const row = rowFor(date, rider);
      add(row.got, it.productId, Number(it.plannedQty));
      row.empty = false;
    }
    for (const d of deliveries) {
      if (d.complaintId || d.isReplacement || d.isReturn) continue;
      const shiftId = d.customer?.shiftId;
      if (!shiftId) continue;
      const date = toDateStrPKT(d.date);
      // The rider who made the delivery, which the app records on every entry. The
      // shift's own rider is only the fallback: when one rider covers another's
      // round, the load and the return are his, so the deliveries must be too —
      // charging them to the shift's rider left one owing the whole load and the
      // other showing a delivery he never had the milk for.
      const row = rowFor(date, d.riderId ?? riderOfShift(shiftId));
      // Charged on a stop the rider skipped? Then it never reached the customer,
      // whatever the bill says, and it is coming back with him.
      const skipped = skippedStops.has(`${date}:${shiftId}:${d.customerId}`);
      add(skipped ? row.chargedBack : row.delivered, d.productId, Number(d.quantity));
      if (skipped) row.empty = false;
    }
    // A delivered free sample left the van too. It is the rider who loaded that
    // shift's round that day who carried it; the shift's own rider is the fallback.
    const loaderOf = new Map<string, string>();
    for (const m of handedRows) if (m.reference && m.riderId && !loaderOf.has(m.reference)) loaderOf.set(m.reference, m.riderId);
    const roundOf = new Map(routes.map((r) => [`${toDateStrPKT(r.date)}:${r.shiftId}`, r.id] as const));
    for (const s of await sampleDeliveries(range)) {
      const routeId = roundOf.get(`${s.date}:${s.shiftId}`);
      const row = rowFor(s.date, (routeId && loaderOf.get(routeId)) || riderOfShift(s.shiftId));
      add(row.delivered, s.productId, s.qty);
    }

    // What the office already decided.
    for (const rev of reviews) {
      const row = rowFor(toDateStrPKT(rev.date), rev.riderId);
      row.reviewed = true;
      row.reviewedByName = rev.reviewedByName;
      row.empty = false;
      for (const l of rev.lines) {
        add(row.stock, l.productId, Number(l.stockQty));
        add(row.waste, l.productId, Number(l.wasteQty));
        if (Number(l.missingQty) > 0) add(row.reviewMissing, l.productId, Number(l.missingQty));
      }
    }

    let list = [...rows.values()].filter((r) => !r.empty);
    if (riderId) list = list.filter((r) => r.riderId === riderId);
    list.sort((a, b) => b.date.localeCompare(a.date) || a.riderName.localeCompare(b.riderName));

    // Stock now, with what these returns put back into it.
    const backFromReturns = new Map<string, number>();
    for (const rev of reviews) {
      for (const l of rev.lines) backFromReturns.set(l.productId, r3((backFromReturns.get(l.productId) ?? 0) + Number(l.stockQty)));
    }
    // What is worth a card: anything in stock, anything that came back, and
    // anything that went out with a shift in these dates — shown even at zero,
    // because "cow milk: 0 L" is the figure someone came here to read. A product
    // that has done nothing at all stays off the page.
    const touched = new Set<string>();
    for (const row of list) {
      for (const m of [row.got, row.returned, row.extrasOut]) {
        for (const [pid, q] of Object.entries(m)) if (q > 0.0005) touched.add(pid);
      }
    }
    const levels: InventoryLevel[] = products
      .filter((p) => !p.retailOnly)
      // The milk and the eggs are always listed — they are what goes out and comes
      // back every day, and 0 L is exactly the figure someone opens this page to
      // read. Anything else earns its card by having stock, a return, or a load.
      .filter((p) =>
        p.unit === "LITER" || isEggName(p.name) ||
        touched.has(p.id) || (onHand.get(p.id) ?? 0) > 0.0005 || (backFromReturns.get(p.id) ?? 0) > 0.0005)
      .map((p) => ({
        productId: p.id,
        name: p.name,
        unit: p.unit as Unit,
        onHand: r3(onHand.get(p.id) ?? 0),
        fromReturns: backFromReturns.get(p.id) ?? 0,
      }));

    return {
      from: lo, to: hi, rows: list, levels,
      products: products.map((p) => ({ id: p.id, name: p.name, unit: p.unit as Unit, retailOnly: p.retailOnly })),
      dbReady: true,
    };
  } catch (e) {
    console.error("[getReturnsBoard]", e);
    return { ...blank, dbReady: false, error: "Could not load the returns." };
  }
}

/**
 * What the retail centre was left with on a day, per product: what packaging sent
 * him, less what the rounds and the spare stock took away.
 *
 * Everything here sits behind the stock line, like every other stock figure on
 * the site. Without it a reset left this page still asking the retail man to hand
 * back milk that had been settled the day before — 144 L of it, once.
 */
export async function retailLeftover(date: string): Promise<Map<string, number>> {
  const range = dateStrRangePKT(date);
  const resetAt = await getStockResetAt();
  const written = resetAt ? { createdAt: { gte: resetAt } } : {};
  const [sent, shorts, loads, extras, dispatches] = await Promise.all([
    db.inventoryMovement.findMany({
      where: { type: "DISPATCHED", reason: SENT_TO_RETAIL, date: range, ...written },
      select: { productId: true, quantity: true },
    }),
    db.inventoryMovement.findMany({
      where: { type: "WASTAGE", stage: "Retail", date: range, ...written },
      select: { productId: true, quantity: true, reference: true },
    }),
    // Rounds that are actually holding stock — the same test the stock formula
    // uses. A round that was planned and dropped never took anything from him.
    db.routeStopItem.findMany({
      where: {
        AND: [
          heldCommitmentWhere(),
          { routeStop: { route: { date: range, ...(resetAt ? { createdAt: { gte: resetAt } } : {}) } } },
        ],
      },
      select: { productId: true, plannedQty: true, routeStop: { select: { routeId: true } } },
    }),
    db.riderExtraItem.findMany({
      where: { date: range, ...written },
      select: { productId: true, givenQty: true, returnedQty: true },
    }),
    db.retailDispatch.findMany({ select: { id: true } }),
  ]);
  // What the rounds really took: the confirmed load where there is one, the sheet
  // otherwise — the same rule as the stock formula, so this page and the Inventory
  // page's "In Retail" cannot disagree.
  const taken = routeLoads(
    loads.map((it) => ({ routeId: it.routeStop.routeId, productId: it.productId, plannedQty: Number(it.plannedQty) })),
    await confirmedLoadsByRoute([...new Set(loads.map((it) => it.routeStop.routeId))], written),
  );
  const sendIds = new Set(dispatches.map((d) => d.id));

  const left = new Map<string, number>();
  const bump = (pid: string, q: number) => left.set(pid, (left.get(pid) ?? 0) + q);
  for (const m of sent) bump(m.productId, Number(m.quantity));
  // Short on the way to Retail never reached the retail man, so it is not his to hand back.
  for (const m of shorts) if (m.reference && sendIds.has(m.reference)) bump(m.productId, -Number(m.quantity));
  for (const t of taken) bump(t.productId, -t.qty);
  // Spare stock a rider has already handed back is not out of the centre any more.
  for (const e of extras) bump(e.productId, -(Number(e.givenQty) - Number(e.returnedQty)));

  const out = new Map<string, number>();
  for (const [pid, q] of left) {
    const v = r3(q);
    if (v > 0.0005) out.set(pid, v);
  }
  return out;
}
