import "server-only";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { MIX_REASON_STORAGE, MIX_REASON_PACKAGING } from "@/lib/mix-milk-source";
import { DILUTION_REASON_STORAGE, DILUTION_REASON } from "@/lib/buffalo-dilution";
import { ACCEPTED_AT_PACKAGING, EGGS_COLLECTED, SENT_TO_RETAIL } from "@/lib/packaging-stock";
import { RETAIL_RETURN_STAGE } from "@/lib/rider-return-math";
import { getStockResetAt } from "@/lib/stock-reset";
import { todayRangePKT } from "@/lib/pkt";
import { routeLoads } from "@/lib/rider-stock";

/**
 * Each route's confirmed load, per product — the HANDED_OVER rows the rider app
 * writes against the route when the rider accepts the load. Only for the routes
 * asked about; `written` is the stock-reset line, like every other stock read.
 */
export async function confirmedLoadsByRoute(
  routeIds: string[],
  written: Prisma.InventoryMovementWhereInput = {},
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (routeIds.length === 0) return out;
  const rows = await db.inventoryMovement.findMany({
    where: { type: "HANDED_OVER", reference: { in: routeIds }, ...written },
    select: { reference: true, productId: true, quantity: true },
  });
  for (const r of rows) {
    const byProduct = out.get(r.reference!) ?? new Map<string, number>();
    byProduct.set(r.productId, (byProduct.get(r.productId) ?? 0) + Number(r.quantity));
    out.set(r.reference!, byProduct);
  }
  return out;
}

/**
 * Which route commitments still hold stock out of storage.
 *
 * A route that has started or finished took its milk with it, so its planned
 * quantities keep counting. A route still PENDING on a day that has passed never
 * ran — its milk is back on the shelf, and holding it forever left storage stuck
 * at zero (and every route save refused) long after the plan was abandoned.
 */
export function heldCommitmentWhere(): Prisma.RouteStopItemWhereInput {
  return {
    routeStop: {
      route: {
        OR: [
          { status: { in: ["IN_PROGRESS", "COMPLETED"] as const } },
          { date: { gte: todayRangePKT().gte } },
        ],
      },
    },
  };
}

// Components of a product's current on-hand quantity, all all-time totals.
export type OnHandComponents = {
  arrived: number;         // ARRIVED movements that reference a RetailDispatch
  yoghurtProduced: number; // PRODUCED (reason "Yoghurt processing")
  /**
   * Buffalo standardised and mix milk made at packaging, since packaging began
   * accepting loads straight into inventory (src/lib/packaging-stock.ts). What
   * they used is already subtracted (mixStorageUse / dilutionStorageUse); this
   * is what they produced going back in. Optional so older callers and tests
   * that build components by hand keep working.
   */
  madeHere?: number;
  yoghurtUse: number;      // KITCHEN_USE (reason "Yoghurt processing")
  routePlanned: number;    // RouteStopItem.plannedQty (committed for delivery)
  returned: number;        // RETURNED (unsold stock riders bring back)
  counterPurchase: number; // COUNTER_PURCHASE (walk-in buys — stock in)
  counterSale: number;     // COUNTER_SALE (walk-in sells — stock out)
  wastage: number;         // WASTAGE with a `stage` set (manual Waste-entry write-offs — stock out)
  extraOut: number;        // RiderExtraItem net still out (givenQty − returnedQty) — spare stock with riders (stock out until returned)
  replacement: number;     // REPLACEMENT (free replacements sent to a customer for spoiled milk — stock out; drawn from returned stock)
  mixStorageUse: number;   // KITCHEN_USE (reason "Mix milk processing (storage)") — mix milk made FROM stock, so it leaves storage. The packaging-sourced portion never reached storage and is excluded on purpose.
  dilutionStorageUse: number; // KITCHEN_USE (reason "Buffalo dilution (storage)") — cow milk taken from stock to standardise the buffalo. Same reasoning as above: the packaging-sourced half is docked from the load, not from storage.
  // RetailPlacementLine.quantity on placements that have not been voided —
  // product left at a shop on consignment. It has physically gone, so it leaves
  // storage the moment it is dropped, and it never comes back: unsold stock at a
  // mart is written off, not returned.
  //
  // NOTE this is the FULL dropped quantity, forever — NOT the unresolved
  // remainder. Reporting some of it sold or expired changes who owns the money,
  // not where the milk is. The retail screen's "Out at marts" figure is the
  // unresolved part and is a different number on purpose; do not "fix" one to
  // match the other. This is also why the retail module writes no
  // InventoryMovement at all — the line IS the record, so the same litres can
  // never be deducted twice.
  retailOut: number;
  /**
   * RetailStockEntry.quantity on entries that have not been voided — the only
   * way stock arrives for a retail product, which comes off no production run
   * and through no dispatch. Zero for every milk-pipeline product.
   */
  retailStockIn: number;
  /**
   * True for retail products (Product.retailOnly). Selects the single-clamp
   * branch below; see the comment there for why they cannot use the split one.
   */
  retailOnly: boolean;
  /**
   * Sent to Retail TODAY (DISPATCHED, reason SENT_TO_RETAIL). It sits in Retail
   * until the day ends, so it is out of inventory; from tomorrow whatever the
   * shifts did not use counts as back in inventory (see getStockComponents).
   * Optional so older callers and tests that build components by hand keep working.
   */
  sentToRetail?: number;
  /**
   * What the retail centre handed back TODAY and the office accepted as usable
   * (RetailReturnLine.stockQty). It is at the farm again, so it counts here now
   * rather than at midnight — and only for today: from tomorrow the leftover
   * comes back on its own, because a past day's sends are not subtracted at all.
   */
  retailHandback?: number;
};

