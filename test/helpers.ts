import { db, cleanups } from "./setup";
import type { Unit } from "@/lib/units";
import { getHeadBalance } from "@/lib/head-balances";

let seq = 0;
export const uniq = (p = "T") => `__TEST_${p}_${Date.now()}_${seq++}`;

export async function headBal(head: string): Promise<number> {
  return getHeadBalance(head);
}

/** Snapshot several head balances; returns a fn giving the delta since snapshot. */
export async function snapshotHeads(heads: string[]) {
  const before: Record<string, number> = {};
  for (const h of heads) before[h] = await getHeadBalance(h);
  return async function delta(h: string) {
    return (await getHeadBalance(h)) - before[h];
  };
}

export async function createProduct(
  overrides: Partial<{ name: string; unit: Unit; defaultRate: number; retailOnly: boolean; packSize: number }> = {}
) {
  const p = await db.product.create({
    data: {
      name: overrides.name ?? uniq("prod"),
      unit: (overrides.unit ?? "LITER") as never,
      defaultRate: overrides.defaultRate ?? 100,
      retailOnly: overrides.retailOnly ?? false,
      packSize: overrides.packSize ?? null,
    },
  });
  cleanups.push(async () => {
    // OTC sales referencing this product leave a customer-less Payment + a COUNTER_SALE
    // movement that aren't otherwise linked — remove them so head balances stay clean.
    const sales = await db.otcSale.findMany({ where: { lines: { some: { productId: p.id } } }, select: { id: true, invoiceNo: true } });
    for (const s of sales) {
      await db.payment.deleteMany({ where: { notes: `OTC Sale ${s.invoiceNo}` } });
      await db.inventoryMovement.deleteMany({ where: { reference: s.id } });
    }
    await db.otcSale.deleteMany({ where: { id: { in: sales.map((x) => x.id) } } }); // cascades lines
    // A leaked retail line would suppress this product's on-hand forever AND
    // block the delete, so the whole consignment chain goes with it.
    const placementIds = (
      await db.retailPlacement.findMany({
        where: { lines: { some: { productId: p.id } } },
        select: { id: true },
      })
    ).map((x) => x.id);
    if (placementIds.length > 0) {
      const resolutions = await db.retailResolution.findMany({
        where: { placementId: { in: placementIds } },
        select: { id: true, receivableId: true },
      });
      await db.retailResolutionLine.deleteMany({ where: { resolutionId: { in: resolutions.map((r) => r.id) } } });
      await db.retailResolution.deleteMany({ where: { id: { in: resolutions.map((r) => r.id) } } });
      await db.retailReceivable.deleteMany({
        where: { id: { in: resolutions.map((r) => r.receivableId).filter(Boolean) as string[] } },
      });
      await db.retailPlacementLine.deleteMany({ where: { placementId: { in: placementIds } } });
      await db.retailPlacement.deleteMany({ where: { id: { in: placementIds } } });
    }
    await db.inventoryMovement.deleteMany({ where: { productId: p.id } });
    // Retail stock has the same foreign key to Product, so a leaked entry
    // would both suppress the next run's on-hand and block the delete.
    await db.retailStockEntry.deleteMany({ where: { productId: p.id } });
    await db.otcSaleLine.deleteMany({ where: { productId: p.id } });
    await db.otcPurchaseLine.deleteMany({ where: { productId: p.id } });
    await db.customerProduct.deleteMany({ where: { productId: p.id } });
    await db.deliveryEntry.deleteMany({ where: { productId: p.id } });
    await db.product.delete({ where: { id: p.id } }).catch(() => {});
  });
  return p;
}

