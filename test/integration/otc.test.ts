import { describe, it, expect } from "vitest";
import { db } from "../setup";
import { createProduct, createCustomer, createVendor, addStock, onHand, snapshotHeads, uniq } from "../helpers";
import { addRetailStock } from "@/app/(dashboard)/retail/actions";
import { createOtcSale, deleteOtcSale, getOtcSaleContext } from "@/app/(dashboard)/over-the-counter/sale/actions";
import { createOtcPurchase, deleteOtcPurchase } from "@/app/(dashboard)/over-the-counter/purchase/actions";
import { getVendorBills, deleteVendorBill, recordVendorPayment } from "@/app/(dashboard)/payments/vendors/actions";
import { computeCustomerOutstanding } from "@/lib/customer-balance";

describe("createOtcSale", () => {
  it("PAID cash sale: stock leaves, head is credited, a customer-less Payment is written", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await addStock(p.id, 100);
    const delta = await snapshotHeads(["CASH"]);
    const stockBefore = await onHand(p.id);

    const res = await createOtcSale({
      date: "", customerType: "CASH", cashName: "Walk-in", deliveryCharge: 0,
      paidAmount: 1000, paymentHead: "CASH",
      lines: [{ productId: p.id, unit: "LITER", rate: 100, quantity: 10 }],
    });
    expect(res.ok).toBe(true);
    expect(await delta("CASH")).toBeCloseTo(1000, 2);        // 10 × 100
    expect(await onHand(p.id)).toBeCloseTo(stockBefore - 10, 3); // stock left
  });

  it("refuses to sell more than on-hand stock", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await addStock(p.id, 5);
    const res = await createOtcSale({
      date: "", customerType: "CASH", deliveryCharge: 0, paidAmount: 5000, paymentHead: "CASH",
      lines: [{ productId: p.id, unit: "LITER", rate: 100, quantity: 50 }],
    });
    expect(res.ok).toBe(false);
  });

  it("rejects NaN / negative rate", async () => {
    const p = await createProduct();
    await addStock(p.id, 100);
    expect((await createOtcSale({ date: "", customerType: "CASH", deliveryCharge: 0, paidAmount: 0, paymentHead: "CASH", lines: [{ productId: p.id, unit: "LITER", rate: NaN, quantity: 1 }] })).ok).toBe(false);
    expect((await createOtcSale({ date: "", customerType: "CASH", deliveryCharge: 0, paidAmount: 0, paymentHead: "CASH", lines: [{ productId: p.id, unit: "LITER", rate: -10, quantity: 1 }] })).ok).toBe(false);
  });

  it("PARTIAL sale to a REGULAR customer: only the unpaid remainder is billed; the paid slice is a customer-less Payment", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await addStock(p.id, 100);
    const c = await createCustomer({ openingBalance: 0 });
    const delta = await snapshotHeads(["CASH"]);
    const before = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;

    // Total 1000, pay 300 now, 700 on credit.
    const res = await createOtcSale({
      date: "", customerType: "REGULAR", customerId: c.id, deliveryCharge: 0,
      paidAmount: 300, paymentHead: "CASH",
      lines: [{ productId: p.id, unit: "LITER", rate: 100, quantity: 10 }],
    });
    expect(res.ok).toBe(true);

    // Customer owes only the 700 remainder — not the whole 1000, not zero.
    const after = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;
    expect(after - before).toBeCloseTo(700, 2);

    // The 300 cash landed in the head.
    expect(await delta("CASH")).toBeCloseTo(300, 2);

    // The paid slice is a Payment with NO customerId (counter cash, not a
    // payment against the customer's subscription account).
    const sale = (await db.otcSale.findFirst({ where: { customerId: c.id }, orderBy: { createdAt: "desc" } }))!;
    expect(Number(sale.paidAmount)).toBeCloseTo(300, 2);
    expect(sale.paymentStatus).toBe("PARTIAL");
    const pay = await db.payment.findFirst({ where: { notes: `OTC Sale ${sale.invoiceNo}` } });
    expect(pay).toBeTruthy();
    expect(pay!.customerId).toBeNull();
    expect(Number(pay!.amount)).toBeCloseTo(300, 2);
    // No customer-attributed payment was created (would wrongly cut arrears).
    expect(await db.payment.count({ where: { customerId: c.id } })).toBe(0);
  });

  it("fully-credit REGULAR sale (paidAmount 0) bills the whole total and moves no cash", async () => {
    const p = await createProduct({ defaultRate: 50 });
    await addStock(p.id, 100);
    const c = await createCustomer({ openingBalance: 0 });
    const before = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;
    const delta = await snapshotHeads(["CASH"]);

    const res = await createOtcSale({
      date: "", customerType: "REGULAR", customerId: c.id, deliveryCharge: 0,
      paidAmount: 0, paymentHead: null,
      lines: [{ productId: p.id, unit: "LITER", rate: 50, quantity: 10 }],
    });
    expect(res.ok).toBe(true);
    const after = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;
    expect(after - before).toBeCloseTo(500, 2);       // whole 500 billed
    expect(await delta("CASH")).toBeCloseTo(0, 2);    // no cash in — nothing was paid
    const sale = (await db.otcSale.findFirst({ where: { customerId: c.id }, orderBy: { createdAt: "desc" } }))!;
    expect(sale.paymentStatus).toBe("CREDIT");
    expect(Number(sale.paidAmount)).toBeCloseTo(0, 2);
  });

  it("CASH sale cannot be left partly on credit", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await addStock(p.id, 100);
    const res = await createOtcSale({
      date: "", customerType: "CASH", deliveryCharge: 0, paidAmount: 300, paymentHead: "CASH",
      lines: [{ productId: p.id, unit: "LITER", rate: 100, quantity: 10 }], // total 1000, only 300 paid
    });
    expect(res.ok).toBe(false);
  });
});

