import "server-only";
import { db } from "@/lib/db";

/**
 * What the farm actually sold, in one place.
 *
 * There were four different answers to "how much did we sell" before this — the
 * dashboard, the summary report, the reports overview and the dashboard's own
 * sparkline each had their own — and the dashboard's was wrong in four ways:
 *
 *   • it read `Invoice`, which only exists after someone presses "Generate bills"
 *     on a half-month cycle, so the RUNNING MONTH counted zero for every route
 *     delivery while OTC and retail counted normally;
 *   • a counter sale to a mart was counted twice: once at sale time, and again
 *     when the mart paid;
 *   • consignment actually sold counted only when the shop paid, or never;
 *   • the previous-month figure omitted retail entirely, so the delta was
 *     structurally wrong every month a mart paid anything.
 *
 * THE DEFINITION — three legs, each a moment product left our hands:
 *
 *   DELIVERY     DeliveryEntry, excluding replacements (free), returns negative
 *                  : quantity × unitRate × (isReturn ? −1 : +1)
 *   OTC          OtcSaleLine.amount, every customerType
 *   CONSIGNMENT  RetailResolutionLine.amount — when the shop REPORTS it sold,
 *                  not when they pay
 *
 * Deliberately NOT counted, each for a reason:
 *   Invoice           a restatement of DeliveryEntry that needs a button pressed
 *   Payment / RetailPayment   money in, not product out — this is where the mart
 *                     double count came from
 *   RouteStopItem     a plan, with no rate
 *   RiderExtraItem    stock handling; whatever was delivered is already a
 *                     DeliveryEntry, so counting it would double count
 *   RetailPlacement   dropped at a shop, still our stock until they report it
 *   FarmSale          an asset disposal, reported on its own
 *   deliveryCharge    a service fee, not a product — and it belongs to no product,
 *                     so including it would stop the by-product rows summing to
 *                     the headline
 *   SampleItem        free
 */

export type SalesSource = "DELIVERY" | "OTC" | "CONSIGNMENT";

export type ProductSalesRow = {
  productId: string;
  name: string;
  /** Product.unit — feed to unitLabel() for display. */
  unit: string;
  /** Net of returns; replacements excluded. */
  qty: number;
  value: number;
};

export type ProductSales = {
  /** THE sales figure. */
  total: number;
  bySource: Record<SalesSource, number>;
  /** Sorted by value, descending. */
  rows: ProductSalesRow[];
  /** Keyed by the caller's bucket key. Σ buckets === total, exactly. */
  buckets: Record<string, number>;
};

/**
 * The value of one delivery line. Pure and exported because it was duplicated in
 * dashboard-data and the summary report, which is how two "revenue" figures drift.
 */
export function deliveryLineValue(e: {
  quantity: number;
  unitRate: number;
  isReturn: boolean;
  isReplacement: boolean;
}): number {
  if (e.isReplacement) return 0; // a free swap for a complaint is not a sale
  return e.quantity * e.unitRate * (e.isReturn ? -1 : 1);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: unknown) => Number(d ?? 0);

export async function getProductSales(
  range: { start: Date; end: Date },
  opts?: { buckets?: { key: string; start: Date; end: Date }[] }
): Promise<ProductSales> {
  const within = { gte: range.start, lte: range.end };

  const [deliveries, otcLines, consignLines] = await Promise.all([
    db.deliveryEntry.findMany({
      where: { date: within },
      select: {
        date: true, productId: true, quantity: true, unitRate: true,
        isReturn: true, isReplacement: true,
      },
    }),
    db.otcSaleLine.findMany({
      where: { sale: { date: within } },
      select: { productId: true, quantity: true, amount: true, sale: { select: { date: true } } },
    }),
    db.retailResolutionLine.findMany({
      where: { resolution: { date: within } },
      select: {
        soldQty: true, amount: true,
        resolution: { select: { date: true } },
        placementLine: { select: { productId: true } },
      },
    }),
  ]);

  type Acc = { qty: number; value: number };
  const byProduct = new Map<string, Acc>();
  const bySource: Record<SalesSource, number> = { DELIVERY: 0, OTC: 0, CONSIGNMENT: 0 };
  const buckets: Record<string, number> = {};
  for (const b of opts?.buckets ?? []) buckets[b.key] = 0;

  const bucketFor = (at: Date) =>
    opts?.buckets?.find((b) => at >= b.start && at <= b.end)?.key ?? null;

  function add(productId: string, at: Date, qty: number, value: number, src: SalesSource) {
    const cur = byProduct.get(productId) ?? { qty: 0, value: 0 };
    cur.qty += qty;
    cur.value += value;
    byProduct.set(productId, cur);
    bySource[src] += value;
    const key = bucketFor(at);
    if (key !== null) buckets[key] += value;
  }

  for (const d of deliveries) {
    if (d.isReplacement) continue;
    const sign = d.isReturn ? -1 : 1;
    add(
      d.productId, d.date,
      num(d.quantity) * sign,
      deliveryLineValue({
        quantity: num(d.quantity), unitRate: num(d.unitRate),
        isReturn: d.isReturn, isReplacement: d.isReplacement,
      }),
      "DELIVERY"
    );
  }

  for (const l of otcLines) {
    add(l.productId, l.sale.date, num(l.quantity), num(l.amount), "OTC");
  }

  for (const l of consignLines) {
    const pid = l.placementLine?.productId;
    if (!pid) continue;
    add(pid, l.resolution.date, num(l.soldQty), num(l.amount), "CONSIGNMENT");
  }

  const ids = [...byProduct.keys()];
  const products = ids.length
    ? await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, unit: true } })
    : [];
  const meta = new Map(products.map((p) => [p.id, p]));

  const rows: ProductSalesRow[] = ids
    .map((id) => {
      const acc = byProduct.get(id)!;
      const p = meta.get(id);
      return {
        productId: id,
        name: p?.name ?? "Unknown product",
        unit: p?.unit ?? "",
        qty: round2(acc.qty),
        value: round2(acc.value),
      };
    })
    // A product whose returns exactly cancelled its sales carries no information.
    .filter((r) => Math.abs(r.value) > 0.005 || Math.abs(r.qty) > 0.0005)
    .sort((a, b) => b.value - a.value);

  const total = round2(bySource.DELIVERY + bySource.OTC + bySource.CONSIGNMENT);
  for (const k of Object.keys(buckets)) buckets[k] = round2(buckets[k]);

  return {
    total,
    bySource: {
      DELIVERY: round2(bySource.DELIVERY),
      OTC: round2(bySource.OTC),
      CONSIGNMENT: round2(bySource.CONSIGNMENT),
    },
    rows,
    buckets,
  };
}