export async function createCustomer(overrides: Partial<{ name: string; openingBalance: number; status: string; shiftId: string | null }> = {}) {
  const c = await db.customer.create({
    data: {
      customerCode: uniq("C"),
      name: overrides.name ?? uniq("cust"),
      phone: "0300" + Math.floor(Math.random() * 9_000_000 + 1_000_000),
      openingBalance: overrides.openingBalance ?? 0,
      status: (overrides.status ?? "ACTIVE") as never,
      shiftId: overrides.shiftId ?? null,
    },
  });
  cleanups.push(async () => {
    await db.payment.deleteMany({ where: { customerId: c.id } });
    await db.deliveryEntry.deleteMany({ where: { customerId: c.id } });
    await db.invoiceLine.deleteMany({ where: { invoice: { customerId: c.id } } });
    await db.invoice.deleteMany({ where: { customerId: c.id } });
    await db.otcSale.deleteMany({ where: { customerId: c.id } });
    await db.customerProduct.deleteMany({ where: { customerId: c.id } });
    await db.customer.delete({ where: { id: c.id } }).catch(() => {});
  });
  return c;
}

export async function createVendor(overrides: Partial<{ name: string }> = {}) {
  const v = await db.vendor.create({ data: { name: overrides.name ?? uniq("vend") } });
  cleanups.push(async () => {
    // Contra + vendor-receipt Payments carry the vendor's (unique __TEST) name in their
    // notes and have no vendor FK — delete them so they don't inflate a head balance.
    await db.payment.deleteMany({ where: { notes: { contains: v.name } } });
    await db.otcPurchaseLine.deleteMany({ where: { purchase: { vendorId: v.id } } });
    await db.otcPurchase.deleteMany({ where: { vendorId: v.id } });
    await db.expense.deleteMany({ where: { vendorId: v.id } });
    await db.vendorBill.deleteMany({ where: { vendorId: v.id } });
    await db.otcSaleLine.deleteMany({ where: { sale: { vendorId: v.id } } });
    await db.otcSale.deleteMany({ where: { vendorId: v.id } });
    await db.vendorReceivable.deleteMany({ where: { vendorId: v.id } });
    await db.vendor.delete({ where: { id: v.id } }).catch(() => {});
  });
  return v;
}

export async function createRetailVendor(overrides: Partial<{ name: string; followUpDays: number }> = {}) {
  const m = await db.retailVendor.create({
    data: { name: overrides.name ?? uniq("mart"), followUpDays: overrides.followUpDays ?? 3 },
  });
  cleanups.push(async () => {
    // FK order: payments (and the Payment rows they point at) → resolutions →
    // receivables → placements → the mart itself.
    const payments = await db.retailPayment.findMany({ where: { retailVendorId: m.id }, select: { id: true, paymentId: true } });
    await db.retailPayment.deleteMany({ where: { retailVendorId: m.id } });
    await db.payment.deleteMany({ where: { id: { in: payments.map((x) => x.paymentId) } } });

    const resolutions = await db.retailResolution.findMany({ where: { retailVendorId: m.id }, select: { id: true } });
    await db.retailResolutionLine.deleteMany({ where: { resolutionId: { in: resolutions.map((r) => r.id) } } });
    await db.retailResolution.deleteMany({ where: { retailVendorId: m.id } });

    const otc = await db.otcSale.findMany({ where: { retailVendorId: m.id }, select: { id: true, invoiceNo: true } });
    for (const s of otc) {
      await db.payment.deleteMany({ where: { notes: `OTC Sale ${s.invoiceNo}` } });
      await db.inventoryMovement.deleteMany({ where: { reference: s.id } });
    }
    await db.otcSale.deleteMany({ where: { retailVendorId: m.id } });

    await db.retailReceivable.deleteMany({ where: { retailVendorId: m.id } });
    const placements = await db.retailPlacement.findMany({ where: { retailVendorId: m.id }, select: { id: true } });
    await db.retailPlacementLine.deleteMany({ where: { placementId: { in: placements.map((x) => x.id) } } });
    await db.retailPlacement.deleteMany({ where: { retailVendorId: m.id } });
    await db.retailVendor.delete({ where: { id: m.id } }).catch(() => {});
  });
  return m;
}

