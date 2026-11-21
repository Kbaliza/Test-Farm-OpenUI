"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import type { Unit } from "@/lib/units";
import { isYoghurtName } from "@/lib/product-names";
import { BATCH_REASONS } from "@/lib/reconciliation-guard";
import { isFarmWastage } from "@/lib/wastage-stage";
import { DILUTION_REASON, DILUTION_REASONS } from "@/lib/buffalo-dilution";
import { quantityProblem } from "@/lib/quantity";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { MIX_REASONS } from "@/lib/mix-milk-source";
import { Prisma } from "@prisma/client";
import {
  productionFormSchema,
  type ProductionFormValues,
} from "@/lib/validators/production";
import { todayRangePKT, dateStrRangePKT, todayPKTString } from "@/lib/pkt";

export type ActionResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

export async function logProduction(
  values: ProductionFormValues
): Promise<ActionResult> {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  const parsed = productionFormSchema.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => i.message).join("; "),
    };
  }
  const v = parsed.data;
  // Store with PKT time-of-day so the timestamp always falls within dateStrRangePKT(date)
  const [y, m, d] = v.date.split("-").map(Number);
  const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
  const pktTodMs = (Date.now() + PKT_OFFSET_MS) % 86_400_000;
  const date = new Date(Date.UTC(y, m - 1, d) - PKT_OFFSET_MS + pktTodMs);

  try {
    const lines = v.lines.filter((l) => l.quantity > 0);

    // Same quantity rule the form applies (max 2 decimals; eggs whole). The form
    // blocks it, but a server action is a directly-invocable POST, so the decision
    // is made here too — from the same shared function, so they cannot disagree.
    const units = await db.product.findMany({
      where: { id: { in: lines.map((l) => l.productId) } },
      select: { id: true, name: true, unit: true, retailOnly: true },
    });
    // Retail products are not produced here, and the picker never offers them —
    // but a server action is a directly-invocable POST, so the decision is made
    // here rather than left to the screen.
    const retailOnly = units.find((u) => u.retailOnly);
    if (retailOnly) {
      return { ok: false, error: `${retailOnly.name} is a retail product — it is not part of the milk production run. Count it in on the Retail Inventory page.` };
    }
    for (const u of units) {
      const qty = lines.find((l) => l.productId === u.id)?.quantity ?? 0;
      const problem = quantityProblem(u.name, u.unit, qty);
      if (problem) return { ok: false, error: problem };
    }

    // Save production logs + PRODUCED inventory movements.
    //
    // Interactive, with the writes issued on `tx`. The batched array form cannot
    // be used on this client: the audit-actor extension makes each
    // `db.*.create()` fire immediately and separately, so the batch neither ran
    // atomically nor ever settled — the rows committed and this action hung, with
    // the Save button stuck on "Saving..." (see src/lib/db.ts).
    //
    // createMany rather than a create per line: two statements instead of two per
    // product, which matters on a pooler measured at 700-1700ms a round trip.
    // Nothing here reads the created rows back.
    await db.$transaction(async (tx) => {
      await tx.productionLog.createMany({
        data: lines.map((line) => ({
          date,
          productId: line.productId,
          quantity: new Prisma.Decimal(line.quantity),
          notes: v.notes || null,
        })),
      });
      await tx.inventoryMovement.createMany({
        data: lines.map((line) => ({
          date,
          type: "PRODUCED" as const,
          productId: line.productId,
          quantity: new Prisma.Decimal(line.quantity),
          reason: v.notes || null,
        })),
      });
    });

    revalidatePath("/inventory/production");
    revalidatePath("/inventory/skim-milk");
    revalidatePath("/inventory/yoghurt");
    revalidatePath("/inventory");
    revalidatePath("/"); // dashboard milk Arrived / Wastage / Net tiles + trend
    return { ok: true, count: lines.length };
  } catch (e: unknown) {
    console.error("[logProduction]", e);
    const msg = e instanceof Error ? e.message : "Failed to log production";
    return { ok: false, error: msg };
  }
}

