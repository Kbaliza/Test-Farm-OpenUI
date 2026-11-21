"use server";

import { requireRole, OTC_ACCESS } from "@/lib/auth";
import { unitLabel } from "@/lib/units";
import type { Unit } from "@/lib/units";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getHeadBalances, INFLOW_HEADS } from "@/lib/head-balances";
import type { PaymentHeadName } from "@/lib/payment-heads";
import { getOnHandByProduct } from "@/lib/inventory-onhand";
import { todayPKTString } from "@/lib/pkt";

// Money coming IN, so Rider Cash is not on the list — see INFLOW_HEADS. A counter
// sale is not rider-collected cash.
const VALID_HEADS = INFLOW_HEADS;

export type OtcProductOption = {
  productId: string;
  productName: string;
  unit: Unit;
  defaultRate: number;
  // Current quantity in storage — shown next to the product, and the ceiling on
  // what can be sold. Undefined for retail products, which have no stock figure;
  // the line editor reads that as "no stock info" and applies no ceiling.
  onHand?: number;
};

export type OtcCustomerOption = {
  customerId: string;
  name: string;
  customerCode: string;
  // Resolved fallback: customer.deliveryCharge, else the customer's area default, else 0.
  deliveryCharge: number;
};

export type OtcVendorOption = {
  vendorId: string;
  name: string;
};

export type OtcHeadOption = {
  head: string;
  label: string;
  balance: number;
};

export type OtcSaleContext = {
  products: OtcProductOption[];
  customers: OtcCustomerOption[];
  vendors: OtcVendorOption[];
  /** Shops we also supply on consignment — see /retail. */
  retailVendors: OtcVendorOption[];
  heads: OtcHeadOption[];
  nextInvoiceNo: string;
  dbReady: boolean;
};

export async function getOtcSaleContext(): Promise<OtcSaleContext> {
  await requireRole(OTC_ACCESS);
  try {
    const [products, customers, vendors, retailVendors, heads, nextInvoiceNo, onHand] = await Promise.all([
      db.product.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
      db.customer.findMany({
        // On-call customers belong here more than anyone: they are served when
        // they phone in, which is exactly what a counter sale records. They were
        // excluded only because this filter predates the status existing.
        where: { status: { in: ["ACTIVE", "ON_CALL"] } },
        select: {
          id: true, name: true, customerCode: true, deliveryCharge: true,
          area: { select: { defaultDeliveryCharge: true } },
        },
        orderBy: { name: "asc" },
      }),
      db.vendor.findMany({ orderBy: { name: "asc" } }),
      db.retailVendor.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
      getHeadBalances(),
      nextOtcSaleInvoiceNo(),
      getOnHandByProduct(),
    ]);
    return {
      products: products.map((p) => ({
        productId: p.id, productName: p.name,
        unit: p.unit as Unit,
        defaultRate: Number(p.defaultRate),
        // Every product carries a real figure now, retail products included. It
        // used to be left undefined for those, which the line editor reads as "no
        // stock info" and shows no ceiling for — a screen that would now offer
        // exactly what the server refuses.
        onHand: onHand.get(p.id) ?? 0,
      })),
      customers: customers.map((c) => ({
        customerId: c.id, name: c.name, customerCode: c.customerCode,
        deliveryCharge: Number(c.deliveryCharge) || Number(c.area?.defaultDeliveryCharge ?? 0),
      })),
      vendors: vendors.map((v) => ({ vendorId: v.id, name: v.name })),
      retailVendors: retailVendors.map((v) => ({ vendorId: v.id, name: v.name })),
      heads: heads.map((h) => ({ head: h.head, label: h.label, balance: h.balance })),
      nextInvoiceNo,
      dbReady: true,
    };
  } catch {
    return { products: [], customers: [], vendors: [], retailVendors: [], heads: [], nextInvoiceNo: "SAL-0001", dbReady: false };
  }
}

