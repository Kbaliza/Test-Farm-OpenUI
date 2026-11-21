// What the rider app and the returns trigger write, as shared constants.
//
// Browser- and server-safe (no database import), so the Rider Item Returns page,
// the reconciliation and the stock formula all match on the same strings instead
// of each keeping its own copy.

/** RETURNED movement the rider app writes for leftovers handed back at the end of a shift. */
export const END_OF_SHIFT_RETURN_REASON = "End of shift return";

/**
 * RETURNED movement the database trigger mirrors from a customer's return
 * (supabase/returns-sync-trigger.sql). It is the same milk the rider then hands
 * back, so a report must count it EITHER here or as a customer return — never both.
 */
export const CUSTOMER_RETURN_REASON = "Rider return";

/**
 * Reasons the rider app puts on a WASTAGE row that are NOT wastage.
 *
 * When a rider accepts less than the sheet at loading, the app writes the
 * difference as a WASTAGE row with one of these reasons. Nothing was spilled: the
 * milk never left the retail centre. Counted as road wastage, Wajid Khan's
 * 10 October read as 41 L wasted when he had spilled 11 L and simply taken 30 L
 * less than the sheet said — and the reconciliation charged the 30 L twice, once
 * as his wastage and once as Retail's leftover.
 */
export const LOAD_SHORT_REASONS = ["Received different at load", "Extra short at load"] as const;

export function isLoadShortfall(reason: string | null | undefined): boolean {
  return (LOAD_SHORT_REASONS as readonly string[]).includes((reason ?? "").trim());
}

/** A rider's WASTAGE row that really is milk lost on the round. */
export function isRoadWastage(reason: string | null | undefined): boolean {
  return !isLoadShortfall(reason);
}

export type PlannedLine = { routeId: string; productId: string; plannedQty: number };
export type TakenLine = { routeId: string; productId: string; qty: number };

/**
 * What a round actually took out of stock.
 *
 * The sheet (RouteStopItem.plannedQty) is the office's plan. The rider's confirmed
 * load (HANDED_OVER rows referencing the route) is the fact, and it replaces the
 * plan for that route outright — every product, since the app writes a row for
 * each product on the sheet, zero included. A route with no confirmed load keeps
 * its plan.
 *
 * The same rule the Rider Item Returns page and the reconciliation already use
 * for "took"; this makes the stock figures follow it too, so the 30 L a rider
 * declines at loading stays on the retail centre's shelf in the books as well
 * as in the fridge.
 */
export function routeLoads(
  planned: PlannedLine[],
  confirmed: Map<string, Map<string, number>>,
): TakenLine[] {
  const out: TakenLine[] = [];
  for (const p of planned) {
    if (confirmed.has(p.routeId)) continue;
    out.push({ routeId: p.routeId, productId: p.productId, qty: p.plannedQty });
  }
  for (const [routeId, byProduct] of confirmed) {
    for (const [productId, qty] of byProduct) out.push({ routeId, productId, qty });
  }
  return out;
}