export async function logUsage(
  type: "CALF_USE" | "KITCHEN_USE",
  items: { productId: string; quantity: number }[],
  date: string
): Promise<ActionResult> {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    const lines = items.filter((i) => i.quantity > 0);
    if (lines.length === 0)
      return { ok: false, error: "Enter at least one quantity" };

    // Validated through getDayProductionUsage — the SAME function the form on this
    // page gets its "available" figures from.
    //
    // It used to work this out again here, with its own copy of what counts as
    // used. Two copies of one rule is how the form came to offer a quantity the
    // server then refused, and it is where the double-counted wastage hid: this
    // copy charged the farm for milk spoiled at Packaging and Retail, which the
    // dispatch had already taken off the day. One rule now, so what the screen
    // shows and what the server allows cannot drift apart.
    const usage = await getDayProductionUsage(date);
    const byProduct = new Map(usage.map((u) => [u.productId, u]));

    // Same shared quantity rule as logProduction.
    for (const line of lines) {
      const u = byProduct.get(line.productId);
      if (!u) continue;
      const problem = quantityProblem(u.name, u.unit, line.quantity);
      if (problem) return { ok: false, error: problem };
    }

    const f = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));
    const unitSuffix = (unit: string) => (unit === "LITER" ? "L" : unit === "KG" ? "kg" : "pc");
    for (const line of lines) {
      const u = byProduct.get(line.productId);
      if (!u) continue;
      const producedQty = u.producedPlain + u.producedLinked;
      if (producedQty === 0) continue; // no production logged — let it pass
      const remaining = producedQty - u.used;
      const unit = unitSuffix(u.unit);
      if (line.quantity > remaining) {
        return {
          ok: false,
          error: `${u.name}: only ${f(remaining)} ${unit} remaining (${f(producedQty)} ${unit} produced − ${f(u.used)} ${unit} already used${u.dispatched > 0.0005 ? `, of which ${f(u.dispatched)} ${unit} went to packaging` : ""}). Cannot log ${f(line.quantity)} ${unit}.`,
        };
      }
    }

    const [dy, dm, dd] = date.split("-").map(Number);
    const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
    const pktTodMs = (Date.now() + PKT_OFFSET_MS) % 86_400_000;
    const d = new Date(Date.UTC(dy, dm - 1, dd) - PKT_OFFSET_MS + pktTodMs);

    // Interactive and on `tx` — the batched array form hangs on this client
    // (see src/lib/db.ts).
    await db.$transaction(async (tx) => {
      await tx.inventoryMovement.createMany({
        data: lines.map((l) => ({
          date: d,
          type,
          productId: l.productId,
          quantity: new Prisma.Decimal(l.quantity),
        })),
      });
    });

    revalidatePath("/inventory/production");
    revalidatePath("/inventory/reconciliation");
    revalidatePath("/inventory");
    revalidatePath("/"); // dashboard milk Arrived / Wastage / Net tiles + trend
    return { ok: true, count: lines.length };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Failed to log usage";
    return { ok: false, error: msg };
  }
}


export type DayProductUsage = {
  productId: string;
  name: string;
  unit: string;
  /** Plain farm production for the day — the only part an admin may edit. */
  producedPlain: number;
  /** PRODUCED rows owned by a batch (mix/yoghurt made at packaging). Read-only. */
  producedLinked: number;
  /** Everything already drawn from the day's pool (calf + kitchen + wastage + skim + dispatched). */
  used: number;
  calfUse: number;
  kitchenUse: number;
  yoghurtUse: number;
  /** The farm's OWN wastage — stage "Production", or its own form, which sets none. */
  wastage: number;
  /**
   * Wastage recorded at Packaging, Retail or on a rider's van. Shown, never
   * charged: the dispatch already took that milk off the farm's day, so counting
   * it here subtracted the same litres twice. See lib/wastage-stage.
   */
  postDispatchWastage: number;
  skimUse: number;
  dispatched: number;
  /** Cow milk given to buffalo standardisation (kept out of plain kitchen use). */
  dilutionOut: number;
  /** Cow milk stirred INTO this product — the added half of producedLinked. */
  dilutionIn: number;
};

