import { describe, it, expect } from "vitest";
import { db } from "../setup";
import { createProduct, createCustomer } from "../helpers";
import { getPageData } from "@/app/(dashboard)/billing/payment-receiving/actions";
import { getBillingOverview } from "@/app/(dashboard)/billing/invoices/actions";
import { todayPKTString, pktNoonToUTC } from "@/lib/pkt";

const [Y, M] = todayPKTString().split("-").map(Number);

// Two dates that are certainly in their own fortnight, whatever today is.
const IN_FIRST = pktNoonToUTC(`${Y}-${String(M).padStart(2, "0")}-05`);
const IN_SECOND = pktNoonToUTC(`${Y}-${String(M).padStart(2, "0")}-20`);

/** What Customer Bills says this customer was billed for one fortnight. */
async function billedOnCustomerBills(customerId: string, half: number): Promise<number> {
  const overview = await getBillingOverview(Y, M, half);
  const row = overview.customers.find((c) => c.id === customerId);
  if (!row) throw new Error("customer missing from the billing overview");
  return row.deliveries - row.returns + row.deliveryCharge + row.otcAmt - row.discount;
}

async function billColumn(customerId: string) {
  const page = await getPageData(M, Y);
  const row = page.customers.find((c) => c.id === customerId);
  if (!row) throw new Error("customer missing from payment receiving");
  return row;
}

// The Bill column on Payment Receiving used to show the running balance —
// carry-forward from earlier months and all — while the two fortnight options
// showed that fortnight's own charges. "Full month" therefore never equalled
// 1–15 plus 16–end, and was not the month's bill by any reading of it.
describe("the Bill column on Payment Receiving", () => {
  it("full month is the first cycle plus the second, and each matches Customer Bills", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    const c = await createCustomer();

    // 6 L in the first fortnight, 10 L in the second with 1 L handed back.
    await db.deliveryEntry.createMany({
      data: [
        { customerId: c.id, productId: p.id, quantity: 6, unitRate: 100, date: IN_FIRST },
        { customerId: c.id, productId: p.id, quantity: 10, unitRate: 100, date: IN_SECOND },
        { customerId: c.id, productId: p.id, quantity: 1, unitRate: 100, date: IN_SECOND, isReturn: true },
      ],
    });

    const row = await billColumn(c.id);

    // Each fortnight, against the page the bills themselves are read from.
    expect(row.billHalf1).toBeCloseTo(await billedOnCustomerBills(c.id, 1), 2);
    expect(row.billHalf2).toBeCloseTo(await billedOnCustomerBills(c.id, 2), 2);

    // …and the deliveries as typed, so a passing comparison above cannot be two
    // screens agreeing on the same wrong number.
    expect(row.billHalf1).toBeCloseTo(600, 2);
    expect(row.billHalf2).toBeGreaterThanOrEqual(900); // 1000 − 100, plus any delivery charge

    // What the user actually asked for.
    expect(row.billHalf1 + row.billHalf2).toBeCloseTo(
      (await billedOnCustomerBills(c.id, 1)) + (await billedOnCustomerBills(c.id, 2)),
      2,
    );
  }, 240_000);

  it("an old balance does not leak into the month's bill", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    // Rs 5,000 owed from before the software was in use.
    const c = await createCustomer({ openingBalance: 5000 });
    await db.deliveryEntry.create({
      data: { customerId: c.id, productId: p.id, quantity: 3, unitRate: 100, date: IN_FIRST },
    });

    const row = await billColumn(c.id);
    // The month's bill is this month's charges — the Balance column is where
    // what he still owes belongs.
    expect(row.billHalf1 + row.billHalf2).toBeCloseTo(300, 2);
    expect(row.balance).toBeCloseTo(5300, 2);
  }, 240_000);

  it("a fortnight with no bill generated still shows what was delivered in it", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 100 });
    const c = await createCustomer();
    await db.deliveryEntry.create({
      data: { customerId: c.id, productId: p.id, quantity: 4, unitRate: 100, date: IN_FIRST },
    });

    // No invoice was ever generated for this customer.
    expect(await db.invoice.count({ where: { customerId: c.id } })).toBe(0);

    const row = await billColumn(c.id);
    expect(row.billHalf1).toBeCloseTo(400, 2);
  }, 240_000);
});