// True next serial in the "SAL-0001" sequence, scoped to that exact pattern —
// same reasoning as nextCustomerCodeValue() in customers/actions.ts: never
// derive it from "last created row," which can jump around.
async function nextOtcSaleInvoiceNo(): Promise<string> {
  const rows = await db.$queryRaw<{ maxnum: number | null }[]>`
    SELECT MAX(CAST(substring("invoiceNo" from '^SAL-([0-9]+)$') AS INTEGER)) as maxnum
    FROM "OtcSale"
    WHERE "invoiceNo" ~ '^SAL-[0-9]+$'
  `;
  const next = (rows[0]?.maxnum ?? 0) + 1;
  return `SAL-${String(next).padStart(4, "0")}`;
}

export type CreateOtcSaleInput = {
  date: string; // YYYY-MM-DD
  // RETAIL is a straight counter sale to a shop we also supply on consignment.
  // The consignment drops themselves live in /retail, not here.
  customerType: "CASH" | "REGULAR" | "VENDOR" | "RETAIL";
  customerId?: string | null;
  vendorId?: string | null;
  retailVendorId?: string | null;
  cashName?: string | null;
  deliveryCharge: number;
  narration?: string | null;
  // Cash settled at the counter now. 0 = fully on credit, = total = fully paid,
  // anything between = partial. The credit remainder is always total - paidAmount.
  paidAmount: number;
  paymentHead?: string | null; // required when paidAmount > 0 (where the cash lands)
  lines: { productId: string; unit: string; rate: number; quantity: number }[];
};

export type OtcSaveResult =
  | { ok: true; id: string; invoiceNo: string }
  | { ok: false; error: string };

