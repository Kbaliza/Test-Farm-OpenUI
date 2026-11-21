"use server";

import { revalidatePath } from "next/cache";
import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { unitLabel } from "@/lib/units";
import { AUTO_DEACTIVATION_REASON } from "@/lib/deactivation-reasons";
import { reconcileAutoDeactivations } from "@/app/(dashboard)/customers/actions";
import {
  DEFAULT_STATUS,
  isRecoveryStatus,
  nextNoAnswer,
  readReason,
  type Potential,
  type RecoverySource,
} from "@/lib/customer-recovery";

// Customer Recovery: every customer we have lost, and what is being done to win
// each one back.
//
// Who is on the list comes from the customer records themselves — the same
// definition as the Lost tab on View Customers (status INACTIVE or DISABLED) —
// plus anyone added by hand. Nothing here is imported or estimated: why they left
// is the reason recorded when they were moved to Lost, and how long they have
// been gone is counted from their last actual delivery.

export type RecoveryActivity = {
  id: string;
  type: "STATUS" | "CALL" | "NOTE";
  text: string | null;
  from: string | null;
  to: string | null;
  by: string | null;
  at: string; // ISO
};

export type RecoveryRow = {
  customerId: string;
  name: string;
  code: string;
  phone: string;
  area: string;
  reason: string;
  category: string;
  potential: Potential;
  source: RecoverySource;
  customerStatus: string;
  /** Last delivery the customer actually received (ISO), or null if none ever. */
  lastDelivery: string | null;
  daysInactive: number | null;
  /** What they were taking, from their product subscriptions. */
  products: string;
  status: string;
  activity: RecoveryActivity[];
};

export type RecoveryBoard = { ok: true; rows: RecoveryRow[] } | { ok: false; error: string };

type Result = { ok: true } | { ok: false; error: string };

const PATH = "/customers/recovery";
const LOST = ["INACTIVE", "DISABLED"] as const;

export async function getRecoveryBoard(): Promise<RecoveryBoard> {
  await requireRole(FULL_ACCESS);
  try {
    // Move anyone who has just gone 20 days without a delivery into Lost first,
    // so they are on this list on the same load — the Lost tab does the same.
    await reconcileAutoDeactivations();

    const customers = await db.customer.findMany({
      where: { OR: [{ status: { in: [...LOST] } }, { winbackCase: { isNot: null } }] },
      select: {
        id: true, name: true, customerCode: true, phone: true, status: true, deactivationReason: true,
        shift: { select: { name: true } }, area: { select: { name: true } },
        products: { where: { active: true }, select: { quantity: true, product: { select: { name: true, unit: true } } } },
        winbackCase: {
          select: {
            id: true, status: true,
            activities: { orderBy: { at: "desc" }, select: { id: true, type: true, text: true, fromStatus: true, toStatus: true, byName: true, at: true } },
          },
        },
      },
    });

    // A tracked customer who is ACTIVE again has been won back. Marked once, with
    // a line on the timeline saying the system did it and why.
    const backOnService = customers.filter((c) => c.status === "ACTIVE" && c.winbackCase && c.winbackCase.status !== "Recovered");
    for (const c of backOnService) {
      const cs = c.winbackCase!;
      const act = await db.$transaction(async (tx) => {
        await tx.winbackCase.update({ where: { id: cs.id }, data: { status: "Recovered" } });
        return tx.winbackActivity.create({
          data: { caseId: cs.id, type: "STATUS", fromStatus: cs.status, toStatus: "Recovered", text: "Customer is active again", byName: "System" },
          select: { id: true, type: true, text: true, fromStatus: true, toStatus: true, byName: true, at: true },
        });
      });
      cs.activities.unshift(act);
      cs.status = "Recovered";
    }

    // Last real delivery per customer — not a return, which is milk coming back.
    const ids = customers.map((c) => c.id);
    const last = ids.length
      ? await db.deliveryEntry.groupBy({ by: ["customerId"], where: { customerId: { in: ids }, isReturn: false }, _max: { date: true } })
      : [];
    const lastBy = new Map(last.map((l) => [l.customerId, l._max.date] as const));
    const now = Date.now();

    const rows: RecoveryRow[] = customers.map((c) => {
      const lost = (LOST as readonly string[]).includes(c.status);
      const source: RecoverySource = !lost ? "added" : c.deactivationReason === AUTO_DEACTIVATION_REASON ? "auto" : "manual";
      const { category, potential } = readReason(c.deactivationReason, source);
      const lastDate = lastBy.get(c.id) ?? null;
      return {
        customerId: c.id,
        name: c.name,
        code: c.customerCode,
        phone: c.phone,
        area: c.shift?.name ?? c.area?.name ?? "",
        reason: source === "added" ? "Added to the list by hand" : c.deactivationReason?.trim() || "No reason recorded",
        category,
        potential,
        source,
        customerStatus: c.status,
        lastDelivery: lastDate ? lastDate.toISOString() : null,
        daysInactive: lastDate ? Math.max(0, Math.floor((now - lastDate.getTime()) / 86_400_000)) : null,
        products: c.products.map((p) => `${p.product.name} ${Number(p.quantity)} ${unitLabel(p.product.unit)}`.trim()).join(" · "),
        status: c.winbackCase?.status ?? DEFAULT_STATUS,
        activity: (c.winbackCase?.activities ?? []).map((a) => ({
          id: a.id,
          type: (a.type as RecoveryActivity["type"]) ?? "NOTE",
          text: a.text, from: a.fromStatus, to: a.toStatus, by: a.byName, at: a.at.toISOString(),
        })),
      };
    });
    return { ok: true, rows };
  } catch (e) {
    console.error("[getRecoveryBoard]", e);
    return { ok: false, error: "Could not load the recovery list." };
  }
}

