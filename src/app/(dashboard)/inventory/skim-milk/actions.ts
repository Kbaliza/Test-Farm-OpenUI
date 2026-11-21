"use server";

// NOTE: the Skim Milk section is rendered inside the Production / Milk Entry page,
// which DOCTOR may open. These guards must therefore allow DOCTOR too — when they
// did not, the whole production page threw while rendering and the doctor saw a 404.
import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { MIX_REASONS } from "@/lib/mix-milk-source";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { todayRangePKT, todayPKTString, dateStrRangePKT } from "@/lib/pkt";

export type SkimMilkBatchEntry = {
  id: string;
  date: string;
  buffaloMilk: number;
  cowMilk: number;
  mixMilk: number;
  milkUsed: number;
  creamMade: number;
  skimMilkMade: number;
  notes: string | null;
};

export type SkimMilkResult = { ok: true } | { ok: false; error: string };

export async function logSkimMilkBatch(data: {
  date: string;
  buffaloMilk: number;
  cowMilk: number;
  mixMilk: number;
  creamMade: number;
  skimMilkMade: number;
  notes?: string;
}): Promise<SkimMilkResult> {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    // Every quantity must be a real, non-negative number. Without this a negative
    // input still passes the milkUsed > 0 check below (100 buffalo + −50 cow) and
    // writes a negative KITCHEN_USE movement.
    const qtys = [data.buffaloMilk, data.cowMilk, data.mixMilk, data.creamMade, data.skimMilkMade];
    if (qtys.some((q) => !Number.isFinite(q) || q < 0))
      return { ok: false, error: "Quantities cannot be negative." };

    const milkUsed = data.buffaloMilk + data.cowMilk + data.mixMilk;
    if (milkUsed <= 0)
      return { ok: false, error: "Enter at least one milk type quantity." };

    // Mass balance: separating milk yields skim + cream, so output can never
    // exceed input. Without this, "100 L in -> 200 L skim out" was accepted and
    // line ~91 wrote the full 200 L as a PRODUCED movement, creating milk from
    // nothing and inflating stock downstream. Losses (output < input) are normal
    // and stay allowed. Tolerance absorbs float noise on 3dp quantities.
    const madeTotal = data.skimMilkMade + data.creamMade;
    if (madeTotal > milkUsed + 0.001) {
      return {
        ok: false,
        error: `Output (${madeTotal.toFixed(3)} L skim + cream) cannot exceed milk used (${milkUsed.toFixed(3)} L).`,
      };
    }

    // Stock gate — the authoritative lock. Mass balance above only proves output
    // <= typed input; it does NOT prove the input milk exists. Skim is processed
    // at the production stage, so its inputs can't exceed getTodayMilkAvailability
    // (the SAME figure the Skim page shows). A milk type absent from that list
    // means 0 available and is rejected, not skipped — this is the hole that let
    // skim be made from milk that was never produced. All THREE inputs are
    // checked (the client only ever validated buffalo/cow, never the mix input).
    {
      const avail = await getTodayMilkAvailability(data.date);
      const availOf = (keyword: string) => {
        const hit = avail.find((a) => a.name.toLowerCase().includes(keyword));
        return hit ? hit.available : 0;
      };
      const f = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));
      const checks: { qty: number; keyword: string; label: string }[] = [
        { qty: data.buffaloMilk, keyword: "buffalo", label: "Buffalo Milk" },
        { qty: data.cowMilk,     keyword: "cow",     label: "Cow Milk" },
        { qty: data.mixMilk,     keyword: "mix",     label: "Mix Milk" },
      ];
      for (const c of checks) {
        if (c.qty <= 0) continue;
        const have = availOf(c.keyword);
        if (c.qty > have + 0.001) {
          return {
            ok: false,
            error: `${c.label}: only ${f(Math.max(0, have))} L available — cannot use ${f(c.qty)} L. Log or keep the milk in production first.`,
          };
        }
      }
    }

    const [buffaloProduct, cowProduct, mixProduct, skimProduct] = await Promise.all([
      db.product.findFirst({ where: { name: { contains: "Buffalo", mode: "insensitive" }, active: true, retailOnly: false } }),
      db.product.findFirst({ where: { name: { contains: "Cow",     mode: "insensitive" }, active: true, retailOnly: false } }),
      db.product.findFirst({ where: { name: { contains: "Mix",     mode: "insensitive" }, active: true, retailOnly: false } }),
      db.product.findFirst({ where: { name: { contains: "Skim",    mode: "insensitive" }, active: true, retailOnly: false } }),
    ]);

    if (data.buffaloMilk > 0 && !buffaloProduct)
      return { ok: false, error: 'Product "Buffalo Milk" not found. Add it in Products first.' };
    if (data.cowMilk > 0 && !cowProduct)
      return { ok: false, error: 'Product "Cow Milk" not found. Add it in Products first.' };
    if (data.mixMilk > 0 && !mixProduct)
      return { ok: false, error: 'Product "Mix Milk" not found. Add it in Products first.' };
    if (!skimProduct)
      return { ok: false, error: 'Product "Skim Milk" not found. Add it in Products first.' };

    // Cream is auto-created if it doesn't exist — it's always produced alongside skim milk
    const creamProduct = data.creamMade > 0
      ? await db.product.upsert({
          where: { name: "Cream" },
          create: { name: "Cream", unit: "KG", defaultRate: new Prisma.Decimal(0), active: true },
          update: {},
        })
      : null;

    const [y, m, d] = data.date.split("-").map(Number);
    const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
    const pktTodMs = (Date.now() + PKT_OFFSET_MS) % 86_400_000;
    const date = new Date(Date.UTC(y, m - 1, d) - PKT_OFFSET_MS + pktTodMs);

    const batch = await db.skimMilkBatch.create({
      data: {
        date,
        pktDate: data.date,
        buffaloMilk:  new Prisma.Decimal(data.buffaloMilk),
        cowMilk:      new Prisma.Decimal(data.cowMilk),
        mixMilk:      new Prisma.Decimal(data.mixMilk),
        milkUsed:     new Prisma.Decimal(milkUsed),
        creamMade:   new Prisma.Decimal(data.creamMade),
        skimMilkMade: new Prisma.Decimal(data.skimMilkMade),
        notes: data.notes || null,
      },
    });

    // Inventory movements: KITCHEN_USE for each milk input, PRODUCED for skim + cream output
    const movements: Prisma.InventoryMovementCreateManyInput[] = [];
    if (data.buffaloMilk > 0 && buffaloProduct)
      movements.push({ date, type: "KITCHEN_USE", productId: buffaloProduct.id, quantity: new Prisma.Decimal(data.buffaloMilk), reference: batch.id, reason: "Skim milk processing" });
    if (data.cowMilk > 0 && cowProduct)
      movements.push({ date, type: "KITCHEN_USE", productId: cowProduct.id,     quantity: new Prisma.Decimal(data.cowMilk),     reference: batch.id, reason: "Skim milk processing" });
    if (data.mixMilk > 0 && mixProduct)
      movements.push({ date, type: "KITCHEN_USE", productId: mixProduct.id,     quantity: new Prisma.Decimal(data.mixMilk),     reference: batch.id, reason: "Skim milk processing" });
    movements.push({ date, type: "PRODUCED", productId: skimProduct.id, quantity: new Prisma.Decimal(data.skimMilkMade), reference: batch.id, reason: "Skim milk processing" });
    if (data.creamMade > 0 && creamProduct)
      movements.push({ date, type: "PRODUCED", productId: creamProduct.id, quantity: new Prisma.Decimal(data.creamMade), reference: batch.id, reason: "Skim milk processing" });

    await db.inventoryMovement.createMany({ data: movements });

    revalidatePath("/inventory/skim-milk");
    revalidatePath("/inventory/production");
    revalidatePath("/inventory/farm-arrival");
    revalidatePath("/inventory/reconciliation");
    revalidatePath("/inventory");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to save batch";
    return { ok: false, error: msg };
  }
}

