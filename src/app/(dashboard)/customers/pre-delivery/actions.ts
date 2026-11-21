"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { unitSuffix, type Unit } from "@/lib/units";
import { db } from "@/lib/db";
import { Prisma, type RouteStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { dateStrRangePKT, todayPKTString, pktNoonToUTC, addDaysToDateStr, type DateRangePKT } from "@/lib/pkt";
import { runningRound, shiftOnRoad } from "@/lib/shift-lock";
import { isShiftLockedOnDateStr, subscriptionQtyForDate, isBeforeServiceStart, type AreaSchedule } from "@/lib/schedule";
import { getStockByProduct, getStockComponents, retailFromComponents } from "@/lib/inventory-onhand";
import { resequence, sequenceChanges } from "@/lib/delivery-sequence";

// Prisma area row → AreaSchedule.
const AREA_SCHEDULE_SELECT = {
  scheduleType: true, scheduleInterval: true, scheduleAnchor: true, customDates: true,
} as const;
function toSchedule(a: { scheduleType: string; scheduleInterval: number; scheduleAnchor: string | null; customDates: string[] }): AreaSchedule {
  return { scheduleType: a.scheduleType, scheduleInterval: a.scheduleInterval, scheduleAnchor: a.scheduleAnchor, customDates: a.customDates };
}

// Server-side mirror of the client's lock check (defense in depth — the
// client already hides/disables the locked-shift UI, this stops a stale
// client, scripted call, or future UI regression from reading/saving a route
// for a shift that isn't scheduled on the given date).
async function isShiftLockedOnDate(shiftId: string, date: string): Promise<boolean> {
  const shift = await db.shift.findUnique({
    where: { id: shiftId },
    select: { areas: { select: AREA_SCHEDULE_SELECT } },
  });
  if (!shift) return false;
  return isShiftLockedOnDateStr(shift.areas.map(toSchedule), date);
}

// The shift's area schedules — an alternate pattern steps once per shift day.
async function shiftAreaSchedules(shiftId: string): Promise<AreaSchedule[]> {
  const shift = await db.shift.findUnique({
    where: { id: shiftId },
    select: { areas: { select: AREA_SCHEDULE_SELECT } },
  });
  return (shift?.areas ?? []).map(toSchedule);
}

export type ShiftOption = {
  id: string;
  name: string;
  type: string;
  riderId: string | null;
  riderName: string | null;
  // The delivery schedule of every linked area. Empty = no areas configured yet,
  // so the Shift Editor never locks it out. The client computes locked-per-date.
  schedules: AreaSchedule[];
};

export type RiderOption = {
  id: string;
  name: string;
  vehicle: string | null;
};

export type StopProduct = {
  productId: string;
  productName: string;
  unit: Unit;
  quantity: number;
  rate: number;
};

export type CustomerStop = {
  customerId: string;        // for samples: "sample:<sampleId>" (synthetic)
  name: string;
  customerCode: string;
  phone: string;
  address: string | null;
  billingType: string;       // "SAMPLE" for free-sample stops
  stopNumber: number;
  products: StopProduct[];
  isSample?: boolean;        // free sample — delivered once, no payment, not saved as a RouteStop
};

export type CatalogProduct = {
  productId: string;
  productName: string;
  unit: Unit;
  defaultRate: number;
};

export type PreDeliveryContext = {
  shifts: ShiftOption[];
  riders: RiderOption[];
  products: CatalogProduct[];
  dbReady: boolean;
};

export async function getPreDeliveryContext(): Promise<PreDeliveryContext> {
  await requireRole(FULL_ACCESS);
  try {
    const [shifts, riders, products] = await Promise.all([
      db.shift.findMany({
        include: {
          rider: { include: { user: { select: { name: true } } } },
          areas: { select: AREA_SCHEDULE_SELECT },
        },
        orderBy: { name: "asc" },
      }),
      db.rider.findMany({
        where: { active: true },
        include: { user: { select: { name: true } } },
        orderBy: { user: { name: "asc" } },
      }),
      db.product.findMany({
        // Same reason as the customer catalogue: retail products never go out on
        // a round, so the shift editor does not offer them.
        where: { active: true, retailOnly: false },
        orderBy: { name: "asc" },
      }),
    ]);
    return {
      shifts: shifts.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        riderId: s.riderId,
        riderName: s.rider?.user.name ?? null,
        schedules: s.areas.map(toSchedule),
      })),
      riders: riders.map((r) => ({ id: r.id, name: r.user.name, vehicle: r.vehicle })),
      products: products.map((p) => ({
        productId: p.id,
        productName: p.name,
        unit: p.unit as Unit,
        defaultRate: Number(p.defaultRate),
      })),
      dbReady: true,
    };
  } catch {
    return { shifts: [], riders: [], products: [], dbReady: false };
  }
}

// Pending samples for THIS shift become delivery stops on the next run of the
// shift (from the day they were added onward). They ride once, charged at the
// product's standard rate — the rider collects that cash. They stay display-only
// (never saved as RouteStops, so no invoice), and drop off once delivered.
async function loadSampleStops(
  shiftId: string,
  dayRange: DateRangePKT,
  startNumber: number
): Promise<CustomerStop[]> {
  const samples = await db.sampleLead.findMany({
    // Put on a run on or before this day: assignedAt (set on create and on
    // resend), or createdAt for older rows that have none.
    where: {
      shiftId,
      status: "ASSIGNED",
      OR: [
        { assignedAt: { lte: dayRange.lte } },
        { assignedAt: null, createdAt: { lte: dayRange.lte } },
      ],
    },
    include: { items: { include: { product: true } } },
    orderBy: { createdAt: "asc" },
  });
  return samples.map((s, i) => ({
    customerId: `sample:${s.id}`,
    name: s.name,
    customerCode: "SAMPLE",
    phone: s.phone,
    address: s.address,
    billingType: "SAMPLE",
    stopNumber: startNumber + i,
    isSample: true,
    products: s.items.map((it) => ({
      productId: it.productId,
      productName: it.product.name,
      unit: it.product.unit as Unit,
      quantity: Number(it.quantity),
      rate: Number(it.ratePerUnit) || Number(it.product.defaultRate), // charged at the product's standard rate
    })),
  }));
}

// ── Planning a day that has not arrived ──────────────────────────────────────
// What the editor saves for a FUTURE day. It is not a Route on purpose: Route is
// what the rider app reads, and rider access is scoped by shift rather than by date,
// so a route dated tomorrow reaches a rider's phone today. A plan is invisible to
// them and becomes the route only when someone presses Save route on the day.

export type PlanStopInput = {
  customerId: string;
  stopNumber: number;
  products: { productId: string; quantity: number }[];
};

/** Defensive read of the stored JSON: anything malformed is dropped, never thrown. */
function parsePlanStops(raw: unknown): PlanStopInput[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanStopInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const customerId = typeof row.customerId === "string" ? row.customerId : "";
    if (!customerId) continue;
    const products: { productId: string; quantity: number }[] = [];
    if (Array.isArray(row.products)) {
      for (const p of row.products) {
        if (!p || typeof p !== "object") continue;
        const pr = p as Record<string, unknown>;
        const productId = typeof pr.productId === "string" ? pr.productId : "";
        const quantity = Number(pr.quantity);
        if (productId && Number.isFinite(quantity) && quantity > 0) products.push({ productId, quantity });
      }
    }
    out.push({ customerId, stopNumber: Number(row.stopNumber) || 0, products });
  }
  return out;
}

/** The extras stored with a plan: [{ productId, qty }]. Malformed entries are dropped. */
function parsePlanExtras(raw: unknown): { productId: string; qty: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { productId: string; qty: number }[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const row = e as Record<string, unknown>;
    const productId = typeof row.productId === "string" ? row.productId : "";
    const qty = Number(row.qty);
    if (productId && Number.isFinite(qty) && qty > 0) out.push({ productId, qty });
  }
  return out;
}

