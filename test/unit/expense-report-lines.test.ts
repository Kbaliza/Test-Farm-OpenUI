import { describe, expect, it } from "vitest";
import { defaultDepartment } from "@/lib/expense-departments";
import { pickerItems, currentItemName, itemsForCategory } from "@/lib/expense-taxonomy";
import {
  categoryLines, expenseLine, salaryLineFor, shownUnder, vendorKind, vendorPaymentLine,
} from "@/lib/expense-report-lines";

// The owner's list of 14 Nov 2026.
describe("the 14 Nov expense list", () => {
  it("splits salaries by the employee's department", () => {
    expect(salaryLineFor({ category: "FARM", role: "Milking" })).toBe("Farm Salaries");
    expect(salaryLineFor({ category: "RETAIL", role: "Rider" })).toBe("Distribution Salaries");
    expect(salaryLineFor({ category: "AGRICULTURE", role: "Farm Field Worker" })).toBe("Agriculture Salaries");
    // No category set: the role decides, and failing that the Farm.
    expect(salaryLineFor({ category: null, role: "Rider" })).toBe("Distribution Salaries");
    expect(salaryLineFor({ category: null, role: "Manager" })).toBe("Farm Salaries");
    expect(salaryLineFor(null)).toBe("Farm Salaries");
    expect(defaultDepartment("Salary", "Farm Salaries")).toBe("Farm");
    expect(defaultDepartment("Salary", "Distribution Salaries")).toBe("Distribution");
    expect(defaultDepartment("Salary", "Agriculture Salaries")).toBe("Agriculture");
    expect(categoryLines("Salary", {})).toEqual(["Farm Salaries", "Distribution Salaries", "Agriculture Salaries"]);
  });

  it("shows the consultant under Farm salaries and animal purchase under fixed cost", () => {
    expect(expenseLine("Consultancy", "Muhammad Tariq")).toEqual({ category: "Consultancy", item: "" });
    expect(shownUnder("Consultancy", "")).toEqual({ group: "Salary", label: "Consultant" });
    expect(defaultDepartment("Consultancy", "")).toBe("Farm");
    expect(shownUnder("Livestock", "Animal Purchase")).toEqual({ group: "Other Fixed Expense", label: "Animal Purchase" });
    expect(defaultDepartment("Livestock", "Animal Purchase")).toBe("Farm");
  });

  it("counts vendor payments as outsourced milk or desi ghee in Distribution", () => {
    expect(vendorKind("Cow Milk", "Kallar Syedan Milk Vendor")).toBe("milk");
    expect(vendorKind("Desi Ghee", "HRK Dairies (Desi Ghee)")).toBe("ghee");
    expect(vendorKind(null, "Banoori Dairy")).toBe("milk");
    expect(vendorKind(null, "Inam Feed Mill")).toBeNull();
    expect(vendorPaymentLine("milk", "X")).toEqual({ category: "Milk Procurement", item: "Outsourced Milk" });
    expect(vendorPaymentLine("ghee", "X")).toEqual({ category: "Milk Procurement", item: "Outsourced Desi Ghee" });
    expect(vendorPaymentLine(null, "Inam Feed Mill")).toEqual({ category: "Vendor Payment", item: "Inam Feed Mill" });
    expect(defaultDepartment("Milk Procurement", "Outsourced Milk")).toBe("Distribution");
    expect(defaultDepartment("Milk Procurement", "Outsourced Desi Ghee")).toBe("Distribution");
  });

  it("places the lines the list names", () => {
    expect(defaultDepartment("Utility", "Internet")).toBe("Farm");
    expect(defaultDepartment("Utility", "Electricity Bill")).toBe("Farm");
    expect(defaultDepartment("Utility", "Gas Cylinder")).toBe("Distribution");
    expect(defaultDepartment("Utility", "Sector J Rent")).toBe("Distribution");
    expect(defaultDepartment("Other Fixed Expense", "Distribution Fixed Cost")).toBe("Distribution");
    expect(defaultDepartment("Miscellaneous", "Farm Bilty")).toBe("Farm");
    expect(defaultDepartment("Miscellaneous", "Distribution Bilty")).toBe("Distribution");
    expect(defaultDepartment("Fuel", "Generator Fuel")).toBe("Agriculture");
    expect(defaultDepartment("Fuel", "Agriculture")).toBe("Agriculture");
    expect(defaultDepartment("Agriculture", "Pesticides")).toBe("Agriculture");
  });

  it("offers the new items and drops Panaflex and Printing", () => {
    expect(itemsForCategory("Fuel")).toContain("Generator Fuel");
    expect(itemsForCategory("Other Fixed Expense")).toContain("Distribution Fixed Cost");
    expect(itemsForCategory("Utility")).toEqual(expect.arrayContaining(["Gas Cylinder", "Sector J Rent", "Internet", "Electricity Bill"]));
    expect(itemsForCategory("Medicine")).toContain("Vaccine");
    expect(itemsForCategory("Marketing")).not.toContain("Panaflex");
    expect(itemsForCategory("Marketing")).not.toContain("Printing");
  });

  it("calls Egg Crates Egg Packaging, everywhere, once", () => {
    expect(currentItemName("Packaging", "Egg Crates")).toBe("Egg Packaging");
    expect(expenseLine("Packaging", "Egg Crates")).toEqual({ category: "Packaging", item: "Egg Packaging" });
    const live = ["Bottles", "Packets", "Egg Crates"]; // the items added from the page on live
    const items = pickerItems("Packaging", live);
    expect(items).toEqual(["Packaging Material", "Bottles", "Packets", "Egg Packaging"]);
    expect(categoryLines("Packaging", { Packaging: live })).toEqual(items);
  });

  it("lists a category with no items as one line, and Vendor Payment by the vendors paid", () => {
    expect(categoryLines("Loan Payable", {})).toEqual([""]);
    expect(categoryLines("Vendor Payment", {})).toEqual([]);
  });
});
