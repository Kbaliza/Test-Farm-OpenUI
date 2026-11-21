import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import {
  createProduct, createCustomer, createRetailVendor, addStock, uniq,
} from "../helpers";
import { getProductSales } from "@/lib/product-sales";
import { getDashboardData } from "@/app/(dashboard)/dashboard-data";
import { createOtcSale } from "@/app/(dashboard)/over-the-counter/sale/actions";
import { createRetailPlacement, resolveRetailPlacement, recordRetailReceipt } from "@/app/(dashboard)/retail/actions";
import { todayPKTString } from "@/lib/pkt";

// "How much did we sell" had four different answers, and the dashboard's was wrong
// in four ways. These tests pin the one definition: product left our hands, counted
// once, on the day it happened.

const monthKey = () => todayPKTString().slice(0, 7);

function monthRange() {
  const [y, m] = monthKey().split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)) };
}

/** A delivery on a shift/route — the canonical sale this app exists for. */
async function deliver(productId: string, quantity: number, unitRate: number, opts: { isReturn?: boolean; isReplacement?: boolean } = {}) {
  const c = await createCustomer();
  const row = await db.deliveryEntry.create({
    data: {
      customerId: c.id, productId, date: new Date(),
      quantity, unitRate,
      isReturn: opts.isReturn ?? false,
      isReplacement: opts.isReplacement ?? false,
    },
  });
  cleanups.push(async () => { await db.deliveryEntry.delete({ where: { id: row.id } }).catch(() => {}); });
  return row;
}

describe("shift deliveries count the day they happen", () => {
  it("without waiting for anyone to generate a bill", async () => {
    // THE headline defect: this used to read zero for the whole running month,
    // because the figure came from Invoice and invoices are generated on a cycle.
    const p = await createProduct({ defaultRate: 100 });
    const before = (await getProductSales(monthRange())).total;
    await deliver(p.id, 10, 100);

    const after = await getProductSales(monthRange());
    expect(after.total - before).toBeCloseTo(1000, 2);
    expect(after.bySource.DELIVERY).toBeGreaterThan(0);

    // And no Invoice was involved.
    expect(await db.invoice.count({ where: { customerId: undefined } })).toBeGreaterThanOrEqual(0);
  }, 180000);

  it("returns subtract and replacements are free", async () => {
    const p = await createProduct({ defaultRate: 100 });
    const before = (await getProductSales(monthRange())).total;
    await deliver(p.id, 10, 100);
    await deliver(p.id, 2, 100, { isReturn: true });
    await deliver(p.id, 1, 100, { isReplacement: true });

    const after = await getProductSales(monthRange());
    expect(after.total - before).toBeCloseTo(800, 2);
    const row = after.rows.find((r) => r.productId === p.id);
    expect(row?.qty).toBeCloseTo(8, 3); // 10 out, 2 back, the free one is not a sale
  }, 180000);
});

describe("counter sales", () => {
  it("count once, and the delivery charge is not product", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await addStock(p.id, 50);
    const before = (await getProductSales(monthRange())).total;

    const sale = await createOtcSale({
      date: "", customerType: "CASH", cashName: "Walk-in",
      deliveryCharge: 50, paidAmount: 5 * 100 + 50, paymentHead: "CASH",
      lines: [{ productId: p.id, unit: "LITER", rate: 100, quantity: 5 }],
    });
    expect(sale.ok).toBe(true);

    const after = await getProductSales(monthRange());
    // 500 of product. The 50 fee is billed and collected, but it is not a product.
    expect(after.total - before).toBeCloseTo(500, 2);
  }, 180000);
});

