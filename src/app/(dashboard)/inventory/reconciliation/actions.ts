"use server";

import { requireRole } from "@/lib/auth";

import type { Unit } from "@/lib/units";
import { db } from "@/lib/db";
import { MIX_REASONS, MIX_REASON_PACKAGING } from "@/lib/mix-milk-source";
import { DILUTION_REASON, DILUTION_REASONS } from "@/lib/buffalo-dilution";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { todayRangePKT, toDateStrPKT, dateStrRangePKT, dateRangeFromToPKT } from "@/lib/pkt";
import { ACCEPTED_AT_PACKAGING, EGGS_COLLECTED } from "@/lib/packaging-stock";
import { END_OF_SHIFT_RETURN_REASON as END_OF_SHIFT_RETURN, isLoadShortfall } from "@/lib/rider-stock";
import { RIDER_RETURN_STAGE, RETAIL_RETURN_STAGE } from "@/lib/rider-return-math";
import { isFarmWastage } from "@/lib/wastage-stage";
import { milkFlow, type MilkFlow, type WasteBucket } from "@/lib/reconciliation-flow-math";
import { getStockByProduct } from "@/lib/inventory-onhand";
import { sampleDeliveries } from "@/lib/sample-deliveries";
import { isEggName, isYoghurtName, isGheeName } from "@/lib/product-names";
import { getDayProductionUsage } from "@/app/(dashboard)/inventory/production/actions";
import { validateDayEdit, minProduced, BATCH_REASONS } from "@/lib/reconciliation-guard";

export type DayRow = {
  date: string; // "yyyy-MM-dd"
  produced:       Record<string, number>;
  calfUse:        Record<string, number>;
  kitchenUse:     Record<string, number>;
  skimUse:        Record<string, number>; // KITCHEN_USE with reason "Skim milk processing"
  yoghurtUse:     Record<string, number>; // KITCHEN_USE with reason "Yoghurt processing"
  // Buffalo standardisation: cow milk stirred into buffalo milk. Two halves of one
  // move — what leaves cow (`dilutionOut`) is exactly what arrives in buffalo
  // (`dilutionIn`), so the day still balances.
  dilutionIn:     Record<string, number>;
  dilutionOut:    Record<string, number>;
  dispatched:     Record<string, number>; // packaging dispatched (DISPATCHED movements)
  // Van stage removed — Packaging now forwards straight to Retail. This field name is
  // kept for compatibility but carries "declared to retail" (RetailDispatch.declaredItems).
  vanDelivery:    Record<string, number>; // declared to retail (RetailDispatch.declaredItems, bucketed by date)
  retailReceived: Record<string, number>; // retail confirmed receiving (ARRIVED with RetailDispatch reference)
};

export type ReconciliationProduct = {
  id:   string;
  name: string;
  unit: Unit;
};

export type ReconciliationData = {
  rows:     DayRow[];
  products: ReconciliationProduct[];
  dbReady:  boolean;
};

type DispatchItem = { productId: string; quantity: number };

export async function getReconciliationData(days = 30): Promise<ReconciliationData> {
  await requireRole(["ADMIN","MANAGER","DOCTOR"]);
  return buildDayRows(new Date(todayRangePKT().gte.getTime() - (days - 1) * 86_400_000));
}

/** The same day-by-day rows for an explicit range, so the detailed table can
 *  follow whatever dates the summary above is showing. */
export async function getReconciliationDays(from: string, to: string): Promise<ReconciliationData> {
  await requireRole(["ADMIN","MANAGER","DOCTOR"]);
  if (!isValidDate(from) || !isValidDate(to)) return { rows: [], products: [], dbReady: true };
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const range = dateRangeFromToPKT(lo, hi);
  return buildDayRows(range.gte, range.lte);
}

async function buildDayRows(since: Date, until?: Date): Promise<ReconciliationData> {
  try {
    const inRange = (d: Date) => d >= since && (!until || d <= until);

    const [movements, products, retailDispatches] = await Promise.all([
      db.inventoryMovement.findMany({
        where: {
          date: until ? { gte: since, lte: until } : { gte: since },
          type: { in: ["PRODUCED", "CALF_USE", "KITCHEN_USE", "DISPATCHED", "ARRIVED"] },
        },
        select: { date: true, quantity: true, productId: true, type: true, reason: true, reference: true },
        orderBy: { date: "asc" },
      }),
      db.product.findMany({
        where: { active: true, retailOnly: false, NOT: { name: "Ghee" } },
        select: { id: true, name: true, unit: true },
        orderBy: { name: "asc" },
      }),
      // RetailDispatch.date is set at van-confirmation time → correct date bucket for vanDelivery
      // RetailDispatch.declaredItems = van-confirmed quantities
      // All RetailDispatches loaded (no date filter) so ARRIVED filter works for late confirmations
      db.retailDispatch.findMany({ select: { id: true, date: true, declaredItems: true } }),
    ]);

    const retailDispatchIds = new Set(retailDispatches.map((r) => r.id));
    const retailDispatchesInPeriod = retailDispatches.filter((rd) => inRange(new Date(rd.date)));

    const dayMap = new Map<string, DayRow>();

    function ensureDay(dateStr: string): DayRow {
      if (!dayMap.has(dateStr)) {
        dayMap.set(dateStr, {
          date:           dateStr,
          produced:       {},
          calfUse:        {},
          kitchenUse:     {},
          skimUse:        {},
          yoghurtUse:     {},
          dilutionIn:     {},
          dilutionOut:    {},
          dispatched:     {},
          vanDelivery:    {},
          retailReceived: {},
        });
      }
      return dayMap.get(dateStr)!;
    }

    for (const m of movements) {
      const day = ensureDay(toDateStrPKT(m.date));
      const qty = Number(m.quantity);
      const pid = m.productId;
      const add = (obj: Record<string, number>) => { obj[pid] = (obj[pid] ?? 0) + qty; };

      switch (m.type) {
        case "PRODUCED":
          // Milk stirred in at packaging is not farm production — the animals did
          // not give it, it moved across from the other milk. Kept in its own
          // bucket so the Buffalo Prep columns can show it without inflating the
          // day's production.
          if (m.reason === DILUTION_REASON) add(day.dilutionIn);
          else add(day.produced);
          break;
        case "CALF_USE":    add(day.calfUse);         break;
        case "KITCHEN_USE":
          if (m.reason === "Yoghurt processing")      add(day.yoghurtUse);
          else if (m.reason === "Skim milk processing") add(day.skimUse);
          // Mix milk is made at PACKAGING out of milk that was already dispatched,
          // so it is not farm kitchen use. Counting it here inflated the column
          // (519 of 520 L on the current data) and understated Net Production.
          // The inventory summary and getDayProductionUsage already exclude it.
          // Milk given to buffalo standardisation is not kitchen use — it is the
          // same milk, counted against the other product from here on.
          else if ((DILUTION_REASONS as readonly string[]).includes(m.reason ?? "")) add(day.dilutionOut);
          else if (!MIX_REASONS.includes(m.reason as (typeof MIX_REASONS)[number])) add(day.kitchenUse);
          break;
        case "DISPATCHED":  add(day.dispatched);      break;
        case "ARRIVED":
          if (m.reference && retailDispatchIds.has(m.reference)) add(day.retailReceived);
          break;
      }
    }

    for (const rd of retailDispatchesInPeriod) {
      if (!rd.declaredItems) continue;
      const day = ensureDay(toDateStrPKT(rd.date));
      for (const item of rd.declaredItems as DispatchItem[]) {
        day.vanDelivery[item.productId] =
          (day.vanDelivery[item.productId] ?? 0) + item.quantity;
      }
    }

    return {
      rows: Array.from(dayMap.values()).sort((a, b) => b.date.localeCompare(a.date)),
      products: products.map((p) => ({ id: p.id, name: p.name, unit: p.unit })),
      dbReady: true,
    };
  } catch {
    return { rows: [], products: [], dbReady: false };
  }
}

