"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import {
  lockVendor, applyVendorPayment, applyVendorReceipt, applyVendorAdvances,
  reverseVendorReceipt,
} from "@/lib/vendor-settlement";

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { checkHeadFunds, guardHeadFundsTx, getHeadBalances, INFLOW_HEADS, VISIBLE_HEADS, CONTRA_SETTLEMENT_NOTE, type HeadBalance } from "@/lib/head-balances";
import type { PaymentHeadName } from "@/lib/payment-heads";
import { pktDateWithCurrentTime, todayPKTString } from "@/lib/pkt";

export type BillLine = {
  description: string;
  category: string;
  amount: number;
  /** Only on lines that came from an Over-the-Counter purchase or sale. */
  quantity?: number;
  unit?: string;
  rate?: number;
};

export type BillNotes = {
  reference: string;
  lines: BillLine[];
};

export type VendorEntry = {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  outstanding: number;   // what YOU owe them (unpaid VendorBills)
  receivable: number;    // what THEY owe you (unpaid VendorReceivables — Over-the-Counter sales on credit)
  billCount: number;
};

export type VendorBillEntry = {
  id: string;
  vendorId: string;
  date: string;
  amount: number;
  paid: number;
  reference: string;
  lines: BillLine[];
  receiptUrl: string | null;
  createdAt: string;
};

export type VendorReceivableEntry = {
  id: string;
  vendorId: string;
  date: string;
  amount: number;
  received: number;
  notes: string | null;
  /** What was sold, when this came from an Over-the-Counter sale. */
  lines: BillLine[];
  createdAt: string;
};

export type VendorResult = { ok: true } | { ok: false; error: string };

/**
 * An Over-the-Counter purchase or sale writes its bill with a plain note — the
 * items live on the purchase itself, not in the note — so a bill made that way
 * listed nothing on this page while the same items showed on the OTC pages.
 * These turn those items back into bill lines.
 */
type OtcLine = { unit: string; quantity: unknown; rate: unknown; amount: unknown; product: { name: string } };
const otcLines = (lines: OtcLine[], category: string): BillLine[] =>
  lines.map((l) => ({
    description: l.product.name,
    category,
    amount: Number(l.amount),
    quantity: Number(l.quantity),
    unit: l.unit,
    rate: Number(l.rate),
  }));

function parseBillNotes(raw: string | null): { reference: string; lines: BillLine[] } {
  if (!raw) return { reference: "", lines: [] };
  try {
    const parsed = JSON.parse(raw) as BillNotes;
    return { reference: parsed.reference ?? "", lines: parsed.lines ?? [] };
  } catch {
    return { reference: raw, lines: [] };
  }
}

export async function getVendorsData(): Promise<{
  vendors: VendorEntry[];
  headBalances: HeadBalance[];
  dbReady: boolean;
}> {
  await requireRole(FULL_ACCESS);
  try {
    const [vendors, billGroups, receivableGroups, headBalances] = await Promise.all([
      db.vendor.findMany({ orderBy: { name: "asc" } }),
      db.vendorBill.groupBy({
        by: ["vendorId"],
        _sum: { amount: true, paid: true },
        _count: { _all: true },
      }),
      db.vendorReceivable.groupBy({
        by: ["vendorId"],
        _sum: { amount: true, received: true },
      }),
      // Live head balances so the "Pay from" dropdown can show how much is in each
      // account — the same canonical figures the dashboard/expenses use.
      getHeadBalances(),
    ]);

    const balanceMap: Record<string, number> = {};
    const countMap: Record<string, number> = {};
    for (const g of billGroups) {
      balanceMap[g.vendorId] = Number(g._sum.amount ?? 0) - Number(g._sum.paid ?? 0);
      countMap[g.vendorId] = g._count._all;
    }
    // Never netted against balanceMap (what you owe them) — a payable and a
    // receivable for the same vendor are two distinct facts, shown separately.
    const receivableMap: Record<string, number> = {};
    for (const g of receivableGroups) {
      receivableMap[g.vendorId] = Number(g._sum.amount ?? 0) - Number(g._sum.received ?? 0);
    }

    return {
      vendors: vendors.map((v) => ({
        id: v.id,
        name: v.name,
        phone: v.phone,
        notes: v.notes,
        outstanding: balanceMap[v.id] ?? 0,
        receivable: receivableMap[v.id] ?? 0,
        billCount: countMap[v.id] ?? 0,
      })),
      headBalances,
      dbReady: true,
    };
  } catch {
    return { vendors: [], headBalances: [], dbReady: false };
  }
}