describe("deleting an OTC sale", () => {
  it("credit sale to a regular customer: the stock comes back and so does what they owed", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await addStock(p.id, 100);
    const c = await createCustomer({ openingBalance: 0 });
    const stockBefore = await onHand(p.id);
    const owedBefore = (await computeCustomerOutstanding([c.id])).get(c.id) ?? 0;

    const res = await createOtcSale({
      date: "", customerType: "REGULAR", customerId: c.id, deliveryCharge: 0, paidAmount: 0,
      lines: [{ productId: p.id, unit: "LITER", rate: 100, quantity: 25 }],
    });
    expect(res.ok).toBe(true);
    const id = (res as { ok: true; id: string }).id;
    expect(await onHand(p.id)).toBeCloseTo(stockBefore - 25, 3);
    expect((await computeCustomerOutstanding([c.id])).get(c.id) ?? 0).toBeCloseTo(owedBefore + 2500, 2);

    expect(await deleteOtcSale(id)).toEqual({ ok: true });

    expect(await onHand(p.id)).toBeCloseTo(stockBefore, 3);
    expect((await computeCustomerOutstanding([c.id])).get(c.id) ?? 0).toBeCloseTo(owedBefore, 2);
    expect(await db.otcSale.count({ where: { id } })).toBe(0);
    expect(await db.inventoryMovement.count({ where: { reference: id } })).toBe(0);
  }, 180_000);

  it("paid sale: the cash leaves the head it landed in", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await addStock(p.id, 100);
    const delta = await snapshotHeads(["CASH"]);
    const res = await createOtcSale({
      date: "", customerType: "CASH", cashName: uniq("Walk-in"), deliveryCharge: 0,
      paidAmount: 1000, paymentHead: "CASH",
      lines: [{ productId: p.id, unit: "LITER", rate: 100, quantity: 10 }],
    });
    expect(res.ok).toBe(true);
    expect(await delta("CASH")).toBeCloseTo(1000, 2);

    expect(await deleteOtcSale((res as { ok: true; id: string }).id)).toEqual({ ok: true });
    expect(await delta("CASH")).toBeCloseTo(0, 2);
  }, 180_000);

  it("a sale to a vendor takes its receivable with it, unless money came in against it", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await addStock(p.id, 100);
    const v = await createVendor();
    const res = await createOtcSale({
      date: "", customerType: "VENDOR", vendorId: v.id, deliveryCharge: 0, paidAmount: 0,
      lines: [{ productId: p.id, unit: "LITER", rate: 100, quantity: 10 }],
    });
    expect(res.ok).toBe(true);
    const id = (res as { ok: true; id: string }).id;

    // Somebody receives Rs 400 of it: the sale can no longer just vanish.
    const recv = await db.vendorReceivable.findFirstOrThrow({ where: { vendorId: v.id } });
    await db.vendorReceivable.update({ where: { id: recv.id }, data: { received: 400 } });
    const refused = await deleteOtcSale(id);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toMatch(/Undo that receipt/i);

    // Put the receipt back and it deletes cleanly, receivable and all.
    await db.vendorReceivable.update({ where: { id: recv.id }, data: { received: 0 } });
    expect(await deleteOtcSale(id)).toEqual({ ok: true });
    expect(await db.vendorReceivable.count({ where: { id: recv.id } })).toBe(0);
  }, 180_000);
});

