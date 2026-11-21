// The arithmetic of a consignment drop.
//
// Product is left at a shop, and later the shop reports how much of it sold and
// how much expired. A drop can be reported in parts — sold 6, expired 1, and 3
// still on their shelf to ask about next visit — so every line carries running
// totals and "still unaccounted" is always derived, never stored.
//
// Pure and framework-free on purpose: the resolve dialog's live hint and the
// server's rejection must be the SAME function, or the screen offers a number the
// server then refuses. Same rule as src/lib/reconciliation-guard.ts.

import { unitSuffix } from "./units";

export type PlacementLineLike = {
  productName?: string;
  unit?: string;
  /** What was dropped. Never changes. */
  quantity: number;
  /** Reported sold so far, across every resolution of this line. */
  soldQty: number;
  /** Reported expired so far. */
  wastedQty: number;
  rate?: number;
};

/** What is still on their shelf, unreported. */
export function openQty(line: PlacementLineLike): number {
  return round3(Math.max(0, line.quantity - line.soldQty - line.wastedQty));
}

/** True once every line of a drop has been fully accounted for. */
export function isFullyResolved(lines: PlacementLineLike[]): boolean {
  return lines.every((l) => openQty(l) <= 0.000001);
}

/** Value still sitting at the shop, at the agreed shop rate. */
export function openValue(lines: PlacementLineLike[]): number {
  return round2(lines.reduce((s, l) => s + openQty(l) * (l.rate ?? 0), 0));
}

export type ResolutionEntry = {
  /** Which line of the drop this refers to. */
  lineId: string;
  soldQty: number;
  wastedQty: number;
};

export type ResolutionTotals = {
  soldAmount: number;
  /** Revenue forgone: what the shop would have paid for what expired. */
  wastedValue: number;
  /**
   * Money out of pocket: the same quantity at what the stock cost US.
   *
   * Null when any expired line has no cost recorded — a total covering some of
   * the loss and not the rest is worse than showing nothing, because it reads as
   * a complete figure.
   */
  wastedCost: number | null;
  /** Per-line money, in the same order as the entries handed in. */
  amounts: Record<string, number>;
};

/**
 * What a resolution is worth: money owed for the sold part, and the loss on the
 * rest counted twice over — once as revenue forgone at the shop's rate, once as
 * money out of pocket at what it cost us.
 *
 * `costOf` is optional so every existing caller compiles unchanged; without it
 * there is simply no cost figure.
 */
export function resolutionTotals(
  entries: ResolutionEntry[],
  rateOf: (lineId: string) => number,
  costOf?: (lineId: string) => number | null
): ResolutionTotals {
  const amounts: Record<string, number> = {};
  let soldAmount = 0;
  let wastedValue = 0;
  let wastedCost = 0;
  let costKnown = true;
  for (const e of entries) {
    const rate = rateOf(e.lineId) || 0;
    const amt = round2(Math.max(0, e.soldQty) * rate);
    amounts[e.lineId] = amt;
    soldAmount = round2(soldAmount + amt);
    const wasted = Math.max(0, e.wastedQty);
    wastedValue = round2(wastedValue + wasted * rate);
    if (wasted > 0.000001) {
      const cost = costOf?.(e.lineId);
      if (cost == null) costKnown = false;
      else wastedCost = round2(wastedCost + wasted * cost);
    }
  }
  return { soldAmount, wastedValue, wastedCost: costKnown ? wastedCost : null, amounts };
}

/**
 * Why this resolution cannot be recorded, or null when it can.
 *
 * The binding rule is that a shop can never report more than it was actually
 * left with — including everything it has already reported on earlier visits.
 */
export function validateResolution(
  lines: (PlacementLineLike & { id: string })[],
  entries: ResolutionEntry[]
): string | null {
  const byId = new Map(lines.map((l) => [l.id, l] as const));
  let any = false;

  for (const e of entries) {
    const line = byId.get(e.lineId);
    if (!line) return "That line is not part of this drop.";

    const name = line.productName ?? "Product";
    if (!Number.isFinite(e.soldQty) || !Number.isFinite(e.wastedQty)) {
      return `${name}: enter a number for sold and expired.`;
    }
    if (e.soldQty < 0 || e.wastedQty < 0) {
      return `${name}: quantities cannot be negative.`;
    }
    if (e.soldQty > 0.000001 || e.wastedQty > 0.000001) any = true;

    const open = openQty(line);
    if (e.soldQty + e.wastedQty > open + 0.000001) {
      return `${name}: only ${fmtQty(open)}${unitSuffix(line.unit)} is still unaccounted for on this drop.`;
    }
  }

  if (!any) return "Enter how much sold, or how much expired.";
  return null;
}

/** What a shop still owes: every receivable clamped on its own, never netted. */
export function martBalance(receivables: { amount: number; received: number }[]): number {
  return round2(receivables.reduce((s, r) => s + Math.max(0, r.amount - r.received), 0));
}

/**
 * Apply a payment across open receivables, oldest first — the same FIFO the
 * vendor receipts use. Returns what each receivable takes.
 */
export function applyFifo(
  receivables: { id: string; amount: number; received: number }[],
  payment: number
): { id: string; take: number }[] {
  let left = round2(Math.max(0, payment));
  const out: { id: string; take: number }[] = [];
  for (const r of receivables) {
    if (left <= 0.005) break;
    const owed = round2(Math.max(0, r.amount - r.received));
    if (owed <= 0.005) continue;
    const take = Math.min(owed, left);
    out.push({ id: r.id, take: round2(take) });
    left = round2(left - take);
  }
  return out;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

function fmtQty(n: number): string {
  return n % 1 === 0 ? n.toFixed(0) : String(round3(n));
}

