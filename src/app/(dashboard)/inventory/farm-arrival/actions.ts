"use server";

import { requireRole } from "@/lib/auth";

import type { Unit } from "@/lib/units";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { todayRangePKT } from "@/lib/pkt";
import {
  mixDeductionsByDispatch,
  additionsByDispatch,
  type AllocatableLoad,
} from "@/lib/mix-allocation";
import { DILUTION_REASON } from "@/lib/buffalo-dilution";
import { MIX_REASON_PACKAGING } from "@/lib/mix-milk-source";
import { Prisma } from "@prisma/client";
import { ACCEPTED_AT_PACKAGING, EGGS_COLLECTED, SENT_TO_RETAIL } from "@/lib/packaging-stock";
import { getOnHandByProduct, getRetailByProduct } from "@/lib/inventory-onhand";
import { getStockResetAt } from "@/lib/stock-reset";
import { qtyText } from "@/lib/quantity";

export type DispatchItem = {
  productId: string;
  productName: string;
  unit: Unit;
  quantity: number;
};

export type DispatchRecord = {
  id: string;
  date: string;
  status: "PENDING" | "CONFIRMED" | "DISPUTED";
  declaredItems: DispatchItem[];
  receivedItems: DispatchItem[] | null;
  reason: string | null;
  mixMilkDeductions: Record<string, number>;
  /** Milk this load gave to buffalo standardising — comes off what it forwards. */
  dilutionOut: Record<string, number>;
  /** Milk stirred into this load at packaging — goes on top of what it forwards. */
  dilutionIn: Record<string, number>;
};

export type FarmArrivalContext = {
  dispatches: DispatchRecord[];
  mixMilkProduct: { id: string; name: string; unit: Unit } | null;
  dbReady: boolean;
};