/**
 * RETAIL — the stock between packaging and the shifts, for TODAY only.
 *
 * Packaging sends to Retail; the shifts' loads (customers and extras) come out
 * of it and what riders bring back goes into it. At the end of the day whatever
 * is left goes back to inventory. Nothing is written for that: these terms only
 * ever count today's rows, and the same rows from earlier days are counted on the
 * inventory side instead — so yesterday's leftover (sent − loaded + returned)
 * is simply never subtracted from inventory.
 *
 * Only farm products. Retail products (Product.retailOnly) cannot be sent from
 * packaging, so they keep their whole history on the inventory side as before.
 */
export type RetailComponents = {
  /** DISPATCHED SENT_TO_RETAIL today that Retail has ACCEPTED — only then is it on the shelf. */
  sent: number;
  /** Sent today but not yet accepted by Retail: off the farm store, not yet Retail's to load. */
  onTheWay?: number;
  loaded: number;    // plannedQty on held routes dated today (or later)
  extraOut: number;  // RiderExtraItem dated today (or later): given − returned
  /** Always 0. A rider's return comes back to the farm store, not to the retail
   *  centre, so it is counted in inventory — see the note on the formula. */
  returned: number;
  shortfall: number; // written off out of Retail today: short on a send, or spoiled in a return
  /** Handed back to the farm today and accepted as stock — it has left Retail. */
  handedBack: number;
};

/**
 * Retail figure, unclamped — below 0 when loads were set before the stock was sent.
 *
 * This is what the retail centre is holding: what packaging sent it, less what the
 * rounds and the spare stock took out of it. Milk a rider brings back at the end of
 * his shift is NOT here — it comes off the van to the farm store, and is counted in
 * inventory — so this figure and the returns page now say the same thing.
 */
export function retailFromComponents(r: RetailComponents): number {
  return r.sent - r.loaded - r.extraOut - r.shortfall - r.handedBack;
}

// The single formula for "how much of this product is physically on hand right
// now". Split into two clamps on purpose:
//
//   physicalBase = max(0, milk-flow terms)   — the dispatch/production pipeline
//   onHand       = max(0, physicalBase + counterPurchase − counterSale)
//
// The milk-flow base is clamped to 0 FIRST, then Over-the-Counter movements are
// applied on top. Without this split, a product whose milk-flow base is negative
// (common — milk tracking through the dispatch chain is incomplete for some
// products) would swallow an OTC purchase inside a single `max(0, …)` and the
// purchase would never show in storage. Applying OTC after the base clamp makes
// every walk-in buy visibly raise on-hand, and every walk-in sale lower it,
// while staying identical to the old single-clamp result whenever the base is
// already positive.
export function onHandFromComponents(c: OnHandComponents): number {
  // A retail product has no dispatch chain, so it has no milk-flow base to
  // protect and the split below has nothing to do. It gets ONE clamp over the
  // same terms.
  //
  // This is not a nicety. routePlanned sits inside the base clamp, so under the
  // split a retail product would compute max(0, 0 - 20) = 0 for a round of 20
  // bottles — a rider could take stock and deduct nothing, for ever. Same for
  // returned, extraOut and replacement. The split exists because milk arriving
  // through the dispatch chain is incompletely tracked and its base is
  // legitimately negative; none of that is true here.
  if (c.retailOnly) {
    return Math.max(
      0,
      c.retailStockIn + c.counterPurchase + c.returned + c.arrived + c.yoghurtProduced + (c.madeHere ?? 0)
      - c.counterSale - c.retailOut - c.routePlanned - c.wastage
      - c.extraOut - c.replacement - c.mixStorageUse - c.dilutionStorageUse - c.yoghurtUse
    );
  }
  const physicalBase = Math.max(
    0,
    c.arrived + c.yoghurtProduced - c.yoghurtUse - c.routePlanned + c.returned
  );
  // Manual write-offs and rider extra-stock both remove real physical stock whether it
  // arrived via the dispatch pipeline OR was bought over the counter, so they are applied
  // in the SAME final clamp as counterSale — not inside physicalBase, where they would be
  // swallowed by the base's max(0, …) for products whose on-hand comes from OTC purchases.
  return Math.max(
    0,
    physicalBase + c.counterPurchase + (c.madeHere ?? 0) - c.counterSale - c.wastage - c.extraOut - c.replacement - c.mixStorageUse - c.dilutionStorageUse - c.retailOut
    - (c.sentToRetail ?? 0) + (c.retailHandback ?? 0)
  );
}