// Per-product production and consumption for ONE day. Single source of truth for
// "how much of this day's milk is still free", shared by the wastage form's
// availability list and by the admin reconciliation editor's guard rails, so the
// two can never drift apart.
export async function getDayProductionUsage(date?: string): Promise<DayProductUsage[]> {
  // Exported from a "use server" module, so this is reachable as a server action —
  // it needs its own guard, not just the guards of its in-process callers.
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  const targetDate = date ?? todayPKTString();
  const dateRange = dateStrRangePKT(targetDate);

  const [producedRows, usedRows, skimBatches, farmDispatches, products] = await Promise.all([
    db.inventoryMovement.findMany({
      where: { date: dateRange, type: "PRODUCED" },
      select: { productId: true, quantity: true, reason: true, reference: true },
    }),
    // Kitchen/calf use + production wastage. Batch-processing rows are excluded
    // here: skim is counted from its batches below, and mix is consumed at
    // packaging out of what was already dispatched (so it is counted there).
    db.inventoryMovement.findMany({
      where: {
        date: dateRange,
        type: { in: ["KITCHEN_USE", "CALF_USE", "WASTAGE"] },
        OR: [{ reason: null }, { reason: { notIn: ["Skim milk processing", ...MIX_REASONS, ...DILUTION_REASONS] } }],
      },
      select: { productId: true, quantity: true, type: true, reason: true, stage: true },
    }),
    db.skimMilkBatch.findMany({ where: { pktDate: targetDate }, select: { buffaloMilk: true, cowMilk: true, mixMilk: true } }),
    db.farmDispatch.findMany({ where: { date: dateRange }, select: { declaredItems: true } }),
    db.product.findMany({ where: { active: true, retailOnly: false }, select: { id: true, name: true, unit: true } }),
  ]);

  const meta = new Map(products.map((p) => [p.id, { name: p.name, unit: p.unit as string }]));
  const rows = new Map<string, DayProductUsage>();
  const row = (id: string): DayProductUsage => {
    let r = rows.get(id);
    if (!r) {
      const m = meta.get(id);
      r = {
        productId: id, name: m?.name ?? "Unknown", unit: m?.unit ?? "LITER",
        producedPlain: 0, producedLinked: 0, used: 0,
        calfUse: 0, kitchenUse: 0, yoghurtUse: 0, wastage: 0, postDispatchWastage: 0, skimUse: 0, dispatched: 0,
        dilutionOut: 0, dilutionIn: 0,
      };
      rows.set(id, r);
    }
    return r;
  };

  for (const m of producedRows) {
    const r = row(m.productId);
    // Milk stirred in at packaging is not farm production at all — it is the other
    // milk, moved across after dispatch. Tracked on its own so the day can show it
    // without it counting as something the animals gave.
    if (m.reason === DILUTION_REASON) {
      r.dilutionIn += Number(m.quantity);
      continue;
    }
    const linked = !!m.reference || (m.reason != null && (BATCH_REASONS as readonly string[]).includes(m.reason));
    if (linked) r.producedLinked += Number(m.quantity);
    else r.producedPlain += Number(m.quantity);
  }

  for (const m of usedRows) {
    const r = row(m.productId);
    const q = Number(m.quantity);
    if (m.type === "CALF_USE") r.calfUse += q;
    // Wastage at Packaging, Retail or on a rider's van is milk the dispatch has
    // already taken off the farm's day. Charging it here as well subtracted the
    // same litres twice — see lib/wastage-stage.
    else if (m.type === "WASTAGE") {
      if (isFarmWastage(m.stage)) r.wastage += q;
      else r.postDispatchWastage += q;
    }
    else if (m.reason === "Yoghurt processing") r.yoghurtUse += q;
    // Standardising happens at packaging out of milk that was already dispatched,
    // so it is not farm kitchen use. Tracked for display, never for the farm's
    // own availability — the dispatch already accounted for that milk.
    else if ((DILUTION_REASONS as readonly string[]).includes(m.reason ?? "")) r.dilutionOut += q;
    else r.kitchenUse += q;
  }

  // Skim batches are matched to products by name, the same way the wastage list does it.
  const skimTotals = { buffalo: 0, cow: 0, mix: 0 };
  for (const b of skimBatches) {
    skimTotals.buffalo += Number(b.buffaloMilk);
    skimTotals.cow += Number(b.cowMilk);
    skimTotals.mix += Number(b.mixMilk);
  }
  for (const r of rows.values()) {
    const n = r.name.toLowerCase();
    r.skimUse = n.includes("buffalo") ? skimTotals.buffalo
      : n.includes("cow") ? skimTotals.cow
      : n.includes("mix") ? skimTotals.mix
      : 0;
  }

  type FDItem = { productId: string; quantity: number };
  for (const fd of farmDispatches)
    for (const item of (fd.declaredItems as FDItem[]) ?? [])
      row(item.productId).dispatched += Number(item.quantity);

  for (const r of rows.values()) {
    r.used = r.calfUse + r.kitchenUse + r.yoghurtUse + r.wastage + r.skimUse + r.dispatched;
  }
  return [...rows.values()];
}