export async function getContext(): Promise<FarmArrivalContext> {
  await requireRole(["ADMIN","MANAGER","PACKAGING"]);
  try {
    const todayRange = todayRangePKT();
    const [dispatches, mixMilkProduct] = await Promise.all([
      db.farmDispatch.findMany({
        where: { date: todayRange },
        select: {
          id: true,
          date: true,
          status: true,
          declaredItems: true,
          receivedItems: true,
          reason: true,
          acceptedAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      db.product.findFirst({
        where: { name: "Mix Milk", active: true, retailOnly: false },
        select: { id: true, name: true, unit: true },
      }),
    ]);

    const dispatchIds = dispatches.map((d) => d.id);

    // Fetch confirmation timestamps (earliest DISPATCHED movement per dispatch)
    // and today's mix milk KITCHEN_USE movements to attribute them per dispatch
    const [dispatchedMovements, mixMilkMovements, dilutionOutMovements, dilutionInMovements] = await Promise.all([
      db.inventoryMovement.findMany({
        where: { date: todayRange, type: "DISPATCHED", reference: { in: dispatchIds } },
        select: { reference: true, date: true },
        orderBy: { date: "asc" },
      }),
      // Packaging-sourced mixing ONLY. Milk mixed out of storage never came off a
      // load, so docking a load for it would understate what that load can forward.
      db.inventoryMovement.findMany({
        where: { date: todayRange, type: "KITCHEN_USE", reason: MIX_REASON_PACKAGING },
        select: { productId: true, quantity: true, date: true },
        orderBy: { date: "asc" },
      }),
      // Buffalo standardising, both halves. Cow milk leaves the load; the buffalo
      // milk it was stirred into leaves with more than it arrived with.
      db.inventoryMovement.findMany({
        where: { date: todayRange, type: "KITCHEN_USE", reason: DILUTION_REASON },
        select: { productId: true, quantity: true, date: true },
        orderBy: { date: "asc" },
      }),
      db.inventoryMovement.findMany({
        where: { date: todayRange, type: "PRODUCED", reason: DILUTION_REASON },
        select: { productId: true, quantity: true, date: true },
        orderBy: { date: "asc" },
      }),
    ]);

    // Map dispatch ID → earliest confirmation timestamp
    const confirmedAtMap = new Map<string, Date>();
    for (const m of dispatchedMovements) {
      if (m.reference && !confirmedAtMap.has(m.reference)) {
        confirmedAtMap.set(m.reference, m.date);
      }
    }

    // Only loads confirmed the old way share in the day's mixing; a load accepted
    // into the packaging pool, or still waiting, never has anything taken from
    // it (see src/lib/packaging-attribution.ts for the same rule).
    const isOldWay = (d: { acceptedAt: Date | null; status: string }) => !d.acceptedAt && d.status !== "PENDING";
    const loads: AllocatableLoad[] = dispatches.filter(isOldWay).map((d) => ({
      id: d.id,
      date: d.date,
      items: (d.declaredItems as DispatchItem[]).map((i) => ({
        productId: i.productId,
        quantity: Number(i.quantity),
      })),
    }));
    const asMovements = (rows: { productId: string; quantity: unknown; date: Date }[]) =>
      rows.map((m) => ({ productId: m.productId, quantity: Number(m.quantity), date: m.date }));

    const mixDeductions = mixDeductionsByDispatch(loads, confirmedAtMap, asMovements(mixMilkMovements));
    const dilutionOut = mixDeductionsByDispatch(loads, confirmedAtMap, asMovements(dilutionOutMovements));
    const dilutionIn = additionsByDispatch(loads, confirmedAtMap, asMovements(dilutionInMovements));

    return {
      dispatches: dispatches.map((d) => ({
        id: d.id,
        date: d.date.toISOString(),
        status: d.status,
        declaredItems: d.declaredItems as DispatchItem[],
        receivedItems: d.receivedItems ? (d.receivedItems as DispatchItem[]) : null,
        reason: d.reason,
        mixMilkDeductions: isOldWay(d) ? mixDeductions[d.id] ?? {} : {},
        dilutionOut: isOldWay(d) ? dilutionOut[d.id] ?? {} : {},
        dilutionIn: isOldWay(d) ? dilutionIn[d.id] ?? {} : {},
      })),
      mixMilkProduct: mixMilkProduct
        ? { id: mixMilkProduct.id, name: mixMilkProduct.name, unit: mixMilkProduct.unit }
        : null,
      dbReady: true,
    };
  } catch {
    return { dispatches: [], mixMilkProduct: null, dbReady: false };
  }
}

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Packaging ACCEPTS a load from production, and the accepted quantities go into
 * INVENTORY at once — an ARRIVED movement per product (src/lib/packaging-stock.ts).
 *
 * It does not send anything to Retail; that is its own step (sendToRetail below).
 * The quantities are what production sent, checked: a line can be at most what
 * was declared. Accepting less (spillage, a miscount) marks the load disputed,
 * as before, and the shortfall shows in the Wastage log.
 */
export async function confirmArrival(
  id: string,
  postedItems: DispatchItem[],
  reason: string | null,
  isExplicitWastage = false
): Promise<ActionResult> {
  await requireRole(["ADMIN","MANAGER","PACKAGING"]);
  try {
    const dispatch = await db.farmDispatch.findUnique({
      where: { id },
      select: { declaredItems: true, status: true },
    });
    if (!dispatch) return { ok: false, error: "Load not found." };
    if (dispatch.status !== "PENDING") return { ok: false, error: "This load has already been accepted." };

    const declared = dispatch.declaredItems as DispatchItem[];

    // Only what production sent can be accepted — a line for any other product
    // (a page left open from before, when mix milk rode along) is dropped.
    const declaredIds = new Set(declared.map((d) => d.productId));
    const posted = (postedItems ?? []).filter((ri) => declaredIds.has(ri.productId));
    const receivedItems: DispatchItem[] = declared.map((di) => {
      const ri = posted.find((x) => x.productId === di.productId);
      const q = ri ? Number(ri.quantity) : Number(di.quantity);
      return { ...di, quantity: Number.isFinite(q) ? Math.max(0, q) : 0 };
    });

    const f = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));
    for (const ri of receivedItems) {
      const di = declared.find((d) => d.productId === ri.productId)!;
      if (ri.quantity > Number(di.quantity) + 0.001) {
        return { ok: false, error: `${di.productName}: production sent ${f(Number(di.quantity))} — you cannot accept ${f(ri.quantity)}.` };
      }
    }

    const hasVariance = receivedItems.some((ri) => {
      const di = declared.find((d) => d.productId === ri.productId)!;
      return Math.abs(Number(di.quantity) - ri.quantity) > 0.001;
    });
    const isDisputed = !isExplicitWastage && (hasVariance || !!reason);

    // Claim atomically, and write the stock in the same transaction: two
    // operators, a retry or a stale tab cannot accept the same load twice and put
    // its milk into inventory twice.
    const now = new Date();
    const accepted = await db.$transaction(async (tx) => {
      const claim = await tx.farmDispatch.updateMany({
        where: { id, status: "PENDING" },
        data: {
          status: isDisputed ? "DISPUTED" : "CONFIRMED",
          receivedItems: receivedItems as unknown as Prisma.InputJsonValue,
          reason: isExplicitWastage ? "Explicit wastage" : (reason || null),
          acceptedAt: now,
        },
      });
      if (claim.count === 0) return false;
      const lines = receivedItems.filter((ri) => ri.quantity > 0);
      if (lines.length > 0) {
        await tx.inventoryMovement.createMany({
          data: lines.map((ri) => ({
            date: now,
            type: "ARRIVED" as const,
            productId: ri.productId,
            quantity: new Prisma.Decimal(ri.quantity),
            reference: id,
            reason: ACCEPTED_AT_PACKAGING,
          })),
        });
      }
      return true;
    });
    if (!accepted) return { ok: false, error: "This load has already been accepted." };

    revalidatePath("/inventory/farm-arrival");
    revalidatePath("/inventory/production");
    revalidatePath("/inventory/reconciliation");
    revalidatePath("/inventory");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to accept the load" };
  }
}

export type SendLine = { productId: string; quantity: number };

/**
 * Send to Retail, from INVENTORY. Each quantity is capped at what inventory holds
 * for that product. The milk is already counted in inventory (it went in when
 * packaging accepted it), so a send adds nothing: it records the handover — one
 * RetailDispatch the Retail screen confirms, plus a DISPATCHED movement per
 * product so Reconciliation and the product ledger read "dispatched" as before.
 * If Retail reports receiving less, the shortfall is written off there.
 */
export async function sendToRetail(lines: SendLine[]): Promise<ActionResult> {
  await requireRole(["ADMIN","MANAGER","PACKAGING"]);
  const wanted = new Map<string, number>();
  for (const l of lines ?? []) {
    const q = Number(l?.quantity);
    if (!l?.productId || !Number.isFinite(q) || q < 0) return { ok: false, error: "Enter valid quantities (0 or more)." };
    if (Math.abs(Math.round(q * 1000) - q * 1000) > 1e-6) return { ok: false, error: "Use at most 3 decimal places." };
    if (q > 0) wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + q);
  }
  if (wanted.size === 0) return { ok: false, error: "Enter a quantity for at least one product." };

  try {
    const products = await db.product.findMany({
      where: { id: { in: [...wanted.keys()] } },
      select: { id: true, name: true, unit: true },
    });
    const meta = new Map(products.map((p) => [p.id, p]));

    const result = await db.$transaction(async (tx): Promise<ActionResult> => {
      // One send at a time, and the same stock lock every other outflow takes.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"packaging-send"}))`;
      for (const pid of [...wanted.keys()].sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock:" + pid}))`;
      }
      const onHand = await getOnHandByProduct();
      const f = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));

      const items: DispatchItem[] = [];
      for (const [productId, q] of wanted) {
        const p = meta.get(productId);
        const have = onHand.get(productId) ?? 0;
        if (!p) return { ok: false, error: "That product no longer exists." };
        if (q > have + 0.0005) {
          return { ok: false, error: `${p.name}: only ${f(have)} in inventory — cannot send ${f(q)}.` };
        }
        items.push({ productId, productName: p.name, unit: p.unit as Unit, quantity: q });
      }

      const now = new Date();
      const retail = await tx.retailDispatch.create({
        data: {
          date: now,
          declaredItems: items as unknown as Prisma.InputJsonValue,
          status: "PENDING",
        },
        select: { id: true },
      });
      await tx.inventoryMovement.createMany({
        data: items.map((it) => ({
          date: now,
          type: "DISPATCHED" as const,
          productId: it.productId,
          quantity: new Prisma.Decimal(it.quantity),
          reference: retail.id,
          reason: SENT_TO_RETAIL,
        })),
      });
      return { ok: true };
    });

    if (result.ok) {
      revalidatePath("/inventory/farm-arrival");
      revalidatePath("/inventory/retail");
      revalidatePath("/inventory/reconciliation");
      revalidatePath("/inventory");
      revalidatePath("/");
    }
    return result;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not send to Retail." };
  }
}

