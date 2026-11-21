"use server";

import { requireRole, FULL_ACCESS, type SessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { dateStrRangePKT, pktNoonToUTC } from "@/lib/pkt";
import { getOnHandByProduct } from "@/lib/inventory-onhand";
import { getShiftCustomers } from "@/app/(dashboard)/customers/pre-delivery/actions";
import { type AreaSchedule } from "@/lib/schedule";

export type ReportRider = { id: string; name: string };
export type ReportShift = {
  id: string;
  name: string;
  type: string;
  riderId: string | null;
  riderName: string | null;
  // The delivery schedule of every linked area — a shift is due on a date if ANY
  // of them is (see lib/schedule.isShiftDeliveringOnDate). Empty = no areas
  // configured, which is never locked (fail open, same rule the Shift Editor
  // uses). The client filters the shift picker on this so a rider's OTHER
  // shifts — the ones not due on the date being viewed — are not offered
  // alongside the one actually running that day.
  schedules: AreaSchedule[];
};

export type RiderReportContext = {
  dbReady: boolean;
  riders: ReportRider[];
  shifts: ReportShift[];
};

export async function getRiderReportContext(): Promise<RiderReportContext> {
  await requireRole(FULL_ACCESS);
  try {
    const [riders, shifts] = await Promise.all([
      db.rider.findMany({ where: { active: true }, include: { user: { select: { name: true } } }, orderBy: { user: { name: "asc" } } }),
      db.shift.findMany({
        include: {
          rider: { include: { user: { select: { name: true } } } },
          areas: { select: { scheduleType: true, scheduleInterval: true, scheduleAnchor: true, customDates: true } },
        },
        orderBy: { name: "asc" },
      }),
    ]);
    return {
      dbReady: true,
      riders: riders.map((r) => ({ id: r.id, name: r.user.name })),
      shifts: shifts.map((s) => ({
        id: s.id, name: s.name, type: s.type, riderId: s.riderId, riderName: s.rider?.user.name ?? null,
        schedules: s.areas,
      })),
    };
  } catch {
    return { dbReady: false, riders: [], shifts: [] };
  }
}

export type ReportProductLine = { productId: string; productName: string; unit: string; planned: number; delivered: number; returned: number };
export type ReportRow = {
  customerId: string;
  name: string;
  customerCode: string;
  status: "delivered" | "charged_not_delivered" | "not_delivered" | "skipped" | "extra";
  skipReason: string | null;
  /** When the rider marked it delivered (ISO), from the app; null when not delivered. */
  markedAt: string | null;
  /** Minutes since the delivery before it on the round; null for the first, or with no time. */
  gapMinutes: number | null;
  /** Its place on the day's sheet — orders the stops that have no delivery time. */
  stopNumber: number | null;
  cashCollected: number | null;
  plannedTotal: number;
  deliveredTotal: number;
  returnedTotal: number;
  products: ReportProductLine[];
};

/** A sample on this shift's run that day — samples are not customer stops, so
 *  they are listed on their own. */
export type ReportSample = {
  id: string;
  name: string;
  phone: string;
  items: { productName: string; unit: string; quantity: number }[];
  amount: number;
  /** delivered · not_delivered · pending (still out, nothing reported). */
  status: "delivered" | "not_delivered" | "pending";
  /** The rider has reported but the run is not completed yet. */
  reportedOnly: boolean;
  reason: string | null;
  paymentMethod: string | null;
};

export type RiderReportResult = {
  ok: boolean;
  shiftName: string;
  riderName: string | null;
  rows: ReportRow[];
  samples: ReportSample[];
  stats: {
    plannedCustomers: number;
    deliveredCustomers: number;
    /** Billed but brought back — the rider found nobody in, or was turned away. */
    chargedNotDeliveredCustomers: number;
    chargedNotDeliveredQty: number;
    notDeliveredCustomers: number;
    skippedCustomers: number;
    extraCustomers: number;
    deliveryRate: number;
    plannedQty: number;
    /** What the rider confirmed loading in the app, every product; null when he confirmed nothing. */
    tookQty: number | null;
    /** Sheet minus what he took, where he took less — not wastage, still at the retail centre. */
    shortAtLoadQty: number;
    /** What he took on top of the sheet. */
    extraAtLoadQty: number;
    deliveredQty: number;
    totalCash: number;
    /** First and last delivery the rider marked (ISO), and the minutes between them. */
    firstDeliveryAt: string | null;
    lastDeliveryAt: string | null;
    roundMinutes: number | null;
  };
  /** Until when a MANAGER may still edit this run (ISO). Admins are not limited. */
  managerEditUntil: string | null;
};

/**
 * How long a manager may change a rider's recorded work: 24 hours from the end
 * of the round — when the rider finished it, or when the midnight close did.
 * A round with no end on record (never started, or no round at all) counts from
 * the end of its day. After that only an admin may change it, so a day's
 * deliveries, returns and cash cannot be quietly reworked later.
 */
const MANAGER_EDIT_HOURS = 24;

function managerEditDeadline(route: { completedAt: Date | null; autoClosedAt: Date | null } | null, date: string): Date {
  const ended = route?.completedAt ?? route?.autoClosedAt ?? new Date(dateStrRangePKT(date).lte.getTime() + 1);
  return new Date(ended.getTime() + MANAGER_EDIT_HOURS * 60 * 60 * 1000);
}

/**
 * Who may change a rider's work for this shift and date: an admin always, a
 * manager only inside the window above. Checked on every save, so a dialog left
 * open past the deadline is refused rather than trusted.
 */
async function requireRiderEditor(shiftId: string, date: string): Promise<{ user: SessionUser } | { error: string }> {
  const user = await requireRole(FULL_ACCESS);
  if (user.role === "ADMIN") return { user };
  if (!shiftId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Missing shift or date." };
  const route = await db.route.findFirst({
    where: { shiftId, date: dateStrRangePKT(date) },
    orderBy: { createdAt: "asc" },
    select: { completedAt: true, autoClosedAt: true },
  });
  if (Date.now() > managerEditDeadline(route, date).getTime()) {
    return { error: `This shift ended more than ${MANAGER_EDIT_HOURS} hours ago — only an admin can change it now.` };
  }
  return { user };
}

const EMPTY_STATS = {
  plannedCustomers: 0, deliveredCustomers: 0, chargedNotDeliveredCustomers: 0, chargedNotDeliveredQty: 0, notDeliveredCustomers: 0, skippedCustomers: 0,
  extraCustomers: 0, deliveryRate: 0, plannedQty: 0, tookQty: null, shortAtLoadQty: 0, extraAtLoadQty: 0, deliveredQty: 0, totalCash: 0,
  firstDeliveryAt: null, lastDeliveryAt: null, roundMinutes: null,
};

// Samples that belong to this run: on the day's plan, delivered that day, or
// reported / marked not delivered that day.
async function samplesForRun(shiftId: string, range: { gte: Date; lte: Date }, plannedIds: string[]): Promise<ReportSample[]> {
  const rows = await db.sampleLead.findMany({
    where: {
      shiftId,
      OR: [
        { id: { in: plannedIds } },
        { deliveredAt: range },
        { riderOutcomeAt: range },
      ],
    },
    include: { items: { include: { product: { select: { name: true, unit: true } } } } },
    orderBy: { name: "asc" },
  });
  return rows.map((s) => {
    const delivered = !!s.deliveredAt && s.deliveredAt >= range.gte && s.deliveredAt <= range.lte;
    const status: ReportSample["status"] =
      s.status === "NOT_DELIVERED" ? "not_delivered"
      : delivered ? "delivered"
      : s.riderOutcome === "NOT_DELIVERED" ? "not_delivered"
      : s.riderOutcome === "DELIVERED" ? "delivered"
      : "pending";
    return {
      id: s.id,
      name: s.name,
      phone: s.phone,
      items: s.items.map((it) => ({ productName: it.product.name, unit: it.product.unit, quantity: Number(it.quantity) })),
      amount: s.items.reduce((t, it) => t + Number(it.quantity) * Number(it.ratePerUnit), 0),
      status,
      reportedOnly: s.status === "ASSIGNED" && !!s.riderOutcome,
      reason: s.notDeliveredReason,
      paymentMethod: s.paymentMethod,
    };
  });
}

export async function getRiderShiftReport(shiftId: string, date: string): Promise<RiderReportResult> {
  await requireRole(FULL_ACCESS);
  const blank: RiderReportResult = { ok: false, shiftName: "", riderName: null, rows: [], samples: [], stats: { ...EMPTY_STATS }, managerEditUntil: null };
  if (!shiftId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return blank;

  try {
    const range = dateStrRangePKT(date);

    const [shift, planned, route, shiftCustomers] = await Promise.all([
      db.shift.findUnique({ where: { id: shiftId }, include: { rider: { include: { user: { select: { name: true } } } } } }),
      // Reuse the exact "who should be delivered to" logic (override=true so a
      // non-delivery/locked day still reports rather than returning empty).
      getShiftCustomers(shiftId, date, true),
      db.route.findFirst({
        where: { shiftId, date: range },
        orderBy: { createdAt: "asc" },
        include: { stops: { select: { customerId: true, status: true, skipReason: true, cashCollected: true, deliveredAt: true } } },
      }),
      db.customer.findMany({ where: { shiftId }, select: { id: true, name: true, customerCode: true } }),
    ]);
    if (!shift) return blank;

    // Planned quantities per customer/product (skip synthetic sample stops).
    const plannedByCust = new Map<string, Map<string, ReportProductLine>>();
    const sheetNumber = new Map<string, number>();
    for (const stop of planned.stops) {
      if (stop.isSample) continue;
      if (!sheetNumber.has(stop.customerId)) sheetNumber.set(stop.customerId, stop.stopNumber);
      const m = plannedByCust.get(stop.customerId) ?? new Map<string, ReportProductLine>();
      for (const p of stop.products) {
        const line = m.get(p.productId) ?? { productId: p.productId, productName: p.productName, unit: p.unit, planned: 0, delivered: 0, returned: 0 };
        line.planned += p.quantity;
        m.set(p.productId, line);
      }
      plannedByCust.set(stop.customerId, m);
    }

    // Actual deliveries (mobile-written) for this shift's customers on the date,
    // plus the real cash they collected — a customer Payment with head RIDER_CASH
    // (RouteStop.cashCollected is not populated by the rider app).
    const custIds = shiftCustomers.map((c) => c.id);
    const custInfo = new Map(shiftCustomers.map((c) => [c.id, c]));
    const [deliveries, cashPayments] = custIds.length
      ? await Promise.all([
          db.deliveryEntry.findMany({
            where: { date: range, customerId: { in: custIds } },
            select: { date: true, customerId: true, productId: true, quantity: true, isReturn: true, isReplacement: true, complaintId: true, product: { select: { name: true, unit: true } } },
          }),
          db.payment.findMany({
            where: { head: "RIDER_CASH", customerId: { in: custIds }, date: range },
            select: { customerId: true, amount: true },
          }),
        ])
      : [[], []];

    const cashByCust = new Map<string, number>();
    for (const p of cashPayments) {
      if (!p.customerId) continue;
      cashByCust.set(p.customerId, (cashByCust.get(p.customerId) ?? 0) + Number(p.amount));
    }

    const deliveredByCust = new Map<string, Map<string, ReportProductLine>>();
    // The first delivery the app recorded for each customer — the time to show when
    // there is no stop on the round to carry one (a customer delivered off-route).
    const firstEntryAt = new Map<string, Date>();
    for (const d of deliveries) {
      // A complaint's refund or replacement is recorded in the office. The rider
      // neither delivered it nor brought it back, and counting it as "returned"
      // would let a manager's save below re-create it as a second credit.
      if (d.complaintId) continue;
      const m = deliveredByCust.get(d.customerId) ?? new Map<string, ReportProductLine>();
      const line = m.get(d.productId) ?? { productId: d.productId, productName: d.product.name, unit: d.product.unit, planned: 0, delivered: 0, returned: 0 };
      const qty = Number(d.quantity);
      if (d.isReplacement) { /* free replacement — no charge, don't count as delivered qty */ }
      else if (d.isReturn) line.returned += qty;
      else {
        line.delivered += qty;
        const seen = firstEntryAt.get(d.customerId);
        if (!seen || d.date < seen) firstEntryAt.set(d.customerId, d.date);
      }
      m.set(d.productId, line);
      deliveredByCust.set(d.customerId, m);
    }

    // Per-customer route outcome (status/skip/cash) written by the rider app.
    const stopByCust = new Map<string, { status: string; skipReason: string | null; cash: number | null; deliveredAt: Date | null }>();
    for (const s of route?.stops ?? []) {
      stopByCust.set(s.customerId, { status: s.status, skipReason: s.skipReason ?? null, cash: s.cashCollected != null ? Number(s.cashCollected) : null, deliveredAt: s.deliveredAt });
    }

    const allCustIds = new Set<string>([...plannedByCust.keys(), ...deliveredByCust.keys()]);
    const rows: ReportRow[] = [];
    for (const cid of allCustIds) {
      const info = custInfo.get(cid);
      const plannedMap = plannedByCust.get(cid);
      const deliveredMap = deliveredByCust.get(cid);

      // Merge product lines from both sides.
      const merged = new Map<string, ReportProductLine>();
      for (const [pid, l] of plannedMap ?? []) merged.set(pid, { ...l });
      for (const [pid, l] of deliveredMap ?? []) {
        const ex = merged.get(pid);
        if (ex) { ex.delivered += l.delivered; ex.returned += l.returned; }
        else merged.set(pid, { ...l });
      }
      const products = [...merged.values()];
      const plannedTotal = products.reduce((s, p) => s + p.planned, 0);
      const deliveredTotal = products.reduce((s, p) => s + p.delivered, 0);
      const returnedTotal = products.reduce((s, p) => s + p.returned, 0);

      const stop = stopByCust.get(cid);
      const isPlanned = !!plannedMap;
      const skipped = !!stop && stop.status.toLowerCase().includes("skip");
      let status: ReportRow["status"];
      // The rider's own mark on the stop decides, not whether a charge was written.
      // Two of the app's reasons — nobody in, and turned away — bill the customer
      // anyway, and a charge used to be read as proof of delivery. It said
      // "delivered" for milk that came home on the van and showed up in returns.
      if (skipped) status = deliveredTotal > 1e-6 ? "charged_not_delivered" : "skipped";
      else if (deliveredTotal > 1e-6) status = isPlanned ? "delivered" : "extra";
      else status = "not_delivered";

      rows.push({
        customerId: cid,
        name: info?.name ?? "Customer",
        customerCode: info?.customerCode ?? "",
        status,
        skipReason: stop?.skipReason ?? null,
        // When the rider marked the stop delivered in the app. Only for a delivery:
        // a skipped stop records no time, and a charge on one is not a delivery.
        markedAt:
          status === "delivered" || status === "extra"
            ? (stop?.deliveredAt ?? firstEntryAt.get(cid) ?? null)?.toISOString() ?? null
            : null,
        gapMinutes: null,
        stopNumber: sheetNumber.get(cid) ?? null,
        // Real rider cash from RIDER_CASH payments; fall back to the (usually empty)
        // RouteStop.cashCollected only if no payment was recorded.
        cashCollected: cashByCust.get(cid) ?? stop?.cash ?? null,
        plannedTotal,
        deliveredTotal,
        returnedTotal,
        products,
      });
    }

    // In the order the rider actually delivered, so the time from one door to the
    // next reads down the page. Stops with no delivery time (skipped, not reached)
    // follow, in the order of the day's sheet.
    const at = (r: ReportRow) => (r.markedAt ? Date.parse(r.markedAt) : null);
    rows.sort((a, b) => {
      const ta = at(a), tb = at(b);
      if (ta != null && tb != null && ta !== tb) return ta - tb;
      if ((ta == null) !== (tb == null)) return ta == null ? 1 : -1;
      return (a.stopNumber ?? Infinity) - (b.stopNumber ?? Infinity) || a.name.localeCompare(b.name);
    });
    let prev: number | null = null;
    for (const r of rows) {
      const t = at(r);
      if (t == null) continue;
      if (prev != null) r.gapMinutes = Math.round((t - prev) / 60_000);
      prev = t;
    }
    const timed = rows.filter((r) => r.markedAt);
    const firstDeliveryAt = timed[0]?.markedAt ?? null;
    const lastDeliveryAt = timed[timed.length - 1]?.markedAt ?? null;

    // The load the rider confirmed in the app, against the sheet. This is where
    // "planned 449, delivered 420" stops being a puzzle: 30 L was never taken.
    const load = { took: null as number | null, short: 0, extra: 0 };
    if (route) {
      const confirmedRows = await db.inventoryMovement.findMany({
        where: { type: "HANDED_OVER", reference: route.id },
        select: { productId: true, quantity: true },
      });
      if (confirmedRows.length) {
        const took = new Map<string, number>();
        for (const m of confirmedRows) took.set(m.productId, (took.get(m.productId) ?? 0) + Number(m.quantity));
        const planByProduct = new Map<string, number>();
        for (const m of plannedByCust.values()) for (const l of m.values()) planByProduct.set(l.productId, (planByProduct.get(l.productId) ?? 0) + l.planned);
        load.took = [...took.values()].reduce((s, q) => s + q, 0);
        for (const pid of new Set([...took.keys(), ...planByProduct.keys()])) {
          const diff = (took.get(pid) ?? 0) - (planByProduct.get(pid) ?? 0);
          if (diff < 0) load.short -= diff; else load.extra += diff;
        }
      }
    }

    const plannedCustomers = [...plannedByCust.keys()].length;
    const deliveredCustomers = rows.filter((r) => r.status === "delivered").length;
    const chargedNotDelivered = rows.filter((r) => r.status === "charged_not_delivered");
    const skippedCustomers = rows.filter((r) => r.status === "skipped").length;
    const notDeliveredCustomers = rows.filter((r) => r.status === "not_delivered").length;
    const extraCustomers = rows.filter((r) => r.status === "extra").length;
    const stats = {
      plannedCustomers,
      deliveredCustomers,
      chargedNotDeliveredCustomers: chargedNotDelivered.length,
      chargedNotDeliveredQty: chargedNotDelivered.reduce((s, r) => s + r.deliveredTotal, 0),
      notDeliveredCustomers,
      skippedCustomers,
      extraCustomers,
      deliveryRate: plannedCustomers > 0 ? Math.round((deliveredCustomers / plannedCustomers) * 100) : 0,
      plannedQty: rows.reduce((s, r) => s + r.plannedTotal, 0),
      tookQty: load.took,
      shortAtLoadQty: load.short,
      extraAtLoadQty: load.extra,
      // Only what actually reached a customer. Milk charged on a skipped stop is
      // counted on its own line above, since it is coming back.
      deliveredQty: rows.filter((r) => r.status !== "charged_not_delivered").reduce((s, r) => s + r.deliveredTotal, 0),
      totalCash: rows.reduce((s, r) => s + (r.cashCollected ?? 0), 0),
      firstDeliveryAt,
      lastDeliveryAt,
      roundMinutes: firstDeliveryAt && lastDeliveryAt ? Math.round((Date.parse(lastDeliveryAt) - Date.parse(firstDeliveryAt)) / 60_000) : null,
    };

    const samples = await samplesForRun(shiftId, range, planned.stops.filter((s) => s.isSample).map((s) => s.customerId.replace(/^sample:/, "")));

    return {
      ok: true, shiftName: shift.name, riderName: shift.rider?.user.name ?? null, rows, samples, stats,
      managerEditUntil: managerEditDeadline(route ? { completedAt: route.completedAt, autoClosedAt: route.autoClosedAt } : null, date).toISOString(),
    };
  } catch {
    return blank;
  }
}

// ── Manager edit / spoilage refund-replace ────────────────────────────────────
// DeliveryEntry, RIDER_CASH Payment, and InventoryMovement are the shared
// primitives every downstream screen (bill, ledger, payment-receiving, dashboard,
// rider-cash, inventory) derives from live — so editing them here reflects
// everywhere. (Generated bills also self-refresh from live deliveries on open.)
// Spoilage refunds are tagged in `notes` so a later delivery correction never
// clobbers them; replacements are isReplacement rows (also excluded).

const SPOILAGE_REFUND_NOTE = "Spoilage refund";
const SPOILAGE_REPLACE_NOTE = "Spoilage replacement";

export type ActionResult = { ok: true } | { ok: false; error: string };
export type RiderEditLine = { productId: string; delivered: number; returned: number };
export type RiderEditInput = { customerId: string; shiftId: string; date: string; cash: number; lines: RiderEditLine[] };

function revalidateRiderEdit() {
  for (const p of ["/customers/rider-report", "/billing/invoices", "/billing/payment-receiving", "/payments/recovery", "/payments/rider-cash", "/ledgers", "/inventory", "/"]) {
    revalidatePath(p);
  }
}

// The rate a customer is charged for a product (their subscription rate, else the product default).
async function rateFor(customerId: string, productIds: string[]): Promise<Map<string, number>> {
  if (!productIds.length) return new Map();
  const [cps, prods] = await Promise.all([
    db.customerProduct.findMany({ where: { customerId, productId: { in: productIds } }, select: { productId: true, ratePerUnit: true } }),
    db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, defaultRate: true } }),
  ]);
  const m = new Map<string, number>();
  for (const p of prods) m.set(p.id, Number(p.defaultRate));
  for (const c of cps) m.set(c.productId, Number(c.ratePerUnit));
  return m;
}

const validDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

// Manager override of a rider's recorded work: reconcile delivered + returned per
// product, and the rider cash, for one customer on one date.
export async function saveRiderEdits(input: RiderEditInput): Promise<ActionResult> {
  // This rewrites the day's deliveries, which is the customer's bill: an admin,
  // or a manager within 24 hours of the shift ending.
  const allowed = await requireRiderEditor(input.shiftId, input.date);
  if ("error" in allowed) return { ok: false, error: allowed.error };
  const { user } = allowed;
  if (!input.customerId || !validDate(input.date)) return { ok: false, error: "Missing customer or date." };
  const cash = Number(input.cash) || 0;
  if (cash < 0) return { ok: false, error: "Cash can't be negative." };
  const lines = (input.lines ?? []).filter((l) => l.productId);
  for (const l of lines) {
    if (!Number.isFinite(l.delivered) || l.delivered < 0 || !Number.isFinite(l.returned) || l.returned < 0)
      return { ok: false, error: "Delivered and returned must be valid, non-negative numbers." };
  }

  const when = pktNoonToUTC(input.date);
  const range = dateStrRangePKT(input.date);
  const rateMap = await rateFor(input.customerId, lines.map((l) => l.productId));
  const shift = input.shiftId ? await db.shift.findUnique({ where: { id: input.shiftId }, select: { riderId: true } }) : null;
  const riderId = shift?.riderId ?? null;

  try {
    await db.$transaction(async (tx) => {
      for (const l of lines) {
        const rate = rateMap.get(l.productId) ?? 0;
        // Normal delivery → reconcile to `delivered`. The rows are rewritten, so
        // the glass bottles the rider recorded on them are carried across — never
        // more than the litres now delivered (one bottle is one litre).
        const deliveredWhere = { customerId: input.customerId, productId: l.productId, date: range, isReturn: false, isReplacement: false, complaintId: null };
        const hadBottles = (await tx.deliveryEntry.aggregate({ where: deliveredWhere, _sum: { bottles: true } }))._sum.bottles ?? 0;
        await tx.deliveryEntry.deleteMany({ where: deliveredWhere });
        if (l.delivered > 1e-9) {
          const bottles = hadBottles > 0 ? Math.min(hadBottles, Math.floor(l.delivered + 1e-9)) : null;
          await tx.deliveryEntry.create({ data: { customerId: input.customerId, productId: l.productId, date: when, quantity: new Prisma.Decimal(l.delivered), unitRate: new Prisma.Decimal(rate), riderId, notes: "Manager edit", bottles } });
        }
        // Rider return → reconcile to `returned`, WITHOUT touching spoilage refunds
        // or complaint refunds (both also isReturn). `not` alone skips null-notes
        // rows, so OR them in.
        const returnWhere = { customerId: input.customerId, productId: l.productId, date: range, isReturn: true, complaintId: null, OR: [{ notes: null }, { notes: { not: SPOILAGE_REFUND_NOTE } }] };
        const hadBackBottles = (await tx.deliveryEntry.aggregate({ where: returnWhere, _sum: { bottles: true } }))._sum.bottles ?? 0;
        await tx.deliveryEntry.deleteMany({ where: returnWhere });
        if (l.returned > 1e-9) {
          const bottles = hadBackBottles > 0 ? Math.min(hadBackBottles, Math.floor(l.returned + 1e-9)) : null;
          await tx.deliveryEntry.create({ data: { customerId: input.customerId, productId: l.productId, date: when, quantity: new Prisma.Decimal(l.returned), unitRate: new Prisma.Decimal(rate), isReturn: true, riderId, notes: "Manager edit", bottles } });
        }
      }
      // Rider cash → upsert the RIDER_CASH payment for the date.
      await tx.payment.deleteMany({ where: { customerId: input.customerId, head: "RIDER_CASH", date: range } });
      if (cash > 1e-9) {
        await tx.payment.create({ data: { customerId: input.customerId, head: "RIDER_CASH", amount: new Prisma.Decimal(cash), date: when, riderId, notes: "Manager edit — rider cash", enteredById: user.id } });
      }
    });
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not save the edits. Please try again." };
  } finally {
    revalidateRiderEdit();
  }
}