export async function getVendorReceivables(vendorId: string): Promise<VendorReceivableEntry[]> {
  await requireRole(FULL_ACCESS);
  try {
    const receivables = await db.vendorReceivable.findMany({
      where: { vendorId },
      orderBy: { date: "desc" },
      take: 20,
      include: {
        otcSale: {
          select: {
            invoiceNo: true,
            lines: { select: { unit: true, quantity: true, rate: true, amount: true, product: { select: { name: true } } } },
          },
        },
      },
    });
    return receivables.map((r) => ({
      id: r.id,
      vendorId: r.vendorId,
      date: r.date.toISOString(),
      amount: Number(r.amount),
      received: Number(r.received),
      notes: r.notes ?? (r.otcSale ? `Over the Counter sale ${r.otcSale.invoiceNo}` : null),
      lines: r.otcSale ? otcLines(r.otcSale.lines, "Sale") : [],
      createdAt: r.createdAt.toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function getVendorBills(vendorId: string): Promise<VendorBillEntry[]> {
  await requireRole(FULL_ACCESS);
  try {
    const bills = await db.vendorBill.findMany({
      where: { vendorId },
      orderBy: { date: "desc" },
      take: 20,
      include: {
        otcPurchase: {
          select: {
            invoiceNo: true,
            lines: { select: { unit: true, quantity: true, rate: true, amount: true, product: { select: { name: true } } } },
          },
        },
      },
    });
    return bills.map((b) => {
      const { reference, lines } = parseBillNotes(b.notes);
      const fromOtc = b.otcPurchase ? otcLines(b.otcPurchase.lines, "Purchase") : [];
      return {
        id: b.id,
        vendorId: b.vendorId,
        date: b.date.toISOString(),
        amount: Number(b.amount),
        paid: Number(b.paid),
        reference: reference || b.otcPurchase?.invoiceNo || "",
        lines: lines.length ? lines : fromOtc,
        receiptUrl: b.receiptUrl ?? null,
        createdAt: b.createdAt.toISOString(),
      };
    });
  } catch {
    return [];
  }
}

export async function createVendor(name: string, phone?: string, notes?: string): Promise<
  { ok: true; vendor: VendorEntry } | { ok: false; error: string }
> {
  await requireRole(FULL_ACCESS);
  if (!name.trim()) return { ok: false, error: "Vendor name is required." };
  try {
    const v = await db.vendor.upsert({
      where: { name: name.trim() },
      update: {
        phone: phone?.trim() || undefined,
        notes: notes?.trim() || undefined,
      },
      create: {
        name:  name.trim(),
        phone: phone?.trim() || null,
        notes: notes?.trim() || null,
      },
    });
    revalidatePath("/payments/vendors");
    return {
      ok: true,
      vendor: { id: v.id, name: v.name, phone: v.phone, notes: v.notes, outstanding: 0, receivable: 0, billCount: 0 },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to create vendor." };
  }
}

const VALID_HEADS = VISIBLE_HEADS;

// Apply a payment to vendor's unpaid bills (oldest first, FIFO) and record the
// cash outflow against the chosen payment head, so head balances reflect it
// (same model the Daily Expenses → Vendor Payment flow uses).
export async function recordVendorPayment(data: {
  vendorId: string;
  amount: number;
  head: string;
  /** The day it was paid ("YYYY-MM-DD", PKT); today when left out. */
  date?: string;
}): Promise<{ ok: true; applied: number; advance: number } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  if (!data.vendorId)              return { ok: false, error: "Select a vendor." };
  if (!data.amount || data.amount <= 0) return { ok: false, error: "Amount must be greater than 0." };
  if (!VALID_HEADS.includes(data.head)) return { ok: false, error: "Select a payment account." };
  if (data.date && !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return { ok: false, error: "Choose a valid date." };
  if (data.date && data.date > todayPKTString()) return { ok: false, error: "The payment date can't be in the future." };
  // A past day keeps the time of entry, the same as a back-dated daily expense.
  const paidAt = data.date ? pktDateWithCurrentTime(data.date) : new Date();
  try {
    // You may pay MORE than they are owed — the surplus becomes a credit they owe
    // us — but you still cannot pay with money the head does not hold.
    const guard = await checkHeadFunds(data.head, data.amount);
    if (!guard.ok) return guard;

    const vendor = await db.vendor.findUnique({ where: { id: data.vendorId }, select: { name: true } });
    if (!vendor) return { ok: false, error: "Vendor not found." };

    let vendorCat = await db.expenseCategory.findFirst({ where: { name: "Vendor Payment" } });
    if (!vendorCat) vendorCat = await db.expenseCategory.create({ data: { name: "Vendor Payment" } });

    // Bills and the cash-out are one action — commit together or not at all.
    // Previously the bills were updated first and the Expense created after: a
    // failure in between marked bills paid with no money ever leaving the head.
    const result = await db.$transaction(async (tx) => {
      // Race-free overdraft guard inside the write (checkHeadFunds above is only a
      // pre-check). Serialises concurrent outflows on this head so two can't both pass.
      await guardHeadFundsTx(tx, data.head, data.amount);
      // Then the per-vendor lock, so two concurrent overpayments cannot each decide
      // they are the surplus and write two advances.
      await lockVendor(tx, data.vendorId);

      // The cash row FIRST: the advance needs its id, and R1 says every rupee out
      // is exactly one Expense.
      const expense = await tx.expense.create({
        data: {
          date: paidAt,
          categoryId: vendorCat!.id,
          amount: new Prisma.Decimal(data.amount),
          head: data.head as PaymentHeadName,
          description: `Vendor Payment — ${vendor.name}`,
          chitReceived: false,
          // Link it so deleting this expense reverses the FIFO below.
          vendorId: data.vendorId,
        },
        select: { id: true },
      });

      return applyVendorPayment(tx, {
        vendorId: data.vendorId,
        amount: data.amount,
        expenseId: expense.id,
        at: paidAt,
        vendorName: vendor.name,
      });
    });

    revalidatePath("/payments/vendors");
    revalidatePath("/payments/expenses");
    revalidatePath("/payments/monthly-expenses");
    revalidatePath("/payments/salaries");
    revalidatePath("/ledgers");
    revalidatePath("/"); // dashboard head-balance / Outstanding (we owe) tiles
    return { ok: true, applied: result.applied, advance: result.advance };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to record payment." };
  }
}

// Opposite direction of recordVendorPayment: a vendor paying down what THEY
// owe you. Applies the receipt to unpaid VendorReceivables (oldest first,
// FIFO) and records the cash coming in as a real Payment against the chosen
// head — no overdraw guard needed, this is an inflow, not an outflow.
export async function recordVendorReceipt(data: {
  vendorId: string;
  amount: number;
  head: string;
}): Promise<{ ok: true; applied: number; advance: number } | { ok: false; error: string }> {
  const user = await requireRole(FULL_ACCESS);
  if (!data.vendorId)                   return { ok: false, error: "Select a vendor." };
  if (!data.amount || data.amount <= 0) return { ok: false, error: "Amount must be greater than 0." };
  // Money coming IN — Rider Cash is not a receiving account (INFLOW_HEADS).
  if (!INFLOW_HEADS.includes(data.head)) return { ok: false, error: "Select a receiving account." };
  try {
    const vendor = await db.vendor.findUnique({ where: { id: data.vendorId }, select: { name: true } });
    if (!vendor) return { ok: false, error: "Vendor not found." };

    // Mirror of recordVendorPayment: taking MORE than they owe is allowed, and the
    // surplus becomes a credit we owe them. No overdraft guard — this is an inflow.
    // Receivables and the cash-in are one action — commit together or not at all.
    const result = await db.$transaction(async (tx) => {
      await lockVendor(tx, data.vendorId);

      // Cash IN — a real Payment, and now carrying vendorId so it can be shown on
      // their ledger and reversed. Without that link a receipt was invisible money.
      const payment = await tx.payment.create({
        data: {
          date: new Date(),
          amount: new Prisma.Decimal(data.amount),
          head: data.head as PaymentHeadName,
          notes: `Vendor receipt — ${vendor.name}`,
          vendorId: data.vendorId,
          enteredById: user.id,
        },
        select: { id: true },
      });

      return applyVendorReceipt(tx, {
        vendorId: data.vendorId,
        amount: data.amount,
        paymentId: payment.id,
        at: new Date(),
        vendorName: vendor.name,
      });
    });

    revalidatePath("/payments/vendors");
    revalidatePath("/ledgers");
    revalidatePath("/"); // dashboard head-balance / Pending (they owe us) tiles
    return { ok: true, applied: result.applied, advance: result.advance };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to record receipt." };
  }
}

/**
 * Undo a vendor receipt. The receipt side had no undo at all before vendorId
 * existed on Payment — an over-receipt would otherwise leave a credit nobody could
 * remove, because deleteVendorBill refuses ADVANCE rows.
 */
export async function deleteVendorReceipt(paymentId: string): Promise<VendorResult> {
  await requireRole(FULL_ACCESS);
  try {
    const pay = await db.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, amount: true, head: true, vendorId: true },
    });
    if (!pay || !pay.vendorId) return { ok: false, error: "Vendor receipt not found." };

    const amount = Number(pay.amount);
    // Removing the receipt takes the money back OUT of the head, so it is an
    // outflow and takes the same guard every other outflow does.
    const guard = await checkHeadFunds(pay.head, amount);
    if (!guard.ok) {
      return { ok: false, error: `Can't undo — this money has already been spent. ${guard.error}` };
    }

    await db.$transaction(async (tx) => {
      await guardHeadFundsTx(tx, pay.head, amount);
      await lockVendor(tx, pay.vendorId!);
      await reverseVendorReceipt(tx, { vendorId: pay.vendorId!, amount });
      await tx.payment.delete({ where: { id: pay.id } });
    });

    revalidatePath("/payments/vendors");
    revalidatePath("/ledgers");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to undo the receipt." };
  }
}

// Contra-settlement: net what a vendor owes us (unpaid VendorReceivables) against
// what we owe them (unpaid VendorBills), with NO real cash movement — e.g. a vendor
// bought from us on credit while we still owe them for our own purchases, so instead
// of two cash trips the two debts cancel.
//
// Recorded as a matched cash-IN + cash-OUT of the same amount through Office Cash, so
// every existing invariant is preserved EXACTLY rather than special-cased:
//   • receivable.received bumped FIFO  → "they owe us" drops on the vendors page AND
//     the ledger (both read receivable.received).
//   • bill.paid bumped FIFO + a "Vendor Payment" Expense of the same amount → "we owe
//     them" drops on the vendors page (reads bill.paid) AND the ledger (reads Σ vendor
//     Expense). Those two "we owe" formulas only agree while Σ bill.paid == Σ vendor
//     Expense, so the payable side must touch BOTH, exactly like recordVendorPayment.
//   • The paired Payment (+net) and Expense (−net) cancel on the CASH head → the head
//     balance is unchanged; no money actually enters or leaves.
// Net visible effect: payable −net, receivable −net, all cash accounts unchanged.
export async function settleVendorContra(data: { vendorId: string }): Promise<
  { ok: true; settled: number } | { ok: false; error: string }
> {
  const user = await requireRole(FULL_ACCESS);
  if (!data.vendorId) return { ok: false, error: "Select a vendor." };
  try {
    const vendor = await db.vendor.findUnique({ where: { id: data.vendorId }, select: { name: true } });

    // Quick pre-check purely for a friendly error when there's genuinely nothing to
    // net (the authoritative figure is recomputed INSIDE the locked transaction).
    const [preBills, preRecv] = await Promise.all([
      // TRADE only. Netting an ADVANCE would net a credit against itself and write
      // a cash pair for money already accounted for — see R4 in lib/vendor-settlement.
      db.vendorBill.groupBy({ by: ["vendorId"], where: { vendorId: data.vendorId, kind: "TRADE" }, _sum: { amount: true, paid: true } }),
      db.vendorReceivable.groupBy({ by: ["vendorId"], where: { vendorId: data.vendorId, kind: "TRADE" }, _sum: { amount: true, received: true } }),
    ]);
    const prePayable = Math.max(0, Number(preBills[0]?._sum.amount ?? 0) - Number(preBills[0]?._sum.paid ?? 0));
    const preOwed    = Math.max(0, Number(preRecv[0]?._sum.amount ?? 0) - Number(preRecv[0]?._sum.received ?? 0));
    if (Math.min(prePayable, preOwed) <= 0.005) {
      return {
        ok: false,
        error: `Nothing to net for ${vendor?.name ?? "this vendor"} — settling needs both an amount they owe you (unpaid sales) and an amount you owe them (unpaid bills).`,
      };
    }

    let vendorCat = await db.expenseCategory.findFirst({ where: { name: "Vendor Payment" } });
    if (!vendorCat) vendorCat = await db.expenseCategory.create({ data: { name: "Vendor Payment" } });

    const now  = new Date();
    // Description/notes MUST start with CONTRA_SETTLEMENT_NOTE — deleteExpense keys off
    // it to refuse deleting one half of the pair (which would invent cash).
    const note = `${CONTRA_SETTLEMENT_NOTE} — ${vendor?.name ?? "Vendor"} (netted, no cash moved)`;

    // Serialise all contra settlements for THIS vendor against each other with a
    // per-vendor advisory lock, and recompute `net` from a FRESH read INSIDE the
    // transaction. A double-click / two concurrent calls now queue: the second
    // acquires the lock only after the first commits, re-reads net = 0, and no-ops —
    // so it can never create a second Payment+Expense pair or over-apply FIFO.
    let settled = 0;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"vendor:" + data.vendorId}))`;

      // Sequential (not Promise.all) — parallel queries on one interactive-transaction
      // connection are unreliable under load / through a pooler.
      // TRADE only, for the same reason as the pre-check above.
      const bills = await tx.vendorBill.findMany({ where: { vendorId: data.vendorId, kind: "TRADE" }, orderBy: { date: "asc" } });
      const receivables = await tx.vendorReceivable.findMany({ where: { vendorId: data.vendorId, kind: "TRADE" }, orderBy: { date: "asc" } });
      const payable = bills.reduce((s, b) => s + Math.max(0, Number(b.amount) - Number(b.paid)), 0);
      const owed    = receivables.reduce((s, r) => s + Math.max(0, Number(r.amount) - Number(r.received)), 0);
      // Can only cancel the smaller of the two — the remainder stays on the books.
      const net = Math.min(payable, owed);
      if (net <= 0.005) return; // already settled by a concurrent call — idempotent no-op

      // Receivable side (they owe us) — apply `net` FIFO, then the cash-IN half.
      let rIn = net;
      for (const r of receivables) {
        if (rIn <= 0) break;
        const unreceived = Number(r.amount) - Number(r.received);
        if (unreceived <= 0) continue;
        const toApply = Math.min(rIn, unreceived);
        await tx.vendorReceivable.update({
          where: { id: r.id },
          data: { received: new Prisma.Decimal(Number(r.received) + toApply) },
        });
        rIn -= toApply;
      }
      await tx.payment.create({
        // vendorId is load-bearing, not decoration: the receivable identity is
        // Σ recv.received == Σ Payment[vendorId], and this half bumps recv.received.
        // Without the link the contra silently broke that identity by .
        data: { date: now, amount: new Prisma.Decimal(net), head: "CASH", notes: note, vendorId: data.vendorId, enteredById: user.id },
      });

      // Payable side (we owe them) — apply `net` FIFO, then the cash-OUT half that
      // keeps the ledger's expense-based "we owe" in step with bill.paid. Cancels
      // the Payment above on the CASH head.
      let pOut = net;
      for (const b of bills) {
        if (pOut <= 0) break;
        const unpaid = Number(b.amount) - Number(b.paid);
        if (unpaid <= 0) continue;
        const toApply = Math.min(pOut, unpaid);
        await tx.vendorBill.update({
          where: { id: b.id },
          data: { paid: new Prisma.Decimal(Number(b.paid) + toApply) },
        });
        pOut -= toApply;
      }
      await tx.expense.create({
        data: {
          date: now,
          categoryId: vendorCat!.id,
          amount: new Prisma.Decimal(net),
          head: "CASH",
          description: note,
          chitReceived: false,
          vendorId: data.vendorId, // links the cash-out to the vendor, like recordVendorPayment
        },
      });
      settled = net;
    });

    revalidatePath("/payments/vendors");
    revalidatePath("/payments/expenses");
    revalidatePath("/ledgers");
    revalidatePath("/"); // dashboard Outstanding (we owe) / Pending (they owe) tiles
    return { ok: true, settled };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to settle." };
  }
}

export async function createVendorBill(data: {
  vendorId: string;
  date: string;
  reference: string;
  lines: BillLine[];
  receiptUrl?: string | null;
}): Promise<{ ok: true; bill: VendorBillEntry } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  if (!data.vendorId) return { ok: false, error: "Select a vendor." };
  if (!data.date) return { ok: false, error: "Date is required." };
  if (!data.lines.length) return { ok: false, error: "Add at least one item." };

  const total = data.lines.reduce((s, l) => s + l.amount, 0);
  if (total <= 0) return { ok: false, error: "Total amount must be greater than 0." };

  const [y, m, d] = data.date.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const notesJson = JSON.stringify({ reference: data.reference, lines: data.lines } as BillNotes);

  try {
    // In a transaction so any credit we are holding with this vendor is consumed by
    // the new bill in the same breath — that is what "settles against their next
    // bill automatically" means, and it must not be able to half-happen.
    const bill = await db.$transaction(async (tx) => {
      await lockVendor(tx, data.vendorId);
      const created = await tx.vendorBill.create({
        data: {
          vendorId: data.vendorId,
          date,
          amount: new Prisma.Decimal(total),
          paid: new Prisma.Decimal(0),
          notes: notesJson,
          receiptUrl: data.receiptUrl?.trim() || null,
        },
      });
      await applyVendorAdvances(tx, data.vendorId);
      // Re-read: applyVendorAdvances may have paid part of it already.
      return tx.vendorBill.findUniqueOrThrow({ where: { id: created.id } });
    });
    revalidatePath("/payments/vendors");
    revalidatePath("/"); // dashboard Outstanding (we owe) tile
    return {
      ok: true,
      bill: {
        id: bill.id,
        vendorId: bill.vendorId,
        date: bill.date.toISOString(),
        amount: Number(bill.amount),
        paid: Number(bill.paid),
        reference: data.reference,
        lines: data.lines,
        receiptUrl: bill.receiptUrl ?? null,
        createdAt: bill.createdAt.toISOString(),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to create bill." };
  }
}

export async function deleteVendorBill(id: string): Promise<VendorResult> {
  await requireRole(FULL_ACCESS);
  try {
    const bill = await db.vendorBill.findUnique({
      where: { id },
      select: { id: true, vendorId: true, paid: true, kind: true, otcPurchase: { select: { id: true } } },
    });
    if (!bill) return { ok: false, error: "Bill not found." };

    // A bill raised by an Over-the-Counter purchase is only one part of it. Deleting
    // the bill alone left the purchase and the stock it brought in standing, with
    // nobody owed for either — so this goes through the same full reversal the OTC
    // page uses, and refuses for the same reasons.
    if (bill.otcPurchase) {
      const { deleteOtcPurchase } = await import("@/app/(dashboard)/over-the-counter/purchase/actions");
      const res = await deleteOtcPurchase(bill.otcPurchase.id);
      if (res.ok) {
        revalidatePath("/payments/vendors");
        revalidatePath("/");
      }
      return res;
    }

    // An ADVANCE bill is not a bill at all — it is the credit from money they
    // overpaid us. Deleting it here would invent money; the receipt that created it
    // is what has to be undone.
    if (bill.kind === "ADVANCE") {
      return {
        ok: false,
        error: "This is the credit for money this vendor overpaid — undo that receipt instead of deleting this.",
      };
    }

    // A part-paid bill used to be a dead end. It is now deletable, and whatever was
    // already paid against it becomes an advance with that vendor — the same rule an
    // overpayment follows, which is what keeps the payable identity true: Σbill.paid
    // falls by `p` and the open advance rises by `p`, with ΣExpense untouched.
    await db.$transaction(async (tx) => {
      await lockVendor(tx, bill.vendorId);
      const paid = Number(bill.paid);
      await tx.vendorBill.delete({ where: { id } });
      if (paid > 0.005) {
        const v = await tx.vendor.findUnique({ where: { id: bill.vendorId }, select: { name: true } });
        await tx.vendorReceivable.create({
          data: {
            vendorId: bill.vendorId,
            date: new Date(),
            amount: new Prisma.Decimal(paid),
            received: new Prisma.Decimal(0),
            kind: "ADVANCE",
            notes: `Advance with ${v?.name ?? "vendor"} — from a deleted bill that had been paid`,
          },
        });
        // It may be absorbed immediately by another open bill.
        await applyVendorAdvances(tx, bill.vendorId);
      }
    });
    revalidatePath("/payments/vendors");
    revalidatePath("/"); // dashboard Outstanding (we owe) tile
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete." };
  }
}

export async function deleteVendorReceivable(id: string): Promise<VendorResult> {
  await requireRole(FULL_ACCESS);
  try {
    // This had no guard at all. Both of these leave the books wrong if allowed.
    const r = await db.vendorReceivable.findUnique({
      where: { id },
      select: { received: true, kind: true, otcSale: { select: { invoiceNo: true } } },
    });
    if (!r) return { ok: false, error: "Entry not found." };
    if (r.kind === "ADVANCE") {
      return {
        ok: false,
        error: "This is the credit for money we overpaid this vendor — undo that payment instead of deleting this.",
      };
    }
    if (Number(r.received) > 0.005) {
      return {
        ok: false,
        error: "This has payments recorded against it. Undo those receipts first, then delete it.",
      };
    }
    if (r.otcSale) {
      return {
        ok: false,
        error: `This came from counter sale ${r.otcSale.invoiceNo} — delete that sale rather than the receivable.`,
      };
    }
    await db.vendorReceivable.delete({ where: { id } });
    revalidatePath("/payments/vendors");
    revalidatePath("/"); // dashboard Pending (they owe us) tile
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete." };
  }
}
