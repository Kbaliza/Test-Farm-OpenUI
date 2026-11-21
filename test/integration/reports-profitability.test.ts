import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createCustomer, createVendor, createEmployee, uniq } from "../helpers";
import { getReportsData } from "@/app/(dashboard)/reports/actions";

// A far-future month with no other data, so the aggregates are exactly what we seed.
const MONTH = "2099-06";
const D = new Date(Date.UTC(2099, 5, 15, 12, 0, 0)); // 15 Jun 2099, noon UTC → still June in PKT

describe("reports profitability — accrual Revenue vs Expenses → Net Profit", () => {
  it("computes MTD/YTD revenue, all-expenses (incl OTC purchases), net profit and margin", async () => {
    const customer = await createCustomer();
    const vendor = await createVendor();
    const employee = await createEmployee();

    // Revenue = invoice net (1000 − 100 + 50 = 950) + OTC sale (2000) = 2950.
    await db.invoice.create({
      data: { customerId: customer.id, month: 6, year: 2099, deliveriesAmt: 1000, returnsAmt: 100, deliveryCharge: 50 },
    });
    await db.otcSale.create({
      data: { invoiceNo: uniq("SAL"), customerType: "REGULAR", customerId: customer.id, totalAmount: 2000, date: D },
    });

    // All Expenses = operating expense (300) + salary (200) + OTC purchase (400) = 900.
    const cat = await db.expenseCategory.create({ data: { name: uniq("cat") } });
    const exp = await db.expense.create({ data: { categoryId: cat.id, amount: 300, head: "CASH", date: D } });
    cleanups.push(async () => {
      await db.expense.delete({ where: { id: exp.id } }).catch(() => {});
      await db.expenseCategory.delete({ where: { id: cat.id } }).catch(() => {});
    });
    await db.salaryPayment.create({ data: { employeeId: employee.id, month: 6, year: 2099, amount: 200, head: "CASH", paidAt: D } });
    await db.otcPurchase.create({ data: { invoiceNo: uniq("PUR"), vendorId: vendor.id, totalAmount: 400, date: D } });

    const data = await getReportsData(MONTH);
    expect(data.dbReady).toBe(true);

    // Month-to-date (the seeded month).
    const mtd = data.profitability.mtd;
    expect(mtd.revenue).toBeCloseTo(2950, 2);
    expect(mtd.expenses).toBeCloseTo(900, 2);          // 300 + 200 + 400
    expect(mtd.netProfit).toBeCloseTo(2050, 2);        // 2950 − 900
    expect(mtd.margin).toBeCloseTo(2050 / 2950, 4);    // ≈ 0.6949

    // Year-to-date (Jan–Jun 2099) sees the same rows since only June has data.
    const ytd = data.profitability.ytd;
    expect(ytd.revenue).toBeCloseTo(2950, 2);
    expect(ytd.expenses).toBeCloseTo(900, 2);
    expect(ytd.netProfit).toBeCloseTo(2050, 2);
  });

  it("margin is 0 (not NaN) when there is no revenue", async () => {
    // An empty far-future month → zero revenue, guarded margin.
    const data = await getReportsData("2098-03");
    expect(data.profitability.mtd.revenue).toBeCloseTo(0, 2);
    expect(data.profitability.mtd.margin).toBe(0);
  });
});
