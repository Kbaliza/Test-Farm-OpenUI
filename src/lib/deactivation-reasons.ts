// Single source of truth for the customer deactivation reasons.
// Used by the Deactivate dialog (dropdown) and the Lost Customers reason filter,
// so every deactivated customer carries a consistent, filterable reason.

export const DEACTIVATION_REASONS = [
  "Away Temporarily - Return Date Given",
  "Stopped - Poor Service",
  "Stopped - Poor Milk Quality",
  "No Reason Given",
  "Stock Full - Short Break",
  "Moving Out of City",
  "Going Abroad - Return Unknown",
  "Defaulter",
  "Recovery",
] as const;

export type DeactivationReason = (typeof DEACTIVATION_REASONS)[number];

// Default when a manager deactivates without picking anything specific.
export const NO_REASON: DeactivationReason = "No Reason Given";

// ── Auto-deactivation ─────────────────────────────────────────────────────────
// A customer who was once active (has at least one past delivery) but hasn't been
// delivered any product for this many days is moved to Lost automatically.
export const AUTO_DEACTIVATE_DAYS = 20;

// System-set reason, kept out of the manual dropdown but shown in the Lost filter.
export const AUTO_DEACTIVATION_REASON = "No Delivery in 20+ Days (Auto)";

// Every reason a lost customer can carry (manual + system) — used by the filter.
export const ALL_DEACTIVATION_REASONS = [
  ...DEACTIVATION_REASONS,
  AUTO_DEACTIVATION_REASON,
] as const;

// Normalize an arbitrary stored value to one of the fixed reasons (empty/unknown
// → "No Reason Given"), so the filter buckets stay clean.
export function normalizeReason(reason?: string | null): DeactivationReason {
  const r = (reason ?? "").trim();
  return (DEACTIVATION_REASONS as readonly string[]).includes(r) ? (r as DeactivationReason) : NO_REASON;
}