/** An extra item the rider takes on top of the customers' orders. */
export type ShiftExtra = { productId: string; productName: string; unit: Unit; qty: number };
/** An extra already received back (in full or in part) — history, not editable. */
export type SettledExtra = ShiftExtra & { returnedQty: number };

// The shift's extras for a day. Once any have been saved for the day they are
// what counts; before that, the extras in the day's plan stand in for them.
async function loadShiftExtras(
  shiftId: string,
  dateRange: DateRangePKT,
  planExtras: unknown,
): Promise<{ extras: ShiftExtra[]; settledExtras: SettledExtra[] }> {
  const rows = await db.riderExtraItem.findMany({
    where: { shiftId, date: dateRange },
    include: { product: { select: { name: true, unit: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length > 0) {
    const editable = new Map<string, ShiftExtra>();
    const settledExtras: SettledExtra[] = [];
    for (const r of rows) {
      const qty = Number(r.givenQty);
      if (r.status === "OUT" && Number(r.returnedQty) === 0) {
        const cur = editable.get(r.productId);
        if (cur) cur.qty += qty;
        else editable.set(r.productId, { productId: r.productId, productName: r.product.name, unit: r.product.unit as Unit, qty });
      } else {
        settledExtras.push({ productId: r.productId, productName: r.product.name, unit: r.product.unit as Unit, qty, returnedQty: Number(r.returnedQty) });
      }
    }
    return { extras: [...editable.values()], settledExtras };
  }
  const planned = parsePlanExtras(planExtras);
  if (planned.length === 0) return { extras: [], settledExtras: [] };
  const prods = await db.product.findMany({
    where: { id: { in: planned.map((e) => e.productId) } },
    select: { id: true, name: true, unit: true },
  });
  const meta = new Map(prods.map((p) => [p.id, p]));
  return {
    extras: planned.flatMap((e) => {
      const m = meta.get(e.productId);
      return m ? [{ productId: e.productId, productName: m.name, unit: m.unit as Unit, qty: e.qty }] : [];
    }),
    settledExtras: [],
  };
}

/**
 * A saved plan, shaped like the route the editor draws.
 *
 * The plan is a record of intent, not a promise: a customer stopped, removed or on
 * an off-day since it was written is dropped here rather than resurrected, exactly
 * as a saved route's stops are filtered.
 */
async function stopsFromPlan(
  planStops: PlanStopInput[],
  date: string,
  offSet: Set<string>
): Promise<CustomerStop[]> {
  if (planStops.length === 0) return [];
  const productIds = [...new Set(planStops.flatMap((s) => s.products.map((p) => p.productId)))];
  const [customers, prodRows] = await Promise.all([
    db.customer.findMany({
      where: { id: { in: planStops.map((s) => s.customerId) } },
      include: { products: { select: { productId: true, ratePerUnit: true } } },
    }),
    productIds.length
      ? db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, unit: true, defaultRate: true } })
      : Promise.resolve([] as { id: string; name: string; unit: string; defaultRate: Prisma.Decimal }[]),
  ]);
  const custById = new Map(customers.map((c) => [c.id, c]));
  const prodById = new Map(prodRows.map((p) => [p.id, p]));

  const stops: CustomerStop[] = [];
  for (const s of [...planStops].sort((a, b) => a.stopNumber - b.stopNumber)) {
    const c = custById.get(s.customerId);
    if (!c) continue;
    if (c.status !== "ACTIVE" && c.status !== "ON_CALL") continue;
    if (offSet.has(c.id)) continue;
    if (isBeforeServiceStart(date, c.joinDate)) continue;
    const rateOf = new Map(c.products.map((cp) => [cp.productId, Number(cp.ratePerUnit)]));
    const products: StopProduct[] = [];
    for (const p of s.products) {
      const meta = prodById.get(p.productId);
      if (!meta) continue; // product deleted since the plan was written
      products.push({
        productId: p.productId,
        productName: meta.name,
        unit: meta.unit as Unit,
        quantity: p.quantity,
        rate: rateOf.get(p.productId) ?? Number(meta.defaultRate),
      });
    }
    if (products.length === 0) continue;
    stops.push({
      customerId: c.id,
      name: c.name,
      customerCode: c.customerCode,
      phone: c.phone,
      address: c.address,
      billingType: c.billingType,
      stopNumber: stops.length + 1,
      products,
    });
  }
  return stops;
}

// A confirmed one-day/shop order, shaped for merging into a day's route.
type OrderForMerge = {
  customerId: string;
  customer: { name: string; customerCode: string; phone: string; address: string | null; billingType: string };
  items: { productId: string; quantity: Prisma.Decimal; product: { name: string; unit: string; defaultRate: Prisma.Decimal } }[];
};

// Merge one-day/shop orders into the day's stops: add the ordered quantity onto
// an existing customer's line, or append a fresh stop for an order-only customer,
// so the rider actually sees it in that day's route.
function mergeOneDayOrders(stops: CustomerStop[], orders: OrderForMerge[]): CustomerStop[] {
  if (orders.length === 0) return stops;
  const byId = new Map(stops.map((s) => [s.customerId, s] as const));
  const appended: CustomerStop[] = [];
  let nextStop = stops.reduce((m, s) => Math.max(m, s.stopNumber), 0) + 1;

  for (const o of orders) {
    let stop = byId.get(o.customerId);
    if (!stop) {
      stop = {
        customerId: o.customerId,
        name: o.customer.name,
        customerCode: o.customer.customerCode,
        phone: o.customer.phone,
        address: o.customer.address,
        billingType: o.customer.billingType,
        stopNumber: nextStop++,
        products: [],
      };
      byId.set(o.customerId, stop);
      appended.push(stop);
    }
    for (const it of o.items) {
      const qty = Number(it.quantity);
      const existing = stop.products.find((p) => p.productId === it.productId);
      if (existing) existing.quantity += qty;
      else stop.products.push({
        productId: it.productId,
        productName: it.product.name,
        unit: it.product.unit as Unit,
        quantity: qty,
        rate: Number(it.product.defaultRate),
      });
    }
  }
  return [...stops, ...appended];
}

type StockInfo = {
  available: Record<string, number>;
  tracked: string[];
  /** Products whose `available` is Retail (today and later); the rest is storage. */
  fromRetail: string[];
};
const NO_STOCK: StockInfo = { available: {}, tracked: [], fromRetail: [] };

// Available stock for the shift editor's live guard, the same figure saveRoute
// checks: for today (and later) a farm product's RETAIL, otherwise storage — PLUS
// this route's own items and editable extras added back (so re-planning it isn't
// blocked by its own prior commitment). `tracked` = products that have any
// stock history (only those are enforced — untracked items never block).
async function routeStockInfo(routeId: string | null, shiftId: string, date: string): Promise<StockInfo> {
  const retailMode = date >= todayPKTString();
  const [stock, existingItems, ownExtras, trackedRows, retailTrackedRows] = await Promise.all([
    getStockByProduct(),
    routeId
      ? db.routeStopItem.findMany({ where: { routeStop: { routeId } }, select: { productId: true, plannedQty: true } })
      : Promise.resolve([] as { productId: string; plannedQty: Prisma.Decimal }[]),
    retailMode
      ? db.riderExtraItem.findMany({
          where: { shiftId, date: dateStrRangePKT(date), status: "OUT", returnedQty: 0 },
          select: { productId: true, givenQty: true },
        })
      : Promise.resolve([] as { productId: string; givenQty: Prisma.Decimal }[]),
    db.inventoryMovement.findMany({ distinct: ["productId"], select: { productId: true } }),
    // Same reason as the save guard: a retail product's count lives in its own
    // table, and this list is what the editor uses to decide what to enforce. If
    // the two disagree the screen offers what the save then refuses.
    db.retailStockEntry.findMany({ where: { voidedAt: null }, distinct: ["productId"], select: { productId: true } }),
  ]);
  const available: Record<string, number> = {};
  const fromRetail: string[] = [];
  for (const [pid, q] of stock.inventory) {
    if (retailMode && stock.retail.has(pid)) {
      available[pid] = stock.retail.get(pid)!;
      fromRetail.push(pid);
    } else {
      available[pid] = q;
    }
  }
  for (const it of existingItems) available[it.productId] = (available[it.productId] ?? 0) + Number(it.plannedQty);
  for (const it of ownExtras) available[it.productId] = (available[it.productId] ?? 0) + Number(it.givenQty);
  for (const pid of Object.keys(available)) available[pid] = Math.round(available[pid] * 1000) / 1000;
  return { available, tracked: [...trackedRows, ...retailTrackedRows].map((r) => r.productId), fromRetail };
}

export type ShiftCustomersResult = {
  stops: CustomerStop[];
  routeId: string | null;
  available: Record<string, number>; // productId -> qty available to plan on this route
  tracked: string[];                 // productIds that are inventory-tracked (enforced)
  fromRetail: string[];              // productIds whose `available` is Retail (today and later)
  extras: ShiftExtra[];              // extra items for the rider — editable
  settledExtras: SettledExtra[];     // extras already received back — shown only
  // Mobile-owned route lifecycle (read-only on the web). null when no saved route.
  status: RouteStatus | null;        // PENDING | IN_PROGRESS | COMPLETED
  startedAt: string | null;          // ISO — rider started the shift
  completedAt: string | null;        // ISO — rider finished the shift
  /** The rider confirmed the load (ISO): the shift is on the road and frozen. */
  onRoadSince: string | null;
};

export async function getShiftCustomers(
  shiftId: string,
  date: string,
  override = false
): Promise<ShiftCustomersResult> {
  await requireRole(FULL_ACCESS);
  return loadShiftCustomers(shiftId, date, override, true);
}

// The work behind getShiftCustomers, without the role check — the load totals
// read it for packaging too. `withStock` = false skips the stock figures, which
// the totals do not need and which cost a full stock read per shift.
async function loadShiftCustomers(
  shiftId: string,
  date: string,
  override: boolean,
  withStock: boolean,
): Promise<ShiftCustomersResult> {
  const empty: ShiftCustomersResult = {
    stops: [], routeId: null, available: {}, tracked: [], fromRetail: [], extras: [], settledExtras: [],
    status: null, startedAt: null, completedAt: null, onRoadSince: null,
  };
  if (!shiftId) return empty;
  try {
    const dateRange = dateStrRangePKT(date);

    // Off-days the customer set for this date (skip them) + confirmed one-day
    // orders for this shift+date (merge them in).
    const [offDays, orders, route] = await Promise.all([
      db.customerCalendarDay.findMany({
        where: { date: dateRange, status: { in: ["NO_DELIVERY", "VACATION"] } },
        select: { customerId: true },
      }),
      db.customerOrder.findMany({
        where: { forDate: dateRange, status: "CONFIRMED", customer: { shiftId } },
        include: {
          customer: { select: { name: true, customerCode: true, phone: true, address: true, billingType: true } },
          items: { include: { product: { select: { name: true, unit: true, defaultRate: true } } } },
        },
      }),
      // Check for existing route. Same deterministic order as saveRoute so the
      // editor reads exactly the row saveRoute writes, even if a legacy duplicate
      // (old server-TZ timestamp) exists for this shift/day.
      db.route.findFirst({
        where: { shiftId, date: dateRange },
        orderBy: { createdAt: "asc" },
        include: {
          stops: {
            orderBy: { stopNumber: "asc" },
            include: {
              customer: true,
              items: { include: { product: true } },
            },
          },
        },
      }),
    ]);
    const offSet = new Set(offDays.map((o) => o.customerId));

    // Only fall back to "not scheduled → empty" when there is NO saved route. A saved
    // route was deliberately planned (possibly via admin override), so it must show on
    // reopen regardless of the area schedule lock.
    const hasSavedRoute = !!route && route.stops.length > 0;
    if (!hasSavedRoute && !override && (await isShiftLockedOnDate(shiftId, date))) {
      return empty;
    }

    const routeLifecycle = {
      status: route?.status ?? null,
      startedAt: route?.startedAt?.toISOString() ?? null,
      completedAt: route?.completedAt?.toISOString() ?? null,
      onRoadSince: date === todayPKTString() ? (await runningRound(shiftId, date))?.since ?? null : null,
    };

    if (route && route.stops.length > 0) {
      // Exclude customers whose supply is stopped (recovery/inactive) or who set
      // this date as an off-day, even if they were on a previously-saved route.
      const base: CustomerStop[] = route.stops
        // ACTIVE, not an off-day, and service has actually started (joinDate gate —
        // catches a saved route whose customer's start date was set to a later day).
        // ON_CALL is kept here on purpose: an on-call customer is never loaded
        // automatically, but once a manager has added them to THIS day's route the
        // saved stop must survive a reload — filtering on ACTIVE alone silently
        // dropped them the next time the editor was opened.
        .filter((stop) => (stop.customer.status === "ACTIVE" || stop.customer.status === "ON_CALL")
          && !offSet.has(stop.customerId)
          && !isBeforeServiceStart(date, stop.customer.joinDate))
        .map((stop) => ({
          customerId: stop.customerId,
          name: stop.customer.name,
          customerCode: stop.customer.customerCode,
          phone: stop.customer.phone,
          address: stop.customer.address,
          billingType: stop.customer.billingType,
          stopNumber: stop.stopNumber,
          products: stop.items.map((item) => ({
            productId: item.productId,
            productName: item.product.name,
            unit: item.product.unit as Unit,
            quantity: Number(item.plannedQty),
            rate: Number(item.product.defaultRate),
          })),
        }));
      const withOrders = mergeOneDayOrders(base, orders);
      const maxStop = withOrders.reduce((m, s) => Math.max(m, s.stopNumber), 0);
      const sampleStops = await loadSampleStops(shiftId, dateRange, maxStop + 1);
      const [stock, extras] = await Promise.all([
        withStock ? routeStockInfo(route.id, shiftId, date) : NO_STOCK,
        loadShiftExtras(shiftId, dateRange, null),
      ]);
      return { routeId: route.id, stops: [...withOrders, ...sampleStops], ...stock, ...extras, ...routeLifecycle };
    }

    // A plan prepared for this day stands in for the route that deliberately does
    // not exist yet, so what was set up yesterday is what the editor opens on —
    // and what the load preview counts — without any of it reaching a rider.
    const plan = await db.routePlan.findFirst({ where: { shiftId, date: dateRange } });
    if (plan) {
      const planned = await stopsFromPlan(parsePlanStops(plan.stops), date, offSet);
      const withPlanOrders = mergeOneDayOrders(planned, orders);
      const maxPlanStop = withPlanOrders.reduce((m, s) => Math.max(m, s.stopNumber), 0);
      const planSamples = await loadSampleStops(shiftId, dateRange, maxPlanStop + 1);
      const [planStock, planExtras] = await Promise.all([
        withStock ? routeStockInfo(null, shiftId, date) : NO_STOCK,
        loadShiftExtras(shiftId, dateRange, plan.extras),
      ]);
      return { routeId: null, stops: [...withPlanOrders, ...planSamples], ...planStock, ...planExtras, ...routeLifecycle };
    }

    // No existing route — load from customer subscriptions, ordered by the
    // delivery sequence set on each customer (unset ones fall to the end).
    const customers = await db.customer.findMany({
      where: { shiftId, status: "ACTIVE" },
      include: {
        products: {
          include: { product: true },
          where: { product: { active: true } },
        },
      },
      orderBy: [
        { deliverySequence: { sort: "asc", nulls: "last" } },
        { customerCode: "asc" },
      ],
    });

    const shiftAreas = await shiftAreaSchedules(shiftId);
    const base: CustomerStop[] = customers
      // Not an off-day, and service has actually started. The joinDate gate stops a
      // brand-new customer (esp. DAILY, which may carry no per-product anchorDate)
      // from appearing on a route dated before they were set to start.
      .filter((c) => !offSet.has(c.id) && !isBeforeServiceStart(date, c.joinDate))
      .map((c, i) => ({
        customerId: c.id,
        name: c.name,
        customerCode: c.customerCode,
        phone: c.phone,
        address: c.address,
        billingType: c.billingType,
        stopNumber: i + 1,
        // Honour each product's schedule: DAILY delivers its flat quantity,
        // ALTERNATE delivers the pattern entry for THIS shift day (0 = skip),
        // counted in shift days from the product's start date. Skip-day lines are dropped so
        // the rider only sees what's actually going out that day.
        products: c.products
          .map((cp) => ({
            productId: cp.productId,
            productName: cp.product.name,
            unit: cp.product.unit as Unit,
            quantity: subscriptionQtyForDate(
              {
                scheduleType: cp.scheduleType,
                quantity: Number(cp.quantity),
                alternatePattern: cp.alternatePattern.map(Number),
                weekdays: cp.weekdays,
                anchorDate: cp.anchorDate,
                shiftAreas,
              },
              date
            ),
            rate: Number(cp.product.defaultRate),
          }))
          .filter((p) => p.quantity > 0),
      }))
      // A customer with nothing to deliver today — every product is a skip day
      // (pattern value 0) or they have no active subscription — shouldn't appear
      // on the route at all. Previously they showed up as an empty "No order"
      // stop. Anyone with a one-day order is re-added by mergeOneDayOrders below,
      // so this only removes genuine no-delivery customers.
      .filter((s) => s.products.length > 0);
    const withOrders = mergeOneDayOrders(base, orders);
    const maxStop = withOrders.reduce((m, s) => Math.max(m, s.stopNumber), 0);
    const sampleStops = await loadSampleStops(shiftId, dateRange, maxStop + 1);
    const [stock, extras] = await Promise.all([
      withStock ? routeStockInfo(route?.id ?? null, shiftId, date) : NO_STOCK,
      loadShiftExtras(shiftId, dateRange, null),
    ]);
    return { routeId: route?.id ?? null, stops: [...withOrders, ...sampleStops], ...stock, ...extras, ...routeLifecycle };
  } catch (e) {
    console.error("[getShiftCustomers]", e);
    return empty;
  }
}

// ── Today's product totals (prep sheet) ──────────────────────────────────────
// Grand total of every product to hand to riders TODAY, summed across ALL shifts
// scheduled today — so prep staff can stage the stock before the routes leave.
// Reuses getShiftCustomers per shift so scheduling, saved-route-vs-subscription,
// one-day orders and free samples all stay in lockstep with the editor itself.

export type TodayTotal = {
  productId: string;
  name: string;
  unit: Unit;
  qty: number;
};

export async function getTodayProductTotals(): Promise<{ date: string; totals: TodayTotal[] }> {
  const { date, totals } = await getProductTotalsForDate(todayPKTString());
  return { date, totals };
}

/** The load preview looks at today, tomorrow and the day after. */
const LOAD_PREVIEW_DAYS = 3;

// The same total for any of those days, so prep staff can see what is coming.
// Display only: it reads exactly what the shift editor would show for that date
// and writes nothing. A future day is a projection — saved routes, subscriptions,
// off-days and one-day orders as they stand right now — so it can still change.
export async function getProductTotalsForDate(
  date: string
): Promise<{ date: string; totals: TodayTotal[]; error?: string }> {
  await requireRole(FULL_ACCESS);
  return productTotalsForDate(date);
}

// The whole load of every shift that day — customers, samples and the extras the
// riders take. Shared by the shift editor's load preview and the packaging page.
async function productTotalsForDate(
  date: string
): Promise<{ date: string; totals: TodayTotal[]; error?: string }> {
  const today = todayPKTString();
  const last = addDaysToDateStr(today, LOAD_PREVIEW_DAYS - 1);
  // String comparison is safe on zero-padded YYYY-MM-DD.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > last) {
    return { date, totals: [], error: "Only today and the next 2 days can be shown." };
  }
  const shifts = await db.shift.findMany({ select: { id: true } });
  const byProduct = new Map<string, TodayTotal>();
  for (const s of shifts) {
    // override=false → a shift not scheduled today returns empty and contributes nothing.
    const res = await loadShiftCustomers(s.id, date, false, false);
    const lines = [
      ...res.stops.flatMap((stop) => stop.products),
      ...[...res.extras, ...res.settledExtras].map((e) => ({ productId: e.productId, productName: e.productName, unit: e.unit, quantity: e.qty })),
    ];
    for (const p of lines) {
      if (p.quantity <= 0) continue;
      const cur = byProduct.get(p.productId);
      if (cur) cur.qty += p.quantity;
      else byProduct.set(p.productId, { productId: p.productId, name: p.productName, unit: p.unit, qty: p.quantity });
    }
  }
  for (const t of byProduct.values()) t.qty = Math.round(t.qty * 1000) / 1000;
  const totals = [...byProduct.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { date, totals };
}

// ── Customer search for adding to route ──────────────────────────────────────

export type CustomerSearchResult = {
  customerId: string;
  name: string;
  customerCode: string;
  phone: string;
  address: string | null;
  billingType: string;
  shiftId: string | null;
  shiftName: string | null;
  products: StopProduct[];
};

export async function searchCustomersForRoute(
  query: string,
  date: string = todayPKTString()
): Promise<CustomerSearchResult[]> {
  await requireRole(FULL_ACCESS);
  const q = query.trim();
  if (!q) return [];
  try {
    const customers = await db.customer.findMany({
      where: {
        // ON_CALL customers are searchable too — they are excluded from automatic
        // route building, not from being added by hand.
        status: { in: ["ACTIVE", "ON_CALL"] },
        OR: [
          { name:         { contains: q, mode: "insensitive" } },
          { customerCode: { contains: q, mode: "insensitive" } },
          { phone:        { contains: q } },
        ],
      },
      include: {
        shift: { include: { areas: { select: AREA_SCHEDULE_SELECT } } },
        products: {
          include: { product: true },
          where: { product: { active: true } },
        },
      },
      orderBy: { name: "asc" },
      take: 20,
    });
    return customers.map((c) => ({
      customerId: c.id,
      name:         c.name,
      customerCode: c.customerCode,
      phone:        c.phone,
      address:      c.address,
      billingType:  c.billingType,
      shiftId:      c.shiftId,
      shiftName:    c.shift?.name ?? null,
      products: c.products
        .map((cp) => ({
          productId:   cp.productId,
          productName: cp.product.name,
          unit:        cp.product.unit as Unit,
          // An ON_CALL customer is served on request, so the day's schedule says
          // nothing about what they want — use their saved quantity. Without this
          // an on-call customer added on a non-scheduled day would arrive with no
          // products at all.
          quantity:    c.status === "ON_CALL"
            ? Number(cp.quantity)
            : subscriptionQtyForDate(
                {
                  scheduleType: cp.scheduleType,
                  quantity: Number(cp.quantity),
                  alternatePattern: cp.alternatePattern.map(Number),
                  weekdays: cp.weekdays,
                  anchorDate: cp.anchorDate,
                  shiftAreas: (c.shift?.areas ?? []).map(toSchedule),
                },
                date
              ),
          rate:        Number(cp.product.defaultRate),
        }))
        .filter((p) => p.quantity > 0),
    }));
  } catch {
    return [];
  }
}

// ── On-call customers for a shift ────────────────────────────────────────────
// Listed in the route editor's "Add customer" dialog so a manager can drop one
// into today's run the moment they phone in — no searching. They are never part
// of the automatic route (getShiftCustomers loads status=ACTIVE only), and their
// saved quantities are shown as-is for the same reason as above.
export async function getOnCallCustomersForShift(
  shiftId: string
): Promise<CustomerSearchResult[]> {
  await requireRole(FULL_ACCESS);
  if (!shiftId) return [];
  try {
    const customers = await db.customer.findMany({
      where: { shiftId, status: "ON_CALL" },
      include: {
        shift: true,
        products: { include: { product: true }, where: { product: { active: true } } },
      },
      orderBy: [{ deliverySequence: { sort: "asc", nulls: "last" } }, { name: "asc" }],
    });
    return customers.map((c) => ({
      customerId:   c.id,
      name:         c.name,
      customerCode: c.customerCode,
      phone:        c.phone,
      address:      c.address,
      billingType:  c.billingType,
      shiftId:      c.shiftId,
      shiftName:    c.shift?.name ?? null,
      products: c.products
        .map((cp) => ({
          productId:   cp.productId,
          productName: cp.product.name,
          unit:        cp.product.unit as Unit,
          quantity:    Number(cp.quantity),
          rate:        Number(cp.product.defaultRate),
        }))
        .filter((p) => p.quantity > 0),
    }));
  } catch (e) {
    console.error("[getOnCallCustomersForShift]", e);
    return [];
  }
}

// Write every changed sequence in ONE statement instead of one per customer.
//
// Moving a customer up a round renumbers everyone below them, so a 30-stop shift
// meant 30 sequential UPDATEs inside a single interactive transaction — and
// Prisma closes such a transaction after a few seconds and then rejects every
// later query in it with "Transaction not found". The write was correct; it
// simply could not finish in time once the link slowed down. Set-based, this is
// one round trip no matter how many customers moved.
async function applySequences(
  tx: Prisma.TransactionClient,
  updates: { id: string; deliverySequence: number }[]
): Promise<void> {
  if (updates.length === 0) return;
  const rows = Prisma.join(
    updates.map((u) => Prisma.sql`(${u.id}::text, ${u.deliverySequence}::int)`)
  );
  await tx.$executeRaw`
    UPDATE "Customer" AS c SET "deliverySequence" = v.seq
    FROM (VALUES ${rows}) AS v(id, seq)
    WHERE c.id = v.id`;
}

export type SaveRouteResult = { ok: true } | { ok: false; error: string };

/** Which shift and day the editor's customer list was loaded for. */
export type LoadedFor = { shiftId: string; date: string };

// The editor switches shift at once but the new shift's customers take seconds
// to arrive. A save in between sent the OLD shift's customers under the NEW
// shift: on 28 Oct the CBR round was saved as a copy of Bahria Phase 1-6 and no
// CBR customer was on it. The page says which list it is holding; a save whose
// list belongs to another shift or day is refused and writes nothing.
const LIST_MISMATCH = "The customer list on screen was still the previous shift's — nothing was saved. Wait for this shift's customers to load, then save again.";
function listMismatch(data: { shiftId: string; date: string; loadedFor?: LoadedFor }): boolean {
  return !!data.loadedFor && (data.loadedFor.shiftId !== data.shiftId || data.loadedFor.date !== data.date);
}

// Save ONLY the order of the stops — nothing else.
//
// Reordering does not change a single quantity, so none of the gates that guard a
// re-plan apply to it: not the stock ceiling, not the "is this shift scheduled
// today" lock. A manager dragging a customer up the round is recording where that
// customer sits, and that must simply be kept.
//
// Two things happen: the shift's standing sequence is updated (what every FUTURE
// day is built from), and, if this day already has an editable route, its stops
// are renumbered to match. No route is created, no quantities are touched, no
// stock is committed. A route the rider has already started — or a locked one — is
// left exactly as it is; the standing order is still saved for the days after it.
export async function saveDeliveryOrder(data: {
  shiftId: string;
  date: string;
  /** Customer ids in the order the manager left them. Sample stops excluded. */
  customerIds: string[];
  loadedFor?: LoadedFor;
}): Promise<SaveRouteResult> {
  await requireRole(FULL_ACCESS);
  if (listMismatch(data)) return { ok: false, error: LIST_MISMATCH };
  try {
    const ordered = data.customerIds.filter((id) => id && !id.startsWith("sample:"));
    if (ordered.length === 0) return { ok: true };

    const shiftCustomers = await db.customer.findMany({
      where: { shiftId: data.shiftId },
      select: { id: true, deliverySequence: true, customerCode: true },
    });
    const updates = sequenceChanges(resequence(ordered, shiftCustomers), shiftCustomers);

    // Today's route, if it exists and can still be edited. Same deterministic pick
    // as saveRoute so both always act on the same row.
    const route = await db.route.findFirst({
      where: { shiftId: data.shiftId, date: dateStrRangePKT(data.date) },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, locked: true, stops: { select: { id: true, customerId: true } } },
    });
    const routeEditable = !!route && !route.locked && route.status === "PENDING";

    const position = new Map(ordered.map((id, i) => [id, i + 1] as const));

    await db.$transaction(async (tx) => {
      await applySequences(tx, updates);
      if (route && routeEditable) {
        // Anything on the route but not in the list keeps its place after the rest,
        // so a stop can never silently collide with another's number.
        let trailing = ordered.length;
        const renumbered = route.stops.map((stop) => ({
          id: stop.id,
          stopNumber: position.get(stop.customerId) ?? ++trailing,
        }));
        if (renumbered.length > 0) {
          const rows = Prisma.join(
            renumbered.map((r) => Prisma.sql`(${r.id}::text, ${r.stopNumber}::int)`)
          );
          await tx.$executeRaw`
            UPDATE "RouteStop" AS s SET "stopNumber" = v.n
            FROM (VALUES ${rows}) AS v(id, n)
            WHERE s.id = v.id`;
        }
      }
    });

    revalidatePath("/customers/pre-delivery");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save the delivery order." };
  }
}

