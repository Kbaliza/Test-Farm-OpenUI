import { describe, it, expect } from "vitest";
import {
  TAXONOMY, CATEGORY_ITEMS, EXPENSE_TYPES,
  categoriesForType, itemsForCategory, isFreeTextItemCategory,
  SALARY_CATEGORY, VENDOR_CATEGORY,
} from "@/lib/expense-taxonomy";

// The farm's "Quick Expense Head Mapping" sheet, transcribed. Every head the owners
// use day to day must land on a category that exists, with the right expense type,
// and an item that is actually offered — otherwise the head cannot be recorded at
// all. Encoding the sheet here means editing the taxonomy can never silently break
// one of them.
const QUICK_HEADS: { head: string; type: string; category: string; item: string }[] = [
  { head: "Chicken Feed",       type: "Variable Expense", category: "Feed",                item: "Chicken Feed" },
  { head: "Rider Fuel",         type: "Variable Expense", category: "Fuel",                item: "Rider/Bike Fuel" },
  { head: "Animal Purchase",    type: "Fixed Asset",      category: "Livestock",           item: "Animal Purchase" },
  { head: "Bike Maintenance",   type: "Variable Expense", category: "Maintenance",         item: "Bike Maintenance" },
  { head: "Bilti",              type: "Variable Expense", category: "Logistics",           item: "Freight" },
  { head: "Desi Ghee",          type: "Variable Expense", category: "Kitchen",             item: "Desi Ghee" },
  { head: "Fix Cost",           type: "Fixed Expense",    category: "Other Fixed Expense", item: "General Fixed Cost" },
  { head: "Fuel",               type: "Variable Expense", category: "Fuel",                item: "General Fuel" },
  { head: "Generator",          type: "Variable Expense", category: "Maintenance",         item: "Generator Maintenance" },
  { head: "Internet Bundle",    type: "Variable Expense", category: "Utility",             item: "Internet" },
  { head: "Kitchen",            type: "Variable Expense", category: "Kitchen",             item: "General Kitchen" },
  { head: "Medicine",           type: "Variable Expense", category: "Medicine",            item: "General Medicine" },
  { head: "Misc",               type: "Variable Expense", category: "Miscellaneous",       item: "General Miscellaneous" },
  { head: "Packaging",          type: "Variable Expense", category: "Packaging",           item: "Packaging Material" },
  { head: "Semen",              type: "Variable Expense", category: "Medicine",            item: "Semen" },
  { head: "Shed",               type: "Fixed Asset",      category: "Civil",               item: "Shed" },
  { head: "Silage",             type: "Variable Expense", category: "Feed",                item: "Silage" },
  { head: "Suzuki Maintenance", type: "Variable Expense", category: "Maintenance",         item: "Suzuki Maintenance" },
  { head: "Vaccine",            type: "Variable Expense", category: "Medicine",            item: "Vaccine" },
  { head: "Wanda",              type: "Variable Expense", category: "Feed",                item: "Wanda" },
  { head: "Feed",               type: "Variable Expense", category: "Feed",                item: "General Feed" },
  { head: "Consultation",       type: "Variable Expense", category: "Medicine",            item: "Veterinary Consultation" },
  { head: "Cylinder",           type: "Variable Expense", category: "Utility",             item: "Gas Cylinder" },
  { head: "Milk Outsource",     type: "Variable Expense", category: "Milk Procurement",    item: "Outsourced Milk" },
];

// These three heads do not use the static item list, so they are checked separately:
//   Salary / Van Monthly Driver -> an EMPLOYEE is picked (writes a SalaryPayment)
//   Loan                        -> free-text item
const SPECIAL_HEADS = [
  { head: "Salary",             type: "Fixed Expense", category: "Salary" },
  { head: "Van Monthly Driver", type: "Fixed Expense", category: "Salary" },
  { head: "Loan",               type: "Liabilities",   category: "Loan Payable" },
];

const typeOf = (name: string) => TAXONOMY.find((t) => t.name === name)?.type;

describe("every quick expense head can actually be recorded", () => {
  it.each(QUICK_HEADS)("$head -> $category / $item", ({ type, category, item }) => {
    expect(typeOf(category), `category "${category}" is missing`).toBe(type);
    expect(itemsForCategory(category), `item "${item}" is missing from "${category}"`).toContain(item);
  });

  it.each(SPECIAL_HEADS)("$head -> $category (item picked another way)", ({ type, category }) => {
    expect(typeOf(category), `category "${category}" is missing`).toBe(type);
  });

  it("the heads that pick an item another way still do", () => {
    // Salary resolves its item from the employee list, Loan Payable from free text.
    // If either lost that behaviour, those heads would need a static item instead.
    expect(SALARY_CATEGORY).toBe("Salary");
    expect(isFreeTextItemCategory("Loan Payable")).toBe(true);
    expect(itemsForCategory("Salary")).toHaveLength(0);
    expect(itemsForCategory("Loan Payable")).toHaveLength(0);
  });
});

describe("the taxonomy stays coherent", () => {
  it("every category has a known type", () => {
    for (const c of TAXONOMY) expect(EXPENSE_TYPES).toContain(c.type);
  });

  it("no category name is listed twice", () => {
    const names = TAXONOMY.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every item list belongs to a real category", () => {
    // A typo'd key here would silently offer no items at all.
    for (const key of Object.keys(CATEGORY_ITEMS)) {
      expect(TAXONOMY.some((c) => c.name === key), `"${key}" is not a category`).toBe(true);
    }
  });

  it("no category offers the same item twice", () => {
    for (const [name, items] of Object.entries(CATEGORY_ITEMS)) {
      expect(new Set(items).size, name).toBe(items.length);
    }
  });

  it("the two specially-handled categories have no static items", () => {
    expect(CATEGORY_ITEMS[SALARY_CATEGORY]).toBeUndefined();
    expect(CATEGORY_ITEMS[VENDOR_CATEGORY]).toBeUndefined();
  });

  it("each type still offers categories in the picker", () => {
    for (const t of EXPENSE_TYPES) expect(categoriesForType(t).length).toBeGreaterThan(0);
  });
});

describe("nothing that already existed was dropped", () => {
  it("keeps every category that was there before", () => {
    for (const name of [
      "Vehicles", "Civil", "Machinery", "Equipment",
      "Salary", "Rent",
      "Loan Payable", "Vendor Payable", "Tax Payable", "Rent Payable",
      "Maintenance", "Agriculture", "Fuel", "Labor", "Utility", "Medicine", "Feed", "Kitchen",
    ]) {
      expect(TAXONOMY.some((c) => c.name === name), name).toBe(true);
    }
  });

  it("keeps every item that was there before", () => {
    for (const [cat, items] of Object.entries({
      Vehicles: ["Delivery Bike", "Delivery Van", "Tractor"],
      Civil: ["Farm", "Shed", "Retail"],
      Maintenance: ["Vehicles/Machines"],
      Fuel: ["Retail", "Farm", "Agriculture"],
      Utility: ["Farm Bill", "Retail Bill"],
      Medicine: ["Vaccine", "Semen", "Treatment Medicine"],
      Feed: ["Wanda", "Hay", "Silage", "Chicken Feed"],
      Kitchen: ["Farm"],
    })) {
      for (const i of items) expect(itemsForCategory(cat), `${cat}/${i}`).toContain(i);
    }
  });
});
