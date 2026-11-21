// Number formatting for the Production Reconciliation page, shared by the Summary
// and Detailed tabs so a litre reads the same everywhere on it.

const r1 = (v: number) => Math.round(v * 10) / 10;

/** "1,234 L" or "12.5 L" — one decimal only when there is one. */
export function Lr(v: number): string {
  const x = r1(v);
  const s = Number.isInteger(x)
    ? x.toLocaleString("en-US")
    : x.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${s} L`;
}

/** Whole pieces. */
export function PC(v: number): string {
  return `${Math.round(v).toLocaleString("en-US")} pcs`;
}

/** A quantity in its own unit, or null when there is nothing (the tables show a dash). */
export function qtyOrNull(v: number | undefined, unit: string): string | null {
  if (!v || Math.abs(v) < 0.0005) return null;
  if (unit === "PIECE") return PC(v);
  const x = r1(v);
  const s = Number.isInteger(x) ? x.toLocaleString("en-US") : x.toFixed(1);
  return `${s} ${unit === "KG" ? "kg" : "L"}`;
}

/** Zero within rounding. */
export const isZero = (v: number) => Math.abs(v) < 0.0005;
