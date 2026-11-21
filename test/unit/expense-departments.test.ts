import { describe, expect, it } from "vitest";
import { DEPARTMENTS, defaultDepartment, departmentOf, isDepartment, lineKey } from "@/lib/expense-departments";

// The owner's sheet of 9 Nov 2026: which department each expense line sits in.
const SHEET: [string, string, string][] = [
  // Farm
  ["Farm", "Maintenance", "Farm Bike Maintenance"],
  ["Farm", "Fuel", "Farm Bike Fuel"],
  ["Farm", "Feed", "Feed Additives"],
  ["Farm", "Feed", "Wanda"],
  ["Farm", "Feed", "Chicken Feed"],
  ["Farm", "Feed", "Silage"],
  ["Farm", "Feed", "Toori"],
  ["Farm", "Feed", "Hay"],
  ["Farm", "Kitchen", "Farm"],
  ["Farm", "Miscellaneous", "Farm Miscellaneous"],
  ["Farm", "Fuel", "Farm Generator"],
  ["Farm", "Other Fixed Expense", "Farm Fixed Cost"],
  // Distribution
  ["Distribution", "Fuel", "Distribution Van Fuel"],
  ["Distribution", "Fuel", "Distribution Rider Fuel"],
  ["Distribution", "Packaging", "Packets"],
  ["Distribution", "Packaging", "Bottles"],
  ["Distribution", "Maintenance", "Distribution Van Maintenance"],
  ["Distribution", "Maintenance", "Distribution Bike Maintenance"],
  ["Distribution", "Milk Procurement", "Outsourced Milk"],
  ["Distribution", "Marketing", "Facebook Ads"],
  ["Distribution", "Marketing", "Social Media Ads"],
  ["Distribution", "Miscellaneous", "Distribution Miscellaneous"],
  // Agriculture
  ["Agriculture", "Maintenance", "Tractor Maintenance"],
  ["Agriculture", "Agriculture", "Seed"],
  ["Agriculture", "Agriculture", "Fertilizer"],
  ["Agriculture", "Agriculture", "Harvesting"],
];

describe("expense departments", () => {
  it("has Agriculture as a third department", () => {
    expect([...DEPARTMENTS]).toEqual(["Farm", "Distribution", "Agriculture"]);
    expect(isDepartment("Agriculture")).toBe(true);
    expect(isDepartment("Retail")).toBe(false);
  });

  it.each(SHEET)("puts %s › %s › %s where the sheet says", (dept, category, item) => {
    expect(defaultDepartment(category, item)).toBe(dept);
  });

  it("leaves a line nobody has placed on the Farm", () => {
    expect(defaultDepartment("Civil", "Shed")).toBe("Farm");
    expect(defaultDepartment("Something New", "")).toBe("Farm");
  });

  it("lets a saved choice win, including Agriculture, and ignores junk", () => {
    expect(departmentOf("Civil", "Shed", { [lineKey("Civil", "Shed")]: "Agriculture" })).toBe("Agriculture");
    expect(departmentOf("Packaging", "Bottles", { [lineKey("Packaging", "Bottles")]: "Farm" })).toBe("Farm");
    expect(departmentOf("Packaging", "Bottles", { [lineKey("Packaging", "Bottles")]: "Nope" })).toBe("Distribution");
  });
});
