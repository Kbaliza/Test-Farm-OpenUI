"use server";

import { SENT_TO_RETAIL } from "@/lib/packaging-stock";
import { requireRole } from "@/lib/auth";
import type { Unit } from "@/lib/units";
import { DASHBOARD_ROLES } from "@/lib/access";

import { db } from "@/lib/db";
import { getDateRangePKT, dateStrRangePKT, dateRangeFromToPKT } from "@/lib/pkt";
import { onHandFromComponents, getStockComponents, retailFromComponents, heldCommitmentWhere, confirmedLoadsByRoute } from "@/lib/inventory-onhand";
import { isRoadWastage, routeLoads } from "@/lib/rider-stock";
import { MIX_REASONS, MIX_REASON_STORAGE } from "@/lib/mix-milk-source";
import { DILUTION_REASON, DILUTION_REASONS } from "@/lib/buffalo-dilution";
import { loadLoss } from "@/lib/mix-allocation";
import { packagingAttribution, EMPTY_SHARE, type LoadShare } from "@/lib/packaging-attribution";

export type Period = "today" | "week" | "month";

export type ProductSummary = {
  productId: string;
  productName: string;
  unit: Unit;
  produced: number;
  kitchenUse: number;
  skimUse: number;
  yoghurtUse: number;
  calfUse: number;
  dispatched: number;
  arrived: number;
  handedOver: number;
  delivered: number;
  returned: number;
  wastage: number;
  replacement: number;
  inStorage: number;
  /** In Retail today — sent from packaging, not yet given to a shift. Goes back to storage at day end. */
  inRetail: number;
  /** Sent to Retail today and not yet accepted there — off the store, not yet Retail's to load. */
  onTheWay: number;
  withRiders: number;
  deliveryRate: number;
  /** Dropped at retail marts on consignment in this period. */
  retailOut: number;
};

export type RiderSummary = {
  riderId: string;
  riderName: string;
  handedOver: number;
  delivered: number;
  returned: number;
  wastage: number;
  pendingOnVan: number;
};

/** A retail product on the storage screen. Counts of packs, never litres. */
export type RetailProductSummary = {
  productId: string;
  productName: string;
  unit: Unit;
  packSize: number | null;
  inStorage: number;
  atShops: number;
  costPrice: number | null;
  stockValue: number | null;
};

export type InventorySummaryData = {
  products: ProductSummary[];
  /**
   * Retail products, kept in their OWN array rather than appended to `products`.
   * That list is filtered retailOnly:false on purpose and feeds the milk totals,
   * the reports and the By Product grid — appending would leak pack counts into
   * every one of them.
   */
  retailProducts: RetailProductSummary[];
  riders: RiderSummary[];
  totals: {
    produced: number;
    kitchenUse: number;
    skimUse: number;
    yoghurtUse: number;
    calfUse: number;
    netDispatched: number;
    arrived: number;
    inStorage: number;
    inRetail: number;
    onTheWay: number;
    withRiders: number;
    combined: number;
    delivered: number;
    returned: number;
    wastage: number;
  };
  dbReady: boolean;
};

