// Product units, in one place.
//
// The rule used to live in ~39 separate copies across the app — object maps and
// ternary chains — each of which returned `undefined` or fell through to "pc" for
// any unit it had not been told about. Adding a unit meant finding all 39. This is
// the single home for the rule, imported by both the browser and the server so a
// label can never disagree with itself.
//
// Deliberately does NOT value-import @prisma/client: this module is pulled into
// client components, and importing the Prisma runtime there bloats the bundle. The
// tuple below is pinned to Prisma's enum by a type-only check, so the two cannot
// drift without the compiler saying so.

import type { ProductUnit } from "@prisma/client";

export const UNITS = ["LITER", "KG", "PIECE", "MILLILITER", "GRAM"] as const;
export type Unit = (typeof UNITS)[number];

// Never executed. If someone adds a value to the Prisma enum and not to UNITS
// (or vice versa), `tsc --noEmit` fails here rather than at some render site.
const _unitsMatchPrisma: Record<ProductUnit, true> = {
  LITER: true,
  KG: true,
  PIECE: true,
  MILLILITER: true,
  GRAM: true,
};
void _unitsMatchPrisma;

/**
 * Units sold as packs: a bottle of 250 ml, a sachet of 500 g. The quantity typed
 * is the NUMBER OF PACKS, never the millilitres — so 40 means forty bottles.
 */
export const PACK_UNITS: readonly Unit[] = ["MILLILITER", "GRAM"];

export function isPackUnit(unit: string | null | undefined): boolean {
  return unit === "MILLILITER" || unit === "GRAM";
}

const LABELS: Record<Unit, string> = {
  LITER: "L",
  KG: "kg",
  PIECE: "pc",
  MILLILITER: "ml",
  GRAM: "g",
};

/**
 * The short label. Passes an already-shortened value straight through, so rows
 * written before units were stored as the enum ("L", "kg", "pc") still render.
 */
export function unitLabel(unit: string | null | undefined): string {
  if (!unit) return "";
  return LABELS[unit as Unit] ?? unit;
}

/** The same label with a leading space, for the many "12 L" message builders. */
export function unitSuffix(unit: string | null | undefined): string {
  const l = unitLabel(unit);
  return l ? ` ${l}` : "";
}

/** "Milliliter (ml)" — for the unit picker in the products admin. */
export function unitOptionLabel(unit: Unit): string {
  const names: Record<Unit, string> = {
    LITER: "Liter",
    KG: "Kilogram",
    PIECE: "Piece",
    MILLILITER: "Milliliter",
    GRAM: "Gram",
  };
  return `${names[unit]} (${LABELS[unit]})`;
}

/** Display order: the farm's own units first, then packs. */
export function unitSortOrder(unit: string | null | undefined): number {
  const i = UNITS.indexOf(unit as Unit);
  return i === -1 ? UNITS.length : i;
}

/** What a pack unit is measured in once converted: ml → L, g → kg. */
export function baseUnitOf(unit: string | null | undefined): Unit | null {
  if (unit === "MILLILITER") return "LITER";
  if (unit === "GRAM") return "KG";
  return (UNITS.includes(unit as Unit) ? (unit as Unit) : null);
}

/**
 * Packs → litres/kilograms. Returns null when it cannot be known (a pack unit with
 * no size recorded), so a caller shows nothing rather than "NaN L".
 *
 * This is display only. NOTHING sums this into a stored figure — every quantity in
 * the database is a pack count, and every price is per pack.
 */
export function toBaseQuantity(
  unit: string | null | undefined,
  packSize: number | null | undefined,
  packCount: number
): number | null {
  if (!isPackUnit(unit)) return packCount;
  if (packSize == null || !Number.isFinite(packSize) || packSize <= 0) return null;
  return round3((packCount * packSize) / 1000);
}

/**
 * What one unit of price is: a pack product is priced per PACK, not per
 * millilitre, so "₨ 120/ml" would be a lie on an invoice or a rate label.
 */
export function perUnitLabel(unit: string | null | undefined): string {
  return isPackUnit(unit) ? "pack" : unitLabel(unit);
}

/** "40 packs" for a pack product, "12 L" for anything else. */
export function qtyLabel(unit: string | null | undefined, qty: number): string {
  if (isPackUnit(unit)) return `${trim(qty)} ${qty === 1 ? "pack" : "packs"}`;
  return `${trim(qty)}${unitSuffix(unit)}`;
}

/** "250 ml" */
export function packLabel(unit: string | null | undefined, packSize: number | null | undefined): string {
  if (!isPackUnit(unit) || packSize == null) return "";
  return `${trim(packSize)} ${unitLabel(unit)}`;
}

/** "250 ml × 40" */
export function packQtyLabel(
  unit: string | null | undefined,
  packSize: number | null | undefined,
  qty: number
): string {
  const p = packLabel(unit, packSize);
  return p ? `${p} × ${trim(qty)}` : `${trim(qty)}${unitSuffix(unit)}`;
}

/** "10 L" — the volume those packs add up to, or null when it cannot be derived. */
export function equivalentLabel(
  unit: string | null | undefined,
  packSize: number | null | undefined,
  qty: number
): string | null {
  if (!isPackUnit(unit)) return null;
  const base = toBaseQuantity(unit, packSize, qty);
  if (base == null) return null;
  return `${trim(base)} ${unitLabel(baseUnitOf(unit))}`;
}

/** Why this pack size cannot be saved, or null when it is fine. */
export function packSizeProblem(
  unit: string | null | undefined,
  packSize: number | null | undefined
): string | null {
  if (isPackUnit(unit)) {
    if (packSize == null || !Number.isFinite(packSize) || packSize <= 0) {
      return `Enter the pack size in ${unitLabel(unit)} — for example 250.`;
    }
    return null;
  }
  if (packSize != null) return "Pack size only applies to products sold in ml or g.";
  return null;
}

function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

function trim(n: number): string {
  return n % 1 === 0 ? n.toFixed(0) : String(round3(n));
}
