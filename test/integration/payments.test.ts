import { describe, it, expect } from "vitest";
import { db } from "../setup";
import { createCustomer, snapshotHeads } from "../helpers";
import { recordPayment } from "@/app/(dashboard)/billing/payment-receiving/actions";
import { computeCustomerOutstanding } from "@/lib/customer-balance";
import { getHeadBalance } from "@/lib/head-balances";

describe("recordPayment", () => {
  it("normal: creates one payment, credits the head, reduces customer outstanding", async () => {
    const c = await createCustomer();
    const delta = await snapshotHeads(["CASH"]);
    const before = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;

    const res = await recordPayment({ customerId: c.id, amount: 500, head: "CASH", date: "", notes: "t-normal" });
    expect(res.ok).toBe(true);

    expect(await delta("CASH")).toBeCloseTo(500, 2);
    const after = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;
    expect(after - before).toBeCloseTo(-500, 2);

    const count = await db.payment.count({ where: { customerId: c.id } });
    expect(count).toBe(1);
  });

  it("rejects non-positive and NaN amounts", async () => {
    const c = await createCustomer();
    expect((await recordPayment({ customerId: c.id, amount: 0, head: "CASH", date: "" })).ok).toBe(false);
    expect((await recordPayment({ customerId: c.id, amount: -100, head: "CASH", date: "" })).ok).toBe(false);
    expect((await recordPayment({ customerId: c.id, amount: NaN, head: "CASH", date: "" })).ok).toBe(false);
    expect(await db.payment.count({ where: { customerId: c.id } })).toBe(0);
  });

  it("rejects an invalid head", async () => {
    const c = await createCustomer();
    expect((await recordPayment({ customerId: c.id, amount: 100, head: "BITCOIN", date: "" })).ok).toBe(false);
    expect(await db.payment.count({ where: { customerId: c.id } })).toBe(0);
  });

  it("IDEMPOTENT: a rapid duplicate submit does NOT double-credit", async () => {
    const c = await createCustomer();
    const delta = await snapshotHeads(["HBL"]);
    const args = { customerId: c.id, amount: 750, head: "HBL", date: "", notes: "dup-key" };

    await recordPayment(args);
    await recordPayment(args); // identical, within 15s → should be a no-op

    expect(await db.payment.count({ where: { customerId: c.id } })).toBe(1);
    expect(await delta("HBL")).toBeCloseTo(750, 2);
  });

  it("CONCURRENT duplicate submit (double-click) still records only once", async () => {
    const c = await createCustomer();
    const args = { customerId: c.id, amount: 900, head: "CASH", date: "", notes: "race-key" };
    const before = await getHeadBalance("CASH");

    await Promise.all([recordPayment(args), recordPayment(args)]);

    expect(await db.payment.count({ where: { customerId: c.id } })).toBe(1);
    expect((await getHeadBalance("CASH")) - before).toBeCloseTo(900, 2);
  });

  it("distinct amounts are NOT deduped (two real payments)", async () => {
    const c = await createCustomer();
    await recordPayment({ customerId: c.id, amount: 100, head: "CASH", date: "", notes: "a" });
    await recordPayment({ customerId: c.id, amount: 200, head: "CASH", date: "", notes: "b" });
    expect(await db.payment.count({ where: { customerId: c.id } })).toBe(2);
  });
});