// ── Admin correction of a day's farm numbers ─────────────────────────────────
// Only the three numbers the farm types in by hand are editable: produced, calf
// use and plain kitchen use. Skim / yoghurt / mix use, dispatch and retail
// arrivals are each generated by another record (a batch or a dispatch), so
// rewriting them from here would leave those records disagreeing with inventory.

const ADMIN_REASON = "Admin correction (reconciliation)";
const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export type EditableProductRow = {
  productId: string;
  name: string;
  unit: string;
  // Editable
  produced: number;
  calfUse: number;
  kitchenUse: number;
  // Read-only context — this is what constrains a reduction
  producedLinked: number;
  yoghurtUse: number;
  skimUse: number;
  wastage: number;
  dispatched: number;
  /** Cow milk given to buffalo standardisation — locked, like a dispatch. */
  dilutionOut: number;
  /** Cow milk stirred into this product — part of producedLinked. */
  dilutionIn: number;
  /** Produced may not go below this: everything already drawn that isn't calf/kitchen. */
  minProduced: number;
};

export type DayEditData =
  | { ok: true; date: string; rows: EditableProductRow[] }
  | { ok: false; error: string };

export async function getReconciliationDayEdit(date: string): Promise<DayEditData> {
  await requireRole(["ADMIN"]);
  if (!isValidDate(date)) return { ok: false, error: "Invalid date." };
  try {
    const usage = await getDayProductionUsage(date);
    const rows: EditableProductRow[] = usage
      .map((u) => ({
        productId: u.productId,
        name: u.name,
        unit: u.unit,
        produced: u.producedPlain,
        calfUse: u.calfUse,
        kitchenUse: u.kitchenUse,
        producedLinked: u.producedLinked,
        yoghurtUse: u.yoghurtUse,
        skimUse: u.skimUse,
        wastage: u.wastage,
        dispatched: u.dispatched,
        dilutionOut: u.dilutionOut,
        dilutionIn: u.dilutionIn,
        // Locked consumption = everything except the calf/kitchen the admin can lower.
        minProduced: minProduced(u),
      }))
      // A product with no activity at all that day would just be noise.
      .filter((r) => r.produced || r.calfUse || r.kitchenUse || r.producedLinked || r.yoghurtUse || r.skimUse || r.wastage || r.dispatched || r.dilutionOut)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, date, rows };
  } catch (e) {
    console.error("[getReconciliationDayEdit]", e);
    return { ok: false, error: "Could not load that day." };
  }
}

export type SaveEditResult =
  | { ok: true; changed: number }
  | { ok: false; error: string; conflicts?: string[] };

