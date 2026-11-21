"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import {
  getHeadBalances, checkHeadFunds, guardHeadFundsTx, INFLOW_HEADS, type HeadBalance,
} from "@/lib/head-balances";
import {
  isFarmSaleCategory, isValidUnit, categoryHasTag, cleanDetails,
  FARM_SALE_BUYER_TYPES,
} from "@/lib/farm-sale-catalog";
import { todayPKTString } from "@/lib/pkt";
import type { PaymentHeadName } from "@/lib/payment-heads";

// Selling what the farm produces that is not milk: an animal, a machine, a trolley
// of silage, scrap.
//
// Two things make this its own module rather than another OtcSale customerType:
//   • an OtcSaleLine needs a real Product and a milk Unit, and a buffalo is neither;
//   • everything that reads OtcSale counts it as revenue, and a Rs 265,000 animal
//     landing in Monthly Sales would dwarf a month of milk.
//
// Every farm sale is paid in full — there is no credit path, so no receivable is
// written and nobody ends up owing us for one.

const round2 = (n: number) => Math.round(n * 100) / 100;

// Money coming IN, so Rider Cash is not on the list: a Payment written straight
// onto RIDER_CASH from a desk screen has no receivedAt and would sit in no head at
// all — see HEAD_PAYMENT_WHERE in lib/head-balances.
const VALID_HEADS = INFLOW_HEADS;

export type FarmSaleLineInput = {
  category: string;
  item: string;
  unit: string;
  rate: number;
  quantity: number;
  animalTag?: string | null;
  details?: Record<string, string> | null;
};

export type FarmSaleLineView = {
  id: string;
  category: string;
  item: string;
  unit: string;
  rate: number;
  quantity: number;
  amount: number;
  animalTag: string | null;
  details: Record<string, string> | null;
};

export type FarmSaleView = {
  id: string;
  invoiceNo: string;
  date: string;
  buyerType: string;
  buyerName: string;
  vendorId: string | null;
  transportCharge: number;
  gatePassNo: string | null;
  narration: string | null;
  totalAmount: number;
  paymentHead: string;
  lines: FarmSaleLineView[];
};

export type FarmSalesContext = {
  vendors: { id: string; name: string; phone: string | null }[];
  heads: HeadBalance[];
  nextInvoiceNo: string;
  today: string;
  dbReady: boolean;
};

export type FarmSaleResult =
  | { ok: true; id: string; invoiceNo: string }
  | { ok: false; error: string };

/**
 * The true next serial in the "FSAL-0001" sequence, scoped to that exact pattern so
 * a stray row with another prefix never makes it jump. Deliberately MAX(...) rather
 * than "last created row" — the same helper shape as nextOtcSaleInvoiceNo().
 */
async function nextFarmSaleInvoiceNo(): Promise<string> {
  const rows = await db.$queryRaw<{ maxnum: number | null }[]>`
    SELECT MAX(CAST(substring("invoiceNo" from '^FSAL-([0-9]+)$') AS INTEGER)) as maxnum
    FROM "FarmSale"
    WHERE "invoiceNo" ~ '^FSAL-[0-9]+$'
  `;
  const next = (rows[0]?.maxnum ?? 0) + 1;
  return `FSAL-${String(next).padStart(4, "0")}`;
}

function toDetails(v: Prisma.JsonValue | null): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (val != null) out[k] = String(val);
  return Object.keys(out).length ? out : null;
}

type SaleRow = Prisma.FarmSaleGetPayload<{ include: { lines: true; vendor: true } }>;

function toView(s: SaleRow): FarmSaleView {
  return {
    id: s.id,
    invoiceNo: s.invoiceNo,
    date: s.date.toISOString(),
    buyerType: s.buyerType,
    buyerName: s.vendor?.name ?? (s.cashName?.trim() || "Walk-in"),
    vendorId: s.vendorId,
    transportCharge: Number(s.transportCharge),
    gatePassNo: s.gatePassNo,
    narration: s.narration,
    totalAmount: Number(s.totalAmount),
    paymentHead: s.paymentHead,
    lines: s.lines.map((l) => ({
      id: l.id,
      category: l.category,
      item: l.item,
      unit: l.unit,
      rate: Number(l.rate),
      quantity: Number(l.quantity),
      amount: Number(l.amount),
      animalTag: l.animalTag,
      details: toDetails(l.details),
    })),
  };
}

