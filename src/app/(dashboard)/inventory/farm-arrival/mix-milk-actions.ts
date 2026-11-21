"use server";

import { requireRole } from "@/lib/auth";

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import { getOnHandByProduct } from "@/lib/inventory-onhand";
import { ACCEPTED_AT_PACKAGING } from "@/lib/packaging-stock";
import { todayRangePKT } from "@/lib/pkt";
import {
  MIX_REASON_PACKAGING,
  MIX_REASON_STORAGE,
  splitMixSource,
  totalMixable,
} from "@/lib/mix-milk-source";

export type MixMilkBatchEntry = {
  id: string;
  date: string;
  pktDate: string | null;
  buffaloMilk: number;
  cowMilk: number;
  mixMilkMade: number;
  notes: string | null;
};

export type MixMilkResult = { ok: true } | { ok: false; error: string };

type MixMilkBatchRow = {
  id: string;
  date: Date;
  pktDate: string | null;
  buffaloMilk: { toString(): string };
  cowMilk: { toString(): string };
  mixMilkMade: { toString(): string };
  notes: string | null;
};

export type MixMilkAvailability = {
  productId: string;
  name: string;
  /** Dispatched to packaging today. */
  received: number;
  /**
   * Still mixable out of today's dispatch: received − whatever packaging has
   * already taken from it (mix milk, and milk stirred into the buffalo).
   *
   * Deliberately does NOT include milk stirred IN by standardising. Mix milk is
   * made from the milk as it came off the farm; the cow milk added to the buffalo
   * afterwards is not part of what a mix batch may draw on.
   */
  available: number;
  /** Cow milk stirred INTO this product here — not mixable, but it is on the floor. */
  addedHere: number;
  /** On-hand inventory stock, mixable as well. */
  inStorage: number;
  /** available + inStorage — the real ceiling for an input. */
  total: number;
};