export async function getSkimMilkBatches(): Promise<{
  entries: SkimMilkBatchEntry[];
  dbReady: boolean;
}> {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    const batches = await db.skimMilkBatch.findMany({
      orderBy: { date: "desc" },
      take: 60,
    });
    return {
      entries: batches.map((b) => ({
        id:           b.id,
        date:         b.date.toISOString(),
        buffaloMilk:  Number(b.buffaloMilk),
        cowMilk:      Number(b.cowMilk),
        mixMilk:      Number(b.mixMilk),
        milkUsed:     Number(b.milkUsed),
        creamMade:   Number(b.creamMade),
        skimMilkMade: Number(b.skimMilkMade),
        notes:        b.notes,
      })),
      dbReady: true,
    };
  } catch {
    return { entries: [], dbReady: false };
  }
}

export async function deleteSkimMilkBatch(id: string): Promise<SkimMilkResult> {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    await db.inventoryMovement.deleteMany({ where: { reference: id } });
    await db.skimMilkBatch.delete({ where: { id } });
    revalidatePath("/inventory/skim-milk");
    revalidatePath("/inventory/production");
    revalidatePath("/inventory/farm-arrival");
    revalidatePath("/inventory/reconciliation");
    revalidatePath("/inventory");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to delete batch";
    return { ok: false, error: msg };
  }
}

