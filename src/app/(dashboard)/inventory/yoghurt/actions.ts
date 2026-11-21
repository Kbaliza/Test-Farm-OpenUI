"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { activeProductNameContains } from "@/lib/product-names";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { pktDateWithCurrentTime } from "@/lib/pkt";
import { getOnHandByProduct } from "@/lib/inventory-onhand";

/** The three milk products this page draws on, matched by name as elsewhere. */
async function milkProducts() {
  const [buffalo, cow, mix] = await Promise.all([
    db.product.findFirst({ where: activeProductNameContains("Buffalo") }),
    db.product.findFirst({ where: activeProductNameContains("Cow") }),
    db.product.findFirst({ where: activeProductNameContains("Mix") }),
  ]);
  return { buffalo, cow, mix };
}

export type YoghurtBatchEntry = {
  id: string;
  date: string;
  buffaloMilk: number;
  cowMilk: number;
  mixMilk: number;
  boilingWaste: number;
  yoghurtProduced: number;
  productionWaste: number;
  notes: string | null;
};

export type YoghurtResult = { ok: true } | { ok: false; error: string };

export async function logYoghurtBatch(data: {
  date: string;
  buffaloMilk: number;
  cowMilk: number;
  mixMilk: number;
  boilingWaste: number;
  yoghurtProduced: number;
  productionWaste: number;
  notes?: string;
}): Promise<YoghurtResult> {
  await requireRole([...FULL_ACCESS, "DOCTOR", "PACKAGING"]);
  try {
    // Non-negative guard — a negative input would otherwise write a negative
    // KITCHEN_USE movement and inflate available milk.
    const qtys = [data.buffaloMilk, data.cowMilk, data.mixMilk, data.boilingWaste, data.yoghurtProduced, data.productionWaste];
    if (qtys.some((q) => !Number.isFinite(q) || q < 0))
      return { ok: false, error: "Quantities cannot be negative." };

    // Mass balance, same rule as the skim and mix batches: what comes out can
    // never exceed what went in. Without it, "10 L milk -> 500 kg yoghurt" was
    // accepted and written as a PRODUCED movement that flows straight into
    // inStorage — creating stock from nothing. Losses (boiling/production waste)
    // are normal, so only the excess direction is rejected.
    const milkIn = data.buffaloMilk + data.cowMilk + data.mixMilk;
    const out = data.yoghurtProduced + data.boilingWaste + data.productionWaste;
    if (milkIn > 0 && out > milkIn + 0.001) {
      return {
        ok: false,
        error: `Output (${out.toFixed(3)} yoghurt + waste) cannot exceed milk used (${milkIn.toFixed(3)} L).`,
      };
    }

    const [buffaloProduct, cowProduct, mixProduct, yoghurtProduct] = await Promise.all([
      db.product.findFirst({ where: activeProductNameContains("Buffalo") }),
      db.product.findFirst({ where: activeProductNameContains("Cow") }),
      db.product.findFirst({ where: activeProductNameContains("Mix") }),
      db.product.findFirst({ where: { active: true, retailOnly: false, OR: [{ name: { contains: "yogurt", mode: "insensitive" } }, { name: { contains: "yoghurt", mode: "insensitive" } }] } }),
    ]);

    if (data.buffaloMilk > 0 && !buffaloProduct)
      return { ok: false, error: 'No active buffalo milk product found — expected one with "Buffalo" in its name (e.g. "Pure Buffalo"). Check Inventory > Products.' };
    if (data.cowMilk > 0 && !cowProduct)
      return { ok: false, error: 'No active cow milk product found — expected one with "Cow" in its name. Check Inventory > Products.' };
    if (data.mixMilk > 0 && !mixProduct)
      return { ok: false, error: 'No active mix milk product found — expected one with "Mix" in its name. Check Inventory > Products.' };
    if (data.yoghurtProduced > 0 && !yoghurtProduct)
      return { ok: false, error: 'No active yoghurt product found — expected one named "Yogurt" or "Yoghurt". Check Inventory > Products.' };

    // Validate against real stock — the same figure the Inventory pages and the
    // Waste entry screen show, and the one getMilkInStorage puts on this form.
    {
      const milkInputs = [
        data.buffaloMilk > 0 && buffaloProduct ? { id: buffaloProduct.id, name: buffaloProduct.name, qty: data.buffaloMilk } : null,
        data.cowMilk > 0 && cowProduct         ? { id: cowProduct.id,     name: cowProduct.name,     qty: data.cowMilk     } : null,
        data.mixMilk > 0 && mixProduct         ? { id: mixProduct.id,     name: mixProduct.name,     qty: data.mixMilk     } : null,
      ].filter(Boolean) as { id: string; name: string; qty: number }[];

      if (milkInputs.length > 0) {
        const onHand = await getOnHandByProduct();
        const f = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));
        for (const p of milkInputs) {
          const available = onHand.get(p.id) ?? 0;
          if (p.qty > available + 1e-6) {
            return {
              ok: false,
              error: `${p.name}: only ${f(Math.max(0, available))} L in storage. Cannot use ${f(p.qty)} L.`,
            };
          }
        }
      }
    }

    const date = pktDateWithCurrentTime(data.date);

    const batch = await db.yoghurtBatch.create({
      data: {
        date,
        buffaloMilk: new Prisma.Decimal(data.buffaloMilk),
        cowMilk: new Prisma.Decimal(data.cowMilk),
        mixMilk: new Prisma.Decimal(data.mixMilk),
        boilingWaste: new Prisma.Decimal(data.boilingWaste),
        yoghurtProduced: new Prisma.Decimal(data.yoghurtProduced),
        productionWaste: new Prisma.Decimal(data.productionWaste),
        notes: data.notes || null,
      },
    });

    const movements: Prisma.InventoryMovementCreateManyInput[] = [];

    if (data.buffaloMilk > 0 && buffaloProduct) {
      movements.push({ date, type: "KITCHEN_USE", productId: buffaloProduct.id, quantity: new Prisma.Decimal(data.buffaloMilk), reference: batch.id, reason: "Yoghurt processing" });
    }
    if (data.cowMilk > 0 && cowProduct) {
      movements.push({ date, type: "KITCHEN_USE", productId: cowProduct.id, quantity: new Prisma.Decimal(data.cowMilk), reference: batch.id, reason: "Yoghurt processing" });
    }
    if (data.mixMilk > 0 && mixProduct) {
      movements.push({ date, type: "KITCHEN_USE", productId: mixProduct.id, quantity: new Prisma.Decimal(data.mixMilk), reference: batch.id, reason: "Yoghurt processing" });
    }
    if (data.yoghurtProduced > 0 && yoghurtProduct) {
      movements.push({ date, type: "PRODUCED", productId: yoghurtProduct.id, quantity: new Prisma.Decimal(data.yoghurtProduced), reference: batch.id, reason: "Yoghurt processing" });
    }

    if (movements.length > 0) {
      await db.inventoryMovement.createMany({ data: movements });
    }

    revalidatePath("/inventory/yoghurt");
    revalidatePath("/inventory");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to save batch";
    return { ok: false, error: msg };
  }
}