// Returns how much of each product is still available at the farm for wastage
// entry. Thin wrapper over getDayProductionUsage so this list and the admin
// reconciliation editor's guard rails always agree on what "used" means.
export async function getProductionAvailable(
  date?: string
): Promise<{ productId: string; name: string; unit: string; available: number }[]> {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    const rows = await getDayProductionUsage(date);
    return rows
      // Unchanged behaviour: only products that actually had production that day.
      .filter((r) => r.producedPlain + r.producedLinked > 0)
      .map((r) => ({
        productId: r.productId,
        name: r.name,
        unit: r.unit,
        available: Math.max(0, r.producedPlain + r.producedLinked - r.used),
      }));
  } catch {
    return [];
  }
}

// items carry `remaining` (what the user has right now).
// wastage = available − remaining is computed and logged automatically.
export async function logProductionWastage(
  items: { productId: string; lost: number }[],
  date: string
): Promise<ActionResult> {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    if (items.length === 0) return { ok: false, error: "Enter the quantity lost for at least one product." };

    const productIds = items.map((l) => l.productId);
    const dateRange = dateStrRangePKT(date);

    const [producedRows, usedRows, skimBatches, productRows] = await Promise.all([
      db.inventoryMovement.findMany({
        where: { date: dateRange, type: "PRODUCED", productId: { in: productIds } },
        select: { productId: true, quantity: true },
      }),
      db.inventoryMovement.findMany({
        where: {
          date: dateRange,
          type: { in: ["KITCHEN_USE", "CALF_USE", "WASTAGE"] },
          productId: { in: productIds },
          OR: [
            { reason: null },
            { reason: { notIn: ["Skim milk processing", ...MIX_REASONS, ...DILUTION_REASONS] } },
          ],
        },
        select: { productId: true, quantity: true },
      }),
      db.skimMilkBatch.findMany({
        where: { pktDate: date },
        select: { buffaloMilk: true, cowMilk: true, mixMilk: true },
      }),
      db.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, unit: true },
      }),
    ]);

    // Same shared quantity rule as the other two entry points — the figure the
    // operator types is a quantity like any other.
    for (const it of items) {
      const prod = productRows.find((r) => r.id === it.productId);
      if (!prod) continue;
      const problem = quantityProblem(prod.name, prod.unit, it.lost);
      if (problem) return { ok: false, error: problem };
    }

    const producedMap = new Map<string, number>();
    for (const m of producedRows) producedMap.set(m.productId, (producedMap.get(m.productId) ?? 0) + Number(m.quantity));

    const usedMap = new Map<string, number>();
    for (const m of usedRows) usedMap.set(m.productId, (usedMap.get(m.productId) ?? 0) + Number(m.quantity));

    const skimTotals = { buffalo: 0, cow: 0, mix: 0 };
    for (const b of skimBatches) {
      skimTotals.buffalo += Number(b.buffaloMilk);
      skimTotals.cow     += Number(b.cowMilk);
      skimTotals.mix     += Number(b.mixMilk);
    }
    const productMap = new Map(productRows.map((p) => [p.id, p]));
    for (const prod of productRows) {
      const n = prod.name.toLowerCase();
      const skimUsed = n.includes("buffalo") ? skimTotals.buffalo
                     : n.includes("cow")     ? skimTotals.cow
                     : n.includes("mix")     ? skimTotals.mix
                     : 0;
      if (skimUsed > 0) usedMap.set(prod.id, (usedMap.get(prod.id) ?? 0) + skimUsed);
    }

    const f = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));
    const unitSuffix = (u: string) => u === "LITER" ? "L" : u === "KG" ? "kg" : "pc";

    // Compute wastage for each item, validate, collect lines to log
    const wastageLines: { productId: string; wastage: number }[] = [];
    for (const item of items) {
      const prod = productMap.get(item.productId);
      if (!prod) continue;
      const produced = producedMap.get(item.productId) ?? 0;
      if (produced === 0) continue; // no production today — skip silently
      const used    = usedMap.get(item.productId) ?? 0;
      const available = Math.max(0, produced - used);
      const u = unitSuffix(prod.unit);

      if (item.lost < 0) {
        return { ok: false, error: `${prod.name}: quantity lost cannot be negative.` };
      }
      if (item.lost > available + 0.001) {
        return {
          ok: false,
          error: `${prod.name}: you entered ${f(item.lost)} ${u} lost, but only ${f(available)} ${u} is available (${f(produced)} ${u} produced − ${f(used)} ${u} used/wasted).`,
        };
      }

      const wastage = Math.round(item.lost * 1000) / 1000;
      if (wastage > 0.001) wastageLines.push({ productId: item.productId, wastage });
    }

    if (wastageLines.length === 0) {
      return { ok: false, error: "No wastage to log — enter a quantity greater than zero." };
    }

    const [dy, dm, dd] = date.split("-").map(Number);
    const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
    const pktTodMs = (Date.now() + PKT_OFFSET_MS) % 86_400_000;
    const d = new Date(Date.UTC(dy, dm - 1, dd) - PKT_OFFSET_MS + pktTodMs);

    // Interactive and on `tx` — the batched array form hangs on this client
    // (see src/lib/db.ts).
    await db.$transaction(async (tx) => {
      await tx.inventoryMovement.createMany({
        data: wastageLines.map((l) => ({
          date: d,
          type: "WASTAGE" as const,
          productId: l.productId,
          quantity: new Prisma.Decimal(l.wastage),
          reason: "Production wastage",
        })),
      });
    });

    revalidatePath("/inventory/production");
    revalidatePath("/inventory/wastage");
    revalidatePath("/inventory/reconciliation");
    revalidatePath("/inventory");
    revalidatePath("/"); // dashboard milk Arrived / Wastage / Net tiles + trend
    return { ok: true, count: wastageLines.length };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Failed to log wastage";
    return { ok: false, error: msg };
  }
}

