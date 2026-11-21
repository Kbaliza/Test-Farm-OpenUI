import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { uniq } from "../helpers";
import { saveMonthlyBudgets, getMonthlyExpenses, setCategoryBudget } from "@/app/(dashboard)/payments/expenses/actions";
import { DEPARTMENTS_KEY } from "@/lib/expense-departments";

// Budgets by item: a category's budget is its rows added up, and a department
// assignment is kept for every month. On a month long past, so real budgets are
// never touched.
describe("monthly budgets by item", () => {
  it("saves item budgets, sums them per category, and keeps departments", async () => {
    const cat = await db.expenseCategory.create({ data: { name: uniq("Fuel") } });
    const before = await db.appSetting.findUnique({ where: { key: DEPARTMENTS_KEY } });
    cleanups.push(async () => {
      await db.monthlyBudget.deleteMany({ where: { categoryId: cat.id } });
      await db.expenseCategory.delete({ where: { id: cat.id } }).catch(() => {});
      if (before) await db.appSetting.update({ where: { key: DEPARTMENTS_KEY }, data: { value: before.value } });
      else await db.appSetting.deleteMany({ where: { key: DEPARTMENTS_KEY } });
    });
    const M = 3, Y = 2019;

    // An old whole-category budget, the way every budget used to be set.
    expect((await setCategoryBudget(cat.id, M, Y, 1000)).ok).toBe(true);
    const r = await saveMonthlyBudgets({
      month: M, year: Y,
      lines: [{ categoryId: cat.id, item: "Rider/Bike Fuel", amount: 500 }, { categoryId: cat.id, item: "Farm", amount: 250 }],
      departments: { [`${cat.name}›Farm`]: "Distribution", junk: "Nowhere" },
    });
    expect(r.ok).toBe(true);

    const data = await getMonthlyExpenses(M, Y);
    const mine = data.budgets.filter((b) => b.categoryId === cat.id);
    expect(mine.map((b) => `${b.item}:${b.amount}`).sort()).toEqual([":1000", "Farm:250", "Rider/Bike Fuel:500"]);
    expect(data.byCategory.find((c) => c.categoryId === cat.id)?.budget).toBeCloseTo(1750, 2);
    expect(data.departments[`${cat.name}›Farm`]).toBe("Distribution");
    expect(data.departments.junk).toBeUndefined();

    // 0 clears a line; the others stay.
    expect((await saveMonthlyBudgets({ month: M, year: Y, lines: [{ categoryId: cat.id, item: "Farm", amount: 0 }], departments: {} })).ok).toBe(true);
    const after = (await getMonthlyExpenses(M, Y)).budgets.filter((b) => b.categoryId === cat.id);
    expect(after.map((b) => b.item).sort()).toEqual(["", "Rider/Bike Fuel"]);
  }, 300_000);
});