export async function logMixMilkBatch(data: {
  date: string;
  buffaloMilk: number;
  cowMilk: number;
  mixMilkMade: number;
  notes?: string;
}): Promise<MixMilkResult> {
  await requireRole(["ADMIN","MANAGER","PACKAGING"]);
  try {
    // Non-negative guard — a negative input still passes the milkUsed > 0 check
    // below and would write a negative KITCHEN_USE movement.
    const qtys = [data.buffaloMilk, data.cowMilk, data.mixMilkMade];
    if (qtys.some((q) => !Number.isFinite(q) || q < 0))
      return { ok: false, error: "Quantities cannot be negative." };

    const milkUsed = data.buffaloMilk + data.cowMilk;
    if (milkUsed <= 0)
      return { ok: false, error: "Enter at least one milk quantity (Buffalo / Cow)." };
    if (data.mixMilkMade <= 0)
      return { ok: false, error: "Enter mix milk created amount." };

    // Mass balance: mixing buffalo + cow yields mix milk, so output can never
    // exceed input. Without this, "100 L in -> 200 L mix out" was accepted and
    // written as a PRODUCED movement, creating milk from nothing. Losses
    // (output < input) are normal and stay allowed.
    if (data.mixMilkMade > milkUsed + 0.001) {
      return {
        ok: false,
        error: `Mix milk created (${data.mixMilkMade.toFixed(3)} L) cannot exceed milk used (${milkUsed.toFixed(3)} L).`,
      };
    }

    // Stock gate — the authoritative lock. Mass balance above only proves output
    // <= typed input; it does NOT prove the input milk actually exists. Mix milk
    // is made at packaging FROM milk dispatched there, so the inputs can't exceed
    // what getMixMilkAvailability reports (the SAME figure the page shows, so the
    // gate never disagrees with the UI). A milk type absent from that list means
    // 0 available and is rejected — NOT skipped: with nothing dispatched the list
    // is empty, which is exactly how "200 buffalo + 200 cow" from no stock slipped
    // through before (the client guard also skipped when availability was absent).
    // Locked until packaging has accepted something from production.
    if (!(await isPackagingUnlocked())) {
      return { ok: false, error: "Accept a load from production first — mix milk is made from what packaging has accepted." };
    }

    const sources = new Map<string, { fromPackaging: number; fromStorage: number }>();
    {
      const avail = await getMixMilkAvailability(data.date);
      const poolOf = (keyword: string) =>
        avail.find((a) => a.name.toLowerCase().includes(keyword)) ?? null;
      const f = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));
      const checks: { qty: number; keyword: string; label: string }[] = [
        { qty: data.buffaloMilk, keyword: "buffalo", label: "Buffalo Milk" },
        { qty: data.cowMilk,     keyword: "cow",     label: "Cow Milk" },
      ];
      for (const c of checks) {
        if (c.qty <= 0) continue;
        const pool = poolOf(c.keyword);
        const packaging = pool?.available ?? 0;
        const storage = pool?.inStorage ?? 0;
        const have = totalMixable(packaging, storage);
        if (c.qty > have + 0.001) {
          return {
            ok: false,
            error: `${c.label}: only ${f(have)} L can be mixed — ${f(packaging)} L at packaging plus ${f(storage)} L in inventory — cannot use ${f(c.qty)} L.`,
          };
        }
        // Packaging milk first, the rest out of inventory. Recorded per source so
        // the storage portion is deducted from on-hand and the packaging portion
        // is docked from the load it came off.
        sources.set(c.keyword, splitMixSource(c.qty, packaging, storage));
      }
    }

    const [buffaloProduct, cowProduct, mixProduct] = await Promise.all([
      db.product.findFirst({ where: { name: { contains: "Buffalo", mode: "insensitive" }, active: true, retailOnly: false } }),
      db.product.findFirst({ where: { name: { contains: "Cow",     mode: "insensitive" }, active: true, retailOnly: false } }),
      db.product.findFirst({ where: { name: { contains: "Mix",     mode: "insensitive" }, active: true, retailOnly: false } }),
    ]);

    if (data.buffaloMilk > 0 && !buffaloProduct)
      return { ok: false, error: 'Product "Buffalo Milk" not found. Add it in Products first.' };
    if (data.cowMilk > 0 && !cowProduct)
      return { ok: false, error: 'Product "Cow Milk" not found. Add it in Products first.' };
    if (!mixProduct)
      return { ok: false, error: 'Product "Mix Milk" not found. Add it in Products first.' };

    const [y, m, d] = data.date.split("-").map(Number);
    const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
    const pktTodMs = (Date.now() + PKT_OFFSET_MS) % 86_400_000;
    const dateObj = new Date(Date.UTC(y, m - 1, d) - PKT_OFFSET_MS + pktTodMs);

    const batchId = randomUUID();
    await db.$executeRaw`
      INSERT INTO "MixMilkBatch" (id, date, "pktDate", "buffaloMilk", "cowMilk", "mixMilkMade", notes, "createdAt")
      VALUES (${batchId}, ${dateObj}, ${data.date}, ${data.buffaloMilk}, ${data.cowMilk}, ${data.mixMilkMade}, ${data.notes || null}, NOW())
    `;

    const movements: Prisma.InventoryMovementCreateManyInput[] = [];
    const pushUse = (productId: string, keyword: string) => {
      const split = sources.get(keyword);
      if (!split) return;
      if (split.fromPackaging > 0.001)
        movements.push({ date: dateObj, type: "KITCHEN_USE", productId, quantity: new Prisma.Decimal(split.fromPackaging), reference: batchId, reason: MIX_REASON_PACKAGING });
      if (split.fromStorage > 0.001)
        movements.push({ date: dateObj, type: "KITCHEN_USE", productId, quantity: new Prisma.Decimal(split.fromStorage), reference: batchId, reason: MIX_REASON_STORAGE });
    };
    if (data.buffaloMilk > 0 && buffaloProduct) pushUse(buffaloProduct.id, "buffalo");
    if (data.cowMilk > 0 && cowProduct)         pushUse(cowProduct.id, "cow");
    movements.push({ date: dateObj, type: "PRODUCED", productId: mixProduct.id, quantity: new Prisma.Decimal(data.mixMilkMade), reference: batchId, reason: MIX_REASON_PACKAGING });

    await db.inventoryMovement.createMany({ data: movements });

    revalidatePath("/inventory/farm-arrival");
    revalidatePath("/inventory/production");
    revalidatePath("/inventory/reconciliation");
    revalidatePath("/inventory");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to save batch";
    return { ok: false, error: msg };
  }
}

