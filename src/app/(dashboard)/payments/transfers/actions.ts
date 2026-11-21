"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getHeadBalances, checkHeadFunds, guardHeadFundsTx, HEAD_LABELS, RIDER_CASH_RECEIPT_NOTE, VISIBLE_HEADS, type HeadBalance } from "@/lib/head-balances";
import { isFarmOwner, ownerFundingLabel, OWNER_FUNDING_HEAD } from "@/lib/farm-owners";

export type TransferEntry = {
  id: string;
  // "owner" rows are money an owner put in from their own pocket. They are shown in
  // the same list because that is where someone looks for "where did this money come
  // from", but they are a different table and delete down a different path.
  kind: "transfer" | "owner";
  date: string;
  fromHead: string;
  fromLabel: string;
  toHead: string;
  toLabel: string;
  amount: number;
  notes: string | null;
};

export type TransfersPageData = {
  balances: HeadBalance[];
  transfers: TransferEntry[];
  dbReady: boolean;
};

export type TransferResult = { ok: true } | { ok: false; error: string };

const VALID_HEADS = VISIBLE_HEADS;

export async function getTransfersPageData(): Promise<TransfersPageData> {
  await requireRole(FULL_ACCESS);
  try {
    const [balances, transfers, funding] = await Promise.all([
      getHeadBalances(),
      db.headTransfer.findMany({ orderBy: { date: "desc" }, take: 100 }),
      db.ownerContribution.findMany({ orderBy: { date: "desc" }, take: 100 }),
    ]);

    const rows: TransferEntry[] = [
      ...transfers.map((t) => ({
        id: t.id,
        kind: "transfer" as const,
        date: t.date.toISOString(),
        fromHead: t.fromHead,
        fromLabel: HEAD_LABELS[t.fromHead] ?? t.fromHead,
        toHead: t.toHead,
        toLabel: HEAD_LABELS[t.toHead] ?? t.toHead,
        amount: Number(t.amount),
        notes: t.notes,
      })),
      ...funding.map((f) => ({
        id: f.id,
        kind: "owner" as const,
        date: f.date.toISOString(),
        fromHead: f.owner,
        fromLabel: ownerFundingLabel(f.owner),
        toHead: OWNER_FUNDING_HEAD,
        toLabel: HEAD_LABELS[OWNER_FUNDING_HEAD] ?? OWNER_FUNDING_HEAD,
        amount: Number(f.amount),
        notes: f.reason,
      })),
    ].sort((a, b) => b.date.localeCompare(a.date));

    return { balances, transfers: rows, dbReady: true };
  } catch (e) {
    console.error("[getTransfersPageData]", e);
    return { balances: [], transfers: [], dbReady: false };
  }
}

export async function createTransfer(data: {
  fromHead: string;
  toHead: string;
  amount: number;
  date: string; // YYYY-MM-DD
  notes?: string;
}): Promise<TransferResult> {
  await requireRole(FULL_ACCESS);
  if (!VALID_HEADS.includes(data.fromHead)) return { ok: false, error: "Select the source head." };
  if (!VALID_HEADS.includes(data.toHead)) return { ok: false, error: "Select the destination head." };
  if (data.fromHead === data.toHead) return { ok: false, error: "Source and destination must differ." };
  if (!data.amount || data.amount <= 0) return { ok: false, error: "Enter a valid amount." };

  try {
    // Don't allow moving out more than the source head holds.
    const guard = await checkHeadFunds(data.fromHead, data.amount);
    if (!guard.ok) return guard;

    const dt = data.date ? new Date(data.date + "T12:00:00") : new Date();
    await db.$transaction(async (tx) => {
      await guardHeadFundsTx(tx, data.fromHead, data.amount); // race-free guard inside the write
      await tx.headTransfer.create({
        data: {
          fromHead: data.fromHead as never,
          toHead: data.toHead as never,
          amount: new Prisma.Decimal(data.amount),
          notes: data.notes?.trim() || null,
          date: dt,
        },
      });
    });

    // Head balances feed several screens.
    revalidatePath("/payments/transfers");
    revalidatePath("/payments/expenses");
    revalidatePath("/payments/salaries");
    revalidatePath("/ledgers");
    revalidatePath("/"); // dashboard head-balance tiles
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to record transfer." };
  }
}