/**
 * Take a free sample off its shift — the ✕ on a sample stop in the Shift Editor.
 *
 * A sample is not saved with the route: it rides every run of its shift until it
 * is delivered. So the ✕ used to hide it on the screen only, and it was back the
 * next time the shift opened. Now it leaves the shift and returns to the Samples
 * page with no shift, from where it can be sent on any shift again.
 *
 * Not once the round is loaded or started: the rider has it in his app by then.
 */
export async function takeSampleOffShift(data: { sampleId: string; shiftId: string; date: string }): Promise<SaveRouteResult> {
  await requireRole(FULL_ACCESS);
  try {
    const sample = await db.sampleLead.findUnique({ where: { id: data.sampleId }, select: { status: true, shiftId: true } });
    if (!sample) return { ok: false, error: "That sample no longer exists." };
    if (sample.shiftId !== data.shiftId || sample.status !== "ASSIGNED") {
      return { ok: false, error: "This sample is no longer on this shift — open the shift again." };
    }
    const route = await db.route.findFirst({
      where: { shiftId: data.shiftId, date: dateStrRangePKT(data.date) },
      orderBy: { createdAt: "asc" },
      select: { status: true, locked: true },
    });
    if (route && (route.status !== "PENDING" || route.locked)) {
      return { ok: false, error: "The rider has already started this shift — the sample stays on it." };
    }
    const running = await runningRound(data.shiftId, data.date);
    if (running) return { ok: false, error: `${running.shiftName} has already been loaded — the sample stays on it.` };

    await db.sampleLead.update({ where: { id: data.sampleId }, data: { shiftId: null } });
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/samples");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not take the sample off the shift." };
  }
}