export async function getMixMilkBatches(): Promise<{
  entries: MixMilkBatchEntry[];
  dbReady: boolean;
}> {
  await requireRole(["ADMIN","MANAGER","PACKAGING"]);
  try {
    const rows = await db.$queryRaw<MixMilkBatchRow[]>`
      SELECT id, date, "pktDate", "buffaloMilk", "cowMilk", "mixMilkMade", notes
      FROM "MixMilkBatch"
      ORDER BY date DESC
      LIMIT 60
    `;
    return {
      entries: rows.map((r) => ({
        id:          r.id,
        date:        r.date.toISOString(),
        pktDate:     r.pktDate,
        buffaloMilk: Number(r.buffaloMilk),
        cowMilk:     Number(r.cowMilk),
        mixMilkMade: Number(r.mixMilkMade),
        notes:       r.notes,
      })),
      dbReady: true,
    };
  } catch {
    return { entries: [], dbReady: false };
  }
}

export async function deleteMixMilkBatch(id: string): Promise<MixMilkResult> {
  await requireRole(["ADMIN","MANAGER","PACKAGING"]);
  try {
    await db.inventoryMovement.deleteMany({ where: { reference: id } });
    await db.$executeRaw`DELETE FROM "MixMilkBatch" WHERE id = ${id}`;
    revalidatePath("/inventory/farm-arrival");
    revalidatePath("/inventory/production");
    revalidatePath("/inventory/reconciliation");
    revalidatePath("/inventory");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to delete batch";
    return { ok: false, error: msg };
  }
}

// Buffalo + cow milk that can go into a mix batch: what is in INVENTORY.
//
// Packaging accepts a load from production straight into inventory
// (src/lib/packaging-stock.ts), so there is no separate "at packaging" pool any
// more — the mix draws on inventory, and the mix milk it makes goes back in.
// Until something has been accepted today, the Mix Milk and Buffalo sections
// stay locked (isPackagingUnlocked).
//
//   received  = accepted from production today (shown on the cards)
//   available = 0 — nothing sits outside inventory
//   inStorage = inventory (the same figure the Inventory screen shows)
//   total     = inStorage
export async function getMixMilkAvailability(_date?: string): Promise<MixMilkAvailability[]> {
  await requireRole(["ADMIN","MANAGER","PACKAGING"]);
  void _date;
  try {
    const [milkProducts, onHand, acceptedRows] = await Promise.all([
      db.product.findMany({
        where: {
          active: true,
          retailOnly: false,
          unit: "LITER",
          OR: [
            { name: { contains: "buffalo", mode: "insensitive" } },
            { name: { contains: "cow", mode: "insensitive" } },
          ],
        },
        select: { id: true, name: true },
      }),
      getOnHandByProduct(),
      db.inventoryMovement.findMany({
        where: { type: "ARRIVED", reason: ACCEPTED_AT_PACKAGING, date: todayRangePKT() },
        select: { productId: true, quantity: true },
      }),
    ]);
    const accepted = new Map<string, number>();
    for (const m of acceptedRows) accepted.set(m.productId, (accepted.get(m.productId) ?? 0) + Number(m.quantity));

    return milkProducts.map(({ id: productId, name }) => {
      const inStorage = Math.max(0, onHand.get(productId) ?? 0);
      return {
        productId,
        name,
        received: accepted.get(productId) ?? 0,
        available: 0,
        addedHere: 0,
        inStorage,
        total: totalMixable(0, inStorage),
      };
    });
  } catch {
    return [];
  }
}

/** True once packaging has accepted a load from production today. The Mix Milk
 *  and Buffalo sections lock until then. */
export async function isPackagingUnlocked(): Promise<boolean> {
  await requireRole(["ADMIN","MANAGER","PACKAGING"]);
  try {
    const n = await db.farmDispatch.count({ where: { acceptedAt: todayRangePKT() } });
    return n > 0;
  } catch {
    return false;
  }
}