describe("deleting an OTC purchase", () => {
  /** A paid purchase of 20 × 50, with the head balance watcher already primed. */
  async function paidPurchase() {
    const p = await createProduct();
    const v = await createVendor();
    await db.payment.create({ data: { amount: 100000, head: "CASH", customerId: null, notes: uniq("seed") } });
    const before = await onHand(p.id);
    const delta = await snapshotHeads(["CASH"]);
    const res = await createOtcPurchase({
      date: "", vendorId: v.id, deliveryCharge: 0, paidAmount: 1000, paymentHead: "CASH",
      lines: [{ productId: p.id, unit: "LITER", rate: 50, quantity: 20 }],
    });
    expect(res.ok).toBe(true);
    const id = (res as { ok: true; id: string }).id;
    return { p, v, id, before, delta };
  }

  it("takes the stock back out, clears the bill and returns the cash", async () => {
    const { p, v, id, before, delta } = await paidPurchase();
    expect(await onHand(p.id)).toBeCloseTo(before + 20, 3);
    expect(await delta("CASH")).toBeCloseTo(-1000, 2);

    expect(await deleteOtcPurchase(id)).toEqual({ ok: true });

    expect(await onHand(p.id)).toBeCloseTo(before, 3);          // the stock is gone
    expect(await delta("CASH")).toBeCloseTo(0, 2);              // the cash is back
    expect(await db.otcPurchase.count({ where: { id } })).toBe(0);
    expect(await db.vendorBill.count({ where: { vendorId: v.id } })).toBe(0);
    expect(await db.inventoryMovement.count({ where: { reference: id } })).toBe(0);
  }, 180_000);

  it("deleting its bill on the vendors page does exactly the same", async () => {
    const { p, v, id, before, delta } = await paidPurchase();
    const bill = (await db.vendorBill.findFirstOrThrow({ where: { vendorId: v.id } }));

    expect(await deleteVendorBill(bill.id)).toEqual({ ok: true });

    // This is what used to be left behind: the purchase, and its milk.
    expect(await db.otcPurchase.count({ where: { id } })).toBe(0);
    expect(await onHand(p.id)).toBeCloseTo(before, 3);
    expect(await delta("CASH")).toBeCloseTo(0, 2);
  }, 180_000);

  it("refuses once that stock has been used", async () => {
    const { p, id } = await paidPurchase();
    // 20 L sold over the counter — it cannot be un-bought now.
    await db.inventoryMovement.create({
      data: { date: new Date(), type: "COUNTER_SALE", productId: p.id, quantity: 20, reason: uniq("sold") },
    });

    const res = await deleteOtcPurchase(id);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/used or sent out/i);
    expect(await db.otcPurchase.count({ where: { id } })).toBe(1);
  }, 180_000);

  it("refuses once money has been paid against its bill", async () => {
    const p = await createProduct();
    const v = await createVendor();
    await db.payment.create({ data: { amount: 100000, head: "CASH", customerId: null, notes: uniq("seed") } });
    const res = await createOtcPurchase({
      date: "", vendorId: v.id, deliveryCharge: 0, paidAmount: 0, // all on credit
      lines: [{ productId: p.id, unit: "LITER", rate: 50, quantity: 20 }],
    });
    expect(res.ok).toBe(true);
    const id = (res as { ok: true; id: string }).id;
    expect((await recordVendorPayment({ vendorId: v.id, amount: 400, head: "CASH" })).ok).toBe(true);

    const del = await deleteOtcPurchase(id);
    expect(del.ok).toBe(false);
    expect(del.ok === false && del.error).toMatch(/Undo that payment/i);
    expect(await db.otcPurchase.count({ where: { id } })).toBe(1);
  }, 180_000);
});