export type MilkAvailability = {
  productId: string;
  name:      string;
  produced:  number;
  available: number;   // produced − skim milk batches already logged for this date
};

// Available milk per product for a given date (defaults to today).
// Uses the same deduction logic as getNetForDispatch so the value is always
// consistent with the dispatch card: after "Send to Dispatch", available = 0.
// available = produced − KITCHEN_USE(excl. Mix milk) − CALF_USE − farmDispatch_quantities
export async function getTodayMilkAvailability(date?: string): Promise<MilkAvailability[]> {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    const targetDate = date ?? todayPKTString();
    const dateRange = dateStrRangePKT(targetDate);

    const [movements, allUseRows, farmDispatches] = await Promise.all([
      db.inventoryMovement.findMany({
        where: { date: dateRange, type: "PRODUCED" },
        select: {
          productId: true,
          quantity:  true,
          product:   { select: { name: true, unit: true } },
        },
      }),
      // All kitchen/calf use except Mix milk processing — mirrors getNetForDispatch
      db.inventoryMovement.findMany({
        where: {
          date: dateRange,
          type: { in: ["KITCHEN_USE", "CALF_USE", "WASTAGE"] },
          OR: [{ reason: null }, { reason: { notIn: [...MIX_REASONS] } }],
        },
        select: { productId: true, quantity: true },
      }),
      db.farmDispatch.findMany({
        where: { date: { gte: dateRange.gte, lte: dateRange.lte } },
        select: { declaredItems: true },
      }),
    ]);

    const deductMap = new Map<string, number>();
    const addDeduct = (id: string, qty: number) =>
      deductMap.set(id, (deductMap.get(id) ?? 0) + qty);
    for (const m of allUseRows) addDeduct(m.productId, Number(m.quantity));
    type DI = { productId: string; quantity: number };
    for (const fd of farmDispatches)
      for (const item of fd.declaredItems as DI[])
        addDeduct(item.productId, Number(item.quantity));

    const map = new Map<string, { productId: string; name: string; produced: number }>();
    for (const m of movements) {
      if (m.product.unit !== "LITER") continue;
      const existing = map.get(m.productId);
      if (existing) {
        existing.produced += Number(m.quantity);
      } else {
        map.set(m.productId, { productId: m.productId, name: m.product.name, produced: Number(m.quantity) });
      }
    }

    return Array.from(map.values()).map((e) => ({
      productId: e.productId,
      name: e.name,
      produced: e.produced,
      available: Math.max(0, e.produced - (deductMap.get(e.productId) ?? 0)),
    }));
  } catch (e) {
    console.error("[getTodayMilkAvailability]", e);
    return [];
  }
}

export async function getTodaySummary() {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    const totals = await db.skimMilkBatch.aggregate({
      where: { date: todayRangePKT() },
      _sum: { buffaloMilk: true, cowMilk: true, mixMilk: true, milkUsed: true, creamMade: true, skimMilkMade: true },
    });
    return {
      buffaloMilk:  Number(totals._sum.buffaloMilk  ?? 0),
      cowMilk:      Number(totals._sum.cowMilk       ?? 0),
      mixMilk:      Number(totals._sum.mixMilk       ?? 0),
      milkUsed:     Number(totals._sum.milkUsed      ?? 0),
      creamMade:   Number(totals._sum.creamMade    ?? 0),
      skimMilkMade: Number(totals._sum.skimMilkMade  ?? 0),
    };
  } catch {
    return { buffaloMilk: 0, cowMilk: 0, mixMilk: 0, milkUsed: 0, creamMade: 0, skimMilkMade: 0 };
  }
}