export async function createOtcSale(data: CreateOtcSaleInput): Promise<OtcSaveResult> {
  const user = await requireRole(OTC_ACCESS);

  const items = data.lines.filter((l) => l.productId && l.quantity > 0);
  if (!items.length) return { ok: false, error: "Add at least one item with a quantity." };

  // Every rate and quantity must be a real, non-negative number.
  //
  // `rate` was previously unvalidated, and NaN defeats the `totalAmount <= 0`
  // check below because every comparison against NaN is false. A NaN then reached
  // Payment.amount (Postgres numeric accepts NaN), which made the SUM in
  // getHeadBalances NaN, which made `amount - available > 0.005` false in
  // checkHeadFunds — silently disabling the overdraft guard on EVERY head.
  // Negative rates were likewise only caught via the net total.
  for (const l of items) {
    if (!Number.isFinite(l.rate) || l.rate < 0)
      return { ok: false, error: "Rate must be a valid, non-negative number." };
    if (!Number.isFinite(l.quantity) || l.quantity <= 0)
      return { ok: false, error: "Quantity must be a valid number greater than 0." };
  }
  if (!Number.isFinite(data.deliveryCharge ?? 0))
    return { ok: false, error: "Delivery charge must be a valid number." };

  if (data.customerType === "REGULAR" && !data.customerId) return { ok: false, error: "Select a customer." };
  if (data.customerType === "VENDOR" && !data.vendorId) return { ok: false, error: "Select a vendor." };
  if (data.customerType === "RETAIL" && !data.retailVendorId) return { ok: false, error: "Select a shop." };

  const linesAmount = items.reduce((s, l) => s + l.rate * l.quantity, 0);
  const deliveryCharge = Math.max(0, data.deliveryCharge || 0);
  const totalAmount = linesAmount + deliveryCharge;
  if (totalAmount <= 0) return { ok: false, error: "Total must be greater than 0." };

  // How much is settled in cash now (the rest rides on credit). Validate against
  // the server-computed total so a stale/scripted client can't overpay or make a
  // NaN slip through into Payment.amount (which would poison getHeadBalances).
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const rawPaid = data.paidAmount ?? 0;
  if (!Number.isFinite(rawPaid) || rawPaid < 0) {
    return { ok: false, error: "Paying-now amount must be a valid, non-negative number." };
  }
  if (rawPaid > totalAmount + 0.005) {
    return { ok: false, error: "Paying now can't be more than the total." };
  }
  const paidAmount = Math.min(round2(rawPaid), totalAmount);
  // CASH walk-ins have no account to bill, so they must settle in full.
  if (data.customerType === "CASH" && paidAmount < totalAmount - 0.005) {
    return { ok: false, error: "Cash sales must be paid in full — there's no account to bill later." };
  }
  // Any cash coming in needs a head to land in.
  if (paidAmount > 0.005 && !VALID_HEADS.includes(data.paymentHead || "")) {
    return { ok: false, error: "Select a payment account for the amount paid now." };
  }
  // Derived, display-only label — the money math above/below uses paidAmount.
  const paymentStatus =
    paidAmount <= 0.005 ? "CREDIT" : paidAmount >= totalAmount - 0.005 ? "PAID" : "PARTIAL";
  const paidHead = paidAmount > 0.005 ? (data.paymentHead as string) : null;

  // Can't sell more than we physically hold. Sum per product first (the same
  // product can appear on more than one line), then compare each against current
  // on-hand. This is a fast pre-check for a friendly error; the AUTHORITATIVE guard
  // is the advisory-locked re-read inside the transaction below (race-free).
  const onHand = await getOnHandByProduct();
  const products = await db.product.findMany({
    where: { id: { in: items.map((l) => l.productId) } },
    select: { id: true, name: true, unit: true },
  });
  const nameById = new Map(products.map((p) => [p.id, { name: p.name, unit: p.unit }]));

  // Every line is in this map, retail products included — they are counted now,
  // so they are checked and locked like anything else. A sale mixing a bottle
  // with real milk guards both, because everything below reads this same map.
  const wantByProduct = new Map<string, number>();
  for (const l of items) {
    wantByProduct.set(l.productId, (wantByProduct.get(l.productId) ?? 0) + l.quantity);
  }
  for (const [productId, want] of wantByProduct) {
    const have = onHand.get(productId) ?? 0;
    if (want > have + 1e-6) {
      const info = nameById.get(productId);
      const u = info ? unitLabel(info.unit) : "";
      return {
        ok: false,
        error: `Not enough stock for ${info?.name ?? "this product"}: ${have}${u} in storage, ${want}${u} requested.`,
      };
    }
  }

  // Record the real time for a same-day transaction (the common case) so the
  // ledger shows when it actually happened; a back-dated entry keeps noon of
  // the chosen day (its real time is unknown).
  const dt = !data.date || data.date === todayPKTString() ? new Date() : new Date(data.date + "T12:00:00");

  try {
    let created: { id: string; invoiceNo: string } | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const invoiceNo = await nextOtcSaleInvoiceNo();
      try {
        created = await db.$transaction(async (tx) => {
          // Serialize against every other stock-outflow path (waste-entry,
          // rider-extras, and concurrent OTC sales) on the same product via a
          // SHARED "stock:" advisory lock, then re-read on-hand inside the txn so
          // two concurrent outflows can't both pass the ≤-stock check and oversell.
          for (const pid of [...wantByProduct.keys()].sort()) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock:" + pid}))`;
          }
          const freshOnHand = await getOnHandByProduct();
          for (const [productId, want] of wantByProduct) {
            const have = freshOnHand.get(productId) ?? 0;
            if (want > have + 1e-6) {
              const info = nameById.get(productId);
              const u = info ? unitLabel(info.unit) : "";
              throw new Error(`Not enough stock for ${info?.name ?? "this product"}: ${have}${u} in storage, ${want}${u} requested.`);
            }
          }

          // A sale to a Vendor always gets a VendorReceivable — paid or on
          // credit — the same symmetric pattern OtcPurchase already uses for
          // VendorBill, just the opposite direction (money they owe us).
          // The same symmetric treatment for a shop: a sale to a mart always gets
          // a RetailReceivable, paid or on credit, so their balance on the Retail
          // page is the whole picture.
          let retailReceivableId: string | null = null;
          if (data.customerType === "RETAIL") {
            const receivable = await tx.retailReceivable.create({
              data: {
                retailVendorId: data.retailVendorId!,
                date: dt,
                amount: new Prisma.Decimal(totalAmount),
                received: new Prisma.Decimal(paidAmount),
                source: "OTC",
                notes: `Over the Counter sale ${invoiceNo}`,
              },
            });
            retailReceivableId = receivable.id;
          }

          let vendorReceivableId: string | null = null;
          if (data.customerType === "VENDOR") {
            const receivable = await tx.vendorReceivable.create({
              data: {
                vendorId: data.vendorId!,
                date: dt,
                amount: new Prisma.Decimal(totalAmount),
                received: new Prisma.Decimal(paidAmount),
                notes: `Over the Counter sale ${invoiceNo}`,
              },
            });
            vendorReceivableId = receivable.id;
          }

          const sale = await tx.otcSale.create({
            data: {
              invoiceNo,
              date: dt,
              customerType: data.customerType,
              customerId: data.customerType === "REGULAR" ? data.customerId : null,
              vendorId: data.customerType === "VENDOR" ? data.vendorId : null,
              retailVendorId: data.customerType === "RETAIL" ? data.retailVendorId : null,
              cashName: data.customerType === "CASH" ? (data.cashName?.trim() || null) : null,
              deliveryCharge: new Prisma.Decimal(deliveryCharge),
              narration: data.narration?.trim() || null,
              totalAmount: new Prisma.Decimal(totalAmount),
              paidAmount: new Prisma.Decimal(paidAmount),
              paymentStatus,
              paymentHead: paidHead,
              vendorReceivableId,
              retailReceivableId,
              enteredById: user.id,
              lines: {
                create: items.map((l) => ({
                  productId: l.productId,
                  // The product's own unit, not whatever the client sent: the
                  // browser used to post a LABEL here ("L"), which is undefined
                  // for any unit it had not been told about and made this whole
                  // transaction throw.
                  unit: nameById.get(l.productId)?.unit ?? l.unit,
                  rate: new Prisma.Decimal(l.rate),
                  quantity: new Prisma.Decimal(l.quantity),
                  amount: new Prisma.Decimal(l.rate * l.quantity),
                })),
              },
            },
          });

          // Stock leaves the moment the sale is saved, regardless of payment status.
          await tx.inventoryMovement.createMany({
            data: items.map((l) => ({
              date: dt,
              type: "COUNTER_SALE" as const,
              productId: l.productId,
              quantity: new Prisma.Decimal(l.quantity),
              reference: sale.id,
              reason: `OTC Sale ${invoiceNo}`,
              enteredById: user.id,
            })),
          });

          // Paid now -> a real Payment so the cash lands in a head. Credit -> no
          // row here; it's picked up as an unpaid charge by computePrevBalance()
          // in billing/invoices and by computeCustomerOutstanding().
          //
          // customerId is deliberately NULL even for a REGULAR customer. A settled
          // counter sale is a cash transaction, not a payment against their milk
          // account — the goods and the money changed hands together. Attributing
          // it to the customer used to subtract it from what they owe (every
          // reader sums *all* their payments) while no matching charge was ever
          // added (only CREDIT sales are charged), so paying cash at the counter
          // silently wrote the same amount off their subscription arrears, and
          // understated `totalDue` on their invoice by the same amount.
          // Who bought it is still recorded on OtcSale.customerId.
          if (paidAmount > 0.005) {
            await tx.payment.create({
              data: {
                date: dt,
                customerId: null,
                amount: new Prisma.Decimal(paidAmount),
                head: paidHead as PaymentHeadName,
                notes: `OTC Sale ${invoiceNo}`,
                enteredById: user.id,
              },
            });
          }

          return { id: sale.id, invoiceNo };
        });
        break;
      } catch (e) {
        const isCollision =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002" &&
          (e.meta?.target as string[] | undefined)?.includes("invoiceNo");
        if (isCollision && attempt < 4) continue;
        throw e;
      }
    }
    if (!created) throw new Error("Could not generate a unique invoice number — please try again.");

    revalidatePath("/over-the-counter/sale");
    revalidatePath("/inventory");
    revalidatePath("/ledgers");
    if (data.customerType === "REGULAR") {
      revalidatePath("/billing/invoices");
      revalidatePath("/payments/recovery");
    }
    if (data.customerType === "VENDOR") {
      revalidatePath("/payments/vendors");
    }
    if (data.customerType === "RETAIL") {
      revalidatePath("/retail");
    }
    revalidatePath("/");
    return { ok: true, id: created.id, invoiceNo: created.invoiceNo };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save sale." };
  }
}

