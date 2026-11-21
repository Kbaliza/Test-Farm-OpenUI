import { roundQty } from "./quantity";
// Splitting mix-milk usage across the loads it was made from.
//
// Mix milk is produced AT packaging out of milk that was dispatched there, so the
// litres it consumed must be charged against a specific load — otherwise the same
// litres are deducted from every pending load at once and the arrival figures are
// wrong the moment two loads are waiting.
//
// Pure and framework-free so the page, the confirm action and the tests all use
// the identical split.

export type AllocatableLoad = {
  id: string;
  /** When the load was dispatched — oldest is consumed first. */
  date: Date;
  items: { productId: string; quantity: number }[];
};

/**
 * Charge `usedByProduct` against `loads`, oldest first (the milk that arrived
 * first is used first), never taking more from a load than it actually carried.
 *
 * Returns load id → productId → litres charged to that load. Any usage left over
 * (more mixed than the pending loads can account for) is simply not charged —
 * it belongs to a load that has already been accepted.
 */
export function allocateMixUsage(
  loads: AllocatableLoad[],
  usedByProduct: Record<string, number>
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const remaining: Record<string, number> = { ...usedByProduct };

  const ordered = [...loads].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const load of ordered) {
    const share: Record<string, number> = {};
    for (const item of load.items) {
      const left = remaining[item.productId] ?? 0;
      if (left <= 0.0001) continue;
      const take = Math.min(left, item.quantity);
      if (take > 0.0001) {
        share[item.productId] = (share[item.productId] ?? 0) + take;
        remaining[item.productId] = left - take;
      }
    }
    out[load.id] = share;
  }
  return out;
}

/** What a load can still send on: what it carried, minus what was mixed from it. */
export function forwardableQty(declaredQty: number, mixUsed: number): number {
  return Math.max(0, declaredQty - (mixUsed || 0));
}

export type MixMovement = { productId: string; quantity: number; date: Date };

/**
 * The full picture for one day: how much of each load went into mix milk.
 *
 * A load that has already been accepted owns the mixing that happened up to the
 * moment it was accepted. Everything mixed since then belongs to the loads still
 * waiting, and is split across them by {@link allocateMixUsage}.
 *
 * Pure, so the packaging page and the confirm guard compute the identical figure
 * — otherwise the screen offers a quantity the server then refuses.
 */
export function mixDeductionsByDispatch(
  loads: AllocatableLoad[],
  confirmedAt: Map<string, Date>,
  movements: MixMovement[]
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};

  const settled = [...loads]
    .filter((l) => confirmedAt.has(l.id))
    .sort((a, b) => confirmedAt.get(a.id)!.getTime() - confirmedAt.get(b.id)!.getTime());

  let prev = new Date(0);
  for (const l of settled) {
    const at = confirmedAt.get(l.id)!;
    const share: Record<string, number> = {};
    for (const m of movements) {
      if (m.date >= prev && m.date <= at) share[m.productId] = (share[m.productId] ?? 0) + m.quantity;
    }
    out[l.id] = share;
    prev = at;
  }

  const unaccounted: Record<string, number> = {};
  for (const m of movements) {
    if (m.date > prev) unaccounted[m.productId] = (unaccounted[m.productId] ?? 0) + m.quantity;
  }
  return { ...out, ...allocateMixUsage(loads.filter((l) => !confirmedAt.has(l.id)), unaccounted) };
}

/**
 * Charge an ADDITION (milk stirred into a product at packaging) to a load.
 *
 * Unlike consumption there is no ceiling — a load can carry more of a product
 * than it was dispatched with. The addition lands on the oldest load that
 * actually carries that product, so it travels with the milk it was made from;
 * if no pending load carries it, the oldest pending load takes it.
 */
export function allocateAdditions(
  loads: AllocatableLoad[],
  addedByProduct: Record<string, number>
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const ordered = [...loads].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const l of ordered) out[l.id] = {};
  if (ordered.length === 0) return out;

  for (const [productId, qty] of Object.entries(addedByProduct)) {
    if (!(qty > 0.0001)) continue;
    const target =
      ordered.find((l) => l.items.some((i) => i.productId === productId)) ?? ordered[0];
    out[target.id][productId] = (out[target.id][productId] ?? 0) + qty;
  }
  return out;
}

/**
 * The same day-window split as {@link mixDeductionsByDispatch}, for additions:
 * a settled load owns what was added up to the moment it was accepted, and
 * anything added since belongs to the loads still waiting.
 */
export function additionsByDispatch(
  loads: AllocatableLoad[],
  confirmedAt: Map<string, Date>,
  movements: MixMovement[]
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};

  const settled = [...loads]
    .filter((l) => confirmedAt.has(l.id))
    .sort((a, b) => confirmedAt.get(a.id)!.getTime() - confirmedAt.get(b.id)!.getTime());

  let prev = new Date(0);
  for (const l of settled) {
    const at = confirmedAt.get(l.id)!;
    const share: Record<string, number> = {};
    for (const m of movements) {
      if (m.date >= prev && m.date <= at) share[m.productId] = (share[m.productId] ?? 0) + m.quantity;
    }
    out[l.id] = share;
    prev = at;
  }

  const unaccounted: Record<string, number> = {};
  for (const m of movements) {
    if (m.date > prev) unaccounted[m.productId] = (unaccounted[m.productId] ?? 0) + m.quantity;
  }
  return { ...out, ...allocateAdditions(loads.filter((l) => !confirmedAt.has(l.id)), unaccounted) };
}

/**
 * What a load can send on once packaging has both taken from it and added to it:
 * dispatched, minus milk consumed there, plus milk stirred in there.
 */
export function forwardableWithAdditions(
  declaredQty: number,
  consumed: number,
  added: number
): number {
  // Rounded to the three decimals a quantity is stored with: subtracting and
  // adding floats leaves 299.99999999999994 where 300 belongs, and that figure
  // was being written into the load and shown on the card.
  return Math.max(0, roundQty(declaredQty - (consumed || 0) + (added || 0)));
}

/**
 * Real loss on a load: what it should have been able to forward, minus what it
 * actually forwarded.
 *
 * Everything packaging legitimately did to the load has to be taken out first —
 * milk turned into mix milk, milk stirred into another product, milk stirred in
 * from another — or ordinary processing reads as wastage. A load that gave 10 L
 * of cow milk to the buffalo arrives 10 L short by design, not by spillage.
 */
export function loadLoss(
  declaredQty: number,
  receivedQty: number,
  packaging: { mixUsed?: number; dilutionOut?: number; dilutionIn?: number } = {}
): number {
  const expected = forwardableWithAdditions(
    declaredQty,
    (packaging.mixUsed ?? 0) + (packaging.dilutionOut ?? 0),
    packaging.dilutionIn ?? 0
  );
  return Math.max(0, Math.round((expected - receivedQty) * 1000) / 1000);
}
