// What the farm sells that is not milk: an animal, a machine, feed, scrap.
//
// Single source of truth for the Farm Sales taxonomy (Category → units, suggested
// items, and the extra details each category asks for). Used by the browser to
// drive its dropdowns AND by the server to validate what comes back, so the two
// can never disagree about which units a category allows.
//
// Pure on purpose — no "server-only", no database import — exactly like
// expense-taxonomy.ts, so a client component can import it directly.
//
// The item list is a SUGGESTION, not a constraint: a farm sells things nobody
// listed. Category and unit ARE constrained, because they decide how the line
// reads and are stored as plain text.

export type FarmSaleField = {
  /** Key this value is stored under in FarmSaleLine.details. */
  k: string;
  label: string;
  type?: "text" | "number";
  /** When present the field is a fixed choice rather than free text. */
  options?: string[];
};

export type FarmSaleCategory = {
  key: string;
  label: string;
  units: string[];
  items: string[];
  fields: FarmSaleField[];
  /** Animals get a tag number, and it is the one detail stored in its own column
   *  (FarmSaleLine.animalTag) so a herd register could later join on it. */
  hasTag?: boolean;
};

export const FARM_SALE_CATEGORIES: FarmSaleCategory[] = [
  {
    key: "animal",
    label: "Animal",
    units: ["head"],
    items: [
      "Buffalo (Nili-Ravi)", "Buffalo (Kundi)", "Cow (Sahiwal)", "Cow (HF cross)",
      "Heifer", "Calf — male", "Calf — female", "Bull", "Goat",
    ],
    fields: [
      { k: "weight", label: "Weight (kg)", type: "number" },
      { k: "status", label: "Status", options: ["Dry", "In milk", "Pregnant", "Young stock"] },
    ],
    hasTag: true,
  },
  {
    key: "machinery",
    label: "Machinery",
    units: ["unit"],
    items: [
      "Chaff cutter", "Milking machine", "Fodder chopper", "Water pump",
      "Tractor implement", "Generator", "Milk chiller",
    ],
    fields: [
      { k: "model", label: "Make / model" },
      { k: "serial", label: "Serial / reg no." },
      { k: "condition", label: "Condition", options: ["Used", "New", "Scrap"] },
    ],
  },
  {
    key: "feed",
    label: "Feed & fodder",
    units: ["kg", "ton", "trolley", "bag"],
    items: [
      "Silage", "Wanda (concentrate)", "Toori (wheat straw)",
      "Green fodder", "Hay bale", "Maize grain",
    ],
    fields: [
      { k: "batch", label: "Pit / batch" },
      { k: "moisture", label: "Moisture %", type: "number" },
    ],
  },
  {
    key: "other",
    label: "Other",
    units: ["unit", "kg", "trolley"],
    items: ["Manure (gobar)", "Empty drums", "Scrap metal", "Used tyres"],
    fields: [{ k: "note", label: "Detail" }],
  },
];

/** How the buyer is identified. A walk-in has no account, so it must pay in full —
 *  which every farm sale does anyway, since there is no credit path at all. */
export const FARM_SALE_BUYER_TYPES = ["VENDOR", "CASH"] as const;
export type FarmSaleBuyerType = (typeof FARM_SALE_BUYER_TYPES)[number];

/** Ledger entity id standing for every cash walk-in, so those sales are reachable. */
export const FARM_SALE_WALKIN = "__walkin__";

export function farmSaleCategory(key: string): FarmSaleCategory | undefined {
  return FARM_SALE_CATEGORIES.find((c) => c.key === key);
}

export function isFarmSaleCategory(key: string): boolean {
  return FARM_SALE_CATEGORIES.some((c) => c.key === key);
}

export function categoryLabel(key: string): string {
  return farmSaleCategory(key)?.label ?? key;
}

export function unitsFor(key: string): string[] {
  return farmSaleCategory(key)?.units ?? [];
}

/** A unit is only valid for the category that offers it — "head" is not a feed unit. */
export function isValidUnit(category: string, unit: string): boolean {
  return unitsFor(category).includes(unit);
}

export function itemsFor(key: string): string[] {
  return farmSaleCategory(key)?.items ?? [];
}

export function detailFieldsFor(key: string): FarmSaleField[] {
  return farmSaleCategory(key)?.fields ?? [];
}

export function categoryHasTag(key: string): boolean {
  return farmSaleCategory(key)?.hasTag === true;
}

/**
 * Turns a category's detail answers into what gets stored, dropping blanks so an
 * untouched field is absent rather than an empty string. Returns null when nothing
 * was filled in, so `details` stays NULL instead of `{}`.
 */
export function cleanDetails(
  category: string,
  raw: Record<string, string> | undefined | null
): Record<string, string> | null {
  if (!raw) return null;
  const allowed = new Set(detailFieldsFor(category).map((f) => f.k));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k)) continue; // ignore anything the category never asked for
    const t = String(v ?? "").trim();
    if (t) out[k] = t;
  }
  return Object.keys(out).length ? out : null;
}

/** "Weight (kg): 420 · Status: Dry" — one wording for the invoice and the ledger. */
export function describeDetails(
  category: string,
  details: Record<string, string> | null | undefined
): string {
  if (!details) return "";
  return detailFieldsFor(category)
    .filter((f) => details[f.k])
    .map((f) => `${f.label}: ${details[f.k]}`)
    .join(" · ");
}
