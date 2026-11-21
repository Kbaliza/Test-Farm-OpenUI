// Which department an expense line belongs to: the Farm, Distribution (getting
// the milk to customers — riders, vans, packaging, the retail end), or
// Agriculture (the fields: tractor, seed, fertilizer, harvesting).
//
// Decided per LINE — a category and one of its items — not per category, because
// a category often serves more than one: Fuel's "Distribution Rider Fuel" is
// distribution while its "Farm Bike Fuel" is the farm's. A line nobody has
// assigned falls back to the defaults below; any assignment made on the Monthly
// Expenses page is kept in AppSetting (DEPARTMENTS_KEY) and wins.
//
// Only WHERE a line is shown changes here — never an expense, a budget or an amount.

export const DEPARTMENTS = ["Farm", "Distribution", "Agriculture"] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const isDepartment = (v: unknown): v is Department => (DEPARTMENTS as readonly unknown[]).includes(v);

export const DEPARTMENTS_KEY = "expenses.departments";

/** One budget/spend line: a category, and an item inside it ("" = the category as a whole). */
export const lineKey = (category: string, item: string) => `${category}›${item}`;

// Lines that are not the Farm's unless someone says otherwise. A department =
// every item in the category; a map = just those items. Anything not here is Farm.
// The owner's sheet of 9 Nov 2026 set the Distribution and Agriculture lines; the
// list of 14 Nov 2026 moved Internet to the Farm, put agriculture fuel and the
// generator fuel under Agriculture, and split the salaries three ways.
const DEFAULTS: Record<string, Department | Record<string, Department>> = {
  Fuel: {
    Retail: "Distribution",
    "Rider/Bike Fuel": "Distribution",
    "Distribution Van Fuel": "Distribution",
    "Distribution Rider Fuel": "Distribution",
    Agriculture: "Agriculture",
    "Generator Fuel": "Agriculture",
  },
  Maintenance: {
    "Bike Maintenance": "Distribution",
    "Suzuki Maintenance": "Distribution",
    "Distribution Van Maintenance": "Distribution",
    "Distribution Bike Maintenance": "Distribution",
    "Tractor Maintenance": "Agriculture",
  },
  Vehicles: { "Delivery Bike": "Distribution", "Delivery Van": "Distribution" },
  Utility: { "Retail Bill": "Distribution", "Gas Cylinder": "Distribution", "Sector J Rent": "Distribution" },
  Labor: { Retail: "Distribution" },
  Rent: { Retail: "Distribution" },
  Civil: { Retail: "Distribution" },
  Machinery: { Retail: "Distribution" },
  Miscellaneous: { "Distribution Miscellaneous": "Distribution", "Distribution Bilty": "Distribution" },
  "Other Fixed Expense": { "Distribution Fixed Cost": "Distribution" },
  Agriculture: "Agriculture",
  Packaging: "Distribution",
  Logistics: "Distribution",
  Marketing: "Distribution",
  "Milk Procurement": "Distribution",
  // Each employee's pay lands on their department's line — see salaryLineFor.
  Salary: { "Distribution Salaries": "Distribution", "Agriculture Salaries": "Agriculture" },
  "Loan Payable": "Distribution",
};

export function defaultDepartment(category: string, item: string): Department {
  const d = DEFAULTS[category];
  if (typeof d === "string") return d;
  return d?.[item] ?? "Farm";
}

export function departmentOf(category: string, item: string, saved: Record<string, string>): Department {
  const s = saved[lineKey(category, item)];
  return isDepartment(s) ? s : defaultDepartment(category, item);
}