export async function getFarmSalesContext(): Promise<FarmSalesContext> {
  await requireRole(FULL_ACCESS);
  try {
    const [vendors, heads, nextInvoiceNo] = await Promise.all([
      db.vendor.findMany({ select: { id: true, name: true, phone: true }, orderBy: { name: "asc" } }),
      getHeadBalances(),
      nextFarmSaleInvoiceNo(),
    ]);
    return { vendors, heads, nextInvoiceNo, today: todayPKTString(), dbReady: true };
  } catch (e) {
    console.error("[getFarmSalesContext]", e);
    // Never throw at the page: it renders a "database not ready" panel instead.
    return { vendors: [], heads: [], nextInvoiceNo: "FSAL-0001", today: todayPKTString(), dbReady: false };
  }
}

export async function getFarmSalesHistory(): Promise<{ sales: FarmSaleView[]; dbReady: boolean }> {
  await requireRole(FULL_ACCESS);
  try {
    const rows = await db.farmSale.findMany({
      include: { lines: true, vendor: true },
      orderBy: { date: "desc" },
      take: 200,
    });
    return { sales: rows.map(toView), dbReady: true };
  } catch (e) {
    console.error("[getFarmSalesHistory]", e);
    return { sales: [], dbReady: false };
  }
}

export async function createFarmSale(data: {
  date: string;
  buyerType: string;
  vendorId?: string | null;
  cashName?: string | null;
  transportCharge?: number;
  gatePassNo?: string | null;
  narration?: string | null;
  paymentHead: string;
  lines: FarmSaleLineInput[];
}): Promise<FarmSaleResult> {
  const user = await requireRole(FULL_ACCESS);

  if (!FARM_SALE_BUYER_TYPES.includes(data.buyerType as never)) {
    return { ok: false, error: "Choose whether this is a vendor sale or a cash walk-in." };
  }
  if (data.buyerType === "VENDOR" && !data.vendorId) {
    return { ok: false, error: "Select the vendor this was sold to." };
  }

  const lines = (data.lines ?? []).filter((l) => l && l.item?.trim());
  if (!lines.length) return { ok: false, error: "Add at least one item." };

  for (const l of lines) {
    if (!isFarmSaleCategory(l.category)) return { ok: false, error: "Pick a category for every item." };
    if (!isValidUnit(l.category, l.unit)) {
      return { ok: false, error: `"${l.unit}" is not a unit for ${l.category} items.` };
    }
    // Number.isFinite is essential, not just <= 0: NaN fails every comparison, so a
    // NaN amount would slip through, reach Payment.amount, and make the SUM in
    // getHeadBalances() NaN — which silently disables the overdraft guard on EVERY
    // head, because `amount - NaN > 0.005` is false. Every sibling writer guards this.
    if (!Number.isFinite(l.rate) || l.rate < 0) {
      return { ok: false, error: "Rate must be a valid, non-negative number." };
    }
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) {
      return { ok: false, error: "Quantity must be a valid number greater than 0." };
    }
  }

  const transport = data.transportCharge ?? 0;
  if (!Number.isFinite(transport) || transport < 0) {
    return { ok: false, error: "Transport charge must be a valid, non-negative number." };
  }

  // The server recomputes the total. Whatever the browser worked out is display only.
  const totalAmount = round2(lines.reduce((s, l) => s + l.rate * l.quantity, 0) + transport);
  if (totalAmount <= 0) return { ok: false, error: "The sale total must be greater than 0." };

  // Every farm sale is paid in full, so a valid receiving account is mandatory.
  if (!VALID_HEADS.includes(data.paymentHead)) {
    return { ok: false, error: "Select the account this money was received into." };
  }

  try {
    const dt = !data.date || data.date === todayPKTString()
      ? new Date()
      : new Date(data.date + "T12:00:00");

    let created: { id: string; invoiceNo: string } | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const invoiceNo = await nextFarmSaleInvoiceNo();
      try {
        created = await db.$transaction(async (tx) => {
          // Money IN — no overdraft guard, nothing can be overdrawn by receiving.
          // Also no InventoryMovement and no stock lock: nothing sold here is a
          // Product, so there is no on-hand figure to move.
          const payment = await tx.payment.create({
            data: {
              date: dt,
              // Never a customer's payment: attributing counter cash to a customer
              // silently writes off their subscription arrears.
              customerId: null,
              amount: new Prisma.Decimal(totalAmount),
              head: data.paymentHead as PaymentHeadName,
              notes: `Farm Sale ${invoiceNo}`,
              enteredById: user.id,
            },
            select: { id: true },
          });

          const sale = await tx.farmSale.create({
            data: {
              invoiceNo,
              date: dt,
              buyerType: data.buyerType,
              vendorId: data.buyerType === "VENDOR" ? data.vendorId! : null,
              cashName: data.buyerType === "CASH" ? (data.cashName?.trim() || null) : null,
              transportCharge: new Prisma.Decimal(round2(transport)),
              gatePassNo: data.gatePassNo?.trim() || null,
              narration: data.narration?.trim() || null,
              totalAmount: new Prisma.Decimal(totalAmount),
              paymentHead: data.paymentHead,
              paymentId: payment.id,
              enteredById: user.id,
              lines: {
                create: lines.map((l) => ({
                  category: l.category,
                  item: l.item.trim(),
                  unit: l.unit,
                  rate: new Prisma.Decimal(round2(l.rate)),
                  quantity: new Prisma.Decimal(l.quantity),
                  amount: new Prisma.Decimal(round2(l.rate * l.quantity)),
                  // Only animals carry a tag; anything typed against another
                  // category is dropped rather than stored where nothing reads it.
                  animalTag: categoryHasTag(l.category) ? (l.animalTag?.trim() || null) : null,
                  details: cleanDetails(l.category, l.details) ?? Prisma.JsonNull,
                })),
              },
            },
            select: { id: true },
          });

          return { id: sale.id, invoiceNo };
        });
        break;
      } catch (e) {
        // Someone else took this number between our read and our write — take the
        // next one and try again, exactly as createOtcSale does.
        const collision =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002" &&
          (e.meta?.target as string[] | undefined)?.some((t) => t.includes("invoiceNo"));
        if (collision && attempt < 4) continue;
        throw e;
      }
    }
    if (!created) throw new Error("Could not generate a unique invoice number — please try again.");

    revalidatePath("/over-the-counter/farm-sales");
    revalidatePath("/ledgers");
    if (data.buyerType === "VENDOR") revalidatePath("/payments/vendors");
    revalidatePath("/");
    return { ok: true, id: created.id, invoiceNo: created.invoiceNo };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save the sale." };
  }
}

