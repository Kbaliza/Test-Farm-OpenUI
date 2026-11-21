"use server";

import { requireRole } from "@/lib/auth";

import type { Unit } from "@/lib/units";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { todayRangePKT } from "@/lib/pkt";
import { Prisma } from "@prisma/client";
import { SENT_TO_RETAIL } from "@/lib/packaging-stock";

export type RetailDispatchItem = {
  productId: string;
  productName: string;
  unit: Unit;
  quantity: number;
};

export type RetailDispatchRecord = {
  id: string;
  date: string;
  status: "PENDING" | "CONFIRMED" | "DISPUTED";
  declaredItems: RetailDispatchItem[];
  receivedItems: RetailDispatchItem[] | null;
  reason: string | null;
};

export type RetailContext = {
  dispatches: RetailDispatchRecord[];
  dbReady: boolean;
};

export type ActionResult = { ok: true } | { ok: false; error: string };

// Retail intake is done by ADMIN/MANAGER, the Retail Manager who runs this end
// of the chain, and the Van Driver role (repointed here after the Van Delivery
// stage was removed — the rider still confirms loads, just at the retail step now).
const RETAIL_ROLES = ["ADMIN", "MANAGER", "RETAIL_MANAGER", "VAN_DRIVER"] as const;

export async function getRetailContext(): Promise<RetailContext> {
  await requireRole([...RETAIL_ROLES]);
  try {
    const dispatches = await db.retailDispatch.findMany({
      where: { date: todayRangePKT() },
      select: {
        id: true,
        date: true,
        status: true,
        declaredItems: true,
        receivedItems: true,
        reason: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      dispatches: dispatches.map((d) => ({
        id: d.id,
        date: d.date.toISOString(),
        status: d.status,
        declaredItems: d.declaredItems as RetailDispatchItem[],
        receivedItems: d.receivedItems
          ? (d.receivedItems as RetailDispatchItem[])
          : null,
        reason: d.reason,
      })),
      dbReady: true,
    };
  } catch {
    return { dispatches: [], dbReady: false };
  }
}

// Thrown inside the claim transaction when another caller won the race; converted
// back into a normal error result rather than surfacing as a 500.
class AlreadyConfirmedError extends Error {
  constructor() { super("This delivery has already been confirmed."); }
}

export async function confirmRetailArrival(
  id: string,
  receivedItems: RetailDispatchItem[],
  reason: string | null,
  isExplicitWastage = false
): Promise<ActionResult> {
  const user = await requireRole([...RETAIL_ROLES]);
  try {
    const dispatch = await db.retailDispatch.findUnique({
      where: { id },
      select: { declaredItems: true, status: true },
    });
    if (!dispatch) return { ok: false, error: "That send was cancelled by packaging — ask them to send it again." };

    // Confirm once, and only from PENDING. ARRIVED is the only movement type that
    // puts stock into storage, so a second call here would append a second full
    // set of ARRIVED rows and mint milk that never existed. The UI already hides
    // the button once settled (retail-client.tsx `isSettled`), but a server action
    // is a directly-invocable POST — a retry, a stale tab, or two operators
    // clicking at once would otherwise get through. Unlike the packaging leg,
    // nothing downstream has a unique constraint to stop it.
    if (dispatch.status !== "PENDING") {
      return { ok: false, error: "This delivery has already been confirmed." };
    }

    const declared = dispatch.declaredItems as RetailDispatchItem[];

    // Loads already in inventory before Retail sees them — Retail only confirms.
    //  - An egg entry (or an early send) carries its own ARRIVED record: if less
    //    arrived, that record is lowered to match.
    //  - A send from packaging's inventory (DISPATCHED "Packaging to Retail", no
    //    ARRIVED of its own): the milk was counted when packaging accepted it, so
    //    nothing is added; a shortfall is written off as Retail wastage.
    const hasOwnArrival = (await db.inventoryMovement.count({ where: { reference: id, type: "ARRIVED" } })) > 0;
    const isInventorySend = !hasOwnArrival &&
      (await db.inventoryMovement.count({ where: { reference: id, type: "DISPATCHED", reason: SENT_TO_RETAIL } })) > 0;
    const alreadyInInventory = hasOwnArrival || isInventorySend;
    if (alreadyInInventory) {
      for (const ri of receivedItems) {
        const di = declared.find((d) => d.productId === ri.productId);
        if (!di) return { ok: false, error: "That product was not in this load." };
        if (!Number.isFinite(ri.quantity) || ri.quantity < 0) return { ok: false, error: "Enter valid quantities." };
        if (ri.quantity > di.quantity + 0.001) {
          return { ok: false, error: `${di.productName}: ${di.quantity} was sent — more cannot be received.` };
        }
      }
    }

    const hasVariance = receivedItems.some((ri) => {
      const di = declared.find((d) => d.productId === ri.productId);
      return !di || Math.abs(di.quantity - ri.quantity) > 0.001;
    });
    const isDisputed = !isExplicitWastage && (hasVariance || !!reason);

    await db.$transaction(async (tx) => {
      // Claim atomically INSIDE the transaction. The status read above is a
      // separate query, so two concurrent POSTs could both see PENDING and both
      // proceed — and unlike the farm and van legs, retail has no downstream
      // unique constraint to abort the loser. ARRIVED is the only movement that
      // adds stock, so a second pass would mint milk outright. updateMany with
      // status:"PENDING" in the WHERE means exactly one caller gets count === 1.
      const claim = await tx.retailDispatch.updateMany({
        where: { id, status: "PENDING" },
        data: {
          status: isDisputed ? "DISPUTED" : "CONFIRMED",
          receivedItems: receivedItems as unknown as Prisma.InputJsonValue,
          reason: isExplicitWastage ? "Explicit wastage" : (reason || null),
          confirmedAt: new Date(),
        },
      });
      if (claim.count === 0) throw new AlreadyConfirmedError();

      if (isInventorySend) {
        // Nothing is added. Whatever did not arrive comes off inventory.
        for (const di of declared) {
          const got = receivedItems.find((ri) => ri.productId === di.productId)?.quantity ?? di.quantity;
          const short = di.quantity - got;
          if (short <= 0.0005) continue;
          await tx.inventoryMovement.create({
            data: {
              date: new Date(),
              type: "WASTAGE",
              productId: di.productId,
              quantity: new Prisma.Decimal(Math.round(short * 1000) / 1000),
              reason: reason || "Short at Retail",
              stage: "Retail",
              reference: id,
              enteredById: user.id,
            },
          });
        }
        return;
      }

      if (hasOwnArrival) {
        // Lower each product's stock record to what actually arrived.
        for (const di of declared) {
          const got = receivedItems.find((ri) => ri.productId === di.productId)?.quantity ?? di.quantity;
          if (Math.abs(got - di.quantity) <= 0.0005) continue;
          const rows = await tx.inventoryMovement.findMany({
            where: { reference: id, type: "ARRIVED", productId: di.productId },
            select: { id: true },
          });
          if (rows.length === 0) continue;
          if (got <= 0.0005) {
            await tx.inventoryMovement.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
          } else {
            await tx.inventoryMovement.update({ where: { id: rows[0].id }, data: { quantity: new Prisma.Decimal(got) } });
            if (rows.length > 1) await tx.inventoryMovement.deleteMany({ where: { id: { in: rows.slice(1).map((r) => r.id) } } });
          }
        }
        return;
      }

      for (const item of receivedItems) {
        if (item.quantity <= 0) continue;
        await tx.inventoryMovement.create({
          data: {
            date: new Date(),
            type: "ARRIVED",
            productId: item.productId,
            quantity: new Prisma.Decimal(item.quantity),
            reason: reason || null,
            reference: id,
          },
        });
      }
    });

    revalidatePath("/inventory/retail");
    revalidatePath("/inventory/reconciliation");
    revalidatePath("/inventory");
    revalidatePath("/"); // dashboard milk Arrived / Wastage / Net tiles + trend
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to confirm retail delivery",
    };
  }
}