/** Every page a send — or the undoing of one — changes. */
const SEND_PATHS = [
  "/inventory/farm-arrival",
  "/inventory/retail",
  "/inventory/reconciliation",
  "/inventory",
  // What the shifts still need goes back up when a send is undone.
  "/customers/pre-delivery",
  // And what the retail centre is holding to hand back goes down.
  "/inventory/rider-returns",
  "/",
] as const;

const SEND_CONFIRMED =
  "Retail has already confirmed this send. Put it right on the Retail page — record what came back, or log the difference as wastage.";

/**
 * Undo a whole send Retail has not confirmed. The stock goes back to inventory.
 *
 * A send is one RetailDispatch plus one DISPATCHED movement per product, and
 * nothing holds a key to either, so taking both away takes the send off every
 * page. Only while it is PENDING: once Retail has said what arrived, the
 * correction belongs on their side, where the difference is written off with a
 * reason instead of vanishing.
 */
export async function deleteRetailSend(id: string): Promise<ActionResult> {
  return undoSend(id, null);
}

/**
 * Take one product off a send Retail has not confirmed — a mistyped line in an
 * otherwise correct send. If it was the only product, the send goes with it: an
 * empty send is not a record of anything, and Retail would still be shown a card
 * asking them to confirm nothing.
 *
 * Deliberately a second action rather than an optional argument on the one above.
 * A productId that went missing between the browser and the server would turn
 * "remove this line" into "delete the whole send", and every guard would pass.
 */