describe("createOtcPurchase", () => {
  it("CREDIT purchase: stock arrives, an unpaid VendorBill is created, no cash moves", async () => {
    const p = await createProduct();
    const v = await createVendor();
    const delta = await snapshotHeads(["CASH"]);
    const stockBefore = await onHand(p.id);

    const res = await createOtcPurchase({
      date: "", vendorId: v.id, deliveryCharge: 0, paidAmount: 0,
      lines: [{ productId: p.id, unit: "LITER", rate: 50, quantity: 20 }],
    });
    expect(res.ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(stockBefore + 20, 3);
    expect(await delta("CASH")).toBeCloseTo(0, 2);
    const bill = (await db.vendorBill.findFirst({ where: { vendorId: v.id } }))!;
    expect(Number(bill.amount)).toBeCloseTo(1000, 2);
    expect(Number(bill.paid)).toBeCloseTo(0, 2); // unpaid
  });

  it("the vendor page lists what was bought, not just the amount", async () => {
    const p = await createProduct({ name: uniq("Cow Milk") });
    const v = await createVendor();
    expect((await createOtcPurchase({
      date: "", vendorId: v.id, deliveryCharge: 0, paidAmount: 0,
      lines: [{ productId: p.id, unit: "LITER", rate: 50, quantity: 20 }],
    })).ok).toBe(true);

    // The purchase writes its bill with a plain note — the items live on the
    // purchase — so the vendor's bill has to reach through to them.
    const bill = (await getVendorBills(v.id))[0];
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]).toMatchObject({ description: p.name, quantity: 20, rate: 50, amount: 1000 });
    expect(bill.reference).toMatch(/\S/); // the invoice number, so the row is identifiable
  }, 120_000);

  it("PAID purchase: stock arrives, bill fully paid, cash leaves the head", async () => {
    const p = await createProduct();
    const v = await createVendor();
    const delta = await snapshotHeads(["CASH"]);

    const res = await createOtcPurchase({
      date: "2026-08-01", vendorId: v.id, deliveryCharge: 0, paidAmount: 400, paymentHead: "CASH",
      lines: [{ productId: p.id, unit: "LITER", rate: 40, quantity: 10 }],
    });
    expect(res).toMatchObject({ ok: true });
    expect(await delta("CASH")).toBeCloseTo(-400, 2);
    const bill = (await db.vendorBill.findFirst({ where: { vendorId: v.id } }))!;
    expect(Number(bill.paid)).toBeCloseTo(400, 2); // fully settled
  });

  it("PARTIAL purchase: bill keeps the unpaid remainder, only the paid slice leaves the head and books an Expense", async () => {
    const p = await createProduct();
    const v = await createVendor();
    // Seed the head generously so the paid slice always has funds regardless of
    // whatever the running CASH balance is (the overdraft guard is real).
    await db.payment.create({ data: { amount: 100000, head: "CASH", customerId: null, notes: uniq("seed") } });
    const delta = await snapshotHeads(["CASH"]);

    // Total 800, pay 500 now, 300 stays owing.
    const res = await createOtcPurchase({
      date: "", vendorId: v.id, deliveryCharge: 0, paidAmount: 500, paymentHead: "CASH",
      lines: [{ productId: p.id, unit: "LITER", rate: 40, quantity: 20 }],
    });
    expect(res.ok).toBe(true);
    const bill = (await db.vendorBill.findFirst({ where: { vendorId: v.id } }))!;
    expect(Number(bill.amount)).toBeCloseTo(800, 2);
    expect(Number(bill.paid)).toBeCloseTo(500, 2);        // partial
    expect(Number(bill.amount) - Number(bill.paid)).toBeCloseTo(300, 2); // still owed
    expect(await delta("CASH")).toBeCloseTo(-500, 2);     // only the paid slice
    const purchase = (await db.otcPurchase.findFirst({ where: { vendorId: v.id }, orderBy: { createdAt: "desc" } }))!;
    expect(purchase.paymentStatus).toBe("PARTIAL");
    const exp = await db.expense.findFirst({ where: { vendorId: v.id, description: { contains: purchase.invoiceNo } } });
    expect(exp).toBeTruthy();
    expect(Number(exp!.amount)).toBeCloseTo(500, 2);
  });
});