export type OtcSaleLineView = {
  productId: string;
  productName: string;
  unit: string;
  rate: number;
  quantity: number;
  amount: number;
};

/**
 * Undo a sale completely: the stock goes back on the shelf, the money comes back
 * out of the head it landed in, and whatever the buyer was left owing goes with
 * it — a vendor's or a shop's receivable, or a regular customer's credit charge,
 * which is read straight off the sale and so disappears with it.
 *
 * It refuses when money has been collected against the receivable since, because
 * that receipt would be left pointing at nothing. Undo the receipt first.
 */
export async function deleteOtcSale(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireRole(OTC_ACCESS);
  try {
    const sale = await db.otcSale.findUnique({
      where: { id },
      include: {
        vendorReceivable: { select: { id: true, received: true } },
        retailReceivable: { select: { id: true, received: true } },
      },
    });
    if (!sale) return { ok: false, error: "That sale is no longer here." };

    const paidThen = Number(sale.paidAmount);
    const receivable = sale.vendorReceivable ?? sale.retailReceivable;
    if (receivable && Number(receivable.received) > paidThen + 0.005) {
      return {
        ok: false,
        error: `Rs ${(Number(receivable.received) - paidThen).toLocaleString()} has been received against this sale since it was entered. Undo that receipt first, then delete this.`,
      };
    }

    await db.$transaction(async (tx) => {
      // The stock it took out comes back.
      await tx.inventoryMovement.deleteMany({ where: { type: "COUNTER_SALE", reference: sale.id } });
      // The cash it brought in leaves the head again.
      await tx.payment.deleteMany({ where: { customerId: null, notes: `OTC Sale ${sale.invoiceNo}` } });
      // The sale and its lines; then whichever receivable it raised.
      await tx.otcSale.delete({ where: { id: sale.id } });
      if (sale.vendorReceivableId) await tx.vendorReceivable.delete({ where: { id: sale.vendorReceivableId } });
      if (sale.retailReceivableId) await tx.retailReceivable.delete({ where: { id: sale.retailReceivableId } });
    });

    for (const p of [
      "/over-the-counter/sale", "/inventory", "/ledgers", "/payments/vendors",
      "/retail", "/billing/invoices", "/billing/payment-receiving", "/",
    ]) revalidatePath(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete the sale." };
  }
}

export type OtcSaleHistoryEntry = {
  id: string;
  invoiceNo: string;
  date: string;
  customerType: "CASH" | "REGULAR" | "VENDOR" | "RETAIL";
  partyName: string;
  deliveryCharge: number;
  narration: string;
  totalAmount: number;
  paidAmount: number;
  paymentStatus: "PAID" | "PARTIAL" | "CREDIT";
  paymentHead: string | null;
  lines: OtcSaleLineView[];
};

export async function getOtcSaleHistory(): Promise<{ sales: OtcSaleHistoryEntry[]; dbReady: boolean }> {
  await requireRole(OTC_ACCESS);
  try {
    const sales = await db.otcSale.findMany({
      orderBy: { date: "desc" },
      take: 200,
      include: {
        customer: { select: { name: true } },
        vendor: { select: { name: true } },
        retailVendor: { select: { name: true } },
        lines: { include: { product: { select: { name: true } } } },
      },
    });
    return {
      sales: sales.map((s) => ({
        id: s.id,
        invoiceNo: s.invoiceNo,
        date: s.date.toISOString(),
        customerType: s.customerType as "CASH" | "REGULAR" | "VENDOR" | "RETAIL",
        partyName:
          s.customerType === "REGULAR" ? (s.customer?.name ?? "—")
          : s.customerType === "VENDOR" ? (s.vendor?.name ?? "—")
          : s.customerType === "RETAIL" ? (s.retailVendor?.name ?? "—")
          : (s.cashName?.trim() || "Walk-in"),
        deliveryCharge: Number(s.deliveryCharge),
        narration: s.narration ?? "",
        totalAmount: Number(s.totalAmount),
        paidAmount: Number(s.paidAmount),
        paymentStatus: s.paymentStatus as "PAID" | "PARTIAL" | "CREDIT",
        paymentHead: s.paymentHead,
        lines: s.lines.map((l) => ({
          productId: l.productId,
          productName: l.product.name,
          unit: l.unit,
          rate: Number(l.rate),
          quantity: Number(l.quantity),
          amount: Number(l.amount),
        })),
      })),
      dbReady: true,
    };
  } catch {
    return { sales: [], dbReady: false };
  }
}