export async function getInventorySummary(
  period: Period = "today",
  selectedDate?: string,
  dateFrom?: string,
  dateTo?: string
): Promise<InventorySummaryData> {
  await requireRole(DASHBOARD_ROLES);
  try {
    const dateRange = dateFrom
      ? dateRangeFromToPKT(dateFrom, dateTo ?? dateFrom)
      : selectedDate
        ? dateStrRangePKT(selectedDate)
        : getDateRangePKT(period);

    // The all-time balance comes from the shared gathering step — this screen used
    // to re-query and re-sum all twelve terms itself. Only the genuinely
    // period-scoped queries live here now.
    const [stockComponents, movements, activeProducts, periodRouteStopItems, deliveryEntries, periodRetailOutRows, retailDispatchIds] = await Promise.all([
      getStockComponents(),
      db.inventoryMovement.findMany({
        where: { date: dateRange },
        select: {
          type: true,
          productId: true,
          quantity: true,
          riderId: true,
          reference: true,
          reason: true,
          stage: true,
          rider: { select: { user: { select: { name: true } } } },
        },
        orderBy: { date: "asc" },
      }),
      db.product.findMany({
        where: { active: true, retailOnly: false, NOT: { name: "Ghee" } },
        select: { id: true, name: true, unit: true },
        orderBy: { name: "asc" },
      }),
      // Period-scoped route planned quantities — shown as "Handed Over" in product cards
      db.routeStopItem.findMany({
        where: { routeStop: { route: { date: dateRange } } },
        select: { productId: true, plannedQty: true, routeStop: { select: { routeId: true } } },
      }),
      // Actual deliveries written by mobile app — isReturn=false entries are delivered, isReturn=true are returned
      db.deliveryEntry.findMany({
        where: { date: dateRange },
        select: { productId: true, quantity: true, riderId: true, isReturn: true, isReplacement: true },
      }),
      // Period-scoped, for the product card's "Out at retail" line.
      db.retailPlacementLine.findMany({
        where: { placement: { voidedAt: null, date: dateRange }, product: { retailOnly: false } },
        select: { productId: true, quantity: true },
      }),
      // Still needed for the period-scoped "Arrived" card: an ARRIVED movement
      // only counts when it references a real dispatch, and `reference` carries
      // no foreign key to check that against.
      db.retailDispatch.findMany({ select: { id: true } }).then((rs) => new Set(rs.map((r) => r.id))),
    ]);

    // What the rounds took: the rider's confirmed load where he confirmed one, the
    // sheet otherwise — the same rule as the stock formula and the returns page.
    const periodRoutePlannedMap = new Map<string, number>();
    const periodTaken = routeLoads(
      periodRouteStopItems.map((m) => ({ routeId: m.routeStop.routeId, productId: m.productId, plannedQty: Number(m.plannedQty) })),
      await confirmedLoadsByRoute([...new Set(periodRouteStopItems.map((m) => m.routeStop.routeId))]),
    );
    for (const t of periodTaken) periodRoutePlannedMap.set(t.productId, (periodRoutePlannedMap.get(t.productId) ?? 0) + t.qty);

    // Build delivered/returned maps from DeliveryEntry (written by mobile app)
    const deliveredByProduct = new Map<string, number>();
    const deliveredByRider = new Map<string, number>();
    for (const de of deliveryEntries) {
      if (de.isReplacement) continue;
      if (!de.isReturn) {
        deliveredByProduct.set(de.productId, (deliveredByProduct.get(de.productId) ?? 0) + Number(de.quantity));
        if (de.riderId)
          deliveredByRider.set(de.riderId, (deliveredByRider.get(de.riderId) ?? 0) + Number(de.quantity));
      }
    }

    const periodRetailOutMap = new Map<string, number>();
    for (const m of periodRetailOutRows)
      periodRetailOutMap.set(m.productId, (periodRetailOutMap.get(m.productId) ?? 0) + Number(m.quantity));

    const productMap = new Map<string, ProductSummary>();

    for (const ap of activeProducts) {
      productMap.set(ap.id, {
        productId: ap.id,
        productName: ap.name,
        unit: ap.unit,
        produced: 0,
        kitchenUse: 0,
        skimUse: 0,
        yoghurtUse: 0,
        calfUse: 0,
        dispatched: 0,
        arrived: 0,
        handedOver: 0,
        delivered: 0,
        returned: 0,
        wastage: 0,
        replacement: 0,
        inStorage: 0,
        inRetail: 0,
        onTheWay: 0,
        retailOut: 0,
        withRiders: 0,
        deliveryRate: 0,
      });
    }

    // Actual HANDED_OVER movement totals (mobile app load acceptance) and
    // rider-tagged wastage (broken/spilled while on route) — kept separate from
    // p.withRiders/p.wastage so the net "still with rider" calc below isn't
    // double-counting storage-stage wastage that was never on a van.
    const handedOverActualMap = new Map<string, number>();
    const riderWastageMap = new Map<string, number>();

    for (const m of movements) {
      const pid = m.productId;
      if (!productMap.has(pid)) continue;
      const p = productMap.get(pid)!;
      const qty = Number(m.quantity);

      switch (m.type) {
        case "PRODUCED":
          // Milk stirred into another product at packaging is not production —
          // the animals did not give it, it crossed over from the other milk.
          if (m.reason !== DILUTION_REASON) p.produced += qty;
          break;
        case "KITCHEN_USE":
          if (m.reason === "Skim milk processing") p.skimUse += qty;
          else if (m.reason === "Yoghurt processing") p.yoghurtUse += qty;
          // …and the other half of that transfer is not kitchen use either.
          else if ((DILUTION_REASONS as readonly string[]).includes(m.reason ?? "")) break;
          else if (!MIX_REASONS.includes(m.reason as (typeof MIX_REASONS)[number])) p.kitchenUse += qty;
          break;
        case "CALF_USE":
          p.calfUse += qty;
          break;
        case "DISPATCHED":
          p.dispatched += qty;
          break;
        case "ARRIVED":
          if (m.reference && retailDispatchIds.has(m.reference)) p.arrived += qty;
          break;
        case "HANDED_OVER":
          handedOverActualMap.set(pid, (handedOverActualMap.get(pid) ?? 0) + qty);
          break;
        case "RETURNED":
          p.returned += qty;
          break;
        case "WASTAGE":
          // Less accepted at loading than the sheet is not wastage (LOAD_SHORT_REASONS):
          // the milk never got on the van, so it is neither lost nor "with riders".
          if (m.riderId && !m.stage && !isRoadWastage(m.reason)) break;
          p.wastage += qty;
          if (m.riderId) riderWastageMap.set(pid, (riderWastageMap.get(pid) ?? 0) + qty);
          break;
        case "REPLACEMENT":
          p.replacement += qty;
          break;
      }
    }

    const products: ProductSummary[] = [];
    for (const p of productMap.values()) {
      // The same components the stock guards read, run through the same formula,
      // so this column and a refused sale can never disagree about a product.
      const c = stockComponents.inventory.get(p.productId);
      p.inStorage = c ? onHandFromComponents(c) : 0;
      const rc = stockComponents.retail.get(p.productId);
      p.inRetail = rc ? Math.max(0, Math.round(retailFromComponents(rc) * 1000) / 1000) : 0;
      p.onTheWay = rc ? Math.round((rc.onTheWay ?? 0) * 1000) / 1000 : 0;
      p.retailOut = periodRetailOutMap.get(p.productId) ?? 0;
      p.handedOver = periodRoutePlannedMap.get(p.productId) ?? 0;
      p.delivered = deliveredByProduct.get(p.productId) ?? 0;
      // Net stock still physically with riders: what was actually handed over,
      // minus what's since been delivered, returned, or wasted on the road.
      // Lands on 0 once every stop the rider took is accounted for.
      p.withRiders = Math.max(0,
        (handedOverActualMap.get(p.productId) ?? 0)
        - p.delivered
        - p.returned
        - (riderWastageMap.get(p.productId) ?? 0)
      );
      p.deliveryRate = p.handedOver > 0 ? (p.delivered / p.handedOver) * 100 : 0;
      products.push(p);
    }
    products.sort((a, b) => a.productName.localeCompare(b.productName));

    const riderMap = new Map<string, RiderSummary>();
    for (const m of movements) {
      if (!m.riderId || !m.rider) continue;
      if (!["HANDED_OVER", "RETURNED", "WASTAGE"].includes(m.type)) continue;

      const rid = m.riderId;
      if (!riderMap.has(rid)) {
        riderMap.set(rid, {
          riderId: rid,
          riderName: m.rider.user?.name ?? "Unknown",
          handedOver: 0,
          delivered: 0,
          returned: 0,
          wastage: 0,
          pendingOnVan: 0,
        });
      }
      const r = riderMap.get(rid)!;
      const qty = Number(m.quantity);
      switch (m.type) {
        case "HANDED_OVER":
          r.handedOver += qty;
          break;
        case "RETURNED":
          r.returned += qty;
          break;
        case "WASTAGE":
          r.wastage += qty;
          break;
      }
    }
    // Populate rider delivered from DeliveryEntry (mobile app writes actual deliveries there)
    for (const [riderId, qty] of deliveredByRider) {
      if (!riderMap.has(riderId)) continue;
      riderMap.get(riderId)!.delivered = qty;
    }

    // Retail products, gathered separately. Their stock is real now, so the
    // storage screen shows them — but in packs, in their own section, never
    // folded into the milk totals.
    const retailOnly = await db.product.findMany({
      where: { active: true, retailOnly: true },
      select: { id: true, name: true, unit: true, packSize: true, costPrice: true },
      orderBy: { name: "asc" },
    });
    const openAtShops = new Map<string, number>();
    if (retailOnly.length > 0) {
      const shopLines = await db.retailPlacementLine.findMany({
        where: { placement: { voidedAt: null }, product: { retailOnly: true } },
        select: { productId: true, quantity: true, soldQty: true, wastedQty: true },
      });
      for (const l of shopLines) {
        const open = Math.max(0, Number(l.quantity) - Number(l.soldQty) - Number(l.wastedQty));
        openAtShops.set(l.productId, (openAtShops.get(l.productId) ?? 0) + open);
      }
    }
    const retailProducts: RetailProductSummary[] = retailOnly.map((b) => {
      const c = stockComponents.inventory.get(b.id);
      const inStorage = c ? onHandFromComponents(c) : 0;
      const cost = b.costPrice == null ? null : Number(b.costPrice);
      return {
        productId: b.id,
        productName: b.name,
        unit: b.unit,
        packSize: b.packSize == null ? null : Number(b.packSize),
        inStorage,
        atShops: Math.round((openAtShops.get(b.id) ?? 0) * 1000) / 1000,
        costPrice: cost,
        stockValue: cost == null ? null : Math.round(inStorage * cost * 100) / 100,
      };
    });

    const riders: RiderSummary[] = [];
    for (const r of riderMap.values()) {
      r.pendingOnVan = Math.max(
        0,
        r.handedOver - r.delivered - r.returned - r.wastage
      );
      riders.push(r);
    }

    const sumField = (arr: ProductSummary[], key: keyof ProductSummary) =>
      arr.reduce((acc, p) => acc + (p[key] as number), 0);

    const MILK_KWS = ["buffalo", "cow", "mix", "skim"];
    const isMilkProduct = (p: ProductSummary) =>
      p.unit === "LITER" && MILK_KWS.some((kw) => p.productName.toLowerCase().includes(kw));

    // Every Milk Flow figure is a litre total, so it counts milk only. Summing
    // every product mixed 500 eggs (PIECE) into the litres and made "produced"
    // read 1550 L on a day that produced 1000 L of milk.
    const milkProducts = products.filter(isMilkProduct);
    const sumMilk = (key: keyof ProductSummary) => sumField(milkProducts, key);

    const produced = sumMilk("produced");
    const kitchenUse = sumMilk("kitchenUse");
    const skimUse = sumMilk("skimUse");
    const yoghurtUse = sumMilk("yoghurtUse");
    const calfUse = sumMilk("calfUse");
    const arrived = sumMilk("arrived");
    const inStorage = products.filter(isMilkProduct).reduce((s, p) => s + p.inStorage, 0);
    const inRetail = products.filter(isMilkProduct).reduce((s, p) => s + p.inRetail, 0);
    const onTheWay = products.filter(isMilkProduct).reduce((s, p) => s + p.onTheWay, 0);
    const withRiders = products.filter(isMilkProduct).reduce((s, p) => s + p.withRiders, 0);
    const delivered = sumMilk("delivered");
    const returned = sumMilk("returned");
    const wastage = sumMilk("wastage");

    // Add transit wastage from dispatch records (declared - received differences)
    let dispatchWastage = 0;
    try {
      type DI = { productId: string; quantity: number };
      // Real loss only. What packaging legitimately did to a load — milk turned
      // into mix milk, milk stirred into the buffalo, milk stirred in — has to come
      // out first, or ordinary processing is reported as wastage. A load that gave
      // 50 L of cow milk to the buffalo showed up here as 50 L wasted.
      const calcLoss = (
        ds: Array<{ id?: string; declaredItems: unknown; receivedItems: unknown }>,
        shares?: Map<string, LoadShare>
      ) => {
        let t = 0;
        for (const r of ds) {
          if (!r.receivedItems) continue;
          const dec = r.declaredItems as DI[];
          const rec = r.receivedItems as DI[];
          const share = (r.id ? shares?.get(r.id) : undefined) ?? EMPTY_SHARE;
          for (const di of dec) {
            const ri = rec.find((x) => x.productId === di.productId);
            const loss = loadLoss(di.quantity, ri?.quantity ?? di.quantity, {
              mixUsed: share.mixUsed[di.productId] ?? 0,
              dilutionOut: share.dilutionOut[di.productId] ?? 0,
              dilutionIn: share.dilutionIn[di.productId] ?? 0,
            });
            if (loss > 0.001) t += loss;
          }
        }
        return t;
      };
      const [fds, rds] = await Promise.all([
        db.farmDispatch.findMany({
          where: { date: dateRange },
          // id is needed to line each load up with what packaging did to it.
          select: { id: true, declaredItems: true, receivedItems: true },
        }),
        // Van stage removed — Packaging → Retail is now the only downstream leg.
        db.retailDispatch.findMany({
          where: { date: dateRange },
          select: { id: true, declaredItems: true, receivedItems: true },
        }),
      ]);
      // A send from packaging's inventory writes its own Retail wastage row for any
      // shortfall (already in `wastage`), so it is left out of the transit loss.
      const sendIds = new Set(
        (await db.inventoryMovement.findMany({
          where: { type: "DISPATCHED", reason: SENT_TO_RETAIL, reference: { in: rds.map((r) => r.id) } },
          select: { reference: true },
        })).map((m) => m.reference),
      );
      const rdsTransit = rds.filter((r) => !sendIds.has(r.id));
      let yoghurtBoiling = 0;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ybs = await (db as any).yoghurtBatch.findMany({ where: { date: dateRange }, select: { boilingWaste: true } });
        yoghurtBoiling = ybs.reduce((s: number, b: { boilingWaste: unknown }) => s + Number(b.boilingWaste), 0);
      } catch { /* yoghurtBatch table may not exist yet */ }
      // Only the farm leg passes through packaging; the retail leg compares what
      // packaging forwarded against what retail received, with nothing in between.
      const shares = await packagingAttribution(dateRange);
      dispatchWastage = calcLoss(fds, shares) + calcLoss(rdsTransit) + yoghurtBoiling;
    } catch { /* tables may not exist yet */ }

    return {
      products,
      retailProducts,
      riders,
      totals: {
        produced,
        kitchenUse,
        skimUse,
        yoghurtUse,
        calfUse,
        netDispatched: sumMilk("dispatched"),
        arrived,
        inStorage,
        inRetail,
        onTheWay,
        withRiders,
        combined: inStorage + inRetail + onTheWay + withRiders,
        delivered,
        returned,
        wastage: wastage + dispatchWastage,
      },
      dbReady: true,
    };
  } catch {
    return {
      products: [],
      retailProducts: [],
      riders: [],
      totals: {
        produced: 0,
        kitchenUse: 0,
        skimUse: 0,
        yoghurtUse: 0,
        calfUse: 0,
        netDispatched: 0,
        arrived: 0,
        inStorage: 0,
        inRetail: 0,
        onTheWay: 0,
        withRiders: 0,
        combined: 0,
        delivered: 0,
        returned: 0,
        wastage: 0,
      },
      dbReady: false,
    };
  }
}