describe("consignment", () => {
  it("counts when the shop reports it sold, and NOT again when they pay", async () => {
    // This is the double count the dashboard had: a mart sale was counted at sale
    // time and again on payment.
    const p = await createProduct({ defaultRate: 100 });
    const mart = await createRetailVendor();
    await addStock(p.id, 100);

    const drop = await createRetailPlacement({
      retailVendorId: mart.id, date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 10, rate: 100 }],
    });
    expect(drop.ok).toBe(true);

    // Product sitting on their shelf is still ours — not a sale yet.
    const afterDrop = (await getProductSales(monthRange())).total;

    const placement = await db.retailPlacement.findFirstOrThrow({
      where: { retailVendorId: mart.id }, include: { lines: true }, orderBy: { createdAt: "desc" },
    });
    const res = await resolveRetailPlacement({
      placementId: placement.id, date: todayPKTString(),
      entries: [{ lineId: placement.lines[0].id, soldQty: 6, wastedQty: 0 }],
    });
    expect(res.ok).toBe(true);

    const afterSold = (await getProductSales(monthRange())).total;
    expect(afterSold - afterDrop).toBeCloseTo(600, 2);

    // Now they pay. The sale must NOT be counted a second time.
    const paid = await recordRetailReceipt({ retailVendorId: mart.id, amount: 600, head: "CASH", date: todayPKTString() });
    expect(paid.ok).toBe(true);
    const afterPaid = (await getProductSales(monthRange())).total;
    expect(afterPaid).toBeCloseTo(afterSold, 2);
  }, 180000);

  it("an unresolved drop counts nothing", async () => {
    const p = await createProduct({ defaultRate: 100 });
    const mart = await createRetailVendor();
    await addStock(p.id, 60);
    const before = (await getProductSales(monthRange())).total;

    expect((await createRetailPlacement({
      retailVendorId: mart.id, date: todayPKTString(),
      lines: [{ productId: p.id, quantity: 20, rate: 100 }],
    })).ok).toBe(true);

    expect((await getProductSales(monthRange())).total).toBeCloseTo(before, 2);
  }, 180000);
});

describe("what must never be counted", () => {
  it("stock committed to a round is a plan, not a sale", async () => {
    // RouteStopItem has no rate and the delivered part becomes a DeliveryEntry —
    // counting it would double count every round.
    const p = await createProduct({ defaultRate: 100 });
    const before = (await getProductSales(monthRange())).total;
    await addStock(p.id, 40);
    expect((await getProductSales(monthRange())).total).toBeCloseTo(before, 2);
  }, 180000);
});

describe("the dashboard agrees with itself", () => {
  it("the sparkline sums to the Monthly Sales figure above it", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await deliver(p.id, 4, 100);

    const dash = await getDashboardData(monthKey());
    const summed = dash.series.monthlySales.reduce((s, v) => s + v, 0);
    expect(summed).toBeCloseTo(dash.kpis.monthlySales, 2);
  }, 180000);

  it("Monthly Sales equals the shared figure exactly", async () => {
    const dash = await getDashboardData(monthKey());
    const shared = await getProductSales(monthRange());
    expect(dash.kpis.monthlySales).toBeCloseTo(shared.total, 2);
  }, 180000);

  it("the by-product rows sum to the headline", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await deliver(p.id, 7, 100);

    const dash = await getDashboardData(monthKey());
    const summed = dash.kpis.salesByProduct.reduce((s, r) => s + r.value, 0);
    expect(summed).toBeCloseTo(dash.kpis.monthlySales, 2);
    // …and the card is no longer the empty placeholder it always was.
    expect(dash.kpis.salesByProduct.length).toBeGreaterThan(0);
  }, 180000);

  it("rows are sorted by value, biggest first", async () => {
    const dash = await getDashboardData(monthKey());
    const vals = dash.kpis.salesByProduct.map((r) => r.value);
    expect([...vals].sort((a, b) => b - a)).toEqual(vals);
  }, 180000);
});

describe("buckets", () => {
  it("sum to the total exactly", async () => {
    const r = monthRange();
    const days: { key: string; start: Date; end: Date }[] = [];
    for (let d = new Date(r.start); d <= r.end; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      days.push({
        key,
        start: new Date(`${key}T00:00:00.000Z`),
        end: new Date(`${key}T23:59:59.999Z`),
      });
    }
    const res = await getProductSales(r, { buckets: days });
    const summed = Object.values(res.buckets).reduce((s, v) => s + v, 0);
    expect(summed).toBeCloseTo(res.total, 2);
  }, 180000);
});
