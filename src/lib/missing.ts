// Milk that is MISSING — gone, but not wasted by anyone's account.
//
// Two things write it off:
//   · the day-end close (src/lib/day-close.ts): what a rider never brought back
//     by midnight, and what the retail centre still held;
//   · a return review: the rider's app said N came back, the reviewer received
//     less — the difference was never handed over.
//
// Both are InventoryMovement WASTAGE rows, so every stock figure already treats
// them as gone. What makes them "missing" rather than "wasted" is the reason on
// the row: the Wastage log leaves these out and the Missing log shows only these.
// No "server-only" here — the pages and the server both read the list.

export const DAY_CLOSE_REASON = "Not returned from inventory";
export const REVIEW_MISSING_REASON = "Not handed over at review";

export const MISSING_REASONS = [DAY_CLOSE_REASON, REVIEW_MISSING_REASON] as const;

export function isMissingReason(reason: string | null | undefined): boolean {
  return (MISSING_REASONS as readonly string[]).includes((reason ?? "").trim());
}
