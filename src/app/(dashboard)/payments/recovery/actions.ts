"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { recordPayment } from "@/app/(dashboard)/billing/payment-receiving/actions";
import { computeCustomerOutstanding } from "@/lib/customer-balance";

export type VisitEntry = { id: string; note: string; at: string };

export type RecoveryRow = {
  id: string;            // customer id
  caseId: string | null;
  customerCode: string;
  name: string;
  phone: string;
  shiftName: string;
  areaName: string;
  outstanding: number;   // openingBalance + invoice charges − payments
  visits: number;
  visitLog: VisitEntry[]; // per-visit note + timestamp, newest first
  since: string | null;  // openedAt ISO
};

export type RecoveryData = {
  rows: RecoveryRow[];
  totalOutstanding: number;
  dbReady: boolean;
};

export type RecoveryResult = { ok: true } | { ok: false; error: string };

export async function getRecoveryData(): Promise<RecoveryData> {
  await requireRole(FULL_ACCESS);
  try {
    const customers = await db.customer.findMany({
      where: { status: "RECOVERY" },
      select: {
        id: true, customerCode: true, name: true, phone: true,
        shift: { select: { name: true } },
        area: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    });

    const ids = customers.map((c) => c.id);
    const [outstanding, openCases] = await Promise.all([
      computeCustomerOutstanding(ids),
      ids.length
        ? db.recoveryCase.findMany({
            where: { customerId: { in: ids }, status: { not: "CLEARED" } },
            include: { visitLogs: { orderBy: { createdAt: "desc" } } },
          })
        : Promise.resolve([]),
    ]);

    // Latest open case per customer
    const caseByCustomer = new Map<string, { id: string; visits: number; openedAt: Date; visitLog: VisitEntry[] }>();
    for (const rc of openCases) {
      const cur = caseByCustomer.get(rc.customerId);
      if (!cur || rc.openedAt > cur.openedAt) {
        caseByCustomer.set(rc.customerId, {
          id: rc.id,
          visits: rc.visits,
          openedAt: rc.openedAt,
          visitLog: rc.visitLogs.map((v) => ({ id: v.id, note: v.note, at: v.createdAt.toISOString() })),
        });
      }
    }

    const rows: RecoveryRow[] = customers.map((c) => {
      const rc = caseByCustomer.get(c.id);
      return {
        id: c.id,
        caseId: rc?.id ?? null,
        customerCode: c.customerCode,
        name: c.name,
        phone: c.phone,
        shiftName: c.shift?.name ?? "—",
        areaName: c.area?.name ?? "—",
        outstanding: Math.round(outstanding.get(c.id) ?? 0),
        visits: rc?.visits ?? 0,
        visitLog: rc?.visitLog ?? [],
        since: rc?.openedAt.toISOString() ?? null,
      };
    });
    rows.sort((a, b) => b.outstanding - a.outstanding);

    return { rows, totalOutstanding: rows.reduce((s, r) => s + r.outstanding, 0), dbReady: true };
  } catch (e) {
    console.error("[getRecoveryData]", e);
    return { rows: [], totalOutstanding: 0, dbReady: false };
  }
}

export type StopCandidate = {
  id: string;
  name: string;
  customerCode: string;
  phone: string;
  amount: number;   // cumulative outstanding dues
};

// Customers eligible to have supply stopped: not already in recovery/disabled and
// carrying outstanding dues (cumulative, so it works even before this month's
// invoice is generated). Highest dues first.
export async function getStopSupplyCandidates(): Promise<{ candidates: StopCandidate[]; dbReady: boolean }> {
  await requireRole(FULL_ACCESS);
  try {
    const customers = await db.customer.findMany({
      where: { status: { notIn: ["RECOVERY", "DISABLED"] } },
      select: { id: true, name: true, customerCode: true, phone: true },
      orderBy: { name: "asc" },
    });
    const outstanding = await computeCustomerOutstanding(customers.map((c) => c.id));
    const candidates = customers
      .map((c) => ({
        id: c.id,
        name: c.name,
        customerCode: c.customerCode,
        phone: c.phone,
        amount: Math.round(outstanding.get(c.id) ?? 0),
      }))
      .filter((c) => c.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    return { candidates, dbReady: true };
  } catch (e) {
    console.error("[getStopSupplyCandidates]", e);
    return { candidates: [], dbReady: false };
  }
}

function revalidateAll() {
  revalidatePath("/payments/recovery");
  revalidatePath("/billing/payment-receiving");
  revalidatePath("/customers/pre-delivery");
  revalidatePath("/customers");          // status change moves the customer in the list
  revalidatePath("/");                   // dashboard Active / Lost customer counts
}

// Stop supply for the selected customers: mark RECOVERY + open a recovery case.
export async function stopSupply(customerIds: string[]): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  if (!customerIds.length) return { ok: false, error: "No customers selected." };
  try {
    let count = 0;
    for (const id of customerIds) {
      await db.customer.update({ where: { id }, data: { status: "RECOVERY" } });
      const open = await db.recoveryCase.findFirst({ where: { customerId: id, status: { not: "CLEARED" } } });
      if (!open) await db.recoveryCase.create({ data: { customerId: id, status: "IN_RECOVERY" } });
      count++;
    }
    revalidateAll();
    return { ok: true, count };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to stop supply." };
  }
}

// Restart supply: customer back to ACTIVE, close any open recovery case.
export async function restartSupply(customerId: string): Promise<RecoveryResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.customer.update({ where: { id: customerId }, data: { status: "ACTIVE" } });
    await db.recoveryCase.updateMany({
      where: { customerId, status: { not: "CLEARED" } },
      data: { status: "CLEARED", closedAt: new Date() },
    });
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to restart supply." };
  }
}

