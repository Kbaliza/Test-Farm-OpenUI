// How Monthly Expenses turns expenses into lines. A line is a category and an
// item ("" = the category as a whole) — the same key budgets are saved under and
// departments are assigned to (see expense-departments.ts). This file decides:
//
//   • which line an expense or a salary payment lands on;
//   • which lines exist at all, so a line nobody spent on this month still shows
//     with 0 (the owner's list of 14 Nov 2026);
//   • where a line is SHOWN when that is not under its own category — the
//     consultant under Salary, Animal Purchase under Other Fixed Expense.
//
// Only where things are shown changes here. No expense, budget or amount does.

import { CATEGORY_ITEMS, SALARY_CATEGORY, currentItemName } from "./expense-taxonomy";

export const VENDOR_PAYMENT_CATEGORY = "Vendor Payment";
export const MILK_PROCUREMENT_CATEGORY = "Milk Procurement";
export const OUTSOURCED_MILK = "Outsourced Milk";
export const OUTSOURCED_DESI_GHEE = "Outsourced Desi Ghee";

/** Salary is split by the employee's department, one line each. */
export const SALARY_LINES = ["Farm Salaries", "Distribution Salaries", "Agriculture Salaries"] as const;

/**
 * Which salary line an employee's pay goes on. Their category on the employee
 * record decides (FARM / RETAIL / AGRICULTURE); someone with none set is placed
 * by their role, and failing that on the Farm.
 */
export function salaryLineFor(emp: { category: string | null; role: string | null } | null | undefined): string {
  const cat = (emp?.category ?? "").toUpperCase();
  if (cat === "FARM") return "Farm Salaries";
  if (cat === "RETAIL" || cat === "DISTRIBUTION") return "Distribution Salaries";
  if (cat === "AGRICULTURE") return "Agriculture Salaries";
  const role = emp?.role ?? "";
  if (/rider|conductor|distribution|retail|delivery|customer service/i.test(role)) return "Distribution Salaries";
  if (/agri|field|tractor/i.test(role)) return "Agriculture Salaries";
  return "Farm Salaries";
}

/** What a vendor sells us, as far as payments to them are concerned. */
export type VendorKind = "milk" | "ghee" | null;

/** A vendor's kind from what they have sold us most (a product name), else from their name. */
export function vendorKind(topProduct: string | null | undefined, vendorName: string): VendorKind {
  const p = topProduct ?? "";
  if (/ghee/i.test(p)) return "ghee";
  if (/milk|buffalo/i.test(p)) return "milk";
  if (/ghee/i.test(vendorName)) return "ghee";
  if (/milk|dairy|dairies/i.test(vendorName)) return "milk";
  return null;
}

/**
 * The line a vendor payment lands on: milk and desi ghee bought in go to
 * Milk Procurement's two lines; any other vendor gets a line of its own.
 */
export function vendorPaymentLine(kind: VendorKind, vendorName: string | null): { category: string; item: string } {
  if (kind === "milk") return { category: MILK_PROCUREMENT_CATEGORY, item: OUTSOURCED_MILK };
  if (kind === "ghee") return { category: MILK_PROCUREMENT_CATEGORY, item: OUTSOURCED_DESI_GHEE };
  return { category: VENDOR_PAYMENT_CATEGORY, item: vendorName ?? "" };
}

/** Categories split into lines by item in Monthly Expenses. */
export function itemisedInReport(category: string): boolean {
  return category === SALARY_CATEGORY || category === VENDOR_PAYMENT_CATEGORY || (CATEGORY_ITEMS[category]?.length ?? 0) > 0;
}

/** The line an ordinary expense lands on, from its category and recorded item. */
export function expenseLine(category: string, item: string | null): { category: string; item: string } {
  return { category, item: itemisedInReport(category) ? currentItemName(category, item ?? "") : "" };
}

/**
 * Every line a category has, spent on or not: the fixed items, the ones added
 * from the Daily Expenses page, or the category itself when it has no items.
 * Vendor Payment has none of its own — its lines are the vendors actually paid.
 */
export function categoryLines(category: string, extraItems: Record<string, string[]>): string[] {
  if (category === VENDOR_PAYMENT_CATEGORY) return [];
  if (category === SALARY_CATEGORY) return [...SALARY_LINES];
  const items = [...(CATEGORY_ITEMS[category] ?? []), ...(extraItems[category] ?? []).map((i) => currentItemName(category, i))];
  if (!items.length) return [""];
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = i.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Lines shown under another category than their own, with the name they show as.
const SHOWN_UNDER: Record<string, { group: string; label: string }> = {
  "Consultancy›": { group: SALARY_CATEGORY, label: "Consultant" },
  "Livestock›Animal Purchase": { group: "Other Fixed Expense", label: "Animal Purchase" },
};

/** Where a line is shown in Monthly Expenses, and what it is called there. */
export function shownUnder(category: string, item: string): { group: string; label: string } {
  const s = SHOWN_UNDER[`${category}›${item}`];
  if (s) return s;
  return { group: category, label: item || (itemisedInReport(category) ? "Not itemised" : category) };
}
