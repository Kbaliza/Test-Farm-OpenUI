// The part of the business a staff member works in. Browser- and server-safe
// (no database import), so the Staff form, the Attendance filter and the server
// checks all read the same list.
//
// Stored as a plain string on Employee.category rather than a database enum, so
// adding a category later is a one-line change here with no migration.

export const STAFF_CATEGORIES = [
  { id: "AGRICULTURE", label: "Agriculture" },
  { id: "RETAIL", label: "Retail" },
  { id: "FARM", label: "Farm" },
] as const;

export type StaffCategory = (typeof STAFF_CATEGORIES)[number]["id"];

export const STAFF_CATEGORY_IDS: readonly string[] = STAFF_CATEGORIES.map((c) => c.id);

export function isStaffCategory(v: unknown): v is StaffCategory {
  return typeof v === "string" && STAFF_CATEGORY_IDS.includes(v);
}

export function staffCategoryLabel(v: string | null | undefined): string {
  return STAFF_CATEGORIES.find((c) => c.id === v)?.label ?? "Not set";
}