/** The customer's case, created on first touch. Only for someone on the list. */
async function caseFor(customerId: string): Promise<{ id: string; status: string } | string> {
  const c = await db.customer.findUnique({
    where: { id: customerId },
    select: { status: true, winbackCase: { select: { id: true, status: true } } },
  });
  if (!c) return "That customer no longer exists.";
  if (c.winbackCase) return c.winbackCase;
  if (!(LOST as readonly string[]).includes(c.status)) return "This customer is not on the recovery list.";
  return db.winbackCase.create({ data: { customerId }, select: { id: true, status: true } });
}

export async function setRecoveryStatus(customerId: string, status: string): Promise<Result> {
  const user = await requireRole(FULL_ACCESS);
  if (!isRecoveryStatus(status)) return { ok: false, error: "Pick a status from the list." };
  try {
    const cs = await caseFor(customerId);
    if (typeof cs === "string") return { ok: false, error: cs };
    if (cs.status === status) return { ok: true };
    await db.$transaction(async (tx) => {
      await tx.winbackCase.update({ where: { id: cs.id }, data: { status } });
      await tx.winbackActivity.create({
        data: { caseId: cs.id, type: "STATUS", fromStatus: cs.status, toStatus: status, byId: user.id, byName: user.name },
      });
    });
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    console.error("[setRecoveryStatus]", e);
    return { ok: false, error: "Could not change the status." };
  }
}

export async function logRecoveryEntry(customerId: string, type: "CALL" | "NOTE", text: string): Promise<Result> {
  const user = await requireRole(FULL_ACCESS);
  const t = (text ?? "").trim();
  if (!t) return { ok: false, error: "Write what happened first." };
  if (t.length > 1000) return { ok: false, error: "Keep it under 1,000 characters." };
  if (type !== "CALL" && type !== "NOTE") return { ok: false, error: "Unknown entry type." };
  try {
    const cs = await caseFor(customerId);
    if (typeof cs === "string") return { ok: false, error: cs };
    await db.winbackActivity.create({ data: { caseId: cs.id, type, text: t, byId: user.id, byName: user.name } });
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    console.error("[logRecoveryEntry]", e);
    return { ok: false, error: "Could not save that." };
  }
}

/** A call nobody answered: logged, and the case moves to the next attempt (1st → 2nd → 3rd). */
export async function logRecoveryNoAnswer(customerId: string): Promise<Result> {
  const user = await requireRole(FULL_ACCESS);
  try {
    const cs = await caseFor(customerId);
    if (typeof cs === "string") return { ok: false, error: cs };
    const next = nextNoAnswer(cs.status);
    await db.$transaction(async (tx) => {
      await tx.winbackActivity.create({
        data: { caseId: cs.id, type: "CALL", text: `No answer (attempt ${next.attempt} of 3)`, byId: user.id, byName: user.name },
      });
      if (cs.status !== next.status) {
        await tx.winbackCase.update({ where: { id: cs.id }, data: { status: next.status } });
        await tx.winbackActivity.create({
          data: { caseId: cs.id, type: "STATUS", fromStatus: cs.status, toStatus: next.status, byId: user.id, byName: user.name },
        });
      }
    });
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    console.error("[logRecoveryNoAnswer]", e);
    return { ok: false, error: "Could not log the call." };
  }
}

export type AddCandidate = { id: string; name: string; code: string; phone: string; status: string; area: string };

/** Customers who can be added by hand: not already lost and not already on the list. */
export async function findCustomersToAdd(query: string): Promise<AddCandidate[]> {
  await requireRole(FULL_ACCESS);
  const q = (query ?? "").trim();
  if (q.length < 2) return [];
  const rows = await db.customer.findMany({
    where: {
      status: { notIn: [...LOST] },
      winbackCase: { is: null },
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
        { customerCode: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true, customerCode: true, phone: true, status: true, shift: { select: { name: true } } },
    orderBy: { name: "asc" },
    take: 20,
  });
  return rows.map((r) => ({ id: r.id, name: r.name, code: r.customerCode, phone: r.phone, status: r.status, area: r.shift?.name ?? "" }));
}

/** Put a customer who is not lost on the list — someone who has gone quiet, say. */
export async function addToRecovery(customerId: string, note: string): Promise<Result> {
  const user = await requireRole(FULL_ACCESS);
  try {
    const c = await db.customer.findUnique({ where: { id: customerId }, select: { id: true, winbackCase: { select: { id: true } } } });
    if (!c) return { ok: false, error: "That customer no longer exists." };
    if (c.winbackCase) return { ok: false, error: "This customer is already on the recovery list." };
    const t = (note ?? "").trim().slice(0, 1000);
    await db.$transaction(async (tx) => {
      const cs = await tx.winbackCase.create({ data: { customerId } });
      await tx.winbackActivity.create({
        data: { caseId: cs.id, type: "NOTE", text: t ? `Added to the recovery list — ${t}` : "Added to the recovery list", byId: user.id, byName: user.name },
      });
    });
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    console.error("[addToRecovery]", e);
    return { ok: false, error: "Could not add this customer." };
  }
}