export async function deleteRetailSendLine(id: string, productId: string): Promise<ActionResult> {
  if (!productId) return { ok: false, error: "Choose a product to remove." };
  return undoSend(id, productId);
}

async function undoSend(id: string, only: string | null): Promise<ActionResult> {
  await requireRole(["ADMIN", "MANAGER", "PACKAGING"]);
  if (!id) return { ok: false, error: "That send is no longer here." };

  try {
    const d = await db.retailDispatch.findUnique({
      where: { id },
      select: { id: true, date: true, createdAt: true, status: true, declaredItems: true, farmDispatchId: true, vanDispatchId: true },
    });
    if (!d) return { ok: false, error: "That send is no longer here." };
    if (d.status !== "PENDING") return { ok: false, error: SEND_CONFIRMED };
    // A load that came up the old van route, or one that booked itself into stock
    // with an ARRIVED row, is a different shape: deleting only its DISPATCHED rows
    // would leave the arrival behind and mint milk.
    if (d.farmDispatchId || d.vanDispatchId) {
      return { ok: false, error: "This load came from the farm dispatch, not from Send to Retail — it cannot be undone here." };
    }
    if (await db.inventoryMovement.count({ where: { reference: id, type: "ARRIVED" } })) {
      return { ok: false, error: "This load was booked into stock another way — it cannot be undone here." };
    }

    const declared = (d.declaredItems ?? []) as unknown as DispatchItem[];
    const line = only ? declared.find((i) => i.productId === only) : null;
    if (only && !line) return { ok: false, error: "That product is not on this send." };
    const targets = line ? [line] : declared;
    const wipeWholeRow = !only || declared.length === 1;

    // Only a send that still counts can be taken back: today's sends are what
    // Retail is holding. One from an earlier day, or from before the stock was
    // last counted back to nothing, adds to no figure now — there is nothing to
    // claw back, and checking Retail for it would refuse for a reason that is not
    // true.
    const resetAt = await getStockResetAt();
    const countsNow = d.date >= todayRangePKT().gte && (!resetAt || d.createdAt >= resetAt);

    const result = await db.$transaction(async (tx): Promise<ActionResult> => {
      // The same two keys a send takes, in the same order — so an undo cannot
      // cross a send, a batch or a route assignment.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"packaging-send"}))`;
      for (const pid of targets.map((t) => t.productId).sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock:" + pid})) `;
      }

      // Claim the row itself. Retail confirming at this moment blocks here, then
      // finds its own claim matches nothing and reports the send as already gone.
      const claimed = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM "RetailDispatch" WHERE id = ${id} FOR UPDATE`;
      if (claimed.length === 0) return { ok: false, error: "That send is no longer here." };
      if (claimed[0].status !== "PENDING") return { ok: false, error: SEND_CONFIRMED };

      if (countsNow) {
        // Retail cannot give back what the rounds have already taken from it.
        const retail = await getRetailByProduct();
        for (const it of targets) {
          const have = Math.max(0, retail.get(it.productId) ?? 0);
          const q = Number(it.quantity);
          if (q > have + 0.0005) {
            return {
              ok: false,
              error:
                `${it.productName}: ${qtyText(q)} was sent, but only ${qtyText(have)} of it is still at Retail — ` +
                `the shifts have been loaded from the rest. Undo today's rounds first, or let Retail confirm the ` +
                `send and write the difference off there.`,
            };
          }
        }
      }

      // Narrow on purpose: a dispatch id is also the reference on Retail's
      // shortfall write-offs, which a PENDING send cannot have yet — but a wider
      // delete would turn that into silent data loss the day it can.
      await tx.inventoryMovement.deleteMany({
        where: { reference: id, type: "DISPATCHED", reason: SENT_TO_RETAIL, ...(only ? { productId: only } : {}) },
      });
      if (wipeWholeRow) await tx.retailDispatch.delete({ where: { id } });
      else {
        await tx.retailDispatch.update({
          where: { id },
          data: { declaredItems: declared.filter((i) => i.productId !== only) as unknown as Prisma.InputJsonValue },
        });
      }
      return { ok: true };
    });

    if (result.ok) for (const p of SEND_PATHS) revalidatePath(p);
    return result;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not undo the send." };
  }
}

