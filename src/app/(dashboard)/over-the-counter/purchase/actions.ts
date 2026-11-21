"use server";

import { requireRole, OTC_ACCESS } from "@/lib/auth";
import type { Unit } from "@/lib/units";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { checkHeadFunds, guardHeadFundsTx, getHeadBalances, VISIBLE_HEADS } from "@/lib/head-balances";
import type { PaymentHeadName } from "@/lib/payment-heads";
import { getOnHandByProduct } from "@/lib/inventory-onhand";
import { getStockResetAt } from "@/lib/stock-reset";
import { todayPKTString } from "@/lib/pkt";

// Paying out, so any head will do — the Rider Cash box included.
const VALID_HEADS = VISIBLE_HEADS;

export type OtcProductOption = {
  productId: string;
  productName: string;
  unit: Unit;
  defaultRate: number;
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

export type OtcPurchaseContext = {
  products: OtcProductOption[];
  vendors: OtcVendorOption[];
  heads: OtcHeadOption[];
  nextInvoiceNo: string;
  dbReady: boolean;
};

export async function getOtcPurchaseContext(): Promise<OtcPurchaseContext> {
  await requireRole(OTC_ACCESS);
  try {
    const [products, vendors, heads, nextInvoiceNo] = await Promise.all([
      db.product.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
      db.vendor.findMany({ orderBy: { name: "asc" } }),
      getHeadBalances(),
      nextOtcPurchaseInvoiceNo(),
    ]);
    return {
      products: products.map((p) => ({
        productId: p.id, productName: p.name,
        unit: p.unit as Unit,
        defaultRate: Number(p.defaultRate),
      })),
      vendors: vendors.map((v) => ({ vendorId: v.id, name: v.name })),
      heads: heads.map((h) => ({ head: h.head, label: h.label, balance: h.balance })),
      nextInvoiceNo,
      dbReady: true,
    };
  } catch {
    return { products: [], vendors: [], heads: [], nextInvoiceNo: "PUR-0001", dbReady: false };
  }
}

async function nextOtcPurchaseInvoiceNo(): Promise<string> {
  const rows = await db.$queryRaw<{ maxnum: number | null }[]>`
    SELECT MAX(CAST(substring("invoiceNo" from '^PUR-([0-9]+)$') AS INTEGER)) as maxnum
    FROM "OtcPurchase"
    WHERE "invoiceNo" ~ '^PUR-[0-9]+$'
  `;
  const next = (rows[0]?.maxnum ?? 0) + 1;
  return `PUR-${String(next).padStart(4, "0")}`;
}

export type CreateOtcPurchaseInput = {
  date: string; // YYYY-MM-DD
  vendorId: string;
  deliveryCharge: number;
  narration?: string | null;
  // Cash paid to the vendor now. 0 = fully on credit, = total = fully paid, in
  // between = partial. The credit remainder (amount we still owe) = total - paidAmount.
  paidAmount: number;
  paymentHead?: string | null; // required when paidAmount > 0 (where the cash leaves from)
  lines: { productId: string; unit: string; rate: number; quantity: number }[];
};

export type OtcSaveResult =
  | { ok: true; id: string; invoiceNo: string }
  | { ok: false; error: string };

export async function createOtcPurchase(data: CreateOtcPurchaseInput): Promise<OtcSaveResult> {
  const user = await requireRole(OTC_ACCESS);

  if (!data.vendorId) return { ok: false, error: "Select a vendor." };
  const items = data.lines.filter((l) => l.productId && l.quantity > 0);
  if (!items.length) return { ok: false, error: "Add at least one item with a quantity." };

  // Same guard as the sale side: NaN slips past `totalAmount <= 0` (every NaN
  // comparison is false) and would reach Expense.amount, turning the head SUM into
  // NaN and silently disabling checkHeadFunds everywhere. A negative rate netted
  // the cash-out down while the full quantity still posted to stock.
  for (const l of items) {
    if (!Number.isFinite(l.rate) || l.rate < 0)
      return { ok: false, error: "Rate must be a valid, non-negative number." };
    if (!Number.isFinite(l.quantity) || l.quantity <= 0)
      return { ok: false, error: "Quantity must be a valid number greater than 0." };
  }
  if (!Number.isFinite(data.deliveryCharge ?? 0))
    return { ok: false, error: "Delivery charge must be a valid number." };

  // A purchase brings stock IN and raises a vendor bill with it. Retail products
  // are stocked without any money attached — the count is entered by hand on the
  // Retail tab — so routing one through here would invent a payable nobody owes.
  const lineProducts = await db.product.findMany({
    where: { id: { in: items.map((l) => l.productId) } },
    select: { id: true, name: true, unit: true, retailOnly: true },
  });
  const retailOnly = lineProducts.find((p) => p.retailOnly);
  if (retailOnly) {
    return {
      ok: false,
      error: `${retailOnly.name} is a retail product — add its stock on the Retail Inventory page. Buying it here would raise a vendor bill nobody owes.`,
    };
  }
  const unitById = new Map(lineProducts.map((p) => [p.id, p.unit as string]));

  const linesAmount = items.reduce((s, l) => s + l.rate * l.quantity, 0);
  const deliveryCharge = Math.max(0, data.deliveryCharge || 0);
  const totalAmount = linesAmount + deliveryCharge;
  if (totalAmount <= 0) return { ok: false, error: "Total must be greater than 0." };

  // How much cash we hand over now (the rest becomes an unpaid VendorBill). Validate
  // against the server-computed total so a stale/scripted client can't overpay or
  // sneak a NaN into Expense.amount (which would poison getHeadBalances).
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const rawPaid = data.paidAmount ?? 0;
  if (!Number.isFinite(rawPaid) || rawPaid < 0) {
    return { ok: false, error: "Paying-now amount must be a valid, non-negative number." };
  }
  if (rawPaid > totalAmount + 0.005) {
    return { ok: false, error: "Paying now can't be more than the total." };
  }
  const paidAmount = Math.min(round2(rawPaid), totalAmount);
  if (paidAmount > 0.005 && !VALID_HEADS.includes(data.paymentHead || "")) {
    return { ok: false, error: "Select a payment account for the amount paid now." };
  }
  const paymentStatus =
    paidAmount <= 0.005 ? "CREDIT" : paidAmount >= totalAmount - 0.005 ? "PAID" : "PARTIAL";
  const paidHead = paidAmount > 0.005 ? (data.paymentHead as string) : null;

  // Outflow guard — mirrors recordVendorPayment's overdraw check — only for the
  // cash that actually leaves a head right now (the paid slice).
  if (paidAmount > 0.005) {
    const guard = await checkHeadFunds(paidHead!, paidAmount);
    if (!guard.ok) return guard;
  }

  // Same-day purchase keeps the real time (shown in the vendor ledger); a
  // back-dated one keeps noon of the chosen day.
  const dt = !data.date || data.date === todayPKTString() ? new Date() : new Date(data.date + "T12:00:00");

  try {
    let created: { id: string; invoiceNo: string } | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const invoiceNo = await nextOtcPurchaseInvoiceNo();
      try {
        created = await db.$transaction(async (tx) => {
          // Race-free overdraft guard inside the write for the cash actually leaving
          // a head now — the paid slice (checkHeadFunds above is only a pre-check).
          if (paidAmount > 0.005) await guardHeadFundsTx(tx, paidHead!, paidAmount);
          // Same VendorBill mechanics as the existing Vendor Bills flow, now
          // partial-aware: `paid` carries whatever was settled now, so the bill
          // shows the remaining (amount - paid) as outstanding automatically.
          const vendorBill = await tx.vendorBill.create({
            data: {
              vendorId: data.vendorId,
              date: dt,
              amount: new Prisma.Decimal(totalAmount),
              paid: new Prisma.Decimal(paidAmount),
              notes: `Over the Counter purchase ${invoiceNo}`,
            },
          });

          const purchase = await tx.otcPurchase.create({
            data: {
              invoiceNo,
              date: dt,
              vendorId: data.vendorId,
              deliveryCharge: new Prisma.Decimal(deliveryCharge),
              narration: data.narration?.trim() || null,
              totalAmount: new Prisma.Decimal(totalAmount),
              paidAmount: new Prisma.Decimal(paidAmount),
              paymentStatus,
              paymentHead: paidHead,
              vendorBillId: vendorBill.id,
              enteredById: user.id,
              lines: {
                create: items.map((l) => ({
                  productId: l.productId,
                  // The product's own unit, never the label the client posted —
                  // see the matching note in the sale action.
                  unit: unitById.get(l.productId) ?? l.unit,
                  rate: new Prisma.Decimal(l.rate),
                  quantity: new Prisma.Decimal(l.quantity),
                  amount: new Prisma.Decimal(l.rate * l.quantity),
                })),
              },
            },
          });

          // Stock arrives the moment the purchase is saved, regardless of payment status.
          await tx.inventoryMovement.createMany({
            data: items.map((l) => ({
              date: dt,
              type: "COUNTER_PURCHASE" as const,
              productId: l.productId,
              quantity: new Prisma.Decimal(l.quantity),
              reference: purchase.id,
              reason: `OTC Purchase ${invoiceNo}`,
              enteredById: user.id,
            })),
          });

          // Cash leaving a head right now (the paid slice) — same "Vendor Payment"
          // expense category recordVendorPayment() already uses, so it's the same
          // cash-out trail. On a partial purchase this is only the amount paid now.
          if (paidAmount > 0.005) {
            let vendorCat = await tx.expenseCategory.findFirst({ where: { name: "Vendor Payment" } });
            if (!vendorCat) vendorCat = await tx.expenseCategory.create({ data: { name: "Vendor Payment" } });
            const vendor = await tx.vendor.findUnique({ where: { id: data.vendorId }, select: { name: true } });
            await tx.expense.create({
              data: {
                date: dt,
                categoryId: vendorCat.id,
                amount: new Prisma.Decimal(paidAmount),
                head: paidHead as PaymentHeadName,
                description: `OTC Purchase ${invoiceNo} — ${vendor?.name ?? "Vendor"}`,
                chitReceived: false,
                // Link the cash-out to the vendor, like recordVendorPayment does.
                // Without it, deleting this expense returned the cash to the head
                // while the VendorBill (created pre-settled just above) stayed
                // marked paid — goods received, payable settled, money back.
                vendorId: data.vendorId,
              },
            });
          }

          return { id: purchase.id, invoiceNo };
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

    revalidatePath("/over-the-counter/purchase");
    revalidatePath("/inventory");
    revalidatePath("/ledgers");
    revalidatePath("/payments/vendors");
    revalidatePath("/payments/expenses");
    // Dashboard "Outstanding (we owe them)" / head-balance tiles read vendor bills
    // and head expenses; without this the dashboard served a stale cached render and
    // a fresh purchase appeared to have no effect. The OTC sale side already does this.
    revalidatePath("/");
    return { ok: true, id: created.id, invoiceNo: created.invoiceNo };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save purchase." };
  }
}

/**
 * Undo a purchase completely: the stock it brought in, the bill it raised and the
 * cash it paid out all go with it.
 *
 * Deleting the vendor's bill on its own used to leave the purchase standing and
 * its milk on the shelf — the payable vanished while the goods and the cash-out
 * stayed, so the books said we had been given it for nothing. Everything that
 * purchase wrote is reversed here, in one transaction, or none of it is.
 *
 * Two things stop it, because neither can be put right by deleting rows:
 *   • money paid against its bill since it was raised — that receipt has to be
 *     undone first, or the payment would be left pointing at nothing;
 *   • stock that has already been used, sold or sent out — the milk cannot be
 *     un-bought once it has left the building.
 */
export async function deleteOtcPurchase(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireRole(OTC_ACCESS);
  try {
    const purchase = await db.otcPurchase.findUnique({
      where: { id },
      include: {
        lines: { select: { productId: true, quantity: true, product: { select: { name: true, unit: true } } } },
        vendorBill: { select: { id: true, paid: true } },
      },
    });
    if (!purchase) return { ok: false, error: "That purchase is no longer here." };

    const paidThen = Number(purchase.paidAmount);
    const paidNow = purchase.vendorBill ? Number(purchase.vendorBill.paid) : paidThen;
    if (paidNow > paidThen + 0.005) {
      return {
        ok: false,
        error: `Rs ${(paidNow - paidThen).toLocaleString()} has been paid against this purchase since it was entered. Undo that payment on the Vendors page first, then delete this.`,
      };
    }

    // Stock this purchase is still holding up. A purchase from before the last
    // stock reset contributes nothing now — its arrival was settled with
    // everything else — so there is nothing to take back.
    const resetAt = await getStockResetAt();
    const stillCounted = !resetAt || purchase.createdAt >= resetAt;
    if (stillCounted) {
      const onHand = await getOnHandByProduct();
      for (const l of purchase.lines) {
        const have = onHand.get(l.productId) ?? 0;
        const bought = Number(l.quantity);
        if (have + 0.0005 < bought) {
          return {
            ok: false,
            error: `${l.product.name}: this purchase brought in ${bought}, but only ${Math.round(have * 1000) / 1000} is left in inventory — the rest has been used or sent out, so it cannot be taken back off the books.`,
          };
        }
      }
    }

    await db.$transaction(async (tx) => {
      // The stock it brought in.
      await tx.inventoryMovement.deleteMany({ where: { type: "COUNTER_PURCHASE", reference: purchase.id } });
      // The cash it paid out, which returns to the head it left.
      await tx.expense.deleteMany({
        where: { vendorId: purchase.vendorId, description: { startsWith: `OTC Purchase ${purchase.invoiceNo}` } },
      });
      // The purchase itself, its lines with it, and then the bill it points at.
      await tx.otcPurchase.delete({ where: { id: purchase.id } });
      if (purchase.vendorBill) await tx.vendorBill.delete({ where: { id: purchase.vendorBill.id } });
    });

    revalidatePath("/over-the-counter/purchase");
    revalidatePath("/inventory");
    revalidatePath("/ledgers");
    revalidatePath("/payments/vendors");
    revalidatePath("/payments/expenses");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete the purchase." };
  }
}

export type OtcPurchaseLineView = {
  productId: string;
  productName: string;
  unit: string;
  rate: number;
  quantity: number;
  amount: number;
};

export type OtcPurchaseHistoryEntry = {
  id: string;
  invoiceNo: string;
  date: string;
  vendorName: string;
  deliveryCharge: number;
  narration: string;
  totalAmount: number;
  paidAmount: number;
  paymentStatus: "PAID" | "PARTIAL" | "CREDIT";
  paymentHead: string | null;
  lines: OtcPurchaseLineView[];
};

export async function getOtcPurchaseHistory(): Promise<{ purchases: OtcPurchaseHistoryEntry[]; dbReady: boolean }> {
  await requireRole(OTC_ACCESS);
  try {
    const purchases = await db.otcPurchase.findMany({
      orderBy: { date: "desc" },
      take: 200,
      include: {
        vendor: { select: { name: true } },
        lines: { include: { product: { select: { name: true } } } },
      },
    });
    return {
      purchases: purchases.map((p) => ({
        id: p.id,
        invoiceNo: p.invoiceNo,
        date: p.date.toISOString(),
        vendorName: p.vendor.name,
        deliveryCharge: Number(p.deliveryCharge),
        narration: p.narration ?? "",
        totalAmount: Number(p.totalAmount),
        paidAmount: Number(p.paidAmount),
        paymentStatus: p.paymentStatus as "PAID" | "PARTIAL" | "CREDIT",
        paymentHead: p.paymentHead,
        lines: p.lines.map((l) => ({
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
    return { purchases: [], dbReady: false };
  }
}