describe("retail products at the counter", () => {
  it("is REFUSED with no stock, and sells once it has been counted in", async () => {
    const bottle = await createProduct({
      retailOnly: true, unit: "MILLILITER", packSize: 250, defaultRate: 120,
    });
    const sale = {
      date: "", customerType: "CASH" as const, cashName: "Walk-in", deliveryCharge: 0,
      paidAmount: 1200, paymentHead: "CASH",
      // The client used to post a LABEL here; the server takes the unit from the
      // product, so an unknown label can no longer break the write.
      lines: [{ productId: bottle.id, unit: "ml", rate: 120, quantity: 10 }],
    };

    const refused = await createOtcSale(sale);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain(bottle.name);
    expect(await db.otcSaleLine.count({ where: { productId: bottle.id } })).toBe(0);

    await addRetailStock({ productId: bottle.id, quantity: 40 });
    const res = await createOtcSale(sale);
    expect(res.ok).toBe(true);

    const line = await db.otcSaleLine.findFirst({ where: { productId: bottle.id } });
    expect(line?.unit).toBe("MILLILITER");
    // The COUNTER_SALE movement now genuinely deducts.
    expect(await onHand(bottle.id)).toBeCloseTo(30, 3);
  });

  it("refuses a mixed sale when the RETAIL line is short, and writes nothing", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const milk = await createProduct({ defaultRate: 100 });
    await addRetailStock({ productId: bottle.id, quantity: 5 });
    await addStock(milk.id, 100);

    const res = await createOtcSale({
      date: "", customerType: "CASH", deliveryCharge: 0,
      paidAmount: 10 * 120 + 50 * 100, paymentHead: "CASH",
      lines: [
        { productId: bottle.id, unit: "MILLILITER", rate: 120, quantity: 10 },
        { productId: milk.id, unit: "LITER", rate: 100, quantity: 50 },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(bottle.name);
    expect(await onHand(milk.id)).toBeCloseTo(100, 3);
    expect(await onHand(bottle.id)).toBeCloseTo(5, 3);
  });

  it("still refuses a mixed sale when the MILK line is short", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const milk = await createProduct({ defaultRate: 100 });
    await addRetailStock({ productId: bottle.id, quantity: 40 });
    await addStock(milk.id, 5);

    const res = await createOtcSale({
      date: "", customerType: "CASH", deliveryCharge: 0,
      paidAmount: 10 * 120 + 50 * 100, paymentHead: "CASH",
      lines: [
        { productId: bottle.id, unit: "MILLILITER", rate: 120, quantity: 10 },
        { productId: milk.id, unit: "LITER", rate: 100, quantity: 50 },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(milk.name);
    expect(await onHand(bottle.id)).toBeCloseTo(40, 3);
  });

  it("a mixed sale within stock deducts BOTH lines", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const milk = await createProduct({ defaultRate: 100 });
    await addRetailStock({ productId: bottle.id, quantity: 40 });
    await addStock(milk.id, 100);

    const res = await createOtcSale({
      date: "", customerType: "CASH", deliveryCharge: 0,
      paidAmount: 10 * 120 + 50 * 100, paymentHead: "CASH",
      lines: [
        { productId: bottle.id, unit: "MILLILITER", rate: 120, quantity: 10 },
        { productId: milk.id, unit: "LITER", rate: 100, quantity: 50 },
      ],
    });
    expect(res.ok).toBe(true);
    expect(await onHand(bottle.id)).toBeCloseTo(30, 3);
    expect(await onHand(milk.id)).toBeCloseTo(50, 3);
  });

  it("two sales racing for the last bottles: one wins, stock never goes negative", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250, defaultRate: 120 });
    await addRetailStock({ productId: bottle.id, quantity: 10 });

    const sale = () => createOtcSale({
      date: "", customerType: "CASH", cashName: "Walk-in", deliveryCharge: 0,
      paidAmount: 6 * 120, paymentHead: "CASH",
      lines: [{ productId: bottle.id, unit: "MILLILITER", rate: 120, quantity: 6 }],
    });
    const [a, b] = await Promise.all([sale(), sale()]);

    // Six and six against ten: exactly one may pass.
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await onHand(bottle.id)).toBeCloseTo(4, 3);
  });

  it("cannot be bought over the counter — that would raise a vendor bill", async () => {
    const bottle = await createProduct({ retailOnly: true, unit: "MILLILITER", packSize: 250 });
    const vendor = await createVendor();
    const res = await createOtcPurchase({
      date: "", vendorId: vendor.id, deliveryCharge: 0, paidAmount: 0,
      lines: [{ productId: bottle.id, unit: "MILLILITER", rate: 80, quantity: 10 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Retail Inventory page");
  });
});

describe("who the counter can sell to", () => {
  it("offers on-call customers — they are the ones who phone in", async () => {
    const onCall = await createCustomer({ status: "ON_CALL" });
    const active = await createCustomer();
    const ctx = await getOtcSaleContext();
    const ids = ctx.customers.map((c) => c.customerId);
    expect(ids).toContain(onCall.id);
    expect(ids).toContain(active.id);
  }, 180000);

  it("still leaves out customers who have stopped", async () => {
    const lost = await createCustomer({ status: "INACTIVE" });
    const ctx = await getOtcSaleContext();
    expect(ctx.customers.map((c) => c.customerId)).not.toContain(lost.id);
  }, 180000);

  it("an on-call customer can actually be billed", async () => {
    const onCall = await createCustomer({ status: "ON_CALL" });
    const milk = await createProduct({ defaultRate: 100 });
    await addStock(milk.id, 20);

    const res = await createOtcSale({
      date: "", customerType: "REGULAR", customerId: onCall.id, deliveryCharge: 0,
      paidAmount: 0,
      lines: [{ productId: milk.id, unit: "LITER", rate: 100, quantity: 5 }],
    });
    expect(res.ok).toBe(true);
    expect(await onHand(milk.id)).toBeCloseTo(15, 3);
  }, 180000);
});
