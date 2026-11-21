import "server-only";
import { db } from "@/lib/db";
import {
  mixDeductionsByDispatch,
  additionsByDispatch,
  type AllocatableLoad,
} from "@/lib/mix-allocation";
import { MIX_REASON_PACKAGING } from "@/lib/mix-milk-source";
import { DILUTION_REASON } from "@/lib/buffalo-dilution";
import { toDateStrPKT } from "@/lib/pkt";

// What packaging did to each load: milk taken out of it (mix milk, or stirred into
// the buffalo milk) and milk stirred into it. Every screen that compares "declared
// versus received" needs this, or ordinary processing reads as wastage — a load
// that hands 50 L of cow milk to the buffalo arrives 50 L short by design.
//
// One place, because this was previously re-derived by hand on three separate
// screens and each copy knew about a different subset of what packaging can do.

export type LoadShare = {
  mixUsed: Record<string, number>;
  dilutionOut: Record<string, number>;
  dilutionIn: Record<string, number>;
};

export const EMPTY_SHARE: LoadShare = { mixUsed: {}, dilutionOut: {}, dilutionIn: {} };

type DispatchItem = { productId: string; quantity: number };

/** Load id → what packaging took from it and added to it, over the given period. */
export async function packagingAttribution(range: {
  gte: Date;
  lte: Date;
}): Promise<Map<string, LoadShare>> {
  const out = new Map<string, LoadShare>();
  const [dispatches, dispatchedMovements, mixRows, dilutionOutRows, dilutionInRows] =
    await Promise.all([
      db.farmDispatch.findMany({
        where: { date: range },
        select: { id: true, date: true, declaredItems: true, status: true, acceptedAt: true },
      }),
      db.inventoryMovement.findMany({
        where: { date: range, type: "DISPATCHED" },
        select: { reference: true, date: true },
        orderBy: { date: "asc" },
      }),
      db.inventoryMovement.findMany({
        where: { date: range, type: "KITCHEN_USE", reason: MIX_REASON_PACKAGING },
        select: { productId: true, quantity: true, date: true },
        orderBy: { date: "asc" },
      }),
      db.inventoryMovement.findMany({
        where: { date: range, type: "KITCHEN_USE", reason: DILUTION_REASON },
        select: { productId: true, quantity: true, date: true },
        orderBy: { date: "asc" },
      }),
      db.inventoryMovement.findMany({
        where: { date: range, type: "PRODUCED", reason: DILUTION_REASON },
        select: { productId: true, quantity: true, date: true },
        orderBy: { date: "asc" },
      }),
    ]);

  if (dispatches.length === 0) return out;

  const confirmedAt = new Map<string, Date>();
  for (const m of dispatchedMovements) {
    if (m.reference && !confirmedAt.has(m.reference)) confirmedAt.set(m.reference, m.date);
  }

  // Grouped by PKT day: the attribution walks each day's loads in confirmation
  // order, so a period spanning several days must not run them as one sequence.
  const byDay = <T extends { date: Date }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const key = toDateStrPKT(r.date);
      const arr = m.get(key) ?? [];
      arr.push(r);
      m.set(key, arr);
    }
    return m;
  };
  const dispatchesByDay = byDay(dispatches);
  const mixByDay = byDay(mixRows);
  const outByDay = byDay(dilutionOutRows);
  const inByDay = byDay(dilutionInRows);

  const asMovements = (rows: { productId: string; quantity: unknown; date: Date }[]) =>
    rows.map((m) => ({ productId: m.productId, quantity: Number(m.quantity), date: m.date }));

  for (const [day, allDayDispatches] of dispatchesByDay) {
    // Only loads confirmed the OLD way (accept-and-forward in one step) take a
    // share of mixing and standardising. A load accepted into the packaging pool
    // (acceptedAt set), or still waiting, arrived before anything was taken from
    // it — what packaging does afterwards comes out of the pool, not the load
    // (src/lib/packaging-stock.ts). Such loads get an empty share.
    for (const d of allDayDispatches) {
      if (d.acceptedAt || d.status === "PENDING") out.set(d.id, EMPTY_SHARE);
    }
    const dayDispatches = allDayDispatches.filter((d) => !d.acceptedAt && d.status !== "PENDING");
    if (dayDispatches.length === 0) continue;
    const loads: AllocatableLoad[] = dayDispatches.map((d) => ({
      id: d.id,
      date: d.date,
      items: ((d.declaredItems ?? []) as DispatchItem[]).map((i) => ({
        productId: i.productId,
        quantity: Number(i.quantity),
      })),
    }));
    const mix = mixDeductionsByDispatch(loads, confirmedAt, asMovements(mixByDay.get(day) ?? []));
    const dOut = mixDeductionsByDispatch(loads, confirmedAt, asMovements(outByDay.get(day) ?? []));
    const dIn = additionsByDispatch(loads, confirmedAt, asMovements(inByDay.get(day) ?? []));
    for (const l of loads) {
      out.set(l.id, {
        mixUsed: mix[l.id] ?? {},
        dilutionOut: dOut[l.id] ?? {},
        dilutionIn: dIn[l.id] ?? {},
      });
    }
  }
  return out;
}
