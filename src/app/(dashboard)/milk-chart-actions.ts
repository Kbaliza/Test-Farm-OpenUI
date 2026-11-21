"use server";

// The dashboard's Milk Inventory & Sales card.
//
// One question, two answers a day: how much milk came IN (arrived from the farm
// plus milk bought in) and how much went OUT to customers. The old card showed
// inventory alone, over a fixed 7 days, with month-to-date tiles that answered a
// different period from the chart beneath them. Here one date range drives both.

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { dateRangeFromToPKT, todayPKTString, addDaysToDateStr } from "@/lib/pkt";
import { OUTSOURCED_KEY, type MilkChartData, type MilkChartDay } from "@/lib/milk-chart";

const PKT_MS = 5 * 60 * 60 * 1000;
const dayKey = (d: Date) => new Date(d.getTime() + PKT_MS).toISOString().slice(0, 10);

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDaysToDateStr(d, 1)) out.push(d);
  return out;
}

type FDItem = { productId: string; unit: string; quantity: number };

/** Inventory in and sales out per day, for one PKT date range. */
export async function getMilkChartData(fromStr: string, toStr: string): Promise<MilkChartData> {
  await requireRole(FULL_ACCESS);
  const today = todayPKTString();
  const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  let from = valid(fromStr) ? fromStr : today;
  let to = valid(toStr) ? toStr : today;
  if (from > to) [from, to] = [to, from];
  if (to > today) to = today;               // the future holds no milk
  if (from > to) from = to;

  const empty: MilkChartData = {
    from, to, days: [], types: [],
    totals: { arrived: 0, outsourced: 0, inventory: 0, sales: 0, wastage: 0, net: 0 },
  };

  try {
    const range = dateRangeFromToPKT(from, to);
    const literProducts = await db.product.findMany({
      where: { unit: "LITER", active: true, retailOnly: false },
      select: { id: true, name: true },
    });
    const literIds = literProducts.map((p) => p.id);
    const literName = new Map(literProducts.map((p) => [p.id, p.name]));
    if (literIds.length === 0) return empty;

    const [dispatches, outsourced, deliveries, wastageAgg] = await Promise.all([
      // What packaging received from the farm — the same rows the old trend used.
      db.farmDispatch.findMany({
        where: { date: range },
        select: { date: true, declaredItems: true, receivedItems: true },
      }),
      db.inventoryMovement.findMany({
        where: { date: range, type: "COUNTER_PURCHASE", productId: { in: literIds } },
        select: { date: true, quantity: true },
      }),
      // Sales to customers. A return is a credit, so it comes off; a replacement is
      // free milk and is not a sale at all.
      db.deliveryEntry.findMany({
        where: { date: range, isReplacement: false, productId: { in: literIds } },
        select: { date: true, productId: true, quantity: true, isReturn: true },
      }),
      db.inventoryMovement.aggregate({
        _sum: { quantity: true },
        where: { date: range, type: "WASTAGE", productId: { in: literIds } },
      }),
    ]);

    const days = new Map<string, MilkChartDay>();
    for (const date of daysBetween(from, to)) {
      days.set(date, { date, inventory: {}, sales: {}, inventoryTotal: 0, salesTotal: 0 });
    }
    const dayOf = (d: Date) => days.get(dayKey(d));

    for (const d of dispatches) {
      const day = dayOf(d.date);
      if (!day) continue;
      const items = (d.receivedItems ?? d.declaredItems) as FDItem[];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item.unit !== "LITER" || !literIds.includes(item.productId)) continue;
        const q = Number(item.quantity);
        day.inventory[item.productId] = (day.inventory[item.productId] ?? 0) + q;
        day.inventoryTotal += q;
      }
    }
    for (const m of outsourced) {
      const day = dayOf(m.date);
      if (!day) continue;
      const q = Number(m.quantity);
      day.inventory[OUTSOURCED_KEY] = (day.inventory[OUTSOURCED_KEY] ?? 0) + q;
      day.inventoryTotal += q;
    }
    for (const e of deliveries) {
      const day = dayOf(e.date);
      if (!day) continue;
      const q = Number(e.quantity) * (e.isReturn ? -1 : 1);
      day.sales[e.productId] = (day.sales[e.productId] ?? 0) + q;
      day.salesTotal += q;
    }

    // Only the milk types that actually moved get a stack and a legend row.
    const totalsByType: Record<string, number> = {};
    let arrived = 0, outsourcedTotal = 0, sales = 0;
    for (const day of days.values()) {
      for (const [id, v] of Object.entries(day.inventory)) {
        totalsByType[id] = (totalsByType[id] ?? 0) + v;
        if (id === OUTSOURCED_KEY) outsourcedTotal += v; else arrived += v;
      }
      for (const [id, v] of Object.entries(day.sales)) {
        totalsByType[id] = (totalsByType[id] ?? 0) + v;
        sales += v;
      }
    }
    const types = Object.entries(totalsByType)
      .filter(([, total]) => total > 0)
      .map(([id, totalL]) => ({
        id,
        name: id === OUTSOURCED_KEY ? "Bought in" : literName.get(id) ?? "Unknown",
        totalL,
      }))
      .sort((a, b) => b.totalL - a.totalL);

    const wastage = Number(wastageAgg._sum.quantity ?? 0);
    return {
      from, to,
      days: [...days.values()],
      types,
      totals: {
        arrived,
        outsourced: outsourcedTotal,
        inventory: arrived + outsourcedTotal,
        sales,
        wastage,
        net: arrived + outsourcedTotal - sales - wastage,
      },
    };
  } catch (e) {
    console.error("[dashboard] getMilkChartData failed:", e);
    return empty;
  }
}
