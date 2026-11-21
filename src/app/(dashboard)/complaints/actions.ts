"use server";

// Customer complaints, and the refund or replacement given for each.
//
// The credit is never a number stored on the complaint and added up somewhere
// else. A refund is a DeliveryEntry return and a replacement is a DeliveryEntry
// replacement, each linked back by complaintId — the same rows every bill, balance,
// ledger, Payment Receiving and the customer app already read. So a refund comes
// off the bill everywhere at once, and deleting the complaint (which cascades to
// that row) puts it back everywhere at once. See src/lib/complaints.ts for the cap.

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  addDaysToDateStr,
  dateRangeFromToPKT,
  dateStrRangePKT,
  pktNoonToUTC,
  toDateStrPKT,
  todayPKTString,
} from "@/lib/pkt";
import { getOnHandByProduct } from "@/lib/inventory-onhand";
import { unitLabel, type Unit } from "@/lib/units";
import {
  COMPLAINT_REPLACEMENT_REASON,
  billedRate,
  compensableQty,
  compensationProblem,
  complaintShapeProblem,
  isDateStr,
  refundValue,
  type ComplaintDraft,
  type ComplaintResolutionValue,
  type DayProductFigures,
} from "@/lib/complaints";

export type ComplaintCustomer = { id: string; name: string; code: string; shiftName: string | null };

/** A day this customer was delivered to, with what they got. */
export type DeliveryDay = { date: string; summary: string };

/** One product delivered on the chosen day, and how much of it is still open to a complaint. */
export type DayProduct = DayProductFigures & {
  productId: string;
  name: string;
  unit: string;
  compensable: number;
  rate: number;
};

export type ComplaintRow = {
  id: string;
  date: string;
  deliveryDate: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  shiftName: string | null;
  category: string;
  description: string;
  resolution: ComplaintResolutionValue;
  /** Needed to reopen the complaint in the form; the name alone cannot be matched back. */
  productId: string | null;
  productName: string | null;
  unit: string | null;
  quantity: number | null;
  rate: number | null;
  amount: number;
  enteredByName: string;
  createdAt: string;
};

export type ComplaintsResult = { rows: ComplaintRow[]; dbReady: boolean };
export type ComplaintResult = { ok: true } | { ok: false; error: string };

const RANGE_DAYS = [7, 30, 90, 365];
/** How far back the "recent deliveries" shortcut looks. */
const RECENT_DELIVERY_DAYS = 60;

type Client = Prisma.TransactionClient | typeof db;

function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

function revalidateAll() {
  for (const p of [
    "/complaints",
    "/billing/invoices",
    "/billing/payment-receiving",
    "/payments/recovery",
    "/ledgers",
    "/inventory",
    "/customers/rider-report",
    "/",
  ]) {
    revalidatePath(p);
  }
}

export async function getComplaintCustomers(): Promise<ComplaintCustomer[]> {
  await requireRole(FULL_ACCESS);
  try {
    const rows = await db.customer.findMany({
      where: { status: { not: "DISABLED" } },
      select: { id: true, name: true, customerCode: true, shift: { select: { name: true } } },
      orderBy: { name: "asc" },
    });
    return rows.map((c) => ({ id: c.id, name: c.name, code: c.customerCode, shiftName: c.shift?.name ?? null }));
  } catch {
    return [];
  }
}

