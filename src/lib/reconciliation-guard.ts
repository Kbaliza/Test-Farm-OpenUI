// The rule that decides whether an admin's correction to a day's farm numbers is
// allowed. Deliberately pure and framework-free so the SAME rule runs in the
// browser (live warning while typing) and on the server (the decision that
// actually counts). Duplicating it would let the two drift and let a value the
// form accepted be rejected by the server, or worse, the other way round.

export type DayUsageSnapshot = {
  name: string;
  unit: string;
  /** PRODUCED rows owned by a batch (mix/yoghurt made at packaging) — not editable. */
  producedLinked: number;
  yoghurtUse: number;
  skimUse: number;
  wastage: number;
  dispatched: number;
};

export type DayEditInput = {
  produced: number;
  calfUse: number;
  kitchenUse: number;
};

export function unitLabel(unit: string): string {
  return unit === "LITER" ? "L" : unit === "KG" ? "kg" : "";
}

/** Consumption the admin cannot lower from this screen (batch- and dispatch-owned). */
export function lockedUse(u: DayUsageSnapshot): number {
  return u.yoghurtUse + u.skimUse + u.wastage + u.dispatched;
}

/** The smallest `produced` this day can be set to, given what is already locked. */
export function minProduced(u: DayUsageSnapshot): number {
  return Math.max(0, lockedUse(u) - u.producedLinked);
}

/**
 * Returns a human-readable conflict, or null when the edit is allowed.
 * The rule: total production for the day (what the admin types, plus anything a
 * batch made) must cover everything already drawn from that day.
 */
export function validateDayEdit(u: DayUsageSnapshot, e: DayEditInput): string | null {
  const unit = unitLabel(u.unit);
  if ([e.produced, e.calfUse, e.kitchenUse].some((n) => !Number.isFinite(n) || n < 0)) {
    return `${u.name}: quantities must be zero or more.`;
  }

  const locked = lockedUse(u);
  const used = e.calfUse + e.kitchenUse + locked;
  const totalProduced = e.produced + u.producedLinked;
  // Tolerance: these are decimals coming back from Postgres.
  if (totalProduced >= used - 1e-9) return null;

  const parts: string[] = [];
  if (u.dispatched) parts.push(`${u.dispatched}${unit} dispatched to packaging`);
  if (u.skimUse) parts.push(`${u.skimUse}${unit} used by skim milk`);
  if (u.yoghurtUse) parts.push(`${u.yoghurtUse}${unit} used by yoghurt`);
  if (u.wastage) parts.push(`${u.wastage}${unit} wastage`);
  if (e.calfUse) parts.push(`${e.calfUse}${unit} calf use`);
  if (e.kitchenUse) parts.push(`${e.kitchenUse}${unit} kitchen use`);
  const linkedNote = u.producedLinked ? ` (plus ${u.producedLinked}${unit} made by a batch)` : "";

  return (
    `${u.name}: you entered ${e.produced}${unit} produced${linkedNote}, but ${used}${unit} is already ` +
    `accounted for that day — ${parts.join(", ")}. Lower those first, or keep production at ` +
    `${Math.max(0, used - u.producedLinked)}${unit} or more.`
  );
}

// Reasons that mark a movement as belonging to a processing batch rather than to
// plain farm production. Those rows are owned by SkimMilkBatch / MixMilkBatch /
// YoghurtBatch and must never be rewritten by the reconciliation editor.
//
// Lives here, not in the production actions module: that file is "use server", and
// Next only allows async function exports from one — a plain const there fails the
// production build (which `tsc --noEmit` does not catch).
export const BATCH_REASONS = [
  "Skim milk processing",
  "Mix milk processing",
  "Mix milk processing (storage)",
  "Yoghurt processing",
  // Both sides of a buffalo standardisation entry. Like mix milk, it happens AT
  // packaging out of milk that was already dispatched, so these rows never belong
  // to the farm's own production for the day.
  "Buffalo dilution",
] as const;