// Spoiled milk the customer reported after delivery → a credit that reduces what
// they owe (bill returnsAmt, ledger credit, outstanding). No cash moves.
export async function refundSpoiled(customerId: string, date: string, productId: string, qty: number, shiftId = ""): Promise<ActionResult> {
  // A credit on the bill: an admin, or a manager within 24 hours of the shift ending.
  const allowed = await requireRiderEditor(shiftId, date);
  if ("error" in allowed) return { ok: false, error: allowed.error };
  const quantity = Number(qty);
  if (!customerId || !productId || !validDate(date)) return { ok: false, error: "Missing details." };
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, error: "Enter a spoiled quantity greater than 0." };
  const rate = (await rateFor(customerId, [productId])).get(productId) ?? 0;
  try {
    await db.deliveryEntry.create({
      data: { customerId, productId, date: pktNoonToUTC(date), quantity: new Prisma.Decimal(quantity), unitRate: new Prisma.Decimal(rate), isReturn: true, notes: SPOILAGE_REFUND_NOTE },
    });
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not record the refund. Please try again." };
  } finally {
    revalidateRiderEdit();
  }
}

// Spoiled milk replaced with fresh — free to the customer (isReplacement), and the
// stock is drawn from storage (which includes what the rider returned).
export async function replaceSpoiled(customerId: string, date: string, productId: string, qty: number, shiftId = ""): Promise<ActionResult> {
  const allowed = await requireRiderEditor(shiftId, date);
  if ("error" in allowed) return { ok: false, error: allowed.error };
  const { user } = allowed;
  const quantity = Number(qty);
  if (!customerId || !productId || !validDate(date)) return { ok: false, error: "Missing details." };
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, error: "Enter a quantity greater than 0." };
  const rate = (await rateFor(customerId, [productId])).get(productId) ?? 0;
  const when = pktNoonToUTC(date);
  try {
    return await db.$transaction(async (tx) => {
      // Same shared "stock:" lock the waste-entry / OTC-sale outflows use, then a
      // race-free on-hand re-read (on-hand already includes rider-returned stock).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock:" + productId}))`;
      const onHand = (await getOnHandByProduct()).get(productId) ?? 0;
      if (quantity > onHand + 1e-6) {
        return { ok: false as const, error: `Cannot replace more than current stock (${onHand.toFixed(onHand % 1 === 0 ? 0 : 1)} in storage).` };
      }
      await tx.deliveryEntry.create({
        data: { customerId, productId, date: when, quantity: new Prisma.Decimal(quantity), unitRate: new Prisma.Decimal(rate), isReplacement: true, notes: SPOILAGE_REPLACE_NOTE },
      });
      await tx.inventoryMovement.create({
        data: { date: when, type: "REPLACEMENT", productId, quantity: new Prisma.Decimal(quantity), reason: SPOILAGE_REPLACE_NOTE, enteredById: user.id },
      });
      return { ok: true as const };
    });
  } catch {
    return { ok: false, error: "Could not record the replacement. Please try again." };
  } finally {
    revalidateRiderEdit();
  }
}
