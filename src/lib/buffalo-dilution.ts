// Standardising buffalo milk with cow milk.
//
// Buffalo milk comes off the animal too rich to sell, so cow milk is stirred in
// before anything else happens to it. No milk is created or lost — it moves
// between two products:
//
//   buffalo: 100 produced  +10 added  = 110 prepared (what everything downstream uses)
//   cow:     100 produced  −10 given  =  90 left
//
// Both numbers are kept on purpose: the farm still needs to know what the animals
// actually gave, separately from what was made ready for the day.
//
// Pure and framework-free, so the form, the save action and the tests all agree.

import { splitMixSource } from "@/lib/mix-milk-source";

/** Cow milk taken from TODAY'S dispatch to packaging. */
export const DILUTION_REASON = "Buffalo dilution";
/** Cow milk taken from inventory on-hand stock. */
export const DILUTION_REASON_STORAGE = "Buffalo dilution (storage)";
/** Both, for the queries that mean "any dilution movement". */
export const DILUTION_REASONS = [DILUTION_REASON, DILUTION_REASON_STORAGE] as const;

/**
 * Split the cow milk across the two pools, INVENTORY FIRST.
 *
 * Buffalo has no such split and must not get one: what sits in inventory is
 * milk that has ALREADY been standardised, so drawing the buffalo base from
 * stock would dilute milk that was diluted once already. Buffalo is only ever
 * the day's production. Cow is the thing being added, so it can come from
 * either — and on a day the cows gave nothing, inventory is the only source
 * there is.
 *
 * Oldest milk first is the same rule mix milk follows (splitMixSource), and
 * this delegates to it rather than restating it: two copies of a stock-ordering
 * rule is exactly how they come to disagree.
 */
export function splitDilutionSource(
  requested: number,
  packagingAvailable: number,
  storageAvailable: number
): { fromPackaging: number; fromStorage: number } {
  return splitMixSource(requested, packagingAvailable, storageAvailable);
}

/** What the buffalo milk becomes once the cow milk is stirred in. */
export function preparedBuffalo(buffaloProduced: number, cowAdded: number): number {
  return round3(Math.max(0, buffaloProduced) + Math.max(0, cowAdded));
}

/** What is left of the cow milk after giving some away. */
export function cowLeft(cowAvailable: number, cowAdded: number): number {
  return round3(Math.max(0, cowAvailable) - Math.max(0, cowAdded));
}

/**
 * Why this dilution cannot be recorded, or null when it can.
 *
 * The only real constraint is that the cow milk has to exist: `cowAvailable` is
 * what is left after everything else already drawn from the day (skim, yoghurt,
 * calf, kitchen, wastage, and milk already dispatched), so the same litres can
 * never be given away twice.
 */
export function dilutionProblem(args: {
  cowAdded: number;
  /** Today's dispatch plus inventory — the two together are what may be used. */
  cowAvailable: number;
  cowName?: string;
}): string | null {
  const { cowAdded, cowAvailable } = args;
  const cowName = args.cowName ?? "Cow Milk";

  if (!Number.isFinite(cowAdded)) return "Enter how much cow milk to add.";
  if (cowAdded <= 0) return "Enter a cow milk quantity greater than zero.";
  if (cowAdded < 0) return `${cowName}: quantity cannot be negative.`;
  if (cowAdded > cowAvailable + 0.001) {
    return `${cowName}: only ${fmt(cowAvailable)} L is available — cannot add ${fmt(cowAdded)} L to the buffalo milk.`;
  }
  return null;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fmt(n: number): string {
  const v = Math.max(0, n);
  return v % 1 === 0 ? v.toFixed(0) : String(round3(v));
}