/** An extra item as the editor sends it. */
export type ExtraInput = { productId: string; qty: number };

/** Extras added up per product. Anything blank or 0 is dropped; a bad number refuses. */
function sumExtras(raw: ExtraInput[] | undefined): { ok: true; byProduct: Map<string, number> } | { ok: false; error: string } {
  const byProduct = new Map<string, number>();
  for (const l of raw ?? []) {
    if (!l?.productId) continue;
    const q = Number(l.qty);
    if (!Number.isFinite(q) || q < 0) return { ok: false, error: "Enter valid extra quantities (0 or more)." };
    if (q > 0) byProduct.set(l.productId, (byProduct.get(l.productId) ?? 0) + q);
  }
  return { ok: true, byProduct };
}

const fmtQ = (n: number) => String(Math.round(n * 1000) / 1000);

// Save today's extras for a shift: the rows still with the rider and not yet
// received back are brought in line with what the editor holds — updated in
// place, created, or removed. A row already received back (or partly) is history
// and is never touched.
async function replaceExtras(
  tx: Prisma.TransactionClient,
  args: { shiftId: string; date: Date; dateRange: DateRangePKT; riderId: string | null; userId: string; byProduct: Map<string, number> },
): Promise<void> {
  const rows = await tx.riderExtraItem.findMany({
    where: { shiftId: args.shiftId, date: args.dateRange, status: "OUT", returnedQty: 0 },
    select: { id: true, productId: true },
    orderBy: { createdAt: "asc" },
  });
  const byPid = new Map<string, string[]>();
  for (const r of rows) byPid.set(r.productId, [...(byPid.get(r.productId) ?? []), r.id]);

  const remove: string[] = [];
  for (const [pid, ids] of byPid) {
    const q = args.byProduct.get(pid);
    if (q == null) {
      remove.push(...ids);
      continue;
    }
    await tx.riderExtraItem.update({ where: { id: ids[0] }, data: { givenQty: new Prisma.Decimal(q) } });
    remove.push(...ids.slice(1));
  }
  if (remove.length > 0) await tx.riderExtraItem.deleteMany({ where: { id: { in: remove } } });

  const fresh = [...args.byProduct].filter(([pid]) => !byPid.has(pid));
  if (fresh.length > 0) {
    await tx.riderExtraItem.createMany({
      data: fresh.map(([productId, q]) => ({
        date: args.date,
        shiftId: args.shiftId,
        riderId: args.riderId,
        productId,
        givenQty: new Prisma.Decimal(q),
        status: "OUT",
        givenById: args.userId,
      })),
    });
  }
}