export async function getComplaints(days = 30): Promise<ComplaintsResult> {
  await requireRole(FULL_ACCESS);
  const span = RANGE_DAYS.includes(days) ? days : 30;
  const today = todayPKTString();
  try {
    const rows = await db.customerComplaint.findMany({
      where: { date: dateRangeFromToPKT(addDaysToDateStr(today, -(span - 1)), today) },
      include: {
        customer: { select: { name: true, customerCode: true } },
        shift: { select: { name: true } },
        product: { select: { name: true, unit: true } },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 1000,
    });
    return {
      dbReady: true,
      rows: rows.map((r) => ({
        id: r.id,
        date: r.date.toISOString(),
        deliveryDate: r.deliveryDate.toISOString(),
        customerId: r.customerId,
        customerName: r.customer.name,
        customerCode: r.customer.customerCode,
        shiftName: r.shift?.name ?? null,
        category: r.category,
        description: r.description,
        resolution: r.resolution,
        productId: r.productId,
        productName: r.product?.name ?? null,
        unit: r.product?.unit ?? null,
        quantity: r.quantity == null ? null : Number(r.quantity),
        rate: r.rate == null ? null : Number(r.rate),
        amount: Number(r.amount),
        enteredByName: r.enteredByName,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  } catch (e) {
    console.error("[getComplaints]", e);
    return { rows: [], dbReady: false };
  }
}

/** The days this customer was actually delivered to recently — the form's shortcuts. */
export async function getCustomerDeliveryDays(customerId: string): Promise<DeliveryDay[]> {
  await requireRole(FULL_ACCESS);
  if (!customerId) return [];
  try {
    const since = dateStrRangePKT(addDaysToDateStr(todayPKTString(), -RECENT_DELIVERY_DAYS)).gte;
    const rows = await db.deliveryEntry.findMany({
      where: { customerId, date: { gte: since }, isReturn: false, isReplacement: false },
      select: { date: true, quantity: true, product: { select: { name: true, unit: true } } },
      orderBy: { date: "desc" },
      take: 1000,
    });
    const byDay = new Map<string, Map<string, { qty: number; unit: string }>>();
    for (const r of rows) {
      const day = toDateStrPKT(r.date);
      const products = byDay.get(day) ?? new Map<string, { qty: number; unit: string }>();
      const cur = products.get(r.product.name) ?? { qty: 0, unit: r.product.unit };
      cur.qty += Number(r.quantity);
      products.set(r.product.name, cur);
      byDay.set(day, products);
    }
    return [...byDay.entries()].map(([date, products]) => ({
      date,
      summary: [...products.entries()]
        .map(([name, v]) => `${fmtQty(v.qty)} ${unitLabel(v.unit as Unit)} ${name}`)
        .join(", "),
    }));
  } catch {
    return [];
  }
}

/**
 * What each product delivered to this customer on `date` still allows.
 *
 * Shared by the form's preview and by createComplaint inside its lock, so what
 * the form offers and what the server accepts are computed the same way.
 */
/**
 * What was delivered on one day, and how much of it is still open to a complaint.
 *
 * `excludeComplaintId` leaves one complaint out of "already compensated". Editing
 * needs that: a complaint for 2 L counts 2 L against the day's cap, so reopening
 * it would refuse the very quantity it already has, and raising 2 L to 3 L would
 * be measured as if 5 L had been asked for.
 */
async function dayFigures(
  client: Client, customerId: string, date: string, excludeComplaintId?: string,
): Promise<Map<string, DayProduct>> {
  const range = dateStrRangePKT(date);
  const [entries, earlier] = await Promise.all([
    client.deliveryEntry.findMany({
      where: { customerId, date: range, isReplacement: false },
      select: {
        productId: true, quantity: true, unitRate: true, isReturn: true, complaintId: true,
        product: { select: { name: true, unit: true } },
      },
    }),
    client.customerComplaint.groupBy({
      by: ["productId"],
      where: {
        customerId, deliveryDate: range, resolution: { in: ["REFUND", "REPLACEMENT"] },
        ...(excludeComplaintId ? { id: { not: excludeComplaintId } } : {}),
      },
      _sum: { quantity: true },
    }),
  ]);

  const out = new Map<string, DayProduct>();
  for (const e of entries) {
    // A complaint's refund is dated the day the complaint came in, which can be
    // this very day. It is counted once, through `earlier` below — never again
    // here as though a rider had brought it back.
    if (e.complaintId) continue;
    const f = out.get(e.productId) ?? {
      productId: e.productId, name: e.product.name, unit: e.product.unit,
      delivered: 0, deliveredValue: 0, riderReturned: 0, alreadyCompensated: 0, compensable: 0, rate: 0,
    };
    const q = Number(e.quantity);
    if (e.isReturn) f.riderReturned += q;
    else {
      f.delivered += q;
      f.deliveredValue += q * Number(e.unitRate);
    }
    out.set(e.productId, f);
  }
  for (const g of earlier) {
    const f = g.productId ? out.get(g.productId) : undefined;
    if (f) f.alreadyCompensated += Number(g._sum.quantity ?? 0);
  }
  // Only what was actually delivered can be complained about.
  for (const [id, f] of out) {
    if (f.delivered <= 0) {
      out.delete(id);
      continue;
    }
    f.compensable = compensableQty(f);
    f.rate = billedRate(f);
  }
  return out;
}

export async function getComplaintDayProducts(
  customerId: string, date: string, excludeComplaintId?: string,
): Promise<DayProduct[]> {
  await requireRole(FULL_ACCESS);
  if (!customerId || !isDateStr(date)) return [];
  try {
    return [...(await dayFigures(db, customerId, date, excludeComplaintId)).values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function createComplaint(draft: ComplaintDraft): Promise<ComplaintResult> {
  const user = await requireRole(FULL_ACCESS);
  const shape = complaintShapeProblem(draft, todayPKTString());
  if (shape) return { ok: false, error: shape };

  const resolution = draft.resolution as ComplaintResolutionValue;
  const quantity = resolution === "NONE" ? 0 : Number(draft.quantity);
  const description = draft.description.trim();
  const when = pktNoonToUTC(draft.date);

  try {
    return await db.$transaction(async (tx) => {
      // One customer's complaints are recorded one at a time, so two people
      // entering the same complaint at the same moment can't both pass the cap.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"complaint:" + draft.customerId}))`;

      const customer = await tx.customer.findUnique({ where: { id: draft.customerId }, select: { shiftId: true } });
      if (!customer) return { ok: false as const, error: "Customer not found." };

      let productId: string | null = null;
      let rate: number | null = null;
      let amount = 0;

      if (resolution !== "NONE") {
        productId = draft.productId as string;
        const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true } });
        if (!product) return { ok: false as const, error: "Product not found." };

        const figures = (await dayFigures(tx, draft.customerId, draft.deliveryDate)).get(productId);
        const problem = compensationProblem(resolution, quantity, figures, product.name);
        if (problem || !figures) return { ok: false as const, error: problem ?? "Nothing to compensate." };

        rate = billedRate(figures);
        if (resolution === "REFUND") amount = refundValue(quantity, rate);

        if (resolution === "REPLACEMENT") {
          // The same shared lock every stock outflow takes, then a fresh on-hand read.
          // Taken after the complaint lock, and nothing takes them the other way
          // round, so the two can't deadlock.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock:" + productId}))`;
          const onHand = (await getOnHandByProduct()).get(productId) ?? 0;
          if (quantity > onHand + 1e-6) {
            return {
              ok: false as const,
              error: `Only ${fmtQty(Math.max(0, onHand))} of ${product.name} is in stock to send as a replacement.`,
            };
          }
        }
      }

      const complaint = await tx.customerComplaint.create({
        data: {
          customerId: draft.customerId,
          shiftId: customer.shiftId,
          deliveryDate: pktNoonToUTC(draft.deliveryDate),
          date: when,
          category: draft.category,
          description,
          resolution,
          productId,
          quantity: resolution === "NONE" ? null : new Prisma.Decimal(quantity),
          rate: rate == null ? null : new Prisma.Decimal(rate),
          amount: new Prisma.Decimal(amount),
          enteredById: user.id,
          enteredByName: user.name,
        },
        select: { id: true },
      });

      if (resolution === "REFUND") {
        // An isReturn row at the rate that was billed: every bill and balance
        // credits exactly quantity × rate. riderId stays null — this is office
        // work, and it keeps the row out of reach of the rider app's delete policy.
        await tx.deliveryEntry.create({
          data: {
            customerId: draft.customerId,
            productId: productId as string,
            date: when,
            quantity: new Prisma.Decimal(quantity),
            unitRate: new Prisma.Decimal(rate as number),
            isReturn: true,
            notes: `Complaint refund — ${draft.category}`,
            complaintId: complaint.id,
          },
        });
      } else if (resolution === "REPLACEMENT") {
        // Free to the customer (isReplacement is never charged), and the stock
        // really leaves — a REPLACEMENT movement, which on-hand subtracts.
        await tx.deliveryEntry.create({
          data: {
            customerId: draft.customerId,
            productId: productId as string,
            date: when,
            quantity: new Prisma.Decimal(quantity),
            unitRate: new Prisma.Decimal(rate as number),
            isReplacement: true,
            notes: `Complaint replacement — ${draft.category}`,
            complaintId: complaint.id,
          },
        });
        await tx.inventoryMovement.create({
          data: {
            date: when,
            type: "REPLACEMENT",
            productId: productId as string,
            quantity: new Prisma.Decimal(quantity),
            reason: COMPLAINT_REPLACEMENT_REASON,
            reference: complaint.id,
            enteredById: user.id,
          },
        });
      }

      return { ok: true as const };
    });
  } catch (e) {
    console.error("[createComplaint]", e);
    return { ok: false, error: "Could not save the complaint. Please try again." };
  } finally {
    revalidateAll();
  }
}

/**
 * Change a complaint that was entered wrongly.
 *
 * A complaint is not a record on its own: a refund IS a DeliveryEntry return and
 * a replacement IS a DeliveryEntry replacement plus the stock movement that took
 * the goods out. Editing the complaint without redoing those would leave the bill
 * crediting the old amount while the page showed the new one.
 *
 * So the old effects are undone first and the new ones written from scratch, by
 * the same rules a new complaint goes through — the day's cap, the billed rate,
 * and the stock check. The complaint keeps its id and its original author; who
 * changed it, and from what, is in the audit log.
 */
/**
 * Thrown to refuse an edit from inside the transaction, and turned back into a
 * normal error result below — the same shape confirmRiderCashReceived uses.
 *
 * It has to throw rather than return: the old refund and replacement are undone
 * before the new figures can be checked, and RETURNING a value out of an
 * interactive transaction commits it. A refused edit would have destroyed the
 * customer's credit while the complaint went on claiming it.
 */
class RefusedEdit extends Error {}

export async function updateComplaint(id: string, draft: ComplaintDraft): Promise<ComplaintResult> {
  const user = await requireRole(FULL_ACCESS);
  if (!id) return { ok: false, error: "Missing complaint." };
  const shape = complaintShapeProblem(draft, todayPKTString());
  if (shape) return { ok: false, error: shape };

  const resolution = draft.resolution as ComplaintResolutionValue;
  const quantity = resolution === "NONE" ? 0 : Number(draft.quantity);
  const description = draft.description.trim();
  const when = pktNoonToUTC(draft.date);

  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.customerComplaint.findUnique({
        where: { id },
        select: { customerId: true, resolution: true, productId: true, quantity: true },
      });
      if (!existing) throw new RefusedEdit("That complaint was already removed.");

      // Both customers, in a fixed order — an edit that moves a complaint from one
      // customer to another takes two locks, and two such edits crossing over must
      // not be able to wait on each other.
      for (const cid of [...new Set([existing.customerId, draft.customerId])].sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"complaint:" + cid}))`;
      }

      const customer = await tx.customer.findUnique({ where: { id: draft.customerId }, select: { shiftId: true } });
      if (!customer) throw new RefusedEdit("Customer not found.");

      // Undo what it gave, before working out what it should give now. Scoped
      // exactly to what createComplaint wrote.
      await tx.inventoryMovement.deleteMany({
        where: { reference: id, type: "REPLACEMENT", reason: COMPLAINT_REPLACEMENT_REASON },
      });
      await tx.deliveryEntry.deleteMany({ where: { complaintId: id } });

      let productId: string | null = null;
      let rate: number | null = null;
      let amount = 0;

      if (resolution !== "NONE") {
        productId = draft.productId as string;
        const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true } });
        if (!product) throw new RefusedEdit("Product not found.");

        // This complaint is left out of the day's cap: it is the one being changed,
        // and counting it would refuse the quantity it already has.
        const figures = (await dayFigures(tx, draft.customerId, draft.deliveryDate, id)).get(productId);
        const problem = compensationProblem(resolution, quantity, figures, product.name);
        if (problem || !figures) throw new RefusedEdit(problem ?? "Nothing to compensate.");

        rate = billedRate(figures);
        if (resolution === "REFUND") amount = refundValue(quantity, rate);

        if (resolution === "REPLACEMENT") {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock:" + productId}))`;
          // On-hand is read outside this transaction, so it cannot see the movement
          // deleted above. The stock that movement was holding is added back by
          // hand — and only when the product is unchanged, because a complaint
          // switched to another product returns its stock elsewhere.
          const onHand = (await getOnHandByProduct()).get(productId) ?? 0;
          const comingBack =
            existing.resolution === "REPLACEMENT" && existing.productId === productId
              ? Number(existing.quantity ?? 0)
              : 0;
          const available = onHand + comingBack;
          if (quantity > available + 1e-6) {
            throw new RefusedEdit(
              `Only ${fmtQty(Math.max(0, available))} of ${product.name} is in stock to send as a replacement.`,
            );
          }
        }
      }

      await tx.customerComplaint.update({
        where: { id },
        data: {
          customerId: draft.customerId,
          shiftId: customer.shiftId,
          deliveryDate: pktNoonToUTC(draft.deliveryDate),
          date: when,
          category: draft.category,
          description,
          resolution,
          productId,
          quantity: resolution === "NONE" ? null : new Prisma.Decimal(quantity),
          rate: rate == null ? null : new Prisma.Decimal(rate),
          amount: new Prisma.Decimal(amount),
          // enteredBy stays as it was: that is who raised the complaint. The edit
          // itself is recorded in the audit log.
        },
      });

      if (resolution === "REFUND") {
        await tx.deliveryEntry.create({
          data: {
            customerId: draft.customerId,
            productId: productId as string,
            date: when,
            quantity: new Prisma.Decimal(quantity),
            unitRate: new Prisma.Decimal(rate as number),
            isReturn: true,
            notes: `Complaint refund — ${draft.category}`,
            complaintId: id,
          },
        });
      } else if (resolution === "REPLACEMENT") {
        await tx.deliveryEntry.create({
          data: {
            customerId: draft.customerId,
            productId: productId as string,
            date: when,
            quantity: new Prisma.Decimal(quantity),
            unitRate: new Prisma.Decimal(rate as number),
            isReplacement: true,
            notes: `Complaint replacement — ${draft.category}`,
            complaintId: id,
          },
        });
        await tx.inventoryMovement.create({
          data: {
            date: when,
            type: "REPLACEMENT",
            productId: productId as string,
            quantity: new Prisma.Decimal(quantity),
            reason: COMPLAINT_REPLACEMENT_REASON,
            reference: id,
            enteredById: user.id,
          },
        });
      }

      return { ok: true as const };
    });
  } catch (e) {
    // A refusal rolled the whole transaction back, so the complaint and what it
    // gave are exactly as they were.
    if (e instanceof RefusedEdit) return { ok: false, error: e.message };
    console.error("[updateComplaint]", e);
    return { ok: false, error: "Could not save the changes. Please try again." };
  } finally {
    revalidateAll();
  }
}

/** Removes a complaint and undoes what it gave: the refund comes off, the replacement stock goes back. */
export async function deleteComplaint(id: string): Promise<ComplaintResult> {
  await requireRole(FULL_ACCESS);
  if (!id) return { ok: false, error: "Missing complaint." };
  try {
    return await db.$transaction(async (tx) => {
      const c = await tx.customerComplaint.findUnique({ where: { id }, select: { customerId: true } });
      if (!c) return { ok: false as const, error: "That complaint was already removed." };
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"complaint:" + c.customerId}))`;
      // Scoped to what createComplaint wrote, so nothing else sharing the id is touched.
      await tx.inventoryMovement.deleteMany({
        where: { reference: id, type: "REPLACEMENT", reason: COMPLAINT_REPLACEMENT_REASON },
      });
      // Cascades to the linked DeliveryEntry, which takes the credit off every bill.
      await tx.customerComplaint.delete({ where: { id } });
      return { ok: true as const };
    });
  } catch (e) {
    console.error("[deleteComplaint]", e);
    return { ok: false, error: "Could not remove the complaint. Please try again." };
  } finally {
    revalidateAll();
  }
}
