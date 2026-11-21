// Customer complaints — the rules the form, the save action and the tests share.
//
// A complaint is about ONE product on ONE delivery day, and ends in one of:
//
//   REFUND       the customer is credited what they were billed for it
//   REPLACEMENT  the same product is sent again, free, out of stock
//   NONE         recorded only (late delivery, rider behaviour…) — nothing moves
//
// The cap is the whole point. Without it a complaint could refund milk that was
// never delivered, refund a day the rider already took back, or refund the same
// litres twice through two complaints. So a refund or replacement is limited to
//
//   delivered that day − what the rider brought back − what earlier complaints
//   about that same day already refunded or replaced
//
// Pure and framework-free on purpose, so the form previews exactly what the server
// enforces and neither can drift from the other.

import { hasTooManyDecimals, QTY_DECIMALS } from "@/lib/quantity";

/** What went wrong. A plain list, not an enum, so adding one needs no migration. */
export const COMPLAINT_CATEGORIES = [
  "Spoiled milk",
  "Short quantity",
  "Wrong product",
  "Leaking or damaged pack",
  "Late delivery",
  "Not delivered",
  "Rider behaviour",
  "Other",
] as const;

export const COMPLAINT_RESOLUTIONS = ["REFUND", "REPLACEMENT", "NONE"] as const;
export type ComplaintResolutionValue = (typeof COMPLAINT_RESOLUTIONS)[number];

export const RESOLUTION_LABELS: Record<ComplaintResolutionValue, string> = {
  REFUND: "Refund",
  REPLACEMENT: "Replacement",
  NONE: "No compensation",
};

/** InventoryMovement.reason on the stock a replacement takes out. */
export const COMPLAINT_REPLACEMENT_REASON = "Complaint replacement";

export const DESCRIPTION_MAX = 500;

/** What was delivered to one customer, of one product, on one day. */
export type DayProductFigures = {
  /** Quantity actually delivered — not returns, not replacements. */
  delivered: number;
  /** Σ quantity × rate of those deliveries: what the customer was billed. */
  deliveredValue: number;
  /** What the rider brought back that day, which is already credited on its own. */
  riderReturned: number;
  /** Already refunded or replaced by earlier complaints about this same day. */
  alreadyCompensated: number;
};

/** How much of that day's delivery can still be refunded or replaced. */
export function compensableQty(f: DayProductFigures): number {
  return round3(Math.max(0, f.delivered - f.riderReturned - f.alreadyCompensated));
}

/**
 * The rate the customer was actually billed for that day's delivery — not
 * today's price list, which may have changed since. A weighted average only in
 * the rare case one day carried two rates.
 */
export function billedRate(f: DayProductFigures): number {
  return f.delivered > 0 ? round2(f.deliveredValue / f.delivered) : 0;
}

/** What a refund of `qty` at `rate` takes off the bill. */
export function refundValue(qty: number, rate: number): number {
  return round2(Math.max(0, qty) * Math.max(0, rate));
}

export type ComplaintDraft = {
  customerId: string;
  /** "YYYY-MM-DD" of the delivery being complained about. */
  deliveryDate: string;
  /** "YYYY-MM-DD" the complaint was received — the credit is dated here. */
  date: string;
  category: string;
  description: string;
  resolution: string;
  productId?: string | null;
  quantity?: number | null;
};

/** Why this complaint cannot be saved, judged on the form alone. Null when it can. */
export function complaintShapeProblem(d: ComplaintDraft, today: string): string | null {
  if (!d.customerId) return "Choose the customer.";
  if (!isDateStr(d.deliveryDate)) return "Choose the delivery date.";
  if (!isDateStr(d.date)) return "Choose the date the complaint was received.";
  if (d.deliveryDate > today) return "The delivery date can't be in the future.";
  if (d.date > today) return "The complaint date can't be in the future.";
  if (d.date < d.deliveryDate) return "A complaint can't be received before the delivery it is about.";
  if (!(COMPLAINT_CATEGORIES as readonly string[]).includes(d.category)) return "Choose what the complaint is about.";
  const text = (d.description ?? "").trim();
  if (!text) return "Write what the customer said.";
  if (text.length > DESCRIPTION_MAX) return `Keep the details under ${DESCRIPTION_MAX} characters.`;
  if (!(COMPLAINT_RESOLUTIONS as readonly string[]).includes(d.resolution)) {
    return "Choose refund, replacement or no compensation.";
  }
  if (d.resolution === "NONE") return null;
  if (!d.productId) return "Choose which product the complaint is about.";
  const q = Number(d.quantity);
  if (!Number.isFinite(q) || q <= 0) return "Enter a quantity greater than zero.";
  if (hasTooManyDecimals(q)) return `Use at most ${QTY_DECIMALS} decimal places.`;
  return null;
}

/**
 * Why `qty` cannot be refunded or replaced against that day's delivery, or null.
 * `figures` is undefined when nothing of that product was delivered that day.
 */
export function compensationProblem(
  resolution: string,
  qty: number,
  figures: DayProductFigures | undefined,
  productName: string
): string | null {
  if (resolution === "NONE") return null;
  if (!figures || figures.delivered <= 0) {
    return `No ${productName} was delivered to this customer on that day.`;
  }
  const left = compensableQty(figures);
  if (qty > left + 1e-6) {
    return left <= 0
      ? `All of that day's ${productName} has already been returned or compensated.`
      : `Only ${fmtQty(left)} of that day's ${productName} can still be refunded or replaced.`;
  }
  if (resolution === "REFUND" && billedRate(figures) <= 0) {
    return `${productName} was delivered free that day, so there is nothing to refund. Choose a replacement instead.`;
  }
  return null;
}

/** A real calendar "YYYY-MM-DD" — rejects 2026-02-31 as well as garbage. */
export function isDateStr(s: string): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round3(n));
}