export async function createEmployee(overrides: Partial<{ name: string; baseSalary: number; dailyWage: number }> = {}) {
  const e = await db.employee.create({
    data: {
      name: overrides.name ?? uniq("emp"),
      role: "Tester",
      baseSalary: overrides.baseSalary ?? 0,
      dailyWage: overrides.dailyWage ?? null,
      joinedAt: new Date(),
    },
  });
  cleanups.push(async () => {
    await db.salaryPayment.deleteMany({ where: { employeeId: e.id } });
    await db.bonus.deleteMany({ where: { employeeId: e.id } });
    await db.deduction.deleteMany({ where: { employeeId: e.id } });
    await db.attendance.deleteMany({ where: { employeeId: e.id } });
    await db.employee.delete({ where: { id: e.id } }).catch(() => {});
  });
  return e;
}

/** Create a vendor bill directly (unpaid) for netting/payment tests. */
export async function createVendorBill(vendorId: string, amount: number) {
  return db.vendorBill.create({ data: { vendorId, date: new Date(), amount, paid: 0, notes: uniq("bill") } });
}

/** Put cash into a head via a raw customer-less Payment, so outflow guards pass. */
export async function fundHead(head: string, amount: number) {
  // RIDER_CASH only counts toward its head once a handover is confirmed (receivedAt).
  // Without this stamp, funding it would silently add nothing and the test would look
  // like a formula bug rather than a setup one.
  const p = await db.payment.create({ data: {
    head: head as never, amount, notes: uniq("fund"),
    ...(head === "RIDER_CASH"
      ? { handedOverAt: new Date(), receivedAt: new Date(), receivedByName: "Test" }
      : {}),
  } });
  cleanups.push(async () => { await db.payment.delete({ where: { id: p.id } }).catch(() => {}); });
  return p;
}

/** Give a product on-hand stock. Uses COUNTER_PURCHASE — the movement the app's
 *  getOnHandByProduct actually counts as sellable stock (a bare PRODUCED is not). */
export async function addStock(productId: string, quantity: number) {
  const m = await db.inventoryMovement.create({ data: { type: "COUNTER_PURCHASE" as never, productId, quantity, reason: uniq("stock") } });
  cleanups.push(async () => { await db.inventoryMovement.delete({ where: { id: m.id } }).catch(() => {}); });
  return m;
}

import { getOnHandByProduct } from "@/lib/inventory-onhand";
/** On-hand stock for a product, via the SAME formula the app uses. */
export async function onHand(productId: string): Promise<number> {
  return (await getOnHandByProduct()).get(productId) ?? 0;
}

import { getRetailByProduct } from "@/lib/inventory-onhand";
import { SENT_TO_RETAIL } from "@/lib/packaging-stock";
/** Retail today for a product (unclamped), via the SAME formula the app uses. */
export async function inRetail(productId: string): Promise<number> {
  return (await getRetailByProduct()).get(productId) ?? 0;
}

/** Send stock from inventory to Retail through the real packaging action. Cleans
 *  up the send (RetailDispatch + its movements) after the test. */
/** Packaging sends to Retail and, unless `accept` is false, Retail accepts it in
 *  full — only an accepted send is Retail's to load. */
export async function sendToRetailFor(productId: string, quantity: number, accept = true) {
  const { sendToRetail } = await import("@/app/(dashboard)/inventory/farm-arrival/actions");
  const before = new Set(
    (await db.inventoryMovement.findMany({ where: { productId, type: "DISPATCHED", reason: SENT_TO_RETAIL }, select: { id: true } })).map((m) => m.id),
  );
  const r = await sendToRetail([{ productId, quantity }]);
  if (!r.ok) throw new Error(r.error);
  const mine = (await db.inventoryMovement.findMany({
    where: { productId, type: "DISPATCHED", reason: SENT_TO_RETAIL },
    select: { id: true, reference: true },
  })).filter((m) => !before.has(m.id));
  const refs = mine.map((m) => m.reference).filter((x): x is string => !!x);
  cleanups.push(async () => {
    await db.inventoryMovement.deleteMany({ where: { reference: { in: refs } } });
    await db.retailDispatch.deleteMany({ where: { id: { in: refs } } });
  });
  if (accept) await db.retailDispatch.updateMany({ where: { id: { in: refs } }, data: { status: "CONFIRMED" } });
  return refs[0];
}