export async function getYoghurtBatches(): Promise<{
  entries: YoghurtBatchEntry[];
  dbReady: boolean;
}> {
  await requireRole([...FULL_ACCESS, "DOCTOR", "PACKAGING"]);
  try {
    const batches = await db.yoghurtBatch.findMany({
      orderBy: { date: "desc" },
      take: 60,
    });
    return {
      entries: batches.map((b) => ({
        id: b.id,
        date: b.date.toISOString(),
        buffaloMilk: Number(b.buffaloMilk),
        cowMilk: Number(b.cowMilk),
        mixMilk: Number(b.mixMilk),
        boilingWaste: Number(b.boilingWaste),
        yoghurtProduced: Number(b.yoghurtProduced),
        productionWaste: Number(b.productionWaste),
        notes: b.notes,
      })),
      dbReady: true,
    };
  } catch {
    return { entries: [], dbReady: false };
  }
}

export async function deleteYoghurtBatch(id: string): Promise<YoghurtResult> {
  await requireRole([...FULL_ACCESS, "DOCTOR", "PACKAGING"]);
  try {
    await db.inventoryMovement.deleteMany({ where: { reference: id } });
    await db.yoghurtBatch.delete({ where: { id } });
    revalidatePath("/inventory/yoghurt");
    revalidatePath("/inventory");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to delete batch";
    return { ok: false, error: msg };
  }
}

export type RetailStockByDate = {
  buffalo: number;
  cow: number;
  mix: number;
  fetchError?: boolean;
};

// What is actually in storage for each milk this page can use — the SAME figure
// the Inventory pages, Waste entry and every other screen show (getOnHandByProduct).
//
// This used to be its own sum: all-time ARRIVED minus all-time yoghurt use minus
// every route quantity ever planned. Milk delivered months ago kept counting
// against it, so every figure fell below zero and the form read "0 L in storage"
// while the farm held thousands of litres.
export async function getMilkInStorage(): Promise<RetailStockByDate> {
  await requireRole([...FULL_ACCESS, "DOCTOR", "PACKAGING"]);
  try {
    const [{ buffalo, cow, mix }, onHand] = await Promise.all([milkProducts(), getOnHandByProduct()]);
    const qty = (p: { id: string } | null) => (p ? onHand.get(p.id) ?? 0 : 0);
    return { buffalo: qty(buffalo), cow: qty(cow), mix: qty(mix) };
  } catch {
    return { buffalo: 0, cow: 0, mix: 0, fetchError: true };
  }
}