export async function saveReconciliationDayEdit(
  date: string,
  edits: { productId: string; produced: number; calfUse: number; kitchenUse: number }[]
): Promise<SaveEditResult> {
  await requireRole(["ADMIN"]);
  if (!isValidDate(date)) return { ok: false, error: "Invalid date." };
  if (!edits?.length) return { ok: false, error: "Nothing to save." };

  try {
    // Re-read the day inside the request: what the browser was showing may be
    // stale, and validation has to run against what the database says right now.
    const usage = await getDayProductionUsage(date);
    const byId = new Map(usage.map((u) => [u.productId, u]));

    const conflicts: string[] = [];
    const clean: typeof edits = [];

    for (const e of edits) {
      const u = byId.get(e.productId);
      if (!u) { conflicts.push("A product in this form no longer exists."); continue; }
      // Same pure rule the dialog runs while typing — see lib/reconciliation-guard.
      const problem = validateDayEdit(u, e);
      if (problem) { conflicts.push(problem); continue; }
      clean.push(e);
    }

    if (conflicts.length) {
      return { ok: false, error: "This change conflicts with what has already happened.", conflicts };
    }

    const range = dateStrRangePKT(date);
    // Stamp the row with that day's date at the current PKT time-of-day, exactly as
    // logProduction does, so it always lands inside dateStrRangePKT(date).
    const [y, m, d] = date.split("-").map(Number);
    const PKT = 5 * 60 * 60 * 1000;
    const when = new Date(Date.UTC(y, m - 1, d) - PKT + ((Date.now() + PKT) % 86_400_000));
    // `reason NOT IN (...)` never matches NULL in SQL, so the null case has to be
    // OR-ed in explicitly — otherwise plain rows survive the delete and double up.
    const plainReason = { OR: [{ reason: null }, { reason: { notIn: [...BATCH_REASONS] } }] };

    await db.$transaction(async (tx) => {
      for (const e of clean) {
        // Produced — the movement AND the ProductionLog it was written with, or the
        // Production page's history would disagree with inventory.
        await tx.inventoryMovement.deleteMany({
          where: { date: range, type: "PRODUCED", productId: e.productId, reference: null, ...plainReason },
        });
        await tx.productionLog.deleteMany({ where: { date: range, productId: e.productId } });
        if (e.produced > 0) {
          await tx.inventoryMovement.create({
            data: { date: when, type: "PRODUCED", productId: e.productId, quantity: new Prisma.Decimal(e.produced), reason: ADMIN_REASON },
          });
          await tx.productionLog.create({
            data: { date: when, productId: e.productId, quantity: new Prisma.Decimal(e.produced), notes: ADMIN_REASON },
          });
        }

        // Calf use
        await tx.inventoryMovement.deleteMany({ where: { date: range, type: "CALF_USE", productId: e.productId } });
        if (e.calfUse > 0) {
          await tx.inventoryMovement.create({
            data: { date: when, type: "CALF_USE", productId: e.productId, quantity: new Prisma.Decimal(e.calfUse), reason: ADMIN_REASON },
          });
        }

        // Plain kitchen use — batch-owned kitchen rows (skim/mix/yoghurt) are untouched.
        await tx.inventoryMovement.deleteMany({
          where: { date: range, type: "KITCHEN_USE", productId: e.productId, reference: null, ...plainReason },
        });
        if (e.kitchenUse > 0) {
          await tx.inventoryMovement.create({
            data: { date: when, type: "KITCHEN_USE", productId: e.productId, quantity: new Prisma.Decimal(e.kitchenUse), reason: ADMIN_REASON },
          });
        }
      }
    });

    for (const p of ["/inventory/reconciliation", "/inventory/production", "/inventory", "/inventory/skim-milk", "/inventory/yoghurt", "/"]) {
      revalidatePath(p);
    }
    return { ok: true, changed: clean.length };
  } catch (e) {
    console.error("[saveReconciliationDayEdit]", e);
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save changes." };
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Whole days in an inclusive "YYYY-MM-DD" range. */
function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.floor((b - a) / 86_400_000) + 1;
}

// ── The whole flow, farm to customer, for a date range ───────────────────────
//
// Farm → (calfs, kitchen, skim, yoghurt) → Net → accepted at packaging → sent to
// Retail → the riders' loads → delivered / wasted / brought back.
//
// Every figure here comes from the record that already governs it elsewhere, so
// this page and the stock guards can never disagree:
//   · farm production   PRODUCED, minus anything MADE from other stock (mix milk,
//                       skim/cream, yoghurt, standardised buffalo) — those carry a
//                       `reference` or one of BATCH_REASONS and are not what the
//                       animals gave. The old summary counted them and overstated
//                       production by exactly the processed output.
//   · internal use      CALF_USE, plain KITCHEN_USE, and the skim / yoghurt draws.
//   · to Retail         RetailDispatch.declaredItems; received = receivedItems once
//                       Retail has confirmed.
//   · the rider's load  RouteStopItem.plannedQty + RiderExtraItem.givenQty — the
//                       quantities that actually leave stock for a shift.
//   · delivered         DeliveryEntry, excluding returns, free replacements and
//                       complaint rows (the same rule the rider report uses).
//   · wasted            WASTAGE with a rider on it and no stage — what the rider
//                       app reports spilled on the road.
//   · brought back      RETURNED "End of shift return" + extras received back.
//                       The customer-return mirror rows are counted as customer
//                       returns instead, so the same milk is never counted twice.

export type FlowProduct = { id: string; name: string; unit: Unit; kind: "milk" | "egg" | "yoghurt" | "other" };

/** Every stage of the chain, per product id. */
export type StageTotals = {
  produced: Record<string, number>;
  madeHere: Record<string, number>;   // mix milk, skim + cream, yoghurt, standardised buffalo
  calfUse: Record<string, number>;
  kitchenUse: Record<string, number>;
  skimUse: Record<string, number>;
  yoghurtUse: Record<string, number>;
  dilutionIn: Record<string, number>;
  dilutionOut: Record<string, number>;
  acceptedAtPackaging: Record<string, number>;
  toRetail: Record<string, number>;
  retailReceived: Record<string, number>;
  retailShort: Record<string, number>;
  riderLoad: Record<string, number>;
  delivered: Record<string, number>;
  /**
   * Charged on a stop the rider marked skipped: billed, but it never left the van.
   * Held apart from `delivered` so it stays inside what is expected back.
   */
  riderChargedBack: Record<string, number>;
  riderWasted: Record<string, number>;
  customerReturns: Record<string, number>;
  returnedToFarm: Record<string, number>;
  /** What the office decided about the shifts' returns. */
  riderReturnStock: Record<string, number>;
  riderReturnWaste: Record<string, number>;
  /** What the retail centre had left, and what became of it. */
  retailLeftover: Record<string, number>;
  retailReturnStock: Record<string, number>;
  retailReturnWaste: Record<string, number>;
  /** Bought in over the counter (OTC purchases). An opening-stock seed is not a purchase. */
  purchased: Record<string, number>;
  /** Sold over the counter, out of inventory. */
  counterSale: Record<string, number>;
  /** Milk turned into mix milk (either pool). */
  mixUse: Record<string, number>;
  /** Milk taken off a load at packaging for mix / standardising, before acceptance. */
  packagingTransformUse: Record<string, number>;
  /** Declared on the farm's loads whose acceptance falls in the range. */
  farmDeclared: Record<string, number>;
  /** Declared on loads the farm sent in the range that were never accepted. */
  farmPending: Record<string, number>;
  /** Written off at the farm, before anything was sent (stage "Production", or none). */
  farmWaste: Record<string, number>;
  /** Written off at packaging. */
  packWaste: Record<string, number>;
  /** Written off at Retail — short on arrival, or entered against Retail. */
  retailWaste: Record<string, number>;
  /** Any other stage (the office's "Riders" or "Yoghurt" entries, or a stage added later). */
  otherWaste: Record<string, number>;
  /**
   * Taken off the sheet at loading: the rider accepted less than planned. Not
   * wastage — the milk is still at the retail centre — and not counted anywhere
   * as a loss; shown so a round's "took" can be read against its sheet.
   */
  loadShort: Record<string, number>;
};

/** A wastage reason actually recorded, and the litres of milk put down to it. */
export type WasteReason = { reason: string; qty: number };

export type RiderFlow = {
  riderId: string;
  riderName: string;
  milk: { got: number; delivered: number; chargedBack: number; wasted: number; customerReturns: number; expected: number; returned: number; missing: number };
  eggs: { got: number; delivered: number; chargedBack: number; wasted: number; customerReturns: number; expected: number; returned: number; missing: number };
};

export type ReconciliationSummary = {
  from: string;
  to: string;
  days: number;
  products: FlowProduct[];
  stages: StageTotals;
  /** Milk litres, added up across the milk products. */
  milk: {
    produced: number; calfUse: number; kitchenUse: number; skimUse: number; yoghurtUse: number;
    internalUse: number; net: number;
    acceptedAtPackaging: number; toRetail: number; retailReceived: number; retailShort: number;
    /** Written off before anything left for Retail: production, packaging, waste entry. */
    farmWasted: number;
    riderLoad: number; delivered: number; wasted: number; customerReturns: number;
    expectedReturn: number; returned: number; missing: number;
  };
  /** The Summary tab's flow, farm to customer, in litres of milk. */
  flow: MilkFlow;
  /** What each bucket of wastage was put down to, largest first. */
  wasteReasons: Record<WasteBucket, WasteReason[]>;
  eggs: {
    collected: number; toRetail: number; riderLoad: number; delivered: number; wasted: number;
    customerReturns: number; expectedReturn: number; returned: number; missing: number;
  };
  yoghurt: { made: number; milkUsed: number; toRetail: number; delivered: number };
  riders: RiderFlow[];
  /** What the rider app itself confirmed receiving, when it writes those rows at all. */
  handedOverByApp: number;
  dbReady: boolean;
  error?: string;
};

const EMPTY_STAGES = (): StageTotals => ({
  produced: {}, madeHere: {}, calfUse: {}, kitchenUse: {}, skimUse: {}, yoghurtUse: {},
  dilutionIn: {}, dilutionOut: {}, acceptedAtPackaging: {}, toRetail: {}, retailReceived: {},
  retailShort: {}, riderLoad: {}, delivered: {}, riderChargedBack: {}, riderWasted: {}, customerReturns: {}, returnedToFarm: {},
  riderReturnStock: {}, riderReturnWaste: {}, retailLeftover: {}, retailReturnStock: {}, retailReturnWaste: {},
  purchased: {}, counterSale: {}, mixUse: {}, packagingTransformUse: {}, farmDeclared: {}, farmPending: {},
  farmWaste: {}, packWaste: {}, retailWaste: {}, otherWaste: {}, loadShort: {},
});

const WASTE_BUCKETS: WasteBucket[] = ["farm", "packaging", "retail", "road", "riderReturn", "other"];

const EMPTY_REASONS = (): Record<WasteBucket, WasteReason[]> =>
  Object.fromEntries(WASTE_BUCKETS.map((b) => [b, []])) as unknown as Record<WasteBucket, WasteReason[]>;

const EMPTY_FLOW = (): MilkFlow =>
  milkFlow({
    produced: 0, purchased: 0, calfUse: 0, kitchenUse: 0, skimUse: 0, yoghurtUse: 0, counterSale: 0,
    farmAccepted: 0, packagingTransformUse: 0, farmDeclaredAccepted: 0, farmPending: 0,
    toRetail: 0, riderLoad: 0, delivered: 0, chargedBack: 0, customerReturns: 0, returned: 0,
    waste: { farm: 0, packaging: 0, retail: 0, road: 0, riderReturn: 0, other: 0 },
  });

/**
 * Where a write-off happened, from what the row itself says.
 *
 *   road         the rider app's own report: a rider on the row, no stage
 *   riderReturn  the office's split of a rider's return
 *   retail       short on arrival at Retail, the office's Retail entries, and
 *                the spoiled part of Retail's leftover
 *   packaging    written off at packaging
 *   farm         the farm's own loss, before anything was sent (isFarmWastage)
 *   other        any other stage — named, so it is never silently absorbed
 */
function wasteBucket(stage: string | null, riderId: string | null): WasteBucket {
  if (riderId && !stage) return "road";
  if (stage === RIDER_RETURN_STAGE) return "riderReturn";
  if (stage === "Retail" || stage === RETAIL_RETURN_STAGE) return "retail";
  if (stage === "Packaging") return "packaging";
  if (isFarmWastage(stage)) return "farm";
  return "other";
}

const emptyLeg = () => ({ got: 0, delivered: 0, chargedBack: 0, wasted: 0, customerReturns: 0, expected: 0, returned: 0, missing: 0 });

export async function getReconciliationSummary(from: string, to: string): Promise<ReconciliationSummary> {
  await requireRole(["ADMIN", "MANAGER", "DOCTOR"]);
  const blank: ReconciliationSummary = {
    from, to, days: 0, products: [], stages: EMPTY_STAGES(),
    milk: {
      produced: 0, calfUse: 0, kitchenUse: 0, skimUse: 0, yoghurtUse: 0, internalUse: 0, net: 0,
      acceptedAtPackaging: 0, toRetail: 0, retailReceived: 0, retailShort: 0, farmWasted: 0,
      riderLoad: 0, delivered: 0, wasted: 0, customerReturns: 0, expectedReturn: 0, returned: 0, missing: 0,
    },
    flow: EMPTY_FLOW(),
    wasteReasons: EMPTY_REASONS(),
    eggs: { collected: 0, toRetail: 0, riderLoad: 0, delivered: 0, wasted: 0, customerReturns: 0, expectedReturn: 0, returned: 0, missing: 0 },
    yoghurt: { made: 0, milkUsed: 0, toRetail: 0, delivered: 0 },
    riders: [], handedOverByApp: 0, dbReady: true,
  };
  if (!isValidDate(from) || !isValidDate(to)) return { ...blank, error: "Choose a valid date range." };
  const [lo, hi] = from <= to ? [from, to] : [to, from];

  try {
    const range = dateRangeFromToPKT(lo, hi);
    const [
      movementsInRange, productRows, retailDispatches, routeItems, extras, deliveries, shifts,
      riderReturnLines, retailReturnLines, skipRows, farmLoads, riderRows,
    ] = await Promise.all([
      db.inventoryMovement.findMany({
        where: {
          date: range,
          type: {
            in: [
              "PRODUCED", "CALF_USE", "KITCHEN_USE", "DISPATCHED", "ARRIVED", "RETURNED", "WASTAGE", "HANDED_OVER",
              "COUNTER_PURCHASE", "COUNTER_SALE",
            ],
          },
        },
        select: {
          date: true, type: true, productId: true, quantity: true, reason: true, reference: true, stage: true,
          riderId: true, rider: { select: { user: { select: { name: true } } } },
        },
      }),
      db.product.findMany({
        where: { active: true, retailOnly: false },
        select: { id: true, name: true, unit: true },
        orderBy: { name: "asc" },
      }),
      // Every load, so a confirmation that lands after the range still matches its
      // ARRIVED rows; the declared/received totals below only count loads IN range.
      db.retailDispatch.findMany({ select: { id: true, date: true, status: true, declaredItems: true, receivedItems: true } }),
      db.routeStopItem.findMany({
        where: { routeStop: { route: { date: range } } },
        select: {
          productId: true, plannedQty: true,
          routeStop: { select: { route: { select: { id: true, date: true, shiftId: true } } } },
        },
      }),
      db.riderExtraItem.findMany({
        where: { date: range },
        select: { productId: true, givenQty: true, returnedQty: true, riderId: true, shiftId: true },
      }),
      db.deliveryEntry.findMany({
        where: { date: range },
        select: {
          date: true, productId: true, quantity: true, riderId: true, isReturn: true, isReplacement: true,
          complaintId: true, customerId: true, customer: { select: { shiftId: true } },
        },
      }),
      db.shift.findMany({ select: { id: true, riderId: true, rider: { select: { user: { select: { name: true } } } } } }),
      // How the office split what came back.
      db.riderReturnLine.findMany({
        where: { review: { date: range } },
        select: { productId: true, stockQty: true, wasteQty: true },
      }),
      db.retailReturnLine.findMany({
        where: { review: { date: range } },
        select: { productId: true, leftoverQty: true, stockQty: true, wasteQty: true },
      }),
      // Stops the rider marked skipped. A skipped stop can still carry a charge —
      // "customer unresponsive" and "customer refused delivery" both bill the
      // customer — and that milk never left the van. The same test the Rider Item
      // Returns page and the rider report use: only a stop actually marked skipped,
      // never one still sitting PENDING, which is a stop nobody has reported on yet.
      db.routeStop.findMany({
        where: { route: { date: range }, status: { contains: "SKIP", mode: "insensitive" } },
        select: { customerId: true, route: { select: { date: true, shiftId: true } } },
      }),
      // The farm's loads to packaging: those accepted in these dates (their
      // declared quantities are matched to the accepted rows below), and those
      // sent in these dates and never accepted.
      db.farmDispatch.findMany({
        where: { OR: [{ acceptedAt: range }, { date: range }] },
        select: { id: true, date: true, status: true, acceptedAt: true, declaredItems: true },
      }),
      // Every rider's name, not only those holding a shift today: a rider who
      // covered someone else's round, or has since lost his shift, still did the
      // work in these dates and must be named for it.
      db.rider.findMany({ select: { id: true, user: { select: { name: true } } } }),
    ]);

    // A rider's return or spillage belongs to the ROUND it came off, not to the
    // day he pressed the button — the same rule as the Rider Item Returns page.
    // Rows dated outside these dates but stamped with a round inside them are
    // brought in; rows dated inside but stamped with a round outside are left
    // out. (A 6 October round closed on the 10th put 15 L on the wrong day.)
    const moveSelect = {
      date: true, type: true, productId: true, quantity: true, reason: true, reference: true, stage: true,
      riderId: true, rider: { select: { user: { select: { name: true } } } },
    } as const;
    const routesIn = await db.route.findMany({ where: { date: range }, select: { id: true, date: true } });
    const routeDay = new Map(routesIn.map((r) => [r.id, toDateStrPKT(r.date)] as const));
    const isRiderRow = (m: { type: string; riderId: string | null; reason: string | null; stage: string | null }) =>
      (m.type === "RETURNED" && m.reason === END_OF_SHIFT_RETURN) || (m.type === "WASTAGE" && !!m.riderId && !m.stage);
    const late = routesIn.length
      ? await db.inventoryMovement.findMany({
          where: { type: { in: ["RETURNED", "WASTAGE"] }, reference: { in: routesIn.map((r) => r.id) }, NOT: { date: range } },
          select: moveSelect,
        })
      : [];
    const strayRefs = [...new Set(
      movementsInRange.filter((m) => isRiderRow(m) && m.reference && !routeDay.has(m.reference)).map((m) => m.reference!),
    )];
    if (strayRefs.length) {
      for (const r of await db.route.findMany({ where: { id: { in: strayRefs } }, select: { id: true, date: true } })) routeDay.set(r.id, toDateStrPKT(r.date));
    }
    const onItsRoundsDay = (m: (typeof movementsInRange)[number]) => {
      if (!isRiderRow(m) || !m.reference) return true;
      const day = routeDay.get(m.reference);
      return !day || (day >= lo && day <= hi);
    };
    const movements = [...movementsInRange.filter(onItsRoundsDay), ...late.filter(isRiderRow)];

    const products: FlowProduct[] = productRows
      .filter((p) => !isGheeName(p.name))
      .map((p) => ({
        id: p.id,
        name: p.name,
        unit: p.unit as Unit,
        kind: isEggName(p.name) ? "egg" : isYoghurtName(p.name) ? "yoghurt" : p.unit === "LITER" ? "milk" : "other",
      }));
    const kindOf = new Map(products.map((p) => [p.id, p.kind] as const));
    const known = (pid: string) => kindOf.has(pid);

    const stages = EMPTY_STAGES();
    const add = (m: Record<string, number>, pid: string, q: number) => { m[pid] = (m[pid] ?? 0) + q; };

    // Riders, by shift and by the row's own riderId.
    const shiftRider = new Map(shifts.map((s) => [s.id, s.riderId] as const));
    const riderName = new Map<string, string>();
    for (const r of riderRows) if (r.user?.name) riderName.set(r.id, r.user.name);
    for (const s of shifts) if (s.riderId && !riderName.has(s.riderId)) riderName.set(s.riderId, s.rider?.user?.name ?? "Rider");
    const legs = new Map<string, RiderFlow>();
    const leg = (riderId: string | null | undefined): RiderFlow | null => {
      if (!riderId) return null;
      if (!legs.has(riderId)) {
        legs.set(riderId, { riderId, riderName: riderName.get(riderId) ?? "Rider", milk: emptyLeg(), eggs: emptyLeg() });
      }
      return legs.get(riderId)!;
    };
    const side = (r: RiderFlow, pid: string) => (kindOf.get(pid) === "egg" ? r.eggs : kindOf.get(pid) === "milk" ? r.milk : null);

    let handedOverByApp = 0;
    const reasonTotals = Object.fromEntries(
      WASTE_BUCKETS.map((b) => [b, new Map<string, number>()]),
    ) as unknown as Record<WasteBucket, Map<string, number>>;

    for (const m of movements) {
      const pid = m.productId;
      if (!known(pid)) continue;
      const qty = Number(m.quantity);
      switch (m.type) {
        case "PRODUCED":
          // Only what the animals gave counts as farm production. Milk stirred into
          // the buffalo, mix milk, skim, cream and yoghurt are all made FROM stock
          // that was produced already — they carry a reference or a batch reason.
          if (m.reason === DILUTION_REASON) add(stages.dilutionIn, pid, qty);
          else if (m.reference || (BATCH_REASONS as readonly string[]).includes(m.reason ?? "")) add(stages.madeHere, pid, qty);
          else add(stages.produced, pid, qty);
          break;
        case "CALF_USE":
          add(stages.calfUse, pid, qty);
          break;
        case "KITCHEN_USE":
          if (m.reason === "Yoghurt processing") add(stages.yoghurtUse, pid, qty);
          else if (m.reason === "Skim milk processing") add(stages.skimUse, pid, qty);
          else if ((DILUTION_REASONS as readonly string[]).includes(m.reason ?? "")) add(stages.dilutionOut, pid, qty);
          // Mix milk is made at packaging out of stock that already left the farm,
          // so it is not farm kitchen use.
          else if (MIX_REASONS.includes(m.reason as (typeof MIX_REASONS)[number])) add(stages.mixUse, pid, qty);
          else add(stages.kitchenUse, pid, qty);
          // Taken off a load at packaging before it was accepted (the "(storage)"
          // variants come out of inventory instead). It reached inventory as the
          // mix or buffalo it was made into, so it is part of what was received.
          if (m.reason === MIX_REASON_PACKAGING || m.reason === DILUTION_REASON) add(stages.packagingTransformUse, pid, qty);
          break;
        case "COUNTER_PURCHASE":
          // A real purchase is written by the OTC purchase form as "OTC Purchase
          // <invoice>". Anything else (an opening-stock seed after a stock count)
          // is stock being set, not milk bought in.
          if ((m.reason ?? "").startsWith("OTC Purchase")) add(stages.purchased, pid, qty);
          break;
        case "COUNTER_SALE":
          add(stages.counterSale, pid, qty);
          break;
        case "ARRIVED":
          if (m.reason === ACCEPTED_AT_PACKAGING || m.reason === EGGS_COLLECTED) add(stages.acceptedAtPackaging, pid, qty);
          break;
        case "WASTAGE":
          // Every write-off, filed where it happened: the rider app's own road
          // wastage (a rider on the row, no stage), what the office decided about
          // a return, and everything else — production losses and the Waste entry
          // page — so the day's losses are all on the page somewhere.
          // Accepting less than the sheet is not wastage: the milk stayed at the
          // retail centre, and it is already in Retail's leftover (sent − taken).
          // Counting it here charged it twice. See LOAD_SHORT_REASONS.
          if (m.riderId && !m.stage && isLoadShortfall(m.reason)) {
            add(stages.loadShort, pid, qty);
            break;
          }
          {
            // Every row lands in exactly one bucket, so the buckets always add up
            // to every litre written off — nothing dropped, nothing counted twice.
            const bucket = wasteBucket(m.stage, m.riderId);
            if (m.stage === RIDER_RETURN_STAGE) add(stages.riderReturnWaste, pid, qty);
            else if (m.stage === RETAIL_RETURN_STAGE) add(stages.retailReturnWaste, pid, qty);
            else if (bucket === "farm") add(stages.farmWaste, pid, qty);
            else if (bucket === "packaging") add(stages.packWaste, pid, qty);
            else if (bucket === "retail") add(stages.retailWaste, pid, qty);
            else if (bucket === "other") add(stages.otherWaste, pid, qty);
            if (kindOf.get(pid) === "milk") {
              const why = (m.reason ?? "").trim() || "No reason given";
              const key = bucket === "other" && m.stage ? `${m.stage}: ${why}` : why;
              reasonTotals[bucket].set(key, (reasonTotals[bucket].get(key) ?? 0) + qty);
            }
          }
          if (m.riderId && !m.stage) {
            add(stages.riderWasted, pid, qty);
            const r = leg(m.riderId);
            if (r) {
              if (!riderName.has(m.riderId) && m.rider?.user?.name) r.riderName = m.rider.user.name;
              const s = side(r, pid);
              if (s) s.wasted += qty;
            }
          }
          break;
        case "RETURNED":
          // What the rider physically handed back at the end of the shift. The
          // trigger's "Rider return" rows mirror a customer's return and are
          // counted from the delivery entries instead, so they are skipped here.
          if (m.reason === END_OF_SHIFT_RETURN) {
            add(stages.returnedToFarm, pid, qty);
            const r = leg(m.riderId);
            if (r) {
              if (!riderName.has(m.riderId!) && m.rider?.user?.name) r.riderName = m.rider.user.name;
              const s = side(r, pid);
              if (s) s.returned += qty;
            }
          }
          break;
        case "HANDED_OVER":
          handedOverByApp += qty;
          break;
        case "DISPATCHED":
          break; // counted from the Retail loads below, which carry what was declared
      }
    }

    // What the farm's loads declared, against what packaging accepted from them.
    //
    // Matched row by row: an accepted row names its load in `reference`, so the
    // declared side is that same load's quantity for that same product — counted
    // once, however many rows the acceptance wrote. An accepted row with no load
    // behind it has nothing to compare with, so it is taken as declared in full.
    const loadById = new Map(farmLoads.map((l) => [l.id, l] as const));
    const declaredSeen = new Set<string>();
    for (const m of movements) {
      if (m.type !== "ARRIVED" || m.reason !== ACCEPTED_AT_PACKAGING || !known(m.productId)) continue;
      const load = m.reference ? loadById.get(m.reference) : undefined;
      if (!load) { add(stages.farmDeclared, m.productId, Number(m.quantity)); continue; }
      const key = `${load.id}:${m.productId}`;
      if (declaredSeen.has(key)) continue;
      declaredSeen.add(key);
      for (const it of (load.declaredItems as DispatchItem[] | null) ?? []) {
        if (it.productId === m.productId) add(stages.farmDeclared, it.productId, Number(it.quantity));
      }
    }
    // Sent in these dates and still not accepted by packaging.
    for (const l of farmLoads) {
      if (l.acceptedAt || l.status !== "PENDING") continue;
      const day = toDateStrPKT(l.date);
      if (day < lo || day > hi) continue;
      for (const it of (l.declaredItems as DispatchItem[] | null) ?? []) {
        if (known(it.productId)) add(stages.farmPending, it.productId, Number(it.quantity));
      }
    }

    // What went to Retail, and what Retail confirmed receiving.
    for (const rd of retailDispatches) {
      if (toDateStrPKT(rd.date) < lo || toDateStrPKT(rd.date) > hi) continue;
      const declared = (rd.declaredItems as DispatchItem[] | null) ?? [];
      const received = (rd.receivedItems as DispatchItem[] | null) ?? null;
      for (const it of declared) {
        if (!known(it.productId)) continue;
        add(stages.toRetail, it.productId, Number(it.quantity));
        if (received) {
          const got = Number(received.find((r) => r.productId === it.productId)?.quantity ?? 0);
          add(stages.retailReceived, it.productId, got);
          const short = Number(it.quantity) - got;
          if (short > 0.0005) add(stages.retailShort, it.productId, short);
        }
      }
    }

    // ── What each rider actually took ──────────────────────────────────────
    //
    // The app's confirmed load is the fact; the round's quantities are the office's
    // plan, and riders routinely take more. Reading the plan understated what went
    // out — 794 L against a confirmed 841 L on 30 September — which then understated
    // what was expected back and made riders look like they had returned a surplus.
    // The same rule the Rider Item Returns page applies, so the two pages agree:
    // a route's confirmed load replaces that route's plan, and the plan is the
    // fallback for a route nobody confirmed.
    //
    // Per ROUTE, not per rider-day. The app stamps every confirmation with the
    // route it was loaded for (`reference`), and a route is not always loaded by
    // the rider whose shift it is: on 1 October Kamran Khan and Wajid Khan loaded
    // Ahsan's two routes. Keyed by rider-day, Ahsan had confirmed nothing, so his
    // two plans (420 L) were added on top of the loads the others had already
    // confirmed for those same routes — the same milk twice, which then read as
    // 427 L missing on the rounds.
    const confirmedRoutes = new Set<string>();
    // A confirmation with no route on it (none on record; kept for safety) still
    // covers that rider's day, as before.
    const confirmedRiderDays = new Set<string>();
    for (const m of movements) {
      if (m.type !== "HANDED_OVER") continue;
      if (m.reference) confirmedRoutes.add(m.reference);
      else if (m.riderId) confirmedRiderDays.add(`${toDateStrPKT(m.date)}:${m.riderId}`);
    }
    for (const m of movements) {
      if (m.type !== "HANDED_OVER" || !known(m.productId)) continue;
      const qty = Number(m.quantity);
      add(stages.riderLoad, m.productId, qty);
      const r = leg(m.riderId ?? null);
      const s = r && side(r, m.productId);
      if (s) s.got += qty;
    }
    for (const it of routeItems) {
      if (!known(it.productId)) continue;
      const rid = shiftRider.get(it.routeStop.route.shiftId) ?? null;
      const day = toDateStrPKT(it.routeStop.route.date);
      if (confirmedRoutes.has(it.routeStop.route.id)) continue;
      if (rid && confirmedRiderDays.has(`${day}:${rid}`)) continue;
      const qty = Number(it.plannedQty);
      add(stages.riderLoad, it.productId, qty);
      const r = leg(rid);
      const s = r && side(r, it.productId);
      if (s) s.got += qty;
    }
    for (const e of extras) {
      if (!known(e.productId)) continue;
      const given = Number(e.givenQty);
      const back = Number(e.returnedQty);
      add(stages.riderLoad, e.productId, given);
      if (back > 0) add(stages.returnedToFarm, e.productId, back);
      const r = leg(e.riderId ?? shiftRider.get(e.shiftId) ?? null);
      const s = r && side(r, e.productId);
      if (s) { s.got += given; s.returned += back; }
    }

    // What reached the customers. Complaint rows and free replacements are not a
    // sale and not a return — the same rule the rider report and the sale summary use.
    //
    // Milk charged on a stop the rider marked skipped is NOT one of them. The bill
    // stands, but nobody was in and the milk came back on the van, so counting it as
    // delivered overstated what reached customers and understated what was owed
    // back. The Rider Item Returns page has always kept these apart.
    const skippedStops = new Set(
      skipRows.map((x) => `${toDateStrPKT(x.route.date)}:${x.route.shiftId}:${x.customerId}`),
    );
    for (const d of deliveries) {
      if (!known(d.productId) || d.complaintId || d.isReplacement) continue;
      const qty = Number(d.quantity);
      const rid = d.riderId ?? shiftRider.get(d.customer?.shiftId ?? "") ?? null;
      const r = leg(rid);
      const s = r && side(r, d.productId);
      if (d.isReturn) {
        add(stages.customerReturns, d.productId, qty);
        if (s) s.customerReturns += qty;
        continue;
      }
      const sid = d.customer?.shiftId;
      const skipped = !!sid && skippedStops.has(`${toDateStrPKT(d.date)}:${sid}:${d.customerId}`);
      if (skipped) {
        // Left out of delivered, so it stays inside what is expected back — exactly
        // where the van actually has it.
        add(stages.riderChargedBack, d.productId, qty);
        if (s) s.chargedBack += qty;
        continue;
      }
      add(stages.delivered, d.productId, qty);
      if (s) s.delivered += qty;
    }
    // Delivered free samples reached people too, though no customer was billed.
    for (const x of await sampleDeliveries(range)) {
      if (!known(x.productId)) continue;
      add(stages.delivered, x.productId, x.qty);
      const r = leg(shiftRider.get(x.shiftId) ?? null);
      const s = r && side(r, x.productId);
      if (s) s.delivered += x.qty;
    }

    // What the office decided about the returns.
    for (const l of riderReturnLines) {
      if (!known(l.productId)) continue;
      add(stages.riderReturnStock, l.productId, Number(l.stockQty));
    }
    for (const l of retailReturnLines) {
      if (!known(l.productId)) continue;
      add(stages.retailLeftover, l.productId, Number(l.leftoverQty));
      add(stages.retailReturnStock, l.productId, Number(l.stockQty));
    }

    // Per rider: what should have come back, and what is unaccounted for.
    for (const r of legs.values()) {
      for (const s of [r.milk, r.eggs]) {
        s.expected = round3(s.got - s.delivered + s.customerReturns);
        // Less what the rider HIMSELF reported wasting on the road. He accounts for
        // his load two ways — what he hands back and what he says he lost — and only
        // the first was being counted, so an honest rider read short by exactly the
        // amount he had just declared. Same correction as the Rider Item Returns
        // board, so the two pages cannot disagree about one rider's day.
        s.missing = round3(s.expected - s.returned - s.wasted);
        s.got = round3(s.got); s.delivered = round3(s.delivered);
        s.wasted = round3(s.wasted); s.returned = round3(s.returned);
        s.customerReturns = round3(s.customerReturns);
      }
    }

    const ids = (kind: FlowProduct["kind"]) => products.filter((p) => p.kind === kind).map((p) => p.id);
    const sum = (m: Record<string, number>, list: string[]) => round3(list.reduce((t, id) => t + (m[id] ?? 0), 0));
    const milkIds = ids("milk");
    const eggIds = ids("egg");
    const yogIds = ids("yoghurt");

    const produced = sum(stages.produced, milkIds);
    const calfUse = sum(stages.calfUse, milkIds);
    const kitchenUse = sum(stages.kitchenUse, milkIds);
    const skimUse = sum(stages.skimUse, milkIds);
    const yoghurtUse = sum(stages.yoghurtUse, milkIds);
    // The farm's own use. Yoghurt is NOT in here: the yoghurt form draws its milk
    // from inventory (it is capped at what is in storage), so that milk reached
    // packaging first and is shown there, after packing.
    const internalUse = round3(calfUse + kitchenUse + skimUse);
    const riderLoad = sum(stages.riderLoad, milkIds);
    const delivered = sum(stages.delivered, milkIds);
    const customerReturns = sum(stages.customerReturns, milkIds);
    const returned = sum(stages.returnedToFarm, milkIds);
    const expectedReturn = round3(riderLoad - delivered + customerReturns);

    const roadWaste = sum(stages.riderWasted, milkIds);
    const flow = milkFlow({
      produced, purchased: sum(stages.purchased, milkIds),
      calfUse, kitchenUse, skimUse, yoghurtUse,
      counterSale: sum(stages.counterSale, milkIds),
      farmAccepted: sum(stages.acceptedAtPackaging, milkIds),
      packagingTransformUse: sum(stages.packagingTransformUse, milkIds),
      farmDeclaredAccepted: sum(stages.farmDeclared, milkIds),
      farmPending: sum(stages.farmPending, milkIds),
      toRetail: sum(stages.toRetail, milkIds),
      riderLoad, delivered,
      chargedBack: sum(stages.riderChargedBack, milkIds),
      customerReturns, returned,
      waste: {
        farm: sum(stages.farmWaste, milkIds),
        packaging: sum(stages.packWaste, milkIds),
        retail: round3(sum(stages.retailWaste, milkIds) + sum(stages.retailReturnWaste, milkIds)),
        road: roadWaste,
        riderReturn: sum(stages.riderReturnWaste, milkIds),
        other: sum(stages.otherWaste, milkIds),
      },
    });
    const wasteReasons = EMPTY_REASONS();
    for (const b of WASTE_BUCKETS) {
      wasteReasons[b] = [...reasonTotals[b].entries()]
        .map(([reason, qty]) => ({ reason, qty: round3(qty) }))
        .filter((r) => r.qty > 0.0005)
        .sort((a, b2) => b2.qty - a.qty || a.reason.localeCompare(b2.reason));
    }

    const eLoad = sum(stages.riderLoad, eggIds);
    const eDelivered = sum(stages.delivered, eggIds);
    const eCustomerReturns = sum(stages.customerReturns, eggIds);
    const eReturned = sum(stages.returnedToFarm, eggIds);
    const eExpected = round3(eLoad - eDelivered + eCustomerReturns);

    return {
      from: lo,
      to: hi,
      days: daysBetween(lo, hi),
      products,
      stages,
      milk: {
        produced, calfUse, kitchenUse, skimUse, yoghurtUse, internalUse,
        net: round3(produced - internalUse),
        acceptedAtPackaging: sum(stages.acceptedAtPackaging, milkIds),
        // Everything written off UP TO the retail point: the farm's own losses and
        // what went during packaging. Retail's write-offs (a load short on arrival)
        // happen at Retail, after the point this card stands at — they used to be
        // counted in here, which is how 539 L of milk written off at Retail on 5 October
        // read as farm wastage. The riders' road wastage is `wasted` below.
        farmWasted: round3(flow.waste.farm + flow.waste.packaging),
        toRetail: sum(stages.toRetail, milkIds),
        retailReceived: sum(stages.retailReceived, milkIds),
        retailShort: sum(stages.retailShort, milkIds),
        riderLoad, delivered, wasted: sum(stages.riderWasted, milkIds), customerReturns,
        expectedReturn, returned, missing: round3(expectedReturn - returned - sum(stages.riderWasted, milkIds)),
      },
      flow,
      wasteReasons,
      eggs: {
        collected: sum(stages.acceptedAtPackaging, eggIds),
        toRetail: sum(stages.toRetail, eggIds),
        riderLoad: eLoad, delivered: eDelivered, wasted: sum(stages.riderWasted, eggIds),
        customerReturns: eCustomerReturns, expectedReturn: eExpected, returned: eReturned,
        missing: round3(eExpected - eReturned - sum(stages.riderWasted, eggIds)),
      },
      yoghurt: {
        made: sum(stages.madeHere, yogIds),
        milkUsed: yoghurtUse,
        toRetail: sum(stages.toRetail, yogIds),
        delivered: sum(stages.delivered, yogIds),
      },
      riders: [...legs.values()].sort((a, b) => a.riderName.localeCompare(b.riderName)),
      handedOverByApp: round3(handedOverByApp),
      dbReady: true,
    };
  } catch (e) {
    console.error("[getReconciliationSummary]", e);
    return { ...blank, dbReady: false, error: "Could not load the reconciliation." };
  }
}

export type MilkInventorySnapshot = {
  /** Milk in inventory right now, all milk products added up — the Inventory page's "In storage". */
  litres: number;
  /** Sent to Retail today and not yet loaded or handed back — the Inventory page's "In retail". */
  retailLitres: number;
  perProduct: { name: string; litres: number }[];
  asOf: string; // ISO
  ok: boolean;
};

/**
 * What is in stock right now, read by the same formula as the Inventory page and
 * every stock guard (getStockByProduct), so the three can never disagree.
 *
 * Deliberately not tied to the date range: it is a reading of the shelf today,
 * not a movement over the dates on screen.
 */
export async function getCurrentMilkInventory(): Promise<MilkInventorySnapshot> {
  await requireRole(["ADMIN", "MANAGER", "DOCTOR"]);
  const asOf = new Date().toISOString();
  try {
    const [stock, productRows] = await Promise.all([
      getStockByProduct(),
      db.product.findMany({
        where: { active: true, retailOnly: false, unit: "LITER" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);
    // The same products the flow adds up as milk (see `kind` in getReconciliationSummary).
    const milk = productRows.filter((p) => !isEggName(p.name) && !isYoghurtName(p.name) && !isGheeName(p.name));
    const perProduct = milk.map((p) => ({ name: p.name, litres: round3(stock.inventory.get(p.id) ?? 0) }));
    return {
      litres: round3(perProduct.reduce((t, p) => t + p.litres, 0)),
      // Retail can read below zero when a round was set before the stock was sent;
      // the Inventory page shows that as 0, and so does this.
      retailLitres: round3(milk.reduce((t, p) => t + Math.max(0, stock.retail.get(p.id) ?? 0), 0)),
      perProduct,
      asOf,
      ok: true,
    };
  } catch (e) {
    console.error("[getCurrentMilkInventory]", e);
    return { litres: 0, retailLitres: 0, perProduct: [], asOf, ok: false };
  }
}
