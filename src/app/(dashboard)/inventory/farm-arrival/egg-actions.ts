"use server";

// Eggs at Packaging.
//
// Eggs are collected, not made, so they are entered here rather than on the
// Production screen. Adding eggs puts them INTO INVENTORY — the same as accepting
// a production load (src/lib/packaging-stock.ts) — and nothing more. They go to
// Retail from the "Send to Retail" section like every other product, where the
// Eggs box shows what inventory holds.

import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { isEggName } from "@/lib/product-names";
import { todayPKTString, todayRangePKT, toDateStrPKT } from "@/lib/pkt";
import { EGGS_COLLECTED } from "@/lib/packaging-stock";

const PACKAGING_ROLES = ["ADMIN", "MANAGER", "PACKAGING"] as const;

export type EggEntry = {
  id: string;
  date: string;   // "YYYY-MM-DD" PKT
  at: string;     // ISO
  quantity: number;
  /** Entered today — a mistaken entry can still be removed. */
  removable: boolean;
};

export type EggContext = {
  dbReady: boolean;
  /** Null when the catalogue has no active egg product. */
  productName: string | null;
  entries: EggEntry[];
};

export type EggResult = { ok: true } | { ok: false; error: string };

async function eggProduct() {
  const products = await db.product.findMany({
    where: { active: true, retailOnly: false },
    select: { id: true, name: true, unit: true },
    orderBy: { name: "asc" },
  });
  return products.find((p) => isEggName(p.name)) ?? null;
}

/** Eggs added at Packaging in the last 14 days, newest first. */
export async function getEggContext(): Promise<EggContext> {
  await requireRole([...PACKAGING_ROLES]);
  try {
    const product = await eggProduct();
    if (!product) return { dbReady: true, productName: null, entries: [] };

    const rows = await db.inventoryMovement.findMany({
      where: {
        type: "ARRIVED",
        reason: EGGS_COLLECTED,
        productId: product.id,
        date: { gte: new Date(Date.now() - 14 * 86_400_000) },
      },
      select: { id: true, date: true, quantity: true },
      orderBy: { date: "desc" },
      take: 60,
    });
    const today = todayPKTString();
    return {
      dbReady: true,
      productName: product.name,
      entries: rows.map((r) => ({
        id: r.id,
        date: toDateStrPKT(r.date),
        at: r.date.toISOString(),
        quantity: Number(r.quantity),
        removable: toDateStrPKT(r.date) === today,
      })),
    };
  } catch {
    return { dbReady: false, productName: null, entries: [] };
  }
}

/** Add eggs collected — straight into inventory. */
export async function addEggs(input: { quantity: number }): Promise<EggResult> {
  await requireRole([...PACKAGING_ROLES]);

  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, error: "Enter how many eggs, greater than 0." };
  if (!Number.isInteger(quantity)) return { ok: false, error: "Eggs are counted in whole pieces." };

  try {
    const product = await eggProduct();
    if (!product) {
      return { ok: false, error: 'No active egg product found — expected one with "Egg" in its name. Check Inventory > Products.' };
    }
    await db.inventoryMovement.create({
      data: {
        date: new Date(),
        type: "ARRIVED",
        productId: product.id,
        quantity: new Prisma.Decimal(quantity),
        reason: EGGS_COLLECTED,
      },
    });

    revalidatePath("/inventory/farm-arrival");
    revalidatePath("/inventory");
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not save the eggs. Please try again." };
  }
}

/** Remove a mistaken egg entry (a miscount, entered twice) — today's only. */
export async function deleteEggEntry(id: string): Promise<EggResult> {
  await requireRole([...PACKAGING_ROLES]);
  try {
    const row = await db.inventoryMovement.findUnique({
      where: { id },
      select: { type: true, reason: true, productId: true, quantity: true, date: true },
    });
    if (!row || row.type !== "ARRIVED" || row.reason !== EGGS_COLLECTED) {
      return { ok: false, error: "That egg entry no longer exists." };
    }
    const today = todayRangePKT();
    if (row.date < today.gte || row.date > today.lte) {
      return { ok: false, error: "Only today's entries can be removed." };
    }
    await db.inventoryMovement.delete({ where: { id } });
    revalidatePath("/inventory/farm-arrival");
    revalidatePath("/inventory");
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not remove the entry. Please try again." };
  }
}