/**
 * Removes a mis-keyed sale and the cash it booked.
 *
 * This takes money back OUT of a head, so unlike creating one it IS an outflow and
 * takes the same overdraft guard every other outflow does — otherwise deleting a
 * sale whose money has since been spent would drive that head negative.
 */
export async function deleteFarmSale(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  try {
    const sale = await db.farmSale.findUnique({
      where: { id },
      select: { id: true, totalAmount: true, paymentHead: true, paymentId: true },
    });
    if (!sale) return { ok: false, error: "Sale not found." };

    const amount = Number(sale.totalAmount);
    const guard = await checkHeadFunds(sale.paymentHead, amount);
    if (!guard.ok) {
      return { ok: false, error: `Can't delete — this money has already been spent. ${guard.error}` };
    }

    await db.$transaction(async (tx) => {
      // First statement, before any write: takes the per-head advisory lock so a
      // concurrent outflow cannot slip in between the check and the delete.
      await guardHeadFundsTx(tx, sale.paymentHead, amount);
      // Lines cascade with the sale; the Payment is freed first because FarmSale
      // holds the FK to it.
      await tx.farmSale.delete({ where: { id: sale.id } });
      if (sale.paymentId) await tx.payment.deleteMany({ where: { id: sale.paymentId } });
    });

    revalidatePath("/over-the-counter/farm-sales");
    revalidatePath("/ledgers");
    revalidatePath("/payments/vendors");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete the sale." };
  }
}