export async function getProductionContext() {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    const products = await db.product.findMany({
      // Retail products are not produced here, so they never
      // appear on the production screen.
      where: { active: true, retailOnly: false },
      orderBy: { name: "asc" },
    });
    return { products, dbReady: true };
  } catch {
    return { products: [], dbReady: false };
  }
}

export type RecentEntry = {
  id: string;
  date: string;
  productName: string;
  unit: Unit;
  quantity: number;
  notes: string | null;
};

export async function getRecentProduction(
  date?: string
): Promise<RecentEntry[]> {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    const dateRange = date ? dateStrRangePKT(date) : todayRangePKT();
    const logs = await db.productionLog.findMany({
      where: { date: dateRange },
      select: {
        id: true,
        date: true,
        quantity: true,
        notes: true,
        product: { select: { name: true, unit: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return logs.map((l) => ({
      id: l.id,
      date: l.date.toISOString(),
      productName: l.product.name,
      unit: l.product.unit,
      quantity: Number(l.quantity),
      notes: l.notes,
    }));
  } catch {
    return [];
  }
}

// ── Dispatch to Packaging ─────────────────────────────────────────────────────

export type DispatchPreview = {
  productId: string;
  productName: string;
  unit: string;
  produced: number;
  used: number;
  net: number;
};

// Outstanding balance available to send to packaging, per product:
//   net = total produced − internal use (kitchen/calf, incl. skim processing)
//          − everything already sent to packaging (all FarmDispatch declared items)
// This is a running balance (NOT today-only), so production that wasn't dispatched
// the same day — e.g. skim milk & cream processed in a separate step — is carried
// forward and stays in the tile until it's actually sent. Once a FarmDispatch is
// created the declared amount is deducted, so nothing can be double-dispatched.
export async function getNetForDispatch(): Promise<DispatchPreview[]> {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    const today = todayRangePKT();

    const [producedRows, usedRows, wastageRows, todaysFDs, fixedProducts] = await Promise.all([
      // Standardising happens at packaging, so the litres it adds are already
      // there — offering them again on the farm's "send to packaging" tile would
      // dispatch the same milk twice.
      db.inventoryMovement.findMany({
        where: {
          type: "PRODUCED",
          date: { gte: today.gte, lte: today.lte },
          OR: [{ reason: null }, { reason: { not: DILUTION_REASON } }],
        },
        select: { productId: true, quantity: true, product: { select: { name: true, unit: true } } },
      }),
      db.inventoryMovement.findMany({
        where: {
          type: { in: ["KITCHEN_USE", "CALF_USE"] },
          date: { gte: today.gte, lte: today.lte },
          OR: [{ reason: null }, { reason: { notIn: [...MIX_REASONS, ...DILUTION_REASONS] } }],
        },
        select: { productId: true, quantity: true },
      }),
      // Production-stage wastage explicitly logged before dispatching
      db.inventoryMovement.findMany({
        where: { type: "WASTAGE", reason: "Production wastage", date: { gte: today.gte, lte: today.lte } },
        select: { productId: true, quantity: true },
      }),
      // Today's dispatches — deducted so the tile clears after "Send to Packaging".
      db.farmDispatch.findMany({
        where: { date: { gte: today.gte, lte: today.lte } },
        select: { declaredItems: true },
      }),
      // Skim Milk and Cream always appear in the card even before a batch is logged.
      db.product.findMany({
        where: {
          active: true,
          retailOnly: false,
          OR: [
            { name: { contains: "Skim", mode: "insensitive" } },
            { name: "Cream" },
          ],
        },
        select: { id: true, name: true, unit: true },
      }),
    ]);

    // Seed skim milk and cream with 0 so they always appear
    const producedMap = new Map<string, { name: string; unit: string; qty: number }>();
    for (const p of fixedProducts) {
      producedMap.set(p.id, { name: p.name, unit: p.unit, qty: 0 });
    }

    for (const m of producedRows) {
      // Yoghurt is processed separately and does not go through the packaging dispatch chain
      if (isYoghurtName(m.product.name)) continue;
      // Mix Milk is entered and dispatched through a separate flow, not via this page
      if (m.product.name === "Mix Milk") continue;
      const e = producedMap.get(m.productId);
      if (e) e.qty += Number(m.quantity);
      else producedMap.set(m.productId, { name: m.product.name, unit: m.product.unit, qty: Number(m.quantity) });
    }

    // Deductions: today's calf use, kitchen use, skim processing, and what was already dispatched today.
    const deductMap = new Map<string, number>();
    const addDeduct = (id: string, qty: number) =>
      deductMap.set(id, (deductMap.get(id) ?? 0) + qty);

    for (const m of usedRows) addDeduct(m.productId, Number(m.quantity));
    for (const m of wastageRows) addDeduct(m.productId, Number(m.quantity));
    type DI = { productId: string; quantity: number };
    for (const fd of todaysFDs)
      for (const item of fd.declaredItems as DI[])
        addDeduct(item.productId, Number(item.quantity));

    return Array.from(producedMap.entries()).map(([productId, { name, unit, qty: produced }]) => {
      const used = deductMap.get(productId) ?? 0;
      return { productId, productName: name, unit, produced, used, net: Math.max(0, produced - used) };
    });
  } catch (e) {
    console.error("[getNetForDispatch]", e);
    return [];
  }
}

export type SendToPackagingResult = { ok: true } | { ok: false; error: string };

export async function sendToPackaging(): Promise<SendToPackagingResult> {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    const preview = await getNetForDispatch();
    const items = preview
      .filter((p) => p.net > 0)
      .map((p) => ({ productId: p.productId, productName: p.productName, unit: p.unit, quantity: p.net }));

    if (items.length === 0)
      return { ok: false, error: "No milk to dispatch — log production and deductions first." };

    await db.farmDispatch.create({
      data: {
        date: new Date(),
        declaredItems: items as unknown as Prisma.InputJsonValue,
        status: "PENDING",
      },
    });

    revalidatePath("/inventory/farm-arrival");
    revalidatePath("/inventory/production");
    revalidatePath("/inventory");
    revalidatePath("/"); // dashboard milk Arrived / Wastage / Net tiles + trend
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to dispatch";
    return { ok: false, error: msg };
  }
}

// ── Dispatch log ─────────────────────────────────────────────────────────────
// The production page showed what was PRODUCED but nothing about what was then
// sent on, so after pressing "Dispatch to packaging" there was no record of it on
// that screen. This lists today's loads with what each contained.

export type DispatchLogItem = { productName: string; unit: string; quantity: number };
export type DispatchLogEntry = {
  id: string;
  date: string;              // ISO
  status: string;            // PENDING | CONFIRMED | DISPUTED
  declared: DispatchLogItem[];
  received: DispatchLogItem[] | null;  // what packaging actually accepted, once settled
};

export async function getTodaysDispatches(): Promise<DispatchLogEntry[]> {
  await requireRole([...FULL_ACCESS, "DOCTOR"]);
  try {
    const rows = await db.farmDispatch.findMany({
      where: { date: dateStrRangePKT(todayPKTString()) },
      orderBy: { date: "desc" },
      select: { id: true, date: true, status: true, declaredItems: true, receivedItems: true },
    });
    const asItems = (v: unknown): DispatchLogItem[] =>
      Array.isArray(v)
        ? (v as DispatchLogItem[])
            .filter((i) => i && Number(i.quantity) > 0)
            .map((i) => ({ productName: i.productName, unit: i.unit, quantity: Number(i.quantity) }))
        : [];
    return rows.map((r) => ({
      id: r.id,
      date: r.date.toISOString(),
      status: r.status,
      declared: asItems(r.declaredItems),
      received: r.receivedItems ? asItems(r.receivedItems) : null,
    }));
  } catch (e) {
    console.error("[getTodaysDispatches]", e);
    return [];
  }
}