// Save a day's route — this IS the assignment: it writes the row the rider app reads.
//
// Today (and any later day) the whole load — customers plus extras — must be in
// RETAIL: packaging sends it there, and a shift is only assigned once Retail holds
// enough. A past day is a correction and is checked against inventory, as before.
// Retail products (Product.retailOnly) never pass through packaging, so they are
// always checked against their own stock.
export async function saveRoute(data: {
  shiftId: string;
  date: string;
  stops: {
    customerId: string;
    stopNumber: number;
    products: { productId: string; quantity: number }[];
  }[];
  /** The shift's extra items for the day. Left out = the saved extras stay as they are. */
  extras?: ExtraInput[];
  override?: boolean;
  loadedFor?: LoadedFor;
}): Promise<SaveRouteResult> {
  const user = await requireRole(FULL_ACCESS);
  if (listMismatch(data)) return { ok: false, error: LIST_MISMATCH };
  if (!data.override && (await isShiftLockedOnDate(data.shiftId, data.date))) {
    return { ok: false, error: "This shift isn't scheduled to deliver on this date — enable the admin override to save anyway." };
  }
  // Extras belong to today (here) and tomorrow (the plan); a past day's are history.
  const retailMode = data.date >= todayPKTString();
  let extras: Map<string, number> | null = null;
  if (retailMode && data.extras) {
    const parsed = sumExtras(data.extras);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    extras = parsed.byProduct;
  }
  try {
    const dateRange = dateStrRangePKT(data.date);
    // Canonical PKT-noon key (timezone-independent). Previously this used
    // `new Date(y, m-1, d, 12)`, which resolves in the server's LOCAL timezone —
    // so a route saved on a UTC server (12:00Z) and the row the rider's PKT mobile
    // app writes for the same day (07:00Z) were two DIFFERENT Route rows under the
    // exact-timestamp @@unique. The web updated one, the phone read the other, and
    // reorders never reached the rider. pktNoonToUTC() pins both to the same instant.
    const date = pktNoonToUTC(data.date);

    // Extras go to whoever rides the shift. A rider does not have to be assigned
    // yet — the load is planned first and the rider comes later — so the rows are
    // simply stamped with the shift's rider if it has one.
    let riderId: string | null = null;
    if (extras) {
      const shift = await db.shift.findUnique({ where: { id: data.shiftId }, select: { riderId: true } });
      if (!shift) return { ok: false, error: "That shift no longer exists." };
      riderId = shift.riderId;
    }

    // The whole load this save asks for: the customers, the shift's free samples
    // and the extras. Samples are never saved as stops, but they ride this round
    // and their milk comes out of the same stock — so the check counts them, read
    // from the Samples page rather than from what the screen sent.
    const wanted = new Map<string, number>();
    for (const stop of data.stops) {
      if (stop.customerId.startsWith("sample:")) continue;
      for (const p of stop.products) {
        if (p.quantity > 0) wanted.set(p.productId, (wanted.get(p.productId) ?? 0) + p.quantity);
      }
    }
    for (const sample of await loadSampleStops(data.shiftId, dateRange, 0)) {
      for (const p of sample.products) {
        if (p.quantity > 0) wanted.set(p.productId, (wanted.get(p.productId) ?? 0) + p.quantity);
      }
    }
    for (const [pid, q] of extras ?? []) wanted.set(pid, (wanted.get(pid) ?? 0) + q);

    // The order the manager left the stops in is a standing decision, not a
    // one-day one: the rider drives the same street the same way tomorrow. Work
    // out the shift's new permanent sequence BEFORE the transaction so the write
    // is a short list of changed rows inside it.
    //
    // Customers not on today's route (off-day, on-call, supply stopped) keep their
    // place relative to those who were, instead of being pushed to the end of the
    // round — see resequence().
    // Re-planning a PAST day is a correction to that day, not a new instruction
    // for the round — so it fixes the day's stops without rewriting the standing
    // order. Only today and future dates set it.
    const setsStandingOrder = retailMode;
    const orderedStopIds = [...data.stops]
      .filter((s) => !s.customerId.startsWith("sample:"))
      .sort((a, b) => a.stopNumber - b.stopNumber)
      .map((s) => s.customerId);
    const shiftCustomers = setsStandingOrder
      ? await db.customer.findMany({
          where: { shiftId: data.shiftId },
          select: { id: true, deliverySequence: true, customerCode: true },
        })
      : [];
    const sequenceUpdates = setsStandingOrder
      ? sequenceChanges(resequence(orderedStopIds, shiftCustomers), shiftCustomers)
      : [];

    // Check and write in ONE transaction, under the per-product stock locks: two
    // shifts saved at the same moment must not both count the same stock, and a
    // refused save must leave nothing behind (the route row used to be created
    // before the check). Only the products this save wants are locked — shifts
    // that share none of them do not wait for each other.
    // The stops are rebuilt here too — previously the delete and the re-create ran
    // as separate statements: a failure in between left every stop deleted and
    // none recreated, silently returning the whole route's milk to storage.
    const result = await db.$transaction(async (tx): Promise<SaveRouteResult> => {
      // Same key and same sorted order as every other stock outflow, so a send
      // and a save can never deadlock each other.
      for (const pid of [...wanted.keys()].sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock:" + pid}))`;
      }

      let route = await tx.route.findFirst({
        where: { shiftId: data.shiftId, date: dateRange },
        // Deterministic pick if a legacy duplicate (old 12:00Z + new 07:00Z) exists
        // for this day, so we always update the same row rather than flip-flopping.
        orderBy: { createdAt: "asc" },
      });

      // Once the rider has STARTED (IN_PROGRESS) or FINISHED (COMPLETED) the run, or the
      // route is locked, it can't be re-planned — the rider is already working off these
      // quantities, and (for COMPLETED) rebuilding the stops would DELETE the
      // RouteStopItem.plannedQty rows that hold delivered milk out of stock, so inStorage
      // would jump back up by milk that physically left days ago (double-credited with the
      // trigger's RETURNED movements). Edits are only allowed while PENDING.
      if (route && (route.status === "COMPLETED" || route.status === "IN_PROGRESS" || route.locked)) {
        return {
          ok: false,
          error:
            route.locked
              ? "This route is locked and can no longer be edited."
              : route.status === "COMPLETED"
                ? "This shift has already been completed by the rider — its route can't be re-planned. Adjust the delivery entries instead."
                : "The rider has already started this shift — its route can no longer be changed.",
        };
      }

      // ── Stock guard ──────────────────────────────────────────────────────────
      // `available` = the stock (which already subtracts every OTHER shift's load)
      // + THIS route's own current items and extras added back, since this save
      // replaces them. Products with no stock history are skipped — only
      // stock-tracked items (milk, etc.) are enforced.
      if (wanted.size > 0) {
        const wantedIds = [...wanted.keys()];
        const [stock, existingItems, ownExtras, trackedRows, retailTrackedRows, prodRows] = await Promise.all([
          getStockByProduct(),
          route
            ? tx.routeStopItem.findMany({ where: { routeStop: { routeId: route.id } }, select: { productId: true, plannedQty: true } })
            : Promise.resolve([] as { productId: string; plannedQty: Prisma.Decimal }[]),
          extras
            ? tx.riderExtraItem.findMany({
                where: { shiftId: data.shiftId, date: dateRange, status: "OUT", returnedQty: 0 },
                select: { productId: true, givenQty: true },
              })
            : Promise.resolve([] as { productId: string; givenQty: Prisma.Decimal }[]),
          tx.inventoryMovement.findMany({ where: { productId: { in: wantedIds } }, distinct: ["productId"], select: { productId: true } }),
          // Retail products keep their count in their own table, so a movement row
          // is not the only way to be stock-tracked. Without this a bottle with 40
          // in stock is absent from `tracked` and the guard below skips it.
          tx.retailStockEntry.findMany({ where: { productId: { in: wantedIds }, voidedAt: null }, distinct: ["productId"], select: { productId: true } }),
          tx.product.findMany({ where: { id: { in: wantedIds } }, select: { id: true, name: true, unit: true } }),
        ]);
        const own = new Map<string, number>();
        for (const it of existingItems) own.set(it.productId, (own.get(it.productId) ?? 0) + Number(it.plannedQty));
        for (const it of ownExtras) own.set(it.productId, (own.get(it.productId) ?? 0) + Number(it.givenQty));
        const tracked = new Set([...trackedRows, ...retailTrackedRows].map((r) => r.productId));
        const nameById = new Map(prodRows.map((p) => [p.id, p]));
        const retailShort: string[] = [];
        const storeShort: string[] = [];
        for (const [productId, want] of wanted) {
          if (!tracked.has(productId)) continue; // not stock-tracked → don't block
          const fromRetail = retailMode && stock.retail.has(productId);
          const base = fromRetail ? stock.retail.get(productId)! : (stock.inventory.get(productId) ?? 0);
          const available = base + (own.get(productId) ?? 0);
          if (want > available + 1e-6) {
            const info = nameById.get(productId);
            const u = info ? unitSuffix(info.unit) : "";
            const have = Math.max(0, available);
            if (fromRetail) retailShort.push(`${info?.name ?? "product"}: ${fmtQ(want)}${u} needed, only ${fmtQ(have)}${u} in Retail`);
            else storeShort.push(`${info?.name ?? "product"}: ${fmtQ(want)}${u} planned, only ${fmtQ(have)}${u} in storage`);
          }
        }
        if (retailShort.length > 0 || storeShort.length > 0) {
          const parts: string[] = [];
          if (retailShort.length > 0) parts.push(`Not enough in Retail — ${retailShort.join("; ")}. Packaging sends it and Retail accepts it on the Retail page first.`);
          if (storeShort.length > 0) parts.push(`Not enough stock — ${storeShort.join("; ")}. Reduce quantities or add stock first.`);
          return { ok: false, error: parts.join(" ") };
        }
      }

      if (!route) {
        route = await tx.route.create({ data: { date, shiftId: data.shiftId } });
      }
      const routeId = route.id;

      await tx.routeStop.deleteMany({ where: { routeId } });

      // All the stops in one INSERT, then all their items in a second — rather
      // than a create-and-then-create per stop, which cost two round trips each
      // and put a 30-stop route well past the transaction's life expectancy.
      const realStops = data.stops.filter((s) => !s.customerId.startsWith("sample:"));
      if (realStops.length > 0) {
        const created = await tx.routeStop.createManyAndReturn({
          data: realStops.map((s) => ({
            routeId,
            customerId: s.customerId,
            stopNumber: s.stopNumber,
          })),
          select: { id: true },
        });
        // Rows come back in the order they were inserted, which is how each stop
        // finds its items. If that ever stopped holding, the items would be
        // attached to the wrong customers — so refuse rather than guess.
        if (created.length !== realStops.length) {
          throw new Error("Route stops were not all created — refusing to attach quantities.");
        }
        const items = realStops.flatMap((s, i) =>
          s.products
            .filter((p) => p.quantity > 0)
            .map((p) => ({
              routeStopId: created[i].id,
              productId: p.productId,
              plannedQty: new Prisma.Decimal(p.quantity),
            }))
        );
        if (items.length > 0) {
          await tx.routeStopItem.createMany({ data: items });
        }
      }

      // Same transaction as the stops: a saved route and the standing order it
      // implies must never disagree. Only rows that actually moved are written,
      // so saving without reordering touches nothing.
      await applySequences(tx, sequenceUpdates);

      if (extras) {
        await replaceExtras(tx, { shiftId: data.shiftId, date, dateRange, riderId, userId: user.id, byProduct: extras });
      }
      return { ok: true };
    }, { maxWait: 15_000, timeout: 30_000 });
    if (!result.ok) return result;

    // Mark any one-day orders now baked into this route as SCHEDULED so they
    // aren't merged in (double-counted) on the next load.
    const stopCustomerIds = data.stops.map((s) => s.customerId).filter((id) => !id.startsWith("sample:"));
    if (stopCustomerIds.length > 0) {
      await db.customerOrder.updateMany({
        where: { forDate: dateRange, status: "CONFIRMED", customerId: { in: stopCustomerIds } },
        data: { status: "SCHEDULED" },
      });
    }

    // The day has arrived and this IS the route now. A leftover plan would shadow
    // it on the next open (the plan is read before subscriptions) and quietly undo
    // the save.
    await db.routePlan.deleteMany({ where: { shiftId: data.shiftId, date: dateRange } });

    revalidatePath("/customers/pre-delivery");
    revalidatePath("/inventory/farm-arrival");
    revalidatePath("/inventory/rider-returns");
    revalidatePath("/inventory");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save route." };
  }
}