export async function deleteTransfer(id: string): Promise<TransferResult> {
  await requireRole(FULL_ACCESS);
  try {
    const t = await db.headTransfer.findUnique({
      where: { id },
      select: { fromHead: true, toHead: true, amount: true, notes: true },
    });
    if (!t) return { ok: false, error: "Transfer not found." };

    // 1. A rider-cash handover transfer is the other half of Payment.receivedAt.
    // Deleting it here left receivedAt set, so the rider-cash screen refused to
    // re-confirm ("already confirmed received") and hid the row — RIDER_CASH
    // permanently overstated, CASH permanently short, with no way back through
    // the UI. Undo it from the Rider Cash screen instead, where both halves are
    // handled together.
    if (
      t.fromHead === "RIDER_CASH" &&
      t.toHead === "CASH" &&
      (t.notes ?? "").startsWith(RIDER_CASH_RECEIPT_NOTE)
    ) {
      return {
        ok: false,
        error:
          "This transfer was created by confirming a rider's cash handover — it can't be deleted here. Manage it from the Rider Cash screen.",
      };
    }

    // 2. Deleting a transfer moves money back out of the destination, so it is an
    // outflow from toHead and needs the same overdraft guard createTransfer
    // applies to fromHead. Without it: move 10,000 CASH -> HBL, spend it from
    // HBL, delete the transfer, and HBL lands at −10,000.
    const guard = await checkHeadFunds(t.toHead, Number(t.amount));
    if (!guard.ok) {
      return {
        ok: false,
        error: `Can't delete — ${guard.error.replace(/^Insufficient balance in /, "")} would go negative because this money has already been spent.`,
      };
    }

    await db.$transaction(async (tx) => {
      // Race-free re-check on toHead (deleting moves money back out of it), inside the write.
      await guardHeadFundsTx(tx, t.toHead, Number(t.amount));
      await tx.headTransfer.delete({ where: { id } });
    });
    revalidatePath("/payments/transfers");
    revalidatePath("/payments/expenses");
    revalidatePath("/payments/salaries");
    revalidatePath("/ledgers");
    revalidatePath("/"); // dashboard head-balance tiles
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete transfer." };
  }
}

// ── Owner funding ─────────────────────────────────────────────────────────────

/**
 * Records money an owner paid into the farm out of their own personal account.
 *
 * This is NOT a transfer. There is no owner account inside the farm to move money
 * out of — it arrives from outside — so there is no source head, no overdraft
 * guard, and nothing is debited anywhere. It credits HBL (OWNER_FUNDING_HEAD) and
 * leaves the farm owing the owner that amount, which is what the owner ledger
 * shows. From here it is ordinary money in HBL: the expense it paid for is
 * recorded against HBL on the Expenses screen, exactly as it always was.
 *
 * It is a liability, never income. Nothing in reports or profit reads this table.
 */
export async function createOwnerContribution(data: {
  owner: string;
  amount: number;
  date: string; // YYYY-MM-DD
  reason: string;
}): Promise<TransferResult> {
  const user = await requireRole(FULL_ACCESS);
  if (!isFarmOwner(data.owner)) return { ok: false, error: "Select whose personal account this came from." };
  if (!data.amount || data.amount <= 0) return { ok: false, error: "Enter a valid amount." };
  // Required, unlike a transfer's optional note: the whole point is knowing what
  // the money was for when the owner asks months later.
  const reason = data.reason?.trim();
  if (!reason) return { ok: false, error: "Enter what this money was for." };

  try {
    const dt = data.date ? new Date(data.date + "T12:00:00") : new Date();
    await db.ownerContribution.create({
      data: {
        owner: data.owner,
        amount: new Prisma.Decimal(data.amount),
        reason,
        date: dt,
        enteredById: user.id,
      },
    });

    revalidatePath("/payments/transfers");
    revalidatePath("/payments/expenses");
    revalidatePath("/payments/salaries");
    revalidatePath("/ledgers");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to record the contribution." };
  }
}

/**
 * Removes a mis-keyed contribution.
 *
 * Deleting takes the money back OUT of HBL, so it is an outflow like any other and
 * takes the same overdraft guard — otherwise deleting a contribution that has since
 * been spent would drive HBL negative.
 */
export async function deleteOwnerContribution(id: string): Promise<TransferResult> {
  await requireRole(FULL_ACCESS);
  try {
    const row = await db.ownerContribution.findUnique({ where: { id }, select: { amount: true } });
    if (!row) return { ok: false, error: "Entry not found." };

    const guard = await checkHeadFunds(OWNER_FUNDING_HEAD, Number(row.amount));
    if (!guard.ok) {
      return { ok: false, error: `Can't delete — this money has already been spent. ${guard.error}` };
    }

    await db.$transaction(async (tx) => {
      await guardHeadFundsTx(tx, OWNER_FUNDING_HEAD, Number(row.amount));
      // deleteMany, not delete: if another manager deleted it first, that is a
      // no-op rather than a 500.
      await tx.ownerContribution.deleteMany({ where: { id } });
    });

    revalidatePath("/payments/transfers");
    revalidatePath("/payments/expenses");
    revalidatePath("/payments/salaries");
    revalidatePath("/ledgers");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete the entry." };
  }
}
