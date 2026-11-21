// Turning the order a manager dragged into a permanent delivery sequence.
//
// The shift editor plans ONE day, but the order of stops is a standing decision:
// the rider drives the same street in the same direction tomorrow. So when a route
// is saved, the order it was saved in becomes `Customer.deliverySequence`, which is
// what a future day's route is built from.
//
// The wrinkle is that a day's route is rarely the whole shift — customers on an
// off-day, on-call customers, or anyone whose supply is stopped simply aren't on
// it. Renumbering only the ones present would push everybody else to the end of
// the round, so an absent customer is anchored to where they already sat: they
// keep their position relative to the customers who WERE on the route.
//
// Pure and framework-free so the rule can be tested without a database.

export type SequencedCustomer = {
  id: string;
  /** Their current sequence, or null if they have never been given one. */
  deliverySequence: number | null;
  /** Tie-breaker, matching the ordering the route builder already uses. */
  customerCode: string;
};

/**
 * Work out the new sequence for every customer in a shift.
 *
 * @param presentInOrder ids of the customers on the saved route, in the order the
 *                       manager left them.
 * @param all            every customer belonging to the shift, present or not.
 * @returns id → 1-based sequence, for the whole shift.
 */
/** The order the route builder itself uses: sequence first, unset last, then code. */
function compareCurrent(a: SequencedCustomer, b: SequencedCustomer): number {
  const as = a.deliverySequence ?? Number.POSITIVE_INFINITY;
  const bs = b.deliverySequence ?? Number.POSITIVE_INFINITY;
  if (as !== bs) return as - bs;
  return a.customerCode.localeCompare(b.customerCode);
}

export function resequence(
  presentInOrder: string[],
  all: SequencedCustomer[]
): Map<string, number> {
  const byId = new Map(all.map((c) => [c.id, c] as const));

  // Only customers that actually belong to this shift can be placed. A one-day
  // order can put someone else's customer on the route; their own shift owns
  // their sequence, so it is left alone.
  const present = presentInOrder.filter((id) => byId.has(id));
  const presentSet = new Set(present);

  // Where everyone sat before, as a position rather than a raw sequence number.
  // Using the position means the rule works identically on a shift that has never
  // been sequenced (where the builder falls back to customer code) and on one that
  // has — an absent customer is anchored either way, instead of being dumped at
  // the end of the round the first time someone reorders a day they were off.
  const currentOrder = [...all].sort(compareCurrent);
  const oldPos = new Map(currentOrder.map((c, i) => [c.id, i] as const));

  const presentOldPos = present.map((id) => oldPos.get(id) ?? Number.POSITIVE_INFINITY).sort((a, b) => a - b);

  const absent = currentOrder.filter((c) => !presentSet.has(c.id));

  // An absent customer drops back in after however many present customers used to
  // come before them.
  const slotFor = (c: SequencedCustomer) => {
    const mine = oldPos.get(c.id) ?? Number.POSITIVE_INFINITY;
    let n = 0;
    for (const p of presentOldPos) {
      if (p < mine) n++;
      else break;
    }
    return n;
  };

  const insertAt = new Map<number, SequencedCustomer[]>();
  for (const c of absent) {
    const slot = slotFor(c);
    const arr = insertAt.get(slot) ?? [];
    arr.push(c);
    insertAt.set(slot, arr);
  }

  const finalOrder: string[] = [];
  for (let i = 0; i <= present.length; i++) {
    for (const c of insertAt.get(i) ?? []) finalOrder.push(c.id);
    if (i < present.length) finalOrder.push(present[i]);
  }

  const out = new Map<string, number>();
  finalOrder.forEach((id, i) => out.set(id, i + 1));
  return out;
}

/**
 * Only the customers whose sequence actually moves — saving a route without
 * touching the order should not write a single row.
 */
export function sequenceChanges(
  next: Map<string, number>,
  all: SequencedCustomer[]
): { id: string; deliverySequence: number }[] {
  const changes: { id: string; deliverySequence: number }[] = [];
  for (const c of all) {
    const n = next.get(c.id);
    if (n !== undefined && n !== c.deliverySequence) changes.push({ id: c.id, deliverySequence: n });
  }
  return changes;
}