// Log a collection visit with a mandatory note (what the customer said). The
// timestamp is recorded automatically, and the case's visit count is bumped.
export async function addRecoveryVisit(customerId: string, note: string): Promise<RecoveryResult> {
  await requireRole(FULL_ACCESS);
  const text = note.trim();
  if (!text) return { ok: false, error: "Add a note for this visit." };
  try {
    const open = await db.recoveryCase.findFirst({ where: { customerId, status: { not: "CLEARED" } }, orderBy: { openedAt: "desc" } });
    if (!open) return { ok: false, error: "No open recovery case." };
    // Interactive and on `tx` — the batched array form hangs on this client
    // (see src/lib/db.ts), and it also meant these two were not atomic: a visit
    // could be recorded without the case's count moving, or the reverse.
    await db.$transaction(async (tx) => {
      await tx.recoveryVisit.create({ data: { caseId: open.id, note: text } });
      await tx.recoveryCase.update({ where: { id: open.id }, data: { visits: { increment: 1 } } });
    });
    revalidatePath("/payments/recovery");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to log visit." };
  }
}

// Remove a mistaken visit entry and decrement the case's visit count.
export async function deleteRecoveryVisit(visitId: string): Promise<RecoveryResult> {
  await requireRole(FULL_ACCESS);
  try {
    const visit = await db.recoveryVisit.findUnique({ where: { id: visitId }, select: { caseId: true } });
    if (!visit) return { ok: false, error: "Visit not found." };
    const rc = await db.recoveryCase.findUnique({ where: { id: visit.caseId }, select: { visits: true } });
    // Interactive and on `tx` — see the note above and src/lib/db.ts.
    await db.$transaction(async (tx) => {
      await tx.recoveryVisit.delete({ where: { id: visitId } });
      await tx.recoveryCase.update({
        where: { id: visit.caseId },
        data: { visits: Math.max(0, (rc?.visits ?? 1) - 1) },
      });
    });
    revalidatePath("/payments/recovery");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to remove visit." };
  }
}

// Reuse the canonical payment recorder so dues / heads / ledger stay consistent.
export async function recordRecoveryPayment(data: {
  customerId: string;
  amount: number;
  head: string;
  date: string;
  notes?: string;
}): Promise<RecoveryResult> {
  await requireRole(FULL_ACCESS);
  const res = await recordPayment(data);
  if (res.ok) revalidatePath("/payments/recovery");
  return res;
}
