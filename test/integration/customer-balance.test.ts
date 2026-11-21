import { describe, it, expect } from "vitest";
import { db } from "../setup";
import { createCustomer, createProduct, uniq } from "../helpers";
import { computeCustomerOutstanding } from "@/lib/customer-balance";
import { recordPayment } from "@/app/(dashboard)/billing/payment-receiving/actions";

async function delivery(customerId: string, productId: string, qty: number, rate: number, opts: { isReturn?: boolean; isReplacement?: boolean } = {}) {
  return db.deliveryEntry.create({ data: { customerId, productId, quantity: qty, unitRate: rate, isReturn: !!opts.isReturn, isReplacement: !!opts.isReplacement } });
}

describe("computeCustomerOutstanding accuracy", () => {
  it("opening + deliveries − returns − payments (replacements are free)", async () => {
    const c = await createCustomer({ openingBalance: 200 });
    const p = await createProduct();

    await delivery(c.id, p.id, 10, 100);                     // +1000
    await delivery(c.id, p.id, 2, 100, { isReturn: true });  // −200
    await delivery(c.id, p.id, 3, 100, { isReplacement: true }); // +0 (free)
    await recordPayment({ customerId: c.id, amount: 300, head: "CASH", date: "", notes: uniq("pay") }); // −300

    const bal = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;
    // 200 opening + 1000 − 200 + 0 − 300 = 700
    expect(bal).toBeCloseTo(700, 2);
  });

  it("an OTC CREDIT sale to the customer adds to their outstanding exactly once", async () => {
    const c = await createCustomer();
    // a credit OTC sale row (customerId set, CREDIT) — the balance reads it directly
    await db.otcSale.create({ data: { invoiceNo: uniq("SAL"), customerType: "REGULAR", customerId: c.id, totalAmount: 450, paymentStatus: "CREDIT", deliveryCharge: 0, enteredById: (await db.user.findFirst({ where: { role: "ADMIN" } }))!.id } });
    const bal = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;
    expect(bal).toBeCloseTo(450, 2);
  });

  it("a customer who overpays shows a NEGATIVE balance (credit), not floored", async () => {
    const c = await createCustomer();
    const p = await createProduct();
    await delivery(c.id, p.id, 1, 100); // +100
    await recordPayment({ customerId: c.id, amount: 500, head: "CASH", date: "", notes: uniq("pay") }); // −500
    const bal = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;
    expect(bal).toBeCloseTo(-400, 2); // in credit
  });
});