export type PoolView = {
  /** Every farm product with stock in inventory — the boxes on Send to Retail. */
  lines: { productId: string; name: string; unit: string; available: number; acceptedToday: number }[];
  sentToday: { id: string; at: string; status: string; items: DispatchItem[] }[];
  /**
   * Sends from earlier days that Retail never confirmed. Both this page and the
   * Retail page show only today, so one of these was invisible everywhere —
   * three kilos of ghee sat pending for two days with no screen that could show
   * it, let alone clear it.
   */
  stillWaiting: { id: string; at: string; status: string; items: DispatchItem[] }[];
};

/** Inventory figures and today's sends — for the Send to Retail section. */
export async function getPoolView(): Promise<PoolView> {
  await requireRole(["ADMIN","MANAGER","PACKAGING"]);
  try {
    const today = todayRangePKT();
    const [onHand, products, acceptedToday, sendMarks, olderPending] = await Promise.all([
      getOnHandByProduct(),
      db.product.findMany({
        where: { active: true, retailOnly: false },
        select: { id: true, name: true, unit: true },
        orderBy: { name: "asc" },
      }),
      db.inventoryMovement.findMany({
        where: { type: "ARRIVED", reason: { in: [ACCEPTED_AT_PACKAGING, EGGS_COLLECTED] }, date: today },
        select: { productId: true, quantity: true },
      }),
      db.inventoryMovement.findMany({
        where: { type: "DISPATCHED", reason: SENT_TO_RETAIL, date: today },
        select: { reference: true },
      }),
      db.retailDispatch.findMany({
        where: {
          status: "PENDING",
          date: { lt: today.gte, gte: new Date(today.gte.getTime() - 14 * 86_400_000) },
          farmDispatchId: null,
          vanDispatchId: null,
        },
        select: { id: true, createdAt: true, status: true, declaredItems: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const accepted = new Map<string, number>();
    for (const m of acceptedToday) accepted.set(m.productId, (accepted.get(m.productId) ?? 0) + Number(m.quantity));

    const asSend = (s: { id: string; createdAt: Date; status: string; declaredItems: unknown }) => ({
      id: s.id,
      at: s.createdAt.toISOString(),
      status: s.status,
      items: (s.declaredItems as DispatchItem[]) ?? [],
    });

    const sendIds = [...new Set(sendMarks.map((m) => m.reference).filter((r): r is string => !!r))];
    const sends = sendIds.length
      ? await db.retailDispatch.findMany({
          where: { id: { in: sendIds } },
          select: { id: true, createdAt: true, status: true, declaredItems: true },
          orderBy: { createdAt: "desc" },
        })
      : [];

    return {
      lines: products
        .map((p) => ({
          productId: p.id,
          name: p.name,
          unit: p.unit,
          available: Math.max(0, Math.round((onHand.get(p.id) ?? 0) * 1000) / 1000),
          acceptedToday: accepted.get(p.id) ?? 0,
        }))
        .filter((l) => l.available > 0 || l.acceptedToday > 0),
      sentToday: sends.map(asSend),
      stillWaiting: olderPending.map(asSend),
    };
  } catch {
    return { lines: [], sentToday: [], stillWaiting: [] };
  }
}