/**
 * Save the shift's EXTRA LOAD, and nothing else.
 *
 * This is not an assignment: no route is written, no rider is given anything to
 * drive, and the stock is not checked. It records how much extra the shift will
 * carry so it counts in the shift's total load and packaging can get it ready and
 * send it to Retail. The stock check still happens where it belongs — at Save
 * route, which is what actually hands the shift to the rider.
 *
 * Today's extras are saved as the shift's rider items. A future day's are kept
 * with that day's plan, and become rider items when the day's route is saved.
 */
export async function saveShiftExtras(data: {
  shiftId: string;
  date: string;
  extras: ExtraInput[];
}): Promise<SaveRouteResult> {
  const user = await requireRole(FULL_ACCESS);
  if (!data.shiftId) return { ok: false, error: "Choose a shift first." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return { ok: false, error: "Choose a date." };
  const today = todayPKTString();
  if (data.date < today) return { ok: false, error: "A past day's extras are history and can no longer be changed." };
  if (data.date === today) {
    // The rider has the load: what he was given cannot be rewritten under him.
    const road = await shiftOnRoad(data.shiftId);
    if (road) return { ok: false, error: road };
  }
  const parsed = sumExtras(data.extras);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  try {
    const dateRange = dateStrRangePKT(data.date);
    const when = pktNoonToUTC(data.date);

    if (data.date > today) {
      // A future day: keep the extras with the plan. If no plan exists yet, the
      // day's stops are written with it — an empty plan would shadow the
      // subscriptions and the day would open with no customers at all.
      const existing = await db.routePlan.findFirst({ where: { shiftId: data.shiftId, date: dateRange }, select: { id: true } });
      const extras = [...parsed.byProduct].map(([productId, qty]) => ({ productId, qty }));
      if (existing) {
        await db.routePlan.update({
          where: { id: existing.id },
          data: { extras: extras as unknown as Prisma.InputJsonValue, updatedById: user.id },
        });
      } else {
        const day = await loadShiftCustomers(data.shiftId, data.date, true, false);
        const stops: PlanStopInput[] = day.stops
          .filter((st) => !st.isSample)
          .map((st) => ({
            customerId: st.customerId,
            stopNumber: st.stopNumber,
            products: st.products.filter((pr) => pr.quantity > 0).map((pr) => ({ productId: pr.productId, quantity: pr.quantity })),
          }));
        await db.routePlan.create({
          data: {
            shiftId: data.shiftId,
            date: when,
            stops: stops as unknown as Prisma.InputJsonValue,
            extras: extras as unknown as Prisma.InputJsonValue,
            updatedById: user.id,
          },
        });
      }
    } else {
      // Today: the rider items themselves. Extras go to whoever rides the shift,
      // and the shift does not need a rider yet.
      const shift = await db.shift.findUnique({ where: { id: data.shiftId }, select: { riderId: true } });
      if (!shift) return { ok: false, error: "That shift no longer exists." };
      await db.$transaction(async (tx) => {
        await replaceExtras(tx, {
          shiftId: data.shiftId, date: when, dateRange, riderId: shift.riderId, userId: user.id, byProduct: parsed.byProduct,
        });
      }, { maxWait: 10_000, timeout: 20_000 });
    }

    revalidatePath("/customers/pre-delivery");
    revalidatePath("/inventory/farm-arrival");
    revalidatePath("/inventory/rider-returns");
    revalidatePath("/inventory");
    return { ok: true };
  } catch (e) {
    console.error("[saveShiftExtras]", e);
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the extra load." };
  }
}

export type PlanResult = { ok: true } | { ok: false; error: string };

/**
 * Save a FUTURE day's plan. Nothing here reaches a rider.
 *
 * Refuses today and the past outright: those days have a real route, and quietly
 * writing a plan for them would shadow it on the next open. There is no stock guard
 * either — tomorrow's stock is not today's, so blocking a plan on today's on-hand
 * would refuse perfectly ordinary planning. The check still happens at Save route.
 */
export async function saveRoutePlan(data: {
  shiftId: string;
  date: string;
  stops: PlanStopInput[];
  /** The shift's extras for that day. Left out = the plan's extras stay as they are. */
  extras?: ExtraInput[];
  override?: boolean;
  loadedFor?: LoadedFor;
}): Promise<PlanResult> {
  const user = await requireRole(FULL_ACCESS);
  if (!data.shiftId) return { ok: false, error: "Choose a shift first." };
  if (listMismatch(data)) return { ok: false, error: LIST_MISMATCH };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return { ok: false, error: "Choose a date." };
  if (data.date <= todayPKTString()) {
    return { ok: false, error: "Only a future day is saved as a plan — use Save route for today." };
  }
  // Tomorrow, and no further. Phones ignore the date box's limit, so this is where
  // the limit is actually held — a request for next week is refused, not saved.
  if (data.date > addDaysToDateStr(todayPKTString(), 1)) {
    return { ok: false, error: "Only tomorrow can be planned ahead." };
  }
  if (!data.override && (await isShiftLockedOnDate(data.shiftId, data.date))) {
    return { ok: false, error: "This shift isn't scheduled to deliver that day — turn on the admin override to plan it anyway." };
  }
  let extras: { productId: string; qty: number }[] | undefined;
  if (data.extras) {
    const parsed = sumExtras(data.extras);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    extras = [...parsed.byProduct].map(([productId, qty]) => ({ productId, qty }));
  }
  try {
    // Sample stops are display-only, exactly as in saveRoute.
    const stops: PlanStopInput[] = (data.stops ?? [])
      .filter((s) => s.customerId && !s.customerId.startsWith("sample:"))
      .map((s) => ({
        customerId: s.customerId,
        stopNumber: Number(s.stopNumber) || 0,
        products: (s.products ?? [])
          .filter((p) => p.productId && Number.isFinite(Number(p.quantity)) && Number(p.quantity) > 0)
          .map((p) => ({ productId: p.productId, quantity: Number(p.quantity) })),
      }));
    const when = pktNoonToUTC(data.date);
    await db.routePlan.upsert({
      where: { date_shiftId: { date: when, shiftId: data.shiftId } },
      create: {
        shiftId: data.shiftId, date: when, stops: stops as unknown as Prisma.InputJsonValue,
        extras: (extras ?? []) as unknown as Prisma.InputJsonValue, updatedById: user.id,
      },
      update: {
        stops: stops as unknown as Prisma.InputJsonValue,
        ...(extras ? { extras: extras as unknown as Prisma.InputJsonValue } : {}),
        updatedById: user.id,
      },
    });
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/inventory/farm-arrival");
    return { ok: true };
  } catch (e) {
    console.error("[saveRoutePlan]", e);
    return { ok: false, error: "Could not save the plan. Please try again." };
  }
}

// Rider assignment for a shift now happens only from the Areas / Shifts tab
// (see updateShift in ../areas/actions.ts, which does the same customer
// re-mirroring this function used to do). The Shift Editor shows the rider
// read-only, sourced live from Shift.riderId.

// ── The load packaging has to send to Retail ─────────────────────────────────

export type LoadNeedLine = {
  productId: string;
  name: string;
  unit: Unit;
  /** The whole load of every shift that day: customers, samples and extras. */
  needed: number;
  /** Sent to Retail today. Today only. */
  sent: number;
  /** In Retail right now — sent, less what shifts have been given, plus returns. Today only; can be below 0. */
  inRetail: number;
  /** What still has to go to Retail so every shift can be assigned. Today only. */
  stillToSend: number;
};
export type PackagingLoadNeeds = { date: string; isToday: boolean; lines: LoadNeedLine[]; error?: string };

/**
 * Today's or tomorrow's load, per product, for the packaging page — the same
 * totals the shift editor's load preview shows, plus how much of today's is
 * still to be sent to Retail.
 *
 * still to send = (needed − already given to shifts) − in Retail.
 * A shift that is not assigned yet still needs its load; one that is has taken it
 * out of Retail already. When Retail is below 0 (loads were set before anything
 * was sent) the gap is added on, because that stock has to arrive too.
 *
 * Farm products only — a retail product never passes through packaging.
 */
export async function getPackagingLoadNeeds(date: string): Promise<PackagingLoadNeeds> {
  await requireRole(["ADMIN", "MANAGER", "PACKAGING"]);
  const today = todayPKTString();
  const isToday = date === today;
  if (!isToday && date !== addDaysToDateStr(today, 1)) {
    return { date, isToday, lines: [], error: "Only today and tomorrow can be shown." };
  }
  try {
    const [{ totals }, { retail }] = await Promise.all([productTotalsForDate(date), getStockComponents()]);
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const lines: LoadNeedLine[] = [];
    for (const t of totals) {
      const c = retail.get(t.productId);
      if (!c) continue; // retail product, or no longer active
      if (!isToday) {
        lines.push({ productId: t.productId, name: t.name, unit: t.unit, needed: t.qty, sent: 0, inRetail: 0, stillToSend: 0 });
        continue;
      }
      const inRetail = retailFromComponents(c);
      const given = c.loaded + c.extraOut;
      // Sent but not yet accepted by Retail is already on its way: it is not
      // Retail's to load yet, but packaging must not be asked to send it twice.
      const onTheWay = c.onTheWay ?? 0;
      lines.push({
        productId: t.productId,
        name: t.name,
        unit: t.unit,
        needed: t.qty,
        sent: r3(c.sent + onTheWay),
        inRetail: r3(inRetail),
        stillToSend: r3(Math.max(0, t.qty - given - inRetail - onTheWay)),
      });
    }
    return { date, isToday, lines };
  } catch (e) {
    console.error("[getPackagingLoadNeeds]", e);
    return { date, isToday, lines: [], error: "Could not load the shift loads." };
  }
}
