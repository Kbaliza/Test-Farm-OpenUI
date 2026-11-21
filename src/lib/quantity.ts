import { isPackUnit } from "./units";

// One rule for how a production quantity may be written, shared by the forms and
// by the server actions behind them. Kept in a plain module (not "use server") so
// both sides import the SAME function and can never drift — the browser check and
// the check that actually decides must always agree.

/** Measured products may carry at most this many decimal places. */
export const QTY_DECIMALS = 2;

/**
 * Counted products come in whole units — half an egg is not a thing, and neither
 * is half a bottle. Pack units (ml/g) are counted for the same reason: the number
 * typed is how many bottles were handed over, not how many millilitres.
 */
export function isCountedUnit(unit: string): boolean {
  return unit === "PIECE" || isPackUnit(unit);
}

/**
 * A quantity as it should be written down: at most three decimals, which is what
 * the database stores, with float noise rounded away. 300 − 0.1 − 0.2 comes out
 * of JavaScript as 299.99999999999994; this is what makes it 300 again.
 */
export function roundQty(n: number): number {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

/** The same figure as text, without a trailing ".0" — for showing on a page. */
export function qtyText(n: number): string {
  const v = roundQty(n);
  return Number.isInteger(v) ? String(v) : String(v);
}

/** The `step` a number input should use for this unit. */
export function stepForUnit(unit: string): string {
  return isCountedUnit(unit) ? "1" : "0.01";
}

/**
 * True when a value carries more than QTY_DECIMALS decimal places.
 *
 * Compared after scaling rather than by counting characters, so ordinary float
 * noise (0.1 + 0.2 = 0.30000000000000004) is not mistaken for a 17-decimal entry,
 * while a genuine 10.555 is caught.
 */
export function hasTooManyDecimals(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  const scaled = n * 10 ** QTY_DECIMALS;
  return Math.abs(scaled - Math.round(scaled)) > 1e-9;
}

/**
 * The single message for a bad quantity, or null when it is acceptable.
 * Used verbatim by the forms and by the server actions.
 */
export function quantityProblem(name: string, unit: string, qty: number): string | null {
  if (!Number.isFinite(qty) || qty < 0) return `${name}: enter a quantity of zero or more.`;
  if (isCountedUnit(unit)) {
    return Number.isInteger(qty)
      ? null
      : `${name} is counted in whole ${unit === "PIECE" ? "pieces" : "packs"} — enter a whole number.`;
  }
  if (hasTooManyDecimals(qty)) {
    return `${name}: use at most ${QTY_DECIMALS} decimal places (e.g. 10.55, not 10.555).`;
  }
  return null;
}
