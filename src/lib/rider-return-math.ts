// Splitting a rider's returns into usable stock and wastage.
//
// Browser- and server-safe (no database import), so the dialog's warning and the
// server's rejection are the same sentence produced by the same function — the
// screen can never offer a split the save then refuses.

/** The reasons a returned item is written off. Anything else is refused. */
export const RETURN_WASTE_REASONS = [
  "Sour / spoiled",
  "Leaking / damaged",
  "Temperature issue",
  "Contamination",
  "Other",
] as const;
export type ReturnWasteReason = (typeof RETURN_WASTE_REASONS)[number];

/** The stage these write-offs carry, so the Wastage log can tell them apart from
 *  an office write-off typed on the Waste entry page. */
export const RIDER_RETURN_STAGE = "Rider return";

/** The same, for what the retail centre had left over at the end of a day. */
export const RETAIL_RETURN_STAGE = "Retail return";

/** The reason on the movement that puts a manager-entered extra return back. */
export const EXTRA_RECEIVED_REASON = "Extra items received back";

/**
 * APP    — an end-of-shift return the rider app recorded.
 * EXTRA  — spare stock given to a rider, received back.
 * RETAIL — what the retail centre had left after loading the shifts.
 *
 * APP and RETAIL have to be accounted for exactly: the stock is there and all of
 * it is either usable or wasted. EXTRA may be part-returned, because the rest was
 * sold on the round.
 */
export type ReturnLineSource = "APP" | "EXTRA" | "RETAIL";

/** One line the office has to account for. */
export type ReturnLineSpec = {
  /** Stable id: the product id for an app return, the RiderExtraItem id for an extra. */
  key: string;
  source: ReturnLineSource;
  productId: string;
  productName: string;
  unit: string;
  /**
   * APP: exactly what the rider app recorded coming back — stock + waste must
   * equal it. EXTRA: what is still out with the rider — stock + waste may be
   * less, because the rest was sold on the round.
   */
  returnedQty: number;
};

export type ReturnEntry = { key: string; stockQty: number; wasteQty: number; wasteReason?: string | null };

/**
 * On an app return, whatever the reviewer did not put into stock or wastage was
 * never handed over — it is missing, and it is worked out, never typed in.
 * Zero for Retail's leftover and spare stock, which the office counts itself.
 */
export function missingOf(spec: ReturnLineSpec, entry: ReturnEntry): number {
  if (spec.source !== "APP") return 0;
  return Math.max(0, tidy(spec.returnedQty - (Number(entry.stockQty) || 0) - (Number(entry.wasteQty) || 0)));
}

const EPS = 1e-6;
const isWhole = (unit: string) => unit === "PIECE";
const tidy = (n: number) => Math.round(n * 1000) / 1000;

/** The first thing wrong with one line, or null. */
export function validateReturnLine(spec: ReturnLineSpec, entry: ReturnEntry): string | null {
  const { stockQty, wasteQty } = entry;
  for (const [label, v] of [["into inventory", stockQty], ["wastage", wasteQty]] as const) {
    if (!Number.isFinite(v) || v < 0) return `${spec.productName}: enter a valid ${label} quantity (0 or more).`;
    if (Math.abs(v * 1000 - Math.round(v * 1000)) > EPS) return `${spec.productName}: use at most 3 decimal places.`;
    if (isWhole(spec.unit) && Math.abs(v - Math.round(v)) > EPS) return `${spec.productName}: whole pieces only.`;
  }
  const total = tidy(stockQty + wasteQty);
  if (spec.source === "APP") {
    // A rider's return may fall short — the rest is missing — but never over.
    if (total > spec.returnedQty + EPS) return `${spec.productName}: only ${tidy(spec.returnedQty)} was reported returned.`;
  } else if (spec.source === "RETAIL") {
    if (Math.abs(total - spec.returnedQty) > EPS) {
      return `${spec.productName}: into inventory + wastage must add up to ${tidy(spec.returnedQty)} — all of it has to be accounted for.`;
    }
  } else if (total > spec.returnedQty + EPS) {
    return `${spec.productName}: only ${tidy(spec.returnedQty)} is out with the rider.`;
  }
  if (wasteQty > EPS && !(RETURN_WASTE_REASONS as readonly string[]).includes(entry.wasteReason ?? "")) {
    return `${spec.productName}: choose why it was wasted.`;
  }
  return null;
}

/** The first thing wrong with the whole split, or null. Every line must be entered. */
export function validateReturnAllocation(specs: ReturnLineSpec[], entries: ReturnEntry[]): string | null {
  if (specs.length === 0) return "There is nothing to review on this shift.";
  const byKey = new Map(entries.map((e) => [e.key, e]));
  for (const spec of specs) {
    const entry = byKey.get(spec.key);
    if (!entry) return `${spec.productName}: enter how much went into inventory and how much was wasted.`;
    const problem = validateReturnLine(spec, entry);
    if (problem) return problem;
  }
  for (const e of entries) {
    if (!specs.some((s) => s.key === e.key)) return "That return has changed since this was opened — close and reopen it.";
  }
  return null;
}

/** What a split adds up to, for the dialog's footer and the saved totals. */
export function returnTotals(specs: ReturnLineSpec[], entries: ReturnEntry[]) {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  let returned = 0, stock = 0, waste = 0, missing = 0;
  for (const s of specs) {
    const e = byKey.get(s.key);
    const st = Number(e?.stockQty) || 0;
    const wa = Number(e?.wasteQty) || 0;
    const mi = e ? missingOf(s, e) : 0;
    returned += s.source === "EXTRA" ? st + wa : s.returnedQty;
    stock += st;
    waste += wa;
    missing += mi;
  }
  return { returned: tidy(returned), stock: tidy(stock), waste: tidy(waste), missing: tidy(missing) };
}
