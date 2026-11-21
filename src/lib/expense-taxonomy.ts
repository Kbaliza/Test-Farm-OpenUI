// Single source of truth for the Daily Expenses taxonomy (Type -> Category -> Item).
// Used by the server (to seed ExpenseCategory.type) and the client (dropdowns).

export const EXPENSE_TYPES = [
  "Fixed Asset",
  "Fixed Expense",
  "Liabilities",
  "Variable Expense",
] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];

export type TaxonomyCategory = { name: string; type: ExpenseType };

// Category -> Expense Type
export const TAXONOMY: TaxonomyCategory[] = [
  { name: "Vehicles",       type: "Fixed Asset" },
  { name: "Civil",          type: "Fixed Asset" },
  { name: "Machinery",      type: "Fixed Asset" },
  { name: "Equipment",      type: "Fixed Asset" },
  { name: "Livestock",      type: "Fixed Asset" },

  { name: "Salary",         type: "Fixed Expense" },
  { name: "Rent",           type: "Fixed Expense" },
  { name: "Consultancy",    type: "Fixed Expense" },
  { name: "Other Fixed Expense", type: "Fixed Expense" },

  { name: "Loan Payable",   type: "Liabilities" },
  { name: "Vendor Payable", type: "Liabilities" },
  { name: "Tax Payable",    type: "Liabilities" },
  { name: "Rent Payable",   type: "Liabilities" },

  { name: "Maintenance",    type: "Variable Expense" },
  { name: "Agriculture",    type: "Variable Expense" },
  { name: "Fuel",           type: "Variable Expense" },
  { name: "Labor",          type: "Variable Expense" },
  { name: "Utility",        type: "Variable Expense" },
  { name: "Medicine",       type: "Variable Expense" },
  { name: "Feed",           type: "Variable Expense" },
  { name: "Kitchen",        type: "Variable Expense" },
  { name: "Logistics",      type: "Variable Expense" },
  { name: "Miscellaneous",  type: "Variable Expense" },
  { name: "Packaging",      type: "Variable Expense" },
  { name: "Milk Procurement", type: "Variable Expense" },
  { name: "Marketing",      type: "Variable Expense" },
];

// Static item list per category. Categories not listed here use a special item
// input instead (see the flags below): Salary -> employees, Vendor Payable ->
// vendors, Loan Payable -> free text.
export const CATEGORY_ITEMS: Record<string, string[]> = {
  Vehicles:       ["Delivery Bike", "Delivery Van", "Tractor"],
  Civil:          ["Farm", "Shed", "Retail"],
  Machinery:      ["Agriculture", "Retail"],
  Equipment:      ["Farm", "Agriculture"],
  Livestock:      ["Animal Purchase"],
  Rent:           ["Retail", "Farm", "Agriculture Land"],
  "Other Fixed Expense": ["General Fixed Cost", "Farm Fixed Cost", "Distribution Fixed Cost"],
  "Tax Payable":  ["Company Tax"],
  "Rent Payable": ["Unpaid Farm Rent", "Unpaid Agriculture Land Rent"],
  Maintenance:    ["Vehicles/Machines", "Bike Maintenance", "Generator Maintenance", "Suzuki Maintenance",
                   "Farm Bike Maintenance", "Distribution Van Maintenance", "Distribution Bike Maintenance", "Tractor Maintenance"],
  Agriculture:    ["Sowing", "Harvesting", "Baling", "Seed", "Fertilizer", "Pesticides"],
  Fuel:           ["Retail", "Farm", "Agriculture", "Rider/Bike Fuel", "General Fuel",
                   "Farm Bike Fuel", "Farm Generator", "Generator Fuel", "Distribution Van Fuel", "Distribution Rider Fuel"],
  Labor:          ["Agriculture", "Retail", "Farm"],
  Utility:        ["Farm Bill", "Electricity Bill", "Internet", "Retail Bill", "Gas Cylinder", "Sector J Rent"],
  // "Semen" keeps its existing spelling on purpose — expenses already recorded
  // against it store the item as free text, and renaming would orphan them.
  Medicine:       ["Vaccine", "Semen", "Treatment Medicine", "Veterinary Consultation", "General Medicine"],
  Feed:           ["Wanda", "Hay", "Silage", "Chicken Feed", "General Feed", "Feed Additives", "Toori"],
  Kitchen:        ["Farm", "Desi Ghee", "General Kitchen"],
  Logistics:      ["Freight"],
  Miscellaneous:  ["General Miscellaneous", "Farm Miscellaneous", "Distribution Miscellaneous", "Farm Bilty", "Distribution Bilty"],
  // "Egg Packaging" was "Egg Crates" until 14 Nov 2026 (the owner's rename).
  Packaging:      ["Packaging Material", "Bottles", "Packets", "Egg Packaging"],
  // Outsourced milk and desi ghee are bought from vendors, so they are paid as
  // Vendor Payments; Monthly Expenses shows those payments on these two lines.
  "Milk Procurement": ["Outsourced Milk", "Outsourced Desi Ghee"],
  // Panaflex and Printing were taken off the list on 14 Nov 2026.
  Marketing:      ["Social Media Ads", "Facebook Ads"],
};

/** Items renamed since expenses were recorded under the old name: old -> new, per category. */
export const RENAMED_ITEMS: Record<string, Record<string, string>> = {
  Packaging: { "Egg Crates": "Egg Packaging" },
};

/** The current name of an item, for one recorded under an older name. */
export function currentItemName(category: string, item: string): string {
  return RENAMED_ITEMS[category]?.[item] ?? item;
}

/**
 * The Item dropdown for a category: the fixed list, then the items added from the
 * page — under their current names, each once (several added items have since
 * joined the fixed list).
 */
export function pickerItems(category: string, added: string[] = []): string[] {
  const seen = new Set<string>();
  return [...itemsForCategory(category), ...added.map((i) => currentItemName(category, i))].filter((i) => {
    const k = i.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Categories whose Item is chosen specially (matched by exact category name).
export const SALARY_CATEGORY = "Salary";          // -> employee picker (creates a SalaryPayment)
export const VENDOR_CATEGORY = "Vendor Payable";  // -> vendor picker (reduces vendor bills)
export const FREETEXT_ITEM_CATEGORIES = ["Loan Payable", "Consultancy"]; // -> free-text item

export function categoriesForType(type: string): string[] {
  return TAXONOMY.filter((t) => t.type === type).map((t) => t.name);
}
export function itemsForCategory(name: string): string[] {
  return CATEGORY_ITEMS[name] ?? [];
}
export function isFreeTextItemCategory(name: string): boolean {
  return FREETEXT_ITEM_CATEGORIES.includes(name);
}