// Current on-hand quantity per product id, for ALL active products (Ghee
// included — it's sellable over the counter even though the inventory-summary
// screen hides it). Used by the OTC sale flow to show availability and to block
// overselling, and shares `onHandFromComponents` with the inventory summary so
// the two never drift.
/**
 * Every term of the formula, per product, gathered in one pass.
 *
 * Separate from getOnHandByProduct() so the Inventory Summary can build its
 * "In storage" column from the SAME arithmetic instead of keeping a second copy
 * of it. It kept one for a long time, with a comment admitting the two "must
 * always move together" — which is a promise no comment can keep. There is now
 * one gathering step and one formula, and the screen and the stock guards can
 * no longer disagree about the same product.
 */
export async function getOnHandComponents(): Promise<Map<string, OnHandComponents>> {
  return (await getStockComponents()).inventory;
}

/**
 * Inventory and Retail terms, per product, from one gathering pass — so the two
 * stocks can never disagree about where a litre is.
 *
 * For farm products, routes, extras, rider returns and Retail shortfalls dated
 * TODAY belong to Retail; the same rows from earlier days stay on the inventory
 * side, where they always were. Today's sends come off inventory.
 */
export async function getStockComponents(): Promise<{
  inventory: Map<string, OnHandComponents>;
  retail: Map<string, RetailComponents>;
}> {
  const todayStart = todayRangePKT().gte;
  // Everything the last stock reset settled is left out of the figures: rounds,
  // spare stock and mart drops from before it have no arrival behind them any
  // more. Null (the usual case) filters nothing. See src/lib/stock-reset.ts.
  const resetAt = await getStockResetAt();
  const since = resetAt ? { gte: resetAt } : undefined;
  // A reset draws a line in time: everything RECORDED before it is settled —
  // the stock it describes is gone — and everything recorded after it counts.
  //
  // Recorded-at, not dated-at, and the same rule for movements as for the
  // commitments against them. Filtering rounds by their delivery date instead
  // left a hole for the rest of the day the line was drawn on: a round assigned
  // that afternoon carries that morning's date, so it fell on the settled side
  // and took its load out of no one's stock.
  const written = resetAt ? { createdAt: { gte: resetAt } } : {};
  const [
    products,
    retailDispatches,
    arrivedRows,
    yoghurtProducedRows,
    yoghurtUseRows,
    routePlannedRows,
    returnedRows,
    counterSaleRows,
    counterPurchaseRows,
    wastageRows,
    extraRows,
    replacementRows,
    mixStorageRows,
    dilutionStorageRows,
    retailOutRows,
    retailStockInRows,
    madeHereRows,
    sentTodayRows,
    retailHandbackRows,
  ] = await Promise.all([
    db.product.findMany({ where: { active: true }, select: { id: true, retailOnly: true } }),
    db.retailDispatch.findMany({ select: { id: true, status: true } }),
    db.inventoryMovement.findMany({ where: { type: "ARRIVED", ...written }, select: { productId: true, quantity: true, reference: true, reason: true } }),
    db.inventoryMovement.findMany({ where: { type: "PRODUCED", reason: "Yoghurt processing", ...written }, select: { productId: true, quantity: true } }),
    db.inventoryMovement.findMany({ where: { type: "KITCHEN_USE", reason: "Yoghurt processing", ...written }, select: { productId: true, quantity: true } }),
    db.routeStopItem.findMany({
      where: resetAt
        ? { AND: [heldCommitmentWhere(), { routeStop: { route: { createdAt: since } } }] }
        : heldCommitmentWhere(),
      select: { productId: true, plannedQty: true, routeStop: { select: { route: { select: { id: true, date: true } } } } },
    }),
    db.inventoryMovement.findMany({ where: { type: "RETURNED", ...written }, select: { productId: true, quantity: true, date: true } }),
    db.inventoryMovement.findMany({ where: { type: "COUNTER_SALE", ...written }, select: { productId: true, quantity: true } }),
    db.inventoryMovement.findMany({ where: { type: "COUNTER_PURCHASE", ...written }, select: { productId: true, quantity: true } }),
    // Manual Waste-entry write-offs only (stage set) — these deduct from storage.
    // Production/dispatch/rider wastage (stage null) is excluded on purpose to avoid double-counting.
    db.inventoryMovement.findMany({ where: { type: "WASTAGE", stage: { not: null }, ...written }, select: { productId: true, quantity: true, stage: true, reference: true, date: true } }),
    // Rider extra stock still out (givenQty − returnedQty) — spare stock a manager gave riders.
    db.riderExtraItem.findMany({ where: written, select: { productId: true, givenQty: true, returnedQty: true, date: true } }),
    // Free replacements sent to customers for spoiled milk — stock out.
    db.inventoryMovement.findMany({ where: { type: "REPLACEMENT", ...written }, select: { productId: true, quantity: true } }),
    // Mix milk drawn from stock — the only mix-milk usage that touches storage.
    db.inventoryMovement.findMany({ where: { type: "KITCHEN_USE", reason: MIX_REASON_STORAGE, ...written }, select: { productId: true, quantity: true } }),
    // Cow milk drawn from stock to standardise the buffalo. Must be subtracted
    // here for the same reason mix's storage draw is: without it the same litres
    // would still read as on hand and could be poured into the buffalo again
    // tomorrow, and every day after. The packaging-sourced half is NOT here — it
    // never reached storage, and is docked from the load instead.
    db.inventoryMovement.findMany({ where: { type: "KITCHEN_USE", reason: DILUTION_REASON_STORAGE, ...written }, select: { productId: true, quantity: true } }),
    // Product left at retail marts on consignment. A voided drop never happened,
    // so its lines drop out here and the stock returns.
    db.retailPlacementLine.findMany({
      where: { placement: { voidedAt: null, ...written } },
      select: { productId: true, quantity: true },
    }),
    // The only inbound a retail product has. Scoped to retailOnly products so a
    // row written against a farm product — which the action refuses, but a
    // direct POST could still attempt — can never mint milk.
    db.retailStockEntry.findMany({
      where: { voidedAt: null, product: { retailOnly: true }, ...written },
      select: { productId: true, quantity: true },
    }),
    // What buffalo standardising and mix milk PRODUCED, from the first load
    // accepted straight into inventory. Before that, packaging forwarded these
    // with the load and they reached storage through Retail (ARRIVED) — counting
    // those older rows here would count the same milk twice.
    db.farmDispatch
      .findFirst({ where: { acceptedAt: { not: null } }, orderBy: { acceptedAt: "asc" }, select: { acceptedAt: true } })
      .then((first) =>
        first?.acceptedAt
          ? db.inventoryMovement.findMany({
              where: {
                type: "PRODUCED",
                reason: { in: [MIX_REASON_PACKAGING, DILUTION_REASON] },
                date: { gte: first.acceptedAt },
                ...written,
              },
              select: { productId: true, quantity: true },
            })
          : [],
      ),
    // Sent to Retail today — out of inventory, into Retail, until the day ends.
    db.inventoryMovement.findMany({
      where: { type: "DISPATCHED", reason: SENT_TO_RETAIL, date: { gte: todayStart }, ...written },
      select: { productId: true, quantity: true, reference: true },
    }),
    // What the retail centre handed back today, and the office kept.
    db.retailReturnReview.findMany({
      where: { date: { gte: todayStart }, ...written },
      select: { lines: { select: { productId: true, stockQty: true } } },
    }),
  ]);

  // Farm products only: a retail product never passes through packaging.
  const farm = new Set(products.filter((p) => !p.retailOnly).map((p) => p.id));
  const isToday = (d: Date) => d >= todayStart;
  const retailDispatchIds = new Set(retailDispatches.map((d) => d.id));
  const notAccepted = new Set(retailDispatches.filter((d) => d.status === "PENDING").map((d) => d.id));
  const r = {
    sent: new Map<string, number>(),
    onTheWay: new Map<string, number>(),
    loaded: new Map<string, number>(),
    extraOut: new Map<string, number>(),
    returned: new Map<string, number>(),
    shortfall: new Map<string, number>(),
    handedBack: new Map<string, number>(),
  };

  const add = (map: Map<string, number>, id: string, q: number) => map.set(id, (map.get(id) ?? 0) + q);

  const arrived = new Map<string, number>();
  for (const m of arrivedRows) {
    // Into storage through Retail, or accepted / collected at packaging straight
    // into inventory.
    if ((m.reference && retailDispatchIds.has(m.reference)) || m.reason === ACCEPTED_AT_PACKAGING || m.reason === EGGS_COLLECTED) {
      add(arrived, m.productId, Number(m.quantity));
    }
  }
  const madeHere = new Map<string, number>();
  for (const m of madeHereRows) add(madeHere, m.productId, Number(m.quantity));
  const yoghurtProduced = new Map<string, number>();
  for (const m of yoghurtProducedRows) add(yoghurtProduced, m.productId, Number(m.quantity));
  const yoghurtUse = new Map<string, number>();
  for (const m of yoghurtUseRows) add(yoghurtUse, m.productId, Number(m.quantity));
  // What each round took: the rider's confirmed load where he confirmed one,
  // the sheet otherwise — see routeLoads. Reading the sheet alone charged stock
  // for milk a rider had declined at loading, and credited stock for milk he had
  // taken on top of it.
  const routeDate = new Map<string, Date>();
  for (const m of routePlannedRows) routeDate.set(m.routeStop.route.id, m.routeStop.route.date);
  const confirmed = await confirmedLoadsByRoute([...routeDate.keys()], written);
  const routePlanned = new Map<string, number>();
  for (const t of routeLoads(
    routePlannedRows.map((m) => ({ routeId: m.routeStop.route.id, productId: m.productId, plannedQty: Number(m.plannedQty) })),
    confirmed,
  )) {
    if (farm.has(t.productId) && isToday(routeDate.get(t.routeId)!)) add(r.loaded, t.productId, t.qty);
    else add(routePlanned, t.productId, t.qty);
  }
  // Every return goes to inventory, today's included: the rider hands it in at the
  // farm, so it is stock there and not something the retail centre owes back.
  const returned = new Map<string, number>();
  for (const m of returnedRows) add(returned, m.productId, Number(m.quantity));
  const counterSale = new Map<string, number>();
  for (const m of counterSaleRows) add(counterSale, m.productId, Number(m.quantity));
  const counterPurchase = new Map<string, number>();
  for (const m of counterPurchaseRows) add(counterPurchase, m.productId, Number(m.quantity));
  const wastage = new Map<string, number>();
  for (const m of wastageRows) {
    // Two write-offs come out of the Retail pool rather than inventory, because
    // that is where the stock was: what Retail reported short on a send, and the
    // spoiled part of what the retail centre handed back.
    //
    // A RIDER's spoiled return is not one of them any more. His return goes to
    // the farm store, so the good part lands in inventory — and the spoiled part
    // has to come out of the same place, or the milk is written off against a
    // pool it never reached.
    const retailShort =
      (m.stage === "Retail" && !!m.reference && retailDispatchIds.has(m.reference)) ||
      m.stage === RETAIL_RETURN_STAGE;
    if (retailShort && farm.has(m.productId) && isToday(m.date)) add(r.shortfall, m.productId, Number(m.quantity));
    else add(wastage, m.productId, Number(m.quantity));
  }
  const extraOut = new Map<string, number>();
  for (const m of extraRows) {
    const given = Number(m.givenQty);
    const back = Number(m.returnedQty);
    if (farm.has(m.productId) && isToday(m.date)) {
      // Spare stock left the retail centre when it was handed over, and all of it
      // stays gone from there. What the rider brings back comes to the farm store,
      // like the rest of his return — not onto the centre's shelf.
      add(r.extraOut, m.productId, given);
      if (back > 0) add(returned, m.productId, back);
    } else add(extraOut, m.productId, given - back);
  }
  // A send is Retail's to load only once Retail has accepted it. Until then it is
  // on the way: off the farm store's count, and not on Retail's shelf either, so
  // Save route cannot plan a round out of it and the shift cannot start.
  for (const m of sentTodayRows) {
    if (!farm.has(m.productId)) continue;
    add(m.reference && notAccepted.has(m.reference) ? r.onTheWay : r.sent, m.productId, Number(m.quantity));
  }
  const retailHandback = new Map<string, number>();
  for (const rev of retailHandbackRows) {
    for (const l of rev.lines) {
      if (!farm.has(l.productId)) continue;
      add(retailHandback, l.productId, Number(l.stockQty));
      add(r.handedBack, l.productId, Number(l.stockQty));
    }
  }
  const replacement = new Map<string, number>();
  for (const m of replacementRows) add(replacement, m.productId, Number(m.quantity));
  const mixStorageUse = new Map<string, number>();
  for (const m of mixStorageRows) add(mixStorageUse, m.productId, Number(m.quantity));
  const dilutionStorageUse = new Map<string, number>();
  for (const m of dilutionStorageRows) add(dilutionStorageUse, m.productId, Number(m.quantity));
  const retailOut = new Map<string, number>();
  for (const m of retailOutRows) add(retailOut, m.productId, Number(m.quantity));
  const retailStockIn = new Map<string, number>();
  for (const m of retailStockInRows) add(retailStockIn, m.productId, Number(m.quantity));

  const out = new Map<string, OnHandComponents>();
  for (const p of products) {
    out.set(p.id, {
      arrived: arrived.get(p.id) ?? 0,
      yoghurtProduced: yoghurtProduced.get(p.id) ?? 0,
      yoghurtUse: yoghurtUse.get(p.id) ?? 0,
      routePlanned: routePlanned.get(p.id) ?? 0,
      returned: returned.get(p.id) ?? 0,
      counterPurchase: counterPurchase.get(p.id) ?? 0,
      counterSale: counterSale.get(p.id) ?? 0,
      wastage: wastage.get(p.id) ?? 0,
      extraOut: extraOut.get(p.id) ?? 0,
      replacement: replacement.get(p.id) ?? 0,
      mixStorageUse: mixStorageUse.get(p.id) ?? 0,
      dilutionStorageUse: dilutionStorageUse.get(p.id) ?? 0,
      retailOut: retailOut.get(p.id) ?? 0,
      retailStockIn: retailStockIn.get(p.id) ?? 0,
      madeHere: madeHere.get(p.id) ?? 0,
      retailOnly: p.retailOnly,
      // Accepted or still on the way, it has left the farm store.
      sentToRetail: (r.sent.get(p.id) ?? 0) + (r.onTheWay.get(p.id) ?? 0),
      retailHandback: retailHandback.get(p.id) ?? 0,
    });
  }
  const retail = new Map<string, RetailComponents>();
  for (const pid of farm) {
    retail.set(pid, {
      sent: r.sent.get(pid) ?? 0,
      onTheWay: r.onTheWay.get(pid) ?? 0,
      loaded: r.loaded.get(pid) ?? 0,
      extraOut: r.extraOut.get(pid) ?? 0,
      returned: r.returned.get(pid) ?? 0,
      shortfall: r.shortfall.get(pid) ?? 0,
      handedBack: r.handedBack.get(pid) ?? 0,
    });
  }
  return { inventory: out, retail };
}

/**
 * Retail today, per farm product, unclamped (a load set before the stock was sent
 * reads below 0). Retail products are not in the map — they have no Retail.
 */
export async function getRetailByProduct(): Promise<Map<string, number>> {
  return (await getStockByProduct()).retail;
}

/** Inventory (on hand) and Retail today, from one pass. */
export async function getStockByProduct(): Promise<{
  inventory: Map<string, number>;
  retail: Map<string, number>;
}> {
  const { inventory, retail } = await getStockComponents();
  const inv = new Map<string, number>();
  for (const [productId, c] of inventory) inv.set(productId, onHandFromComponents(c));
  const ret = new Map<string, number>();
  for (const [productId, c] of retail) ret.set(productId, retailFromComponents(c));
  return { inventory: inv, retail: ret };
}

/**
 * How much of each product is in INVENTORY right now — at packaging, not what
 * was sent to Retail today. Every outflow except the shifts caps here.
 */
export async function getOnHandByProduct(): Promise<Map<string, number>> {
  const components = await getOnHandComponents();
  const out = new Map<string, number>();
  for (const [productId, c] of components) out.set(productId, onHandFromComponents(c));
  return out;
}
