import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer } from "../helpers";
import { generateInvoice, getInvoiceDetail, setInvoiceDiscount } from "@/app/(dashboard)/billing/invoices/actions";
import { todayPKTString, pktNoonToUTC } from "@/lib/pkt";

// A bill's lines are rebuilt from the deliveries on every open. Two rebuilds at
// once used to double them; they now wait for each other.

const DATE = todayPKTString();
const [Y, M] = DATE.split("-").map(Number);
const HALF = Number(DATE.slice(8)) <= 15 ? 1 : 2;

describe("rebuilding a bill's lines", () => {
  it("many rebuilds at once, with a discount being set in the middle, leave exactly one line per delivery", async () => {
    const p = await createProduct({ unit: "LITER", defaultRate: 260 });
    const c = await createCustomer();
    cleanups.push(async () => { await db.deliveryEntry.deleteMany({ where: { customerId: c.id } }); });
    for (let i = 0; i < 6; i++) await db.deliveryEntry.create({ data: { customerId: c.id, productId: p.id, quantity: 2, unitRate: 260, date: pktNoonToUTC(DATE) } });
    const gen = await generateInvoice(c.id, Y, M, HALF);
    expect(gen.ok).toBe(true);
    const invoiceId = (gen as { id: string }).id;
    cleanups.push(async () => { await db.invoice.delete({ where: { id: invoiceId } }).catch(() => {}); });

    // The page opening, refreshing itself, and the discount save — all at once.
    await Promise.all([
      getInvoiceDetail(invoiceId), getInvoiceDetail(invoiceId),
      setInvoiceDiscount(invoiceId, 100),
      getInvoiceDetail(invoiceId), getInvoiceDetail(invoiceId),
    ]);
    expect(await db.invoiceLine.count({ where: { invoiceId } })).toBe(6);
    const detail = (await getInvoiceDetail(invoiceId))!;
    expect(detail.lines.length).toBe(6);
    expect(detail.deliveriesAmt).toBeCloseTo(6 * 2 * 260, 2);
    expect(detail.discount).toBe(100);

    // Reset to subscriptions: the lines come back the same, and the discount goes.
    expect((await generateInvoice(c.id, Y, M, HALF)).ok).toBe(true);
    const reset = (await getInvoiceDetail(invoiceId))!;
    expect(reset.lines.length).toBe(6);
    expect(reset.discount).toBe(0);
  }, 300_000);
});
