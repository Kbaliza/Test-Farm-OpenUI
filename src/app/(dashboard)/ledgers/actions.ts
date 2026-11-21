"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { unitLabel } from "@/lib/units";
import { heldCommitmentWhere, getOnHandByProduct } from "@/lib/inventory-onhand";
import { db } from "@/lib/db";
import { ownerName, ownerFundingLabel, OWNER_FUNDING_HEAD, isFarmOwner } from "@/lib/farm-owners";
import { ALL_HEADS, HEAD_PAYMENT_WHERE } from "@/lib/head-balances";
import { PAYMENT_HEAD_LABELS, OWNERS_HEAD } from "@/lib/payment-heads";
import { retailMartLedger } from "./retail-ledger";
import { farmSaleLedger } from "./farm-sale-ledger";
import { FARM_SALE_WALKIN } from "@/lib/farm-sale-catalog";
import { dateStrRangePKT, todayPKTString, toDateStrPKT } from "@/lib/pkt";
import { computeCustomerOutstanding, deliveredValueByCustomer } from "@/lib/customer-balance";

// ── shared types ──────────────────────────────────────────────────────────────

export type EntityOption = { id: string; name: string; sub?: string };

export type LedgerSelectors = {
  customers: EntityOption[];
  products: EntityOption[];
  vendors: EntityOption[];
  /** Consignment shops — see /retail. Kept apart from suppliers. */
  retailVendors: EntityOption[];
  employees: EntityOption[];
  expenseCategories: EntityOption[];
  /** Buyers of non-milk goods — the vendors that actually have a farm sale, plus a
   *  sentinel for cash walk-ins so those sales are reachable too. */
  farmSaleBuyers: EntityOption[];
  dbReady: boolean;
};

export type SummaryCard = { label: string; value: string; sub: string; color: string };

export type EntityInfo = {
  name: string;
  initials: string;
  avatarBg: string;
  avatarTc: string;
  meta: string;
  badges: { label: string; cls: string }[];
  /**
   * A live figure for the header, independent of the date range — for a product,
   * what is in inventory right now, read by the same formula as the Inventory page.
   */
  live?: { label: string; value: string; negative: boolean };
};

/** What kind of stock event a product-ledger row is, from the record that wrote it. */
export type LedgerCategory = "in" | "out" | "returned" | "wasted";

/**
 * Billed but never handed over: charged to the customer on a stop the rider marked
 * skipped, so the stock came back on the van. The same rule the Rider Item Returns
 * page and the reconciliation use ("Charged, came back").
 *
 * Informational — no stock moves on this row. The send already left stock on the
 * product ledger, and the milk comes back through the rider's end-of-shift return.
 */
export type BilledReturn = {
  id: string;
  date: string;
  productId: string;
  productName: string;
  unit: string;
  customer: string;
  qty: number;
  amount: number;
  reason: string;
  by: string;
};

export type LedgerRow = {
  id: string;
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  qty?: string;
  rate?: string;
  reference?: string;
  by?: string;
  note?: string;
  head?: string;
  products?: string;              // "2 L Buffalo Milk, 1 kg Yoghurt" — Over-the-Counter line detail
  mode?: "cash" | "credit";       // how an OTC transaction was settled
  category?: LedgerCategory;      // product ledger only
};

export type LedgerData = {
  type: string;
  entityInfo: EntityInfo;
  summary: SummaryCard[];
  rows: LedgerRow[];
  /** Product ledger only: this product's billed returns in the same dates. */
  billedReturns?: BilledReturn[];
};

export type LedgerResult = { ok: true; data: LedgerData } | { ok: false; error: string };

// ── constants ─────────────────────────────────────────────────────────────────

const HEAD_LABELS: Record<string, string> = PAYMENT_HEAD_LABELS;

const MOVE_LABELS: Record<string, string> = {
  PRODUCED:         "Produced from farm",
  DISPATCHED:       "Dispatched to packaging",
  ARRIVED:          "Arrived at packaging",
  HANDED_OVER:      "Handed over to rider",
  DELIVERED:        "Delivered to customer",
  RETURNED:         "Return from rider",
  WASTAGE:          "Wastage recorded",
  KITCHEN_USE:      "Kitchen use",
  CALF_USE:         "Calf use",
  REPLACEMENT:      "Replacement",
  COUNTER_SALE:     "Over the counter sale",
  COUNTER_PURCHASE: "Over the counter purchase",
};

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ── helpers ───────────────────────────────────────────────────────────────────

function ini(name: string) {
  return name.split(" ").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
}

// Effective (paid) days in a month for a daily-wage employee — mirrors the Salaries
// tab's calcSalary EXACTLY so the employee ledger and the Salaries tab agree: days
// with no attendance record default to PRESENT (Sundays → HOLIDAY), and the count
// stops at today for the running month. HALF_DAY counts as 0.5.
function effectiveWageDays(
  year: number,
  month: number,
  attByDate: Map<string, string>,
  todayStr: string
): number {
  const totalDays = new Date(year, month, 0).getDate(); // month is 1-based → last day
  let present = 0, half = 0;
  for (let d = 1; d <= totalDays; d++) {
    const ds = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (ds > todayStr) break;
    const dow = new Date(year, month - 1, d).getDay();
    const status = attByDate.get(ds) ?? (dow === 0 ? "HOLIDAY" : "PRESENT");
    if (status === "PRESENT") present++;
    else if (status === "HALF_DAY") half++;
  }
  return present + half * 0.5;
}

// "2 L Buffalo Milk, 1 kg Yoghurt" from OTC sale/purchase lines.
function fmtProducts(
  lines: { quantity: unknown; unit: string; product: { name: string } }[]
): string {
  return lines
    .map((l) => `${Number(l.quantity)} ${l.unit} ${l.product.name}`)
    .join(", ");
}

// Math.abs() here used to destroy the sign, so a customer in credit (−5,000)
// displayed as "Rs 5,000" — indistinguishable from owing it — and an overdrawn
// head rendered as a healthy positive. Keep the minus.
function rs(n: number) {
  const v = Math.round(n);
  return (v < 0 ? "−Rs " : "Rs ") + Math.abs(v).toLocaleString("en-PK");
}

function dateRange(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;
  const f: { gte?: Date; lte?: Date } = {};
  if (from) f.gte = dateStrRangePKT(from).gte;
  if (to)   f.lte = dateStrRangePKT(to).lte;
  return f;
}

// ── selectors ─────────────────────────────────────────────────────────────────

export async function getLedgerSelectors(): Promise<LedgerSelectors> {
  await requireRole(FULL_ACCESS);
  try {
    const [customers, products, vendors, retailVendors, employees, expenseCategories, farmBuyerRows] =
      await Promise.all([
      db.customer.findMany({
        select: { id: true, name: true, customerCode: true },
        orderBy: { name: "asc" },
      }),
      db.product.findMany({
        where: { active: true },
        select: { id: true, name: true, unit: true },
        orderBy: { name: "asc" },
      }),
      db.vendor.findMany({
        select: { id: true, name: true, phone: true },
        orderBy: { name: "asc" },
      }),
      db.retailVendor.findMany({
        select: { id: true, name: true, areaName: true, city: true },
        orderBy: { name: "asc" },
      }),
      // Disabled staff included: their pay history must stay readable.
      db.employee.findMany({
        select: { id: true, name: true, role: true, active: true },
        orderBy: [{ active: "desc" }, { name: "asc" }],
      }),
      db.expenseCategory.findMany({
        where: { active: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      // Only the vendors that have actually bought farm goods — listing every
      // supplier here would bury the handful of beoparis among a hundred names.
      db.farmSale.findMany({
        where: { vendorId: { not: null } },
        select: { vendor: { select: { id: true, name: true, phone: true } } },
        distinct: ["vendorId"],
      }),
    ]);
    return {
      customers: customers.map((c) => ({ id: c.id, name: c.name, sub: c.customerCode })),
      products:  products.map((p)  => ({ id: p.id, name: p.name, sub: p.unit })),
      vendors:   vendors.map((v)   => ({ id: v.id, name: v.name, sub: v.phone ?? undefined })),
      retailVendors: retailVendors.map((v) => ({
        id: v.id,
        name: v.name,
        sub: [v.areaName, v.city].filter(Boolean).join(", ") || undefined,
      })),
      employees: employees.map((e) => ({
        id: e.id, name: e.name,
        sub: e.active ? e.role ?? undefined : [e.role, "disabled"].filter(Boolean).join(" · "),
      })),
      expenseCategories: [
        { id: "__all__",    name: "All" },
        { id: "__retail__", name: "Retail" },
        { id: "__farm__",   name: "Farm" },
        ...expenseCategories.map((c) => ({ id: c.id, name: c.name })),
      ],
      // The walk-in sentinel is always offered, so cash farm sales are reachable
      // even before any vendor has bought anything.
      farmSaleBuyers: [
        { id: FARM_SALE_WALKIN, name: "Cash walk-ins", sub: "counter sales with no account" },
        ...farmBuyerRows
          .map((r) => r.vendor)
          .filter((v): v is { id: string; name: string; phone: string | null } => !!v)
          .map((v) => ({ id: v.id, name: v.name, sub: v.phone ?? undefined }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ],
      dbReady: true,
    };
  } catch {
    return { customers: [], products: [], vendors: [], retailVendors: [], employees: [], expenseCategories: [], farmSaleBuyers: [], dbReady: false };
  }
}

// ── dispatcher ────────────────────────────────────────────────────────────────

export async function getLedgerData(
  type: string, entityId: string, from?: string, to?: string
): Promise<LedgerResult> {
  await requireRole(FULL_ACCESS);
  const dr = dateRange(from, to);
  try {
    if (type === "customer") return customerLedger(entityId, dr);
    if (type === "product")  return productLedger(entityId, dr);
    if (type === "head")     return headLedger(entityId, dr);
    if (type === "owner")    return ownerLedger(entityId, dr);
    if (type === "vendor")   return vendorLedger(entityId, dr);
    if (type === "retail")   return retailMartLedger(entityId, dr);
    if (type === "farmsale") return farmSaleLedger(entityId, dr);
    if (type === "wastage")  return wastageLedger(dr);
    if (type === "employee") return employeeLedger(entityId, dr);
    if (type === "expense") {
      if (entityId === "__all__")    return expenseAggregateLedger(null,     dr);
      if (entityId === "__retail__") return expenseAggregateLedger("retail",  dr);
      if (entityId === "__farm__")   return expenseAggregateLedger("farm",    dr);
      return expenseLedger(entityId, dr);
    }
    return { ok: false, error: "Unknown ledger type." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to load ledger." };
  }
}

// ── customer ledger ───────────────────────────────────────────────────────────

async function customerLedger(
  customerId: string,
  dr?: { gte?: Date; lte?: Date }
): Promise<LedgerResult> {
  const [customer, deliveries, payments, charges, otcSales] = await Promise.all([
    db.customer.findUnique({
      where: { id: customerId },
      include: { shift: { select: { name: true } }, area: { select: { name: true } } },
    }),
    // Real deliveries recorded by the rider app — the source of truth for what
    // was delivered. Nothing shows here until a delivery is actually recorded.
    db.deliveryEntry.findMany({
      where: { customerId, ...(dr ? { date: dr } : {}) },
      select: {
        id: true, date: true, quantity: true, unitRate: true, isReturn: true, isReplacement: true, notes: true,
        complaint: { select: { category: true, description: true } },
        product: { select: { name: true, unit: true } },
      },
      orderBy: { date: "asc" },
    }),
    db.payment.findMany({
      where: { customerId, ...(dr ? { date: dr } : {}) },
      orderBy: { date: "asc" },
    }),
    // Delivery charges are a field on Invoice, NOT a DeliveryEntry — the flat fee
    // billed once per period.
    db.invoice.findMany({
      // A one-off allowance is carried on the invoice the same way, so a bill
      // that has one belongs here even when no delivery charge was raised.
      where: { customerId, OR: [{ deliveryCharge: { gt: 0 } }, { discount: { gt: 0 } }] },
      select: { id: true, deliveryCharge: true, discount: true, periodEnd: true, periodStart: true, year: true, month: true, half: true },
    }),
    // ALL counter sales (cash and credit). A credit sale is billed and unpaid; a
    // cash sale is billed AND paid on the spot (net zero on the balance) — both
    // are shown so the ledger is complete.
    db.otcSale.findMany({
      where: { customerId, ...(dr ? { date: dr } : {}) },
      select: {
        id: true, date: true, invoiceNo: true, totalAmount: true, paidAmount: true, paymentStatus: true, narration: true,
        lines: { select: { quantity: true, unit: true, product: { select: { name: true } } } },
      },
      orderBy: { date: "asc" },
    }),
  ]);
  if (!customer) return { ok: false, error: "Customer not found." };


  type R = LedgerRow & { _d: Date };
  const all: R[] = [];

  for (const d of deliveries) {
    const amt = Number(d.quantity) * Number(d.unitRate);
    const unit = unitLabel(d.product.unit);
    const qtyRate = { qty: `${Number(d.quantity)} ${unit}`, rate: `Rs ${Number(d.unitRate)}` };
    // A complaint's refund/replacement names itself, and carries what the customer said.
    const complaintNote = d.complaint ? `${d.complaint.category}: ${d.complaint.description}` : undefined;
    if (d.complaint && d.isReplacement) {
      all.push({ _d: d.date, id: d.id, date: d.date.toISOString(), description: `Complaint replacement — ${d.product.name}`, debit: 0, credit: 0, balance: 0, ...qtyRate, note: complaintNote });
    } else if (d.complaint && d.isReturn) {
      all.push({ _d: d.date, id: d.id, date: d.date.toISOString(), description: `Complaint refund — ${d.product.name}`, debit: 0, credit: amt, balance: 0, ...qtyRate, note: complaintNote });
    } else if (d.isReplacement) {
      all.push({ _d: d.date, id: d.id, date: d.date.toISOString(), description: `Replacement — ${d.product.name}`, debit: 0, credit: 0, balance: 0, ...qtyRate, note: d.notes ?? undefined });
    } else if (d.isReturn) {
      all.push({ _d: d.date, id: d.id, date: d.date.toISOString(), description: `Return — ${d.product.name}`, debit: 0, credit: amt, balance: 0, ...qtyRate, note: d.notes ?? undefined });
    } else {
      all.push({ _d: d.date, id: d.id, date: d.date.toISOString(), description: `Delivery — ${d.product.name}`, debit: amt, credit: 0, balance: 0, ...qtyRate, note: d.notes ?? undefined });
    }
  }

  // Delivery charge — dated at the end of the period it was billed for.
  for (const inv of charges) {
    const when = inv.periodEnd ?? inv.periodStart ?? new Date(inv.year, inv.month - 1, 28);
    if (dr?.gte && when < dr.gte) continue;
    if (dr?.lte && when > dr.lte) continue;
    if (Number(inv.deliveryCharge) > 0) {
      all.push({
        _d: when, id: `dc-${inv.id}`,
        date: when.toISOString(),
        description: "Delivery charge",
        debit: Number(inv.deliveryCharge), credit: 0, balance: 0,
      });
    }
    // Shown on its own line rather than netted into the charge above, so the
    // ledger says plainly that an allowance was given and when.
    if (Number(inv.discount) > 0) {
      all.push({
        _d: when, id: `disc-${inv.id}`,
        date: when.toISOString(),
        description: "Discount on bill",
        debit: 0, credit: Number(inv.discount), balance: 0,
      });
    }
  }

  // Counter sales. The customer owes only the unpaid remainder: it's billed at
  // the full amount (debit) and credited by whatever was settled at the counter
  // (paidAmount) — so a fully-paid sale nets to zero, a partial leaves the
  // remainder, and a pure-credit sale adds the whole amount to the balance.
  for (const s of otcSales) {
    const amt = Number(s.totalAmount);
    const paidHere = Number(s.paidAmount);
    all.push({
      _d: s.date, id: `otc-${s.id}`,
      date: s.date.toISOString(),
      description: `Over-the-counter sale — ${s.invoiceNo}`,
      debit: amt, credit: paidHere, balance: 0,
      reference: s.invoiceNo,
      products: fmtProducts(s.lines),
      mode: paidHere >= amt - 0.005 ? "cash" : "credit",
      note: s.narration ?? undefined,
    });
  }

  for (const p of payments) {
    all.push({
      _d: p.date, id: p.id,
      date: p.date.toISOString(),
      description: `Payment — ${HEAD_LABELS[p.head] ?? p.head}`,
      debit: 0, credit: Number(p.amount), balance: 0,
      reference: HEAD_LABELS[p.head] ?? p.head,
      note: p.notes ?? undefined,
    });
  }

  all.sort((a, b) => a._d.getTime() - b._d.getTime());

  // "Current balance" is the customer's REAL, all-time balance — the same figure
  // Recovery, WhatsApp, Payment Receiving and the dashboard show, from the same
  // canonical helper (actual deliveries + fees + OTC credit − payments).
  const currentBal = (await computeCustomerOutstanding([customerId])).get(customerId) ?? 0;

  // The running-balance column starts from where the account stood just before the
  // filtered window, so the last row still lands on the true balance — using the
  // same components as computeCustomerOutstanding.
  let bal = Number(customer.openingBalance);
  if (dr?.gte) {
    const [priorDelivered, priorPays, priorOtcCredit] = await Promise.all([
      deliveredValueByCustomer([customerId], { lt: dr.gte }),
      db.payment.aggregate({ _sum: { amount: true }, where: { customerId, date: { lt: dr.gte } } }),
      db.otcSale.aggregate({ _sum: { totalAmount: true, paidAmount: true }, where: { customerId, date: { lt: dr.gte } } }),
    ]);
    const priorFee = charges
      .filter((i) => { const w = i.periodEnd ?? i.periodStart; return w ? w < dr.gte! : false; })
      .reduce((s, i) => s + Number(i.deliveryCharge) - Number(i.discount), 0);
    bal +=
      (priorDelivered.get(customerId) ?? 0) +
      priorFee +
      (Number(priorOtcCredit._sum.totalAmount ?? 0) - Number(priorOtcCredit._sum.paidAmount ?? 0)) -
      Number(priorPays._sum.amount ?? 0);
  }

  const rows: LedgerRow[] = all.map(({ _d, ...r }) => {
    bal = bal + r.debit - r.credit;
    return { ...r, balance: bal };
  });

  const totalBilled = rows.reduce((s, r) => s + r.debit, 0);
  const totalPaid   = rows.reduce((s, r) => s + r.credit, 0);

  return { ok: true, data: {
    type: "customer",
    entityInfo: {
      name: customer.name, initials: ini(customer.name),
      avatarBg: "#E6F1FB", avatarTc: "#0C447C",
      meta: `${customer.phone} · ${customer.address ?? ""} · ${customer.area?.name ?? ""}`,
      badges: [
        { label: customer.customerCode, cls: "blue" },
        { label: customer.shift?.name ?? "No shift", cls: "gray" },
        { label: currentBal > 0 ? `Balance: ${rs(currentBal)}` : "Clear", cls: currentBal > 0 ? "red" : "green" },
      ],
    },
    summary: [
      { label: "Current balance", value: rs(currentBal), sub: currentBal > 0 ? "Amount owed" : "Clear", color: currentBal > 0 ? "#A32D2D" : "#3B6D11" },
      { label: "Total billed", value: rs(totalBilled), sub: `${rows.filter(r => r.debit > 0).length} charges`, color: "#185FA5" },
      { label: "Total paid", value: rs(totalPaid), sub: `${payments.length} payments`, color: "#3B6D11" },
      { label: "Shift", value: customer.shift?.name ?? "—", sub: "Active", color: "#111" },
      { label: "Phone", value: customer.phone, sub: customer.customerCode, color: "#111" },
    ],
    rows,
  }};
}

// ── product ledger ────────────────────────────────────────────────────────────

const IN_MOVES = new Set(["PRODUCED", "ARRIVED", "RETURNED", "COUNTER_PURCHASE"]);

/**
 * One stock event, from whichever table records it.
 *
 * The ledger used to read InventoryMovement alone, which meant it silently
 * omitted every way stock moves that is NOT a movement row: product left at a
 * shop, quantities committed to a round, spare stock out with a rider, and — once
 * retail products became stock-tracked — the count that puts them on the shelf in
 * the first place. A retail product's ledger showed counter sales going out and
 * nothing at all coming in.
 *
 * These are the same sources getOnHandByProduct() reads, so the history is now
 * complete. It is still a linear running balance: on-hand clamps at zero and this
 * does not, so the two can part company for a product that has gone negative.
 */
type StockEvent = {
  id: string;
  date: Date;
  description: string;
  qty: number;
  isIn: boolean;
  by: string;
  category: LedgerCategory;
};

/** Shown when nothing on record says who made an entry. Never "System" — that was not true. */
const NOT_RECORDED = "Not recorded";

async function productStockEvents(
  productId: string,
  dr?: { gte?: Date; lte?: Date },
  /** Look up who made each entry. Off for the opening balance, which shows no rows. */
  withNames = true,
): Promise<StockEvent[]> {
  const within = dr ? { date: dr } : {};
  const [moves, stockIn, drops, planned, extras] = await Promise.all([
    db.inventoryMovement.findMany({
      where: { productId, ...within },
      include: {
        rider: { include: { user: { select: { name: true } } } },
        enteredBy: { select: { name: true } },
      },
    }),
    db.retailStockEntry.findMany({
      where: { productId, voidedAt: null, ...within },
      include: { enteredBy: { select: { name: true } } },
    }),
    db.retailPlacementLine.findMany({
      where: { productId, placement: { voidedAt: null, ...(dr ? { date: dr } : {}) } },
      include: { placement: { select: { date: true, placementNo: true, retailVendor: { select: { name: true } }, enteredBy: { select: { name: true } } } } },
    }),
    db.routeStopItem.findMany({
      where: {
        productId,
        ...heldCommitmentWhere(),
        ...(dr ? { routeStop: { route: { date: dr } } } : {}),
      },
      include: {
        routeStop: {
          select: {
            route: { select: { date: true, shift: { select: { name: true } } } },
            customer: { select: { name: true, customerCode: true } },
          },
        },
      },
    }),
    db.riderExtraItem.findMany({
      where: { productId, ...within },
      include: { rider: { include: { user: { select: { name: true } } } } },
    }),
  ]);

  // Who made each website entry, from the audit log — the entry itself only
  // carries a name for a rider, or on the few forms that store one.
  const audited = new Map<string, string>();
  if (withNames) {
    const unnamed = moves.filter((m) => !m.rider?.user.name && !m.enteredBy?.name).map((m) => m.id);
    for (let i = 0; i < unnamed.length; i += 1000) {
      const rows = await db.auditLog.findMany({
        where: { tableName: "InventoryMovement", operation: "INSERT", rowId: { in: unnamed.slice(i, i + 1000) }, actorName: { not: null } },
        select: { rowId: true, actorName: true },
      });
      for (const r of rows) if (r.rowId && r.actorName?.trim()) audited.set(r.rowId, r.actorName.trim());
    }
  }

  const events: StockEvent[] = [];

  for (const m of moves) {
    events.push({
      id: m.id,
      date: m.date,
      description: (MOVE_LABELS[m.type] ?? m.type) + (m.reason ? ` — ${m.reason}` : ""),
      qty: Number(m.quantity),
      isIn: IN_MOVES.has(m.type),
      by: m.rider?.user.name ?? m.enteredBy?.name ?? audited.get(m.id) ?? NOT_RECORDED,
      category: m.type === "RETURNED" ? "returned" : m.type === "WASTAGE" ? "wasted" : IN_MOVES.has(m.type) ? "in" : "out",
    });
  }

  for (const e of stockIn) {
    events.push({
      id: e.id,
      date: e.date,
      description: "Counted into retail stock" + (e.note ? ` — ${e.note}` : ""),
      qty: Number(e.quantity),
      isIn: true,
      by: e.enteredBy?.name ?? NOT_RECORDED,
      category: "in",
    });
  }

  // The full dropped quantity, forever — it left storage the day it was dropped,
  // and reporting it sold or expired only decides who owns the money.
  for (const l of drops) {
    events.push({
      id: l.id,
      date: l.placement.date,
      description: `Dropped at ${l.placement.retailVendor?.name ?? "a shop"} — ${l.placement.placementNo}`,
      qty: Number(l.quantity),
      isIn: false,
      by: l.placement.enteredBy?.name ?? NOT_RECORDED,
      category: "out",
    });
  }

  // Named, not aggregated. Each RouteStopItem is ALREADY one customer's line for
  // this product, so "Committed to a round — Islamabad Morning" was throwing away
  // a name that was one join away: you could see 40 eggs left storage and not who
  // any of them went to.
  //
  // The quantity stays plannedQty, which is what actually left storage. When the
  // rider delivered a different amount the shortfall comes back as a RETURNED
  // movement, so counting actualQty here instead would double-count that return.
  // actualQty is shown alongside when it differs, because "sent 12, delivered 10"
  // is the question this row otherwise invites.
  for (const it of planned) {
    const c = it.routeStop.customer;
    const who = c ? `${c.customerCode} ${c.name}` : "a customer";
    const plannedQty = Number(it.plannedQty);
    const actual = it.actualQty == null ? null : Number(it.actualQty);
    const differs = actual !== null && Math.abs(actual - plannedQty) > 1e-6;
    events.push({
      id: it.id,
      date: it.routeStop.route.date,
      description: `Sent to ${who}${differs ? ` — delivered ${actual}` : ""}`,
      qty: plannedQty,
      isIn: false,
      by: it.routeStop.route.shift?.name ?? "Round",
      category: "out",
    });
  }

  // Net still out with the rider; a fully returned batch nets to zero and is
  // left off rather than shown as an in and an out that cancel.
  for (const x of extras) {
    const net = Number(x.givenQty) - Number(x.returnedQty);
    if (Math.abs(net) < 1e-6) continue;
    events.push({
      id: x.id,
      date: x.date,
      description: "Extra stock with rider",
      qty: Math.abs(net),
      isIn: net < 0,
      by: x.rider?.user.name ?? NOT_RECORDED,
      category: net < 0 ? "returned" : "out",
    });
  }

  return events.sort((a, b) => a.date.getTime() - b.date.getTime());
}

async function productLedger(
  productId: string,
  dr?: { gte?: Date; lte?: Date }
): Promise<LedgerResult> {
  const [product, events, onHand, billedReturns] = await Promise.all([
    db.product.findUnique({ where: { id: productId } }),
    productStockEvents(productId, dr),
    getOnHandByProduct(),
    billedReturnRows([productId], dr),
  ]);
  if (!product) return { ok: false, error: "Product not found." };

  const unit = unitLabel(product.unit);

  // Opening stock: everything before the window, so a filtered view's running
  // balance is the true position rather than starting from zero.
  let opening = 0;
  if (dr?.gte) {
    const before = await productStockEvents(productId, { lte: new Date(dr.gte.getTime() - 1) }, false);
    opening = before.reduce((s, e) => s + (e.isIn ? e.qty : -e.qty), 0);
  }

  let bal = opening;
  const rows: LedgerRow[] = [];
  if (dr?.gte && Math.abs(opening) > 1e-6) {
    rows.push({ id: "opening", date: dr.gte.toISOString(), description: "Opening stock",
      debit: 0, credit: 0, balance: opening, qty: `${Math.round(opening * 1000) / 1000} ${unit}`, by: "System" });
  }
  for (const e of events) {
    bal = e.isIn ? bal + e.qty : bal - e.qty;
    rows.push({
      id: e.id,
      date: e.date.toISOString(),
      description: e.description,
      debit: e.isIn ? 0 : e.qty,
      credit: e.isIn ? e.qty : 0,
      balance: bal,
      qty: `${e.qty} ${unit}`,
      by: e.by,
      category: e.category,
    });
  }

  // Rounded to the 3 decimals quantities are stored in: summing Decimal-backed
  // floats leaves noise like 8390.100000000002 that is not a real quantity.
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const totalIn = r3(events.filter((e) => e.isIn).reduce((s, e) => s + e.qty, 0));
  const totalOut = r3(events.filter((e) => !e.isIn).reduce((s, e) => s + e.qty, 0));
  const closing = r3(bal);

  return { ok: true, data: {
    type: "product",
    entityInfo: {
      name: product.name, initials: product.name.slice(0, 2).toUpperCase(),
      avatarBg: "#E6F1FB", avatarTc: "#0C447C",
      meta: "Real-time inventory — updates on each log entry",
      live: (() => {
        const now = Math.round((onHand.get(productId) ?? 0) * 1000) / 1000;
        return { label: "Currently in inventory", value: `${now} ${unit}`, negative: now < 0 };
      })(),
      badges: [
        { label: `In: ${totalIn} ${unit}`, cls: "green" },
        { label: `Out: ${totalOut} ${unit}`, cls: "red" },
        { label: `Net: ${r3(totalIn - totalOut)} ${unit}`, cls: "blue" },
      ],
    },
    summary: [
      { label: "Total in",      value: `${totalIn} ${unit}`,         sub: "produced + returned",  color: "#3B6D11" },
      { label: "Total out",     value: `${totalOut} ${unit}`,        sub: "dispatched + used",    color: "#A32D2D" },
      { label: "Net movement",  value: `${r3(totalIn - totalOut)} ${unit}`, sub: "in minus out",      color: "#854F0B" },
      { label: "Closing stock", value: `${closing} ${unit}`,          sub: "on hand at period end", color: "#185FA5" },
      { label: "Entries",       value: String(rows.length),           sub: "in selected period",  color: "#111" },
    ],
    rows,
    billedReturns,
  }};
}

/**
 * Charged on a stop the rider marked skipped, for some products and dates.
 *
 * A delivery entry counts when the same customer's stop on that day's round of
 * their shift was marked skipped — the exact match the Rider Item Returns page
 * makes for "Charged, came back". Free replacements, complaint rows and customer
 * returns are not a charge and are left out, as everywhere else.
 */
async function billedReturnRows(productIds: string[], dr?: { gte?: Date; lte?: Date }): Promise<BilledReturn[]> {
  if (!productIds.length) return [];
  const [entries, skipped] = await Promise.all([
    db.deliveryEntry.findMany({
      where: {
        productId: { in: productIds },
        isReturn: false, isReplacement: false, complaintId: null,
        customer: { shiftId: { not: null } },
        ...(dr ? { date: dr } : {}),
      },
      select: {
        id: true, date: true, quantity: true, unitRate: true, productId: true, customerId: true,
        product: { select: { name: true, unit: true } },
        customer: { select: { name: true, customerCode: true, shiftId: true } },
        rider: { select: { user: { select: { name: true } } } },
      },
      orderBy: { date: "asc" },
    }),
    db.routeStop.findMany({
      where: {
        status: { contains: "SKIP", mode: "insensitive" },
        ...(dr ? { route: { date: dr } } : {}),
      },
      select: { customerId: true, skipReason: true, route: { select: { date: true, shiftId: true, shift: { select: { name: true } } } } },
    }),
  ]);
  const stopByKey = new Map(
    skipped.map((s) => [`${toDateStrPKT(s.route.date)}:${s.route.shiftId}:${s.customerId}`, s] as const),
  );
  const out: BilledReturn[] = [];
  for (const e of entries) {
    const stop = stopByKey.get(`${toDateStrPKT(e.date)}:${e.customer.shiftId}:${e.customerId}`);
    if (!stop) continue;
    const qty = Number(e.quantity);
    out.push({
      id: e.id,
      date: e.date.toISOString(),
      productId: e.productId,
      productName: e.product.name,
      unit: unitLabel(e.product.unit),
      customer: `${e.customer.customerCode ?? ""} ${e.customer.name}`.trim(),
      qty,
      amount: Math.round(qty * Number(e.unitRate) * 100) / 100,
      reason: stop.skipReason?.trim() || "No reason given",
      by: e.rider?.user?.name ?? stop.route.shift?.name ?? "—",
    });
  }
  return out;
}

/** Billed returns across several products — the ledger's combined Billed Returns view. */
export async function getBilledReturns(
  productIds: string[], from?: string, to?: string
): Promise<{ ok: true; rows: BilledReturn[] } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  try {
    return { ok: true, rows: await billedReturnRows(productIds.slice(0, 20), dateRange(from, to)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to load billed returns." };
  }
}

// ── owner ledger ──────────────────────────────────────────────────────────────

/**
 * What the farm owes one owner for money they put in from their own pocket.
 *
 * A pure liability ledger: every row is money in, so the running balance only
 * grows. There is no repayment side by the owners' own instruction — settling up
 * happens outside the software — so this reads as "total put in to date", and the
 * balance is what the farm owes them.
 *
 * Deliberately NOT income: nothing here feeds revenue, profit or the dashboard.
 */
async function ownerLedger(
  ownerId: string,
  dr?: { gte?: Date; lte?: Date }
): Promise<LedgerResult> {
  if (!isFarmOwner(ownerId)) return { ok: false, error: "Unknown owner." };

  const rowsRaw = await db.ownerContribution.findMany({
    where: { owner: ownerId, ...(dr ? { date: dr } : {}) },
    include: { enteredBy: { select: { name: true } } },
    orderBy: { date: "asc" },
  });

  // Everything before the window, so a filtered view still shows the true total
  // owed rather than restarting from zero.
  let opening = 0;
  if (dr?.gte) {
    const before = await db.ownerContribution.aggregate({
      _sum: { amount: true },
      where: { owner: ownerId, date: { lt: dr.gte } },
    });
    opening = Number(before._sum.amount ?? 0);
  }

  let bal = opening;
  const rows: LedgerRow[] = [];
  if (dr?.gte && Math.abs(opening) > 0.005) {
    rows.push({ id: "opening", date: dr.gte.toISOString(), description: "Opening — owed before this period",
      debit: 0, credit: 0, balance: opening, reference: "—" });
  }
  for (const r of rowsRaw) {
    bal += Number(r.amount);
    rows.push({
      id: r.id,
      date: r.date.toISOString(),
      description: r.reason,
      debit: 0,
      credit: Number(r.amount),
      balance: bal,
      reference: HEAD_LABELS[OWNER_FUNDING_HEAD] ?? OWNER_FUNDING_HEAD,
      note: r.reason,
      by: r.enteredBy?.name ?? "—",
    });
  }

  const total = rowsRaw.reduce((sum, r) => sum + Number(r.amount), 0);
  const name = ownerName(ownerId);

  return { ok: true, data: {
    type: "owner",
    entityInfo: {
      name: `${name} — personal account`,
      initials: name.slice(0, 2).toUpperCase(),
      avatarBg: "#F3E8FF", avatarTc: "#6B21A8",
      meta: `Money ${name} put into the farm — a liability, not income`,
      badges: [
        { label: `Owed: ${rs(bal)}`, cls: "purple" },
        { label: `${rowsRaw.length} contribution${rowsRaw.length === 1 ? "" : "s"}`, cls: "gray" },
      ],
    },
    summary: [
      { label: "Owed to " + name, value: rs(bal),   sub: "total put in",            color: "#6B21A8" },
      { label: "In this period",  value: rs(total), sub: `${rowsRaw.length} entries`, color: "#3B6D11" },
    ],
    rows,
  }};
}

// ── head ledger ───────────────────────────────────────────────────────────────

async function headLedger(
  headKey: string,
  dr?: { gte?: Date; lte?: Date }
): Promise<LedgerResult> {
  // Rider Cash is a cashbox: a collection only enters the head when the rider hands
  // it over and it is confirmed. So on this head a payment is dated by receivedAt,
  // not by the day the rider took the money, and un-confirmed rows are not here at
  // all. Without this the ledger's closing balance would disagree with the head
  // balance card — which is the one thing this opening-balance code exists to avoid.
  // "All heads" — every account combined. Transfers are deliberately LEFT OUT of
  // it: moving money from HBL to Cash is not money arriving or leaving, and across
  // all heads every transfer's in and out cancel exactly. Dropping them makes the
  // closing balance equal the Total in All Accounts figure on the dashboard, and
  // spares the reader a page of rows that sum to nothing.
  //
  // Meezan is not in it: that is the owners' money, owed back to them, not money
  // the farm holds. What is paid through it never touched the farm's accounts.
  // Only a transfer between Meezan and a farm account crosses the line — the
  // farm repaying the owners (out) or the owners putting money in (in) — so those
  // ARE in the combined view, as money leaving or arriving.
  const isAll = headKey === ALL_HEADS;
  const isOwners = headKey === OWNERS_HEAD;
  const owners = OWNERS_HEAD as never;

  const isRiderCash = headKey === "RIDER_CASH";
  const payDateField = isRiderCash ? "receivedAt" : "date";

  // Rider Cash is a cashbox: a collection only enters the head when the rider hands
  // it over and it is confirmed. So a rider-cash payment is dated by receivedAt, not
  // by the day the rider took the money, and un-confirmed ones are not here at all.
  // In the combined view that has to hold per ROW, since the other heads still date
  // by `date` — hence the OR rather than one date field for the lot.
  const payWhere = isAll
    ? {
        AND: [
          HEAD_PAYMENT_WHERE,
          { head: { not: owners } },
          ...(dr
            ? [{ OR: [
                { head: { not: "RIDER_CASH" as never }, date: dr },
                { head: "RIDER_CASH" as never, receivedAt: dr },
              ] }]
            : []),
        ],
      }
    : {
        head: headKey as never,
        ...(isRiderCash ? { receivedAt: { not: null } } : {}),
        ...(dr ? { [payDateField]: dr } : {}),
      };

  const headOnly = isAll ? { head: { not: owners } } : { head: headKey as never };

  // Owner funding credits exactly one head, so only that head's ledger reads it —
  // and the combined view, which contains that head. Without this the ledger's
  // closing figure would disagree with the head balance card.
  // Meezan reads it too, the other way round: money an owner put into HBL is owed
  // back to them, so it is a minus on the owners' account.
  const isFundedHead = isAll || headKey === OWNER_FUNDING_HEAD || isOwners;

  const [payments, expenses, salaries, transfersOut, transfersIn, funding] = await Promise.all([
    db.payment.findMany({
      where: payWhere,
      include: {
        customer: { select: { name: true, customerCode: true } },
        sample: { select: { name: true } },
      },
      orderBy: { date: "asc" },
    }),
    db.expense.findMany({
      where: { ...headOnly, ...(dr ? { date: dr } : {}) },
      include: { category: { select: { name: true } } },
      orderBy: { date: "asc" },
    }),
    db.salaryPayment.findMany({
      where: { ...headOnly, ...(dr ? { paidAt: dr } : {}) },
      include: { employee: { select: { name: true } } },
      orderBy: { paidAt: "asc" },
    }),
    // In the combined view only a transfer across the Meezan line counts — see `isAll`.
    db.headTransfer.findMany({
      where: { ...(isAll ? { toHead: owners, fromHead: { not: owners } } : { fromHead: headKey as never }), ...(dr ? { date: dr } : {}) },
      orderBy: { date: "asc" },
    }),
    db.headTransfer.findMany({
      where: { ...(isAll ? { fromHead: owners, toHead: { not: owners } } : { toHead: headKey as never }), ...(dr ? { date: dr } : {}) },
      orderBy: { date: "asc" },
    }),
    isFundedHead
      ? db.ownerContribution.findMany({ where: { ...(dr ? { date: dr } : {}) }, orderBy: { date: "asc" } })
      : Promise.resolve([]),
  ]);

  type E = { date: Date; row: LedgerRow };
  const entries: E[] = [];

  // In the combined view the account is the one thing every row would otherwise be
  // missing. Appended rather than put in `reference`, which already carries the
  // customer code / category and is just as useful here.
  const named = (desc: string, head: string) =>
    isAll ? `${desc} · ${HEAD_LABELS[head] ?? head}` : desc;

  for (const p of payments) {
    // Dated by when it entered the head — see payWhere above. In the combined view
    // that is decided per row, because only rider cash is dated by receivedAt.
    const byReceipt = isAll ? p.head === "RIDER_CASH" : isRiderCash;
    const on = (byReceipt ? p.receivedAt : p.date) ?? p.date;
    entries.push({ date: on, row: {
      id: p.id, date: on.toISOString(),
      description: named(`Payment — ${p.customer?.name ?? (p.sample ? `Sample · ${p.sample.name}` : "—")}`, p.head),
      debit: 0, credit: Number(p.amount), balance: 0,
      reference: p.customer?.customerCode ?? "SAMPLE",
      note: p.notes ?? undefined,
    }});
  }
  for (const e of expenses) {
    entries.push({ date: e.date, row: {
      id: e.id, date: e.date.toISOString(),
      description: named(`Expense — ${e.description ?? e.category.name}`, e.head),
      debit: Number(e.amount), credit: 0, balance: 0,
      reference: e.category.name,
    }});
  }
  for (const s of salaries) {
    entries.push({ date: s.paidAt, row: {
      id: s.id, date: s.paidAt.toISOString(),
      description: named(`Salary — ${s.employee?.name ?? "Employee"}`, s.head),
      debit: Number(s.amount), credit: 0, balance: 0,
      reference: "Salary", note: s.notes ?? undefined,
    }});
  }
  for (const t of transfersOut) {
    entries.push({ date: t.date, row: {
      id: t.id, date: t.date.toISOString(),
      description: named(`Transfer to ${HEAD_LABELS[t.toHead] ?? t.toHead}`, t.fromHead),
      debit: Number(t.amount), credit: 0, balance: 0,
      reference: "Transfer", note: t.notes ?? undefined,
    }});
  }
  for (const t of transfersIn) {
    entries.push({ date: t.date, row: {
      id: t.id, date: t.date.toISOString(),
      description: named(`Transfer from ${HEAD_LABELS[t.fromHead] ?? t.fromHead}`, t.toHead),
      debit: 0, credit: Number(t.amount), balance: 0,
      reference: "Transfer", note: t.notes ?? undefined,
    }});
  }

  for (const f of funding) {
    entries.push({ date: f.date, row: isOwners ? {
      id: f.id, date: f.date.toISOString(),
      description: `Paid into ${HEAD_LABELS[OWNER_FUNDING_HEAD] ?? OWNER_FUNDING_HEAD} by ${ownerFundingLabel(f.owner)}`,
      debit: Number(f.amount), credit: 0, balance: 0,
      reference: "Owner funding", note: f.reason,
    } : {
      id: f.id, date: f.date.toISOString(),
      description: named(`Funded by ${ownerFundingLabel(f.owner)}`, OWNER_FUNDING_HEAD),
      debit: 0, credit: Number(f.amount), balance: 0,
      reference: "Owner funding", note: f.reason,
    }});
  }

  entries.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Opening balance: everything on this head BEFORE the window. Without it a filtered
  // view showed only the in-window net flow as "Current balance", disagreeing with the
  // head-balance card shown everywhere else. Seed the running balance (and show it as
  // a row) so the closing figure equals the true head balance.
  let opening = 0;
  if (dr?.gte) {
    const [p, e, s, ti, to, of] = await Promise.all([
      // Same rule as the rows above, or the opening figure would not match them.
      db.payment.aggregate({ _sum: { amount: true }, where: isAll
        ? { AND: [HEAD_PAYMENT_WHERE, { head: { not: owners } }, { OR: [
            { head: { not: "RIDER_CASH" as never }, date: { lt: dr.gte } },
            { head: "RIDER_CASH" as never, receivedAt: { lt: dr.gte } },
          ] }] }
        : {
            head: headKey as never,
            ...(isRiderCash ? { receivedAt: { not: null } } : {}),
            [payDateField]: { lt: dr.gte },
          } }),
      db.expense.aggregate({ _sum: { amount: true }, where: { ...headOnly, date: { lt: dr.gte } } }),
      db.salaryPayment.aggregate({ _sum: { amount: true }, where: { ...headOnly, paidAt: { lt: dr.gte } } }),
      db.headTransfer.aggregate({ _sum: { amount: true }, where: { ...(isAll ? { fromHead: owners, toHead: { not: owners } } : { toHead: headKey as never }), date: { lt: dr.gte } } }),
      db.headTransfer.aggregate({ _sum: { amount: true }, where: { ...(isAll ? { toHead: owners, fromHead: { not: owners } } : { fromHead: headKey as never }), date: { lt: dr.gte } } }),
      isFundedHead
        ? db.ownerContribution.aggregate({ _sum: { amount: true }, where: { date: { lt: dr.gte } } })
        : Promise.resolve({ _sum: { amount: null } }),
    ]);
    opening = Number(p._sum.amount ?? 0) - Number(e._sum.amount ?? 0) - Number(s._sum.amount ?? 0)
      + Number(ti._sum.amount ?? 0) - Number(to._sum.amount ?? 0) + (isOwners ? -1 : 1) * Number(of._sum.amount ?? 0);
  }

  let bal = opening;
  const rows: LedgerRow[] = [];
  if (dr?.gte && Math.abs(opening) > 0.005) {
    rows.push({ id: "opening", date: dr.gte.toISOString(), description: "Opening balance",
      debit: 0, credit: 0, balance: opening, reference: "—" });
  }
  for (const { row } of entries) {
    bal += row.credit - row.debit;
    rows.push({ ...row, balance: bal });
  }

  const totalIn  = entries.reduce((s, e) => s + e.row.credit, 0);
  const totalOut = entries.reduce((s, e) => s + e.row.debit, 0);
  const headName = isAll ? "All Accounts" : (HEAD_LABELS[headKey] ?? headKey);

  return { ok: true, data: {
    type: "head",
    entityInfo: {
      name: headName, initials: headName.slice(0, 2).toUpperCase(),
      avatarBg: "#E6F1FB", avatarTc: "#0C447C",
      meta: isAll
        ? "Every payment account combined — transfers between accounts are left out, so this closes on the total cash held"
        : isOwners
          ? "The owners' shared account — what Sajjad and Moiz paid for the farm. The minus is what the farm owes them"
          : "Payment head — tracks all cash flow in and out",
      badges: [
        { label: `Balance: ${rs(bal)}`, cls: "blue" },
        { label: `In: ${rs(totalIn)}`,  cls: "green" },
        { label: `Out: ${rs(totalOut)}`, cls: "red" },
      ],
    },
    summary: [
      { label: "Current balance", value: rs(bal),      sub: "net balance",        color: "#185FA5" },
      { label: "Total in",        value: rs(totalIn),  sub: `${payments.length} payments`, color: "#3B6D11" },
      { label: "Total out",       value: rs(totalOut), sub: `${expenses.length + salaries.length + transfersOut.length} out`, color: "#A32D2D" },
      { label: "Net flow",        value: rs(totalIn - totalOut), sub: "in this period", color: "#854F0B" },
      { label: "Entries",         value: String(rows.length), sub: "transactions",  color: "#111" },
    ],
    rows,
  }};
}

// ── vendor ledger ─────────────────────────────────────────────────────────────

async function vendorLedger(
  vendorId: string,
  dr?: { gte?: Date; lte?: Date }
): Promise<LedgerResult> {
  const [vendor, bills, vendorExpenses, otcPurchases, otcSales, receivableAgg, payableAgg, farmSales] = await Promise.all([
    db.vendor.findUnique({ where: { id: vendorId } }),
    db.vendorBill.findMany({
      where: { vendorId, ...(dr ? { date: dr } : {}) },
      orderBy: { date: "asc" },
    }),
    // The real cash-out trail. Payments used to be inferred from VendorBill.paid
    // and stamped with the BILL's date — so a bill dated 1 Jan settled on 15 Mar
    // showed its payment on 1 Jan, the running balance was wrong for ten weeks,
    // and a March date filter showed neither the bill nor the payment. Expense
    // rows carry the date the money actually left, so use those.
    db.expense.findMany({
      where: { vendorId, ...(dr ? { date: dr } : {}) },
      select: { id: true, date: true, amount: true, head: true, description: true },
      orderBy: { date: "asc" },
    }),
    // Over-the-Counter purchases FROM this vendor — used to attach the itemized
    // products to the VendorBill each one created (matched via vendorBillId).
    db.otcPurchase.findMany({
      where: { vendorId, ...(dr ? { date: dr } : {}) },
      select: {
        vendorBillId: true, paymentStatus: true,
        lines: { select: { quantity: true, unit: true, product: { select: { name: true } } } },
      },
    }),
    // Over-the-Counter sales TO this vendor (what we sold them) — the rows that
    // used to be missing entirely. A credit sale is money they owe us.
    db.otcSale.findMany({
      where: { vendorId, ...(dr ? { date: dr } : {}) },
      select: {
        id: true, date: true, invoiceNo: true, totalAmount: true, paidAmount: true, paymentStatus: true,
        lines: { select: { quantity: true, unit: true, product: { select: { name: true } } } },
      },
      orderBy: { date: "asc" },
    }),
    // Live receivable (what they owe us), never netted against what we owe them.
    db.vendorReceivable.aggregate({ where: { vendorId }, _sum: { amount: true, received: true } }),
    // Live payable (what WE owe them) — ALL bills, not the date-filtered subset, so the
    // "We owe them" card matches the Vendors page and stays consistent with the (also
    // all-time) receivable card regardless of any From/To filter on the rows.
    db.vendorBill.aggregate({ where: { vendorId }, _sum: { amount: true, paid: true } }),
    // Non-milk goods sold to them (animals, machinery, feed). Always paid in full,
    // so these are context only and must not move the payable balance.
    db.farmSale.findMany({
      where: { vendorId, ...(dr ? { date: dr } : {}) },
      select: {
        id: true, date: true, invoiceNo: true, totalAmount: true,
        lines: { select: { quantity: true, unit: true, item: true } },
      },
      orderBy: { date: "asc" },
    }),
  ]);
  if (!vendor) return { ok: false, error: "Vendor not found." };

  // vendorBillId -> the OTC purchase's product detail, to enrich its bill row.
  const purchaseByBill = new Map<string, { products: string; mode: "cash" | "credit" }>();
  for (const p of otcPurchases) {
    if (p.vendorBillId) {
      purchaseByBill.set(p.vendorBillId, {
        products: fmtProducts(p.lines),
        mode: p.paymentStatus === "PAID" ? "cash" : "credit",
      });
    }
  }

  type VR = LedgerRow & { _d: Date };
  const entries: VR[] = [];

  for (const bill of bills) {
    const amt  = Number(bill.amount);
    const otc  = purchaseByBill.get(bill.id);

    // Parse the JSON-encoded notes into a human-readable description.
    let billDesc = "Bill — Supply";
    let billNote: string | undefined;
    if (bill.notes) {
      try {
        const parsed = JSON.parse(bill.notes) as { reference?: string; lines?: { category?: string }[] };
        const ref = parsed.reference?.trim() ?? "";
        const cats = [...new Set((parsed.lines ?? []).map((l) => l.category).filter(Boolean))];
        const parts: string[] = [];
        if (ref) parts.push(`Ref: ${ref}`);
        if (cats.length) parts.push(cats.join(", "));
        billDesc = parts.length ? `Bill — ${parts.join(" · ")}` : "Bill — Supply";
        billNote = ref || undefined;
      } catch {
        billDesc = `Bill — ${bill.notes}`;
        billNote = bill.notes;
      }
    }

    entries.push({
      _d: bill.date,
      id: `${bill.id}-b`, date: bill.date.toISOString(),
      description: billDesc,
      debit: amt, credit: 0, balance: 0,
      note: billNote,
      products: otc?.products,
      mode: otc?.mode,
    });
  }

  // Payments, on the date they actually happened.
  for (const e of vendorExpenses) {
    entries.push({
      _d: e.date,
      id: `${e.id}-p`, date: e.date.toISOString(),
      description: "Payment made",
      debit: 0, credit: Number(e.amount), balance: 0,
      reference: HEAD_LABELS[e.head] ?? e.head,
      note: e.description ?? undefined,
    });
  }

  // What we SOLD to the vendor. These are the receivable/counter-sale side —
  // shown for the record with full product detail. They carry debit=credit=0 so
  // they never move the payable running balance (payable and receivable are
  // tracked separately, see the two summary cards below); the amount and
  // direction live in the description and the `mode` flag.
  for (const s of otcSales) {
    const amt = Number(s.totalAmount);
    const owed = amt - Number(s.paidAmount); // what they still owe us on this sale
    const onCredit = owed > 0.005;
    entries.push({
      _d: s.date,
      id: `sale-${s.id}`, date: s.date.toISOString(),
      description: onCredit
        ? `Sold on credit — ${s.invoiceNo} · ${rs(owed)} (they owe us)`
        : `Sold (paid) — ${s.invoiceNo} · ${rs(amt)}`,
      debit: 0, credit: 0, balance: 0,
      reference: s.invoiceNo,
      products: fmtProducts(s.lines),
      mode: onCredit ? "credit" : "cash",
    });
  }

  // Farm sales (animals, machinery, feed) carry debit=credit=0 for the same reason
  // the OTC rows above do: they are always paid in full, so they must never move the
  // payable running balance — they are here so the statement is complete.
  for (const f of farmSales) {
    entries.push({
      _d: f.date,
      id: `farm-${f.id}`, date: f.date.toISOString(),
      description: `Farm sale (paid) — ${f.invoiceNo} · ${rs(Number(f.totalAmount))}`,
      debit: 0, credit: 0, balance: 0,
      reference: f.invoiceNo,
      products: f.lines.map((l) => `${Number(l.quantity)} ${l.unit} ${l.item}`).join(", "),
      mode: "cash",
    });
  }

  entries.sort((a, b) => a._d.getTime() - b._d.getTime());

  // Seed the row running-balance with everything BEFORE the window (bills − vendor
  // payments), so a filtered view's closing figure is the true payable, not just the
  // in-window net. Without this a date filter made the running balance start at 0.
  let opening = 0;
  if (dr?.gte) {
    const [bAgg, eAgg] = await Promise.all([
      db.vendorBill.aggregate({ _sum: { amount: true }, where: { vendorId, date: { lt: dr.gte } } }),
      db.expense.aggregate({ _sum: { amount: true }, where: { vendorId, date: { lt: dr.gte } } }),
    ]);
    opening = Number(bAgg._sum.amount ?? 0) - Number(eAgg._sum.amount ?? 0);
  }

  let bal = opening;
  const rows: LedgerRow[] = [];
  if (dr?.gte && Math.abs(opening) > 0.005) {
    rows.push({ id: "opening", date: dr.gte.toISOString(), description: "Opening balance (we owe)",
      debit: 0, credit: 0, balance: opening, reference: "—" });
  }
  for (const { _d, ...r } of entries) {
    bal += r.debit - r.credit;
    rows.push({ ...r, balance: bal });
  }

  const totalBilled = bills.reduce((s, b) => s + Number(b.amount), 0);
  const totalPaid   = vendorExpenses.reduce((s, e) => s + Number(e.amount), 0);
  // LIVE balances (all-time) for the two summary cards — payable and receivable, shown
  // side by side, never netted. Both are all-time so they stay consistent with each
  // other and with the Vendors page even when the row list is date-filtered.
  const receivable  = Math.max(0, Number(receivableAgg._sum.amount ?? 0) - Number(receivableAgg._sum.received ?? 0));
  const payable     = Math.max(0, Number(payableAgg._sum.amount ?? 0) - Number(payableAgg._sum.paid ?? 0));

  return { ok: true, data: {
    type: "vendor",
    entityInfo: {
      name: vendor.name, initials: ini(vendor.name),
      avatarBg: "#FAEEDA", avatarTc: "#633806",
      meta: `${vendor.phone ?? "No phone"} · Vendor account`,
      badges: [
        { label: `We owe: ${rs(payable)}`,      cls: "red"   },
        { label: `They owe: ${rs(receivable)}`, cls: "blue"  },
        { label: vendor.phone ?? "—",           cls: "gray"  },
      ],
    },
    // Payable and receivable shown side by side, never combined into one number.
    summary: [
      { label: "We owe them",   value: rs(payable),      sub: "unpaid bills (live)",        color: "#A32D2D" },
      { label: "They owe us",   value: rs(receivable),   sub: "unpaid sales (live)",        color: "#185FA5" },
      { label: "Total billed",  value: rs(totalBilled),  sub: "in this period",             color: "#185FA5" },
      { label: "Total paid",    value: rs(totalPaid),    sub: "payments made",              color: "#3B6D11" },
      { label: "Bills",         value: String(bills.length), sub: "vendor bills",           color: "#111" },
    ],
    rows,
  }};
}

// ── wastage ledger ────────────────────────────────────────────────────────────
// Every WASTAGE inventory movement, valued live at the product's current
// defaultRate (the only per-product rate stored). Products left unpriced
// (defaultRate = 0) contribute 0 to the money total until they're priced.

async function wastageLedger(
  dr?: { gte?: Date; lte?: Date }
): Promise<LedgerResult> {
  const moves = await db.inventoryMovement.findMany({
    where: { type: "WASTAGE", ...(dr ? { date: dr } : {}) },
    select: {
      id: true, date: true, quantity: true, reason: true,
      product: { select: { name: true, unit: true, defaultRate: true } },
      rider: { select: { user: { select: { name: true } } } },
    },
    orderBy: { date: "asc" },
  });


  let runningValue = 0;
  // Quantities can't be summed across units (litres + kg + pieces is meaningless), so
  // keep a per-unit tally and show them separately.
  const qtyByUnit: Record<string, number> = { L: 0, kg: 0, pc: 0 };
  const rows: LedgerRow[] = moves.map((m) => {
    const qty = Number(m.quantity);
    const rate = Number(m.product.defaultRate);
    const value = qty * rate;
    runningValue += value;
    qtyByUnit[unitLabel(m.product.unit)] = (qtyByUnit[unitLabel(m.product.unit)] ?? 0) + qty;
    return {
      id: m.id,
      date: m.date.toISOString(),
      description: `Wastage — ${m.product.name}${m.reason ? ` (${m.reason})` : ""}`,
      debit: value, credit: 0, balance: runningValue,
      qty: `${qty} ${unitLabel(m.product.unit)}`,
      rate: `Rs ${rate}`,
      by: m.rider?.user?.name ?? undefined,
    };
  });

  const totalValue = runningValue;
  const qtyLabel = Object.entries(qtyByUnit)
    .filter(([, v]) => v > 0)
    .map(([u, v]) => `${v.toLocaleString("en-PK")} ${u}`)
    .join(" · ") || "—";

  return { ok: true, data: {
    type: "wastage",
    entityInfo: {
      name: "Wastage", initials: "WA",
      avatarBg: "#FBE3E3", avatarTc: "#A32D2D",
      meta: "All recorded stock wastage, valued at each product's default rate",
      badges: [
        { label: `${moves.length} entries`, cls: "gray" },
        { label: `Value: ${rs(totalValue)}`, cls: "red" },
      ],
    },
    summary: [
      { label: "Total wastage value", value: rs(totalValue),       sub: "at default rates",   color: "#A32D2D" },
      { label: "Entries",             value: String(moves.length), sub: "wastage movements",  color: "#185FA5" },
      { label: "Total quantity",      value: qtyLabel, sub: "by unit", color: "#854F0B" },
    ],
    rows,
  }};
}

// ── employee ledger ───────────────────────────────────────────────────────────

async function employeeLedger(
  employeeId: string,
  dr?: { gte?: Date; lte?: Date }
): Promise<LedgerResult> {
  const [employee, salaryPayments, bonuses, deductions, attendance] = await Promise.all([
    db.employee.findUnique({ where: { id: employeeId } }),
    db.salaryPayment.findMany({
      where: { employeeId }, orderBy: [{ year: "asc" }, { month: "asc" }, { paidAt: "asc" }],
    }),
    db.bonus.findMany({
      where: { employeeId }, orderBy: [{ year: "asc" }, { month: "asc" }],
    }),
    db.deduction.findMany({
      where: { employeeId }, orderBy: [{ year: "asc" }, { month: "asc" }],
    }),
    db.attendance.findMany({ where: { employeeId } }),
  ]);
  if (!employee) return { ok: false, error: "Employee not found." };

  type R = LedgerRow & { _d: Date };
  const all: R[] = [];

  // Salary EARNED debits. The old code only created a debit for months that already
  // had a payment, and only for fixed-salary staff (baseSalary > 0) — so unpaid
  // months showed no liability and daily-wage riders (baseSalary = 0) earned nothing
  // in the ledger at all. Now we value EVERY month that has any activity (attendance,
  // payment, bonus or deduction), the same way the Salaries tab does: fixed staff earn
  // baseSalary; daily-wage staff earn (effective attendance days × dailyWage).
  const baseSalary = Number(employee.baseSalary);
  const dailyWage  = Number(employee.dailyWage ?? 0);
  const isFixed    = baseSalary > 0;
  const todayStr   = todayPKTString();

  const attByDate = new Map<string, string>(
    attendance.map((a) => [a.date.toISOString().split("T")[0], a.status])
  );
  const activeMonths = new Set<string>();
  for (const a of attendance) {
    const [yy, mm] = a.date.toISOString().split("T")[0].split("-");
    activeMonths.add(`${Number(yy)}-${Number(mm)}`);
  }
  for (const p of salaryPayments) activeMonths.add(`${p.year}-${p.month}`);
  for (const b of bonuses)        activeMonths.add(`${b.year}-${b.month}`);
  for (const d of deductions)     activeMonths.add(`${d.year}-${d.month}`);

  for (const key of activeMonths) {
    const [yy, mm] = key.split("-").map(Number);
    const earned = isFixed ? baseSalary : effectiveWageDays(yy, mm, attByDate, todayStr) * dailyWage;
    if (earned <= 0.005) continue;
    const d = new Date(yy, mm - 1, 1);
    all.push({ _d: d, id: `sal-${key}`, date: d.toISOString(),
      description: `Salary earned — ${MONTH_NAMES[mm - 1]} ${yy}`,
      debit: earned, credit: 0, balance: 0,
      note: isFixed ? "Monthly salary" : "Daily wage × days worked", by: "System",
    });
  }

  for (const b of bonuses) {
    const d = new Date(b.year, b.month - 1, 2);
    all.push({ _d: d, id: b.id, date: d.toISOString(),
      description: `Bonus — ${b.description ?? MONTH_NAMES[b.month - 1] + " " + b.year}`,
      debit: Number(b.amount), credit: 0, balance: 0,
      note: b.description ?? undefined, by: "Admin",
    });
  }

  for (const d of deductions) {
    const dt = new Date(d.year, d.month - 1, 3);
    all.push({ _d: dt, id: d.id, date: dt.toISOString(),
      description: `Deduction — ${d.description ?? MONTH_NAMES[d.month - 1] + " " + d.year}`,
      debit: 0, credit: Number(d.amount), balance: 0,
      note: d.description ?? undefined, by: "Admin",
    });
  }

  for (const p of salaryPayments) {
    all.push({ _d: p.paidAt, id: p.id, date: p.paidAt.toISOString(),
      description: `Payment — ${MONTH_NAMES[p.month - 1]} ${p.year} via ${HEAD_LABELS[p.head] ?? p.head}`,
      debit: 0, credit: Number(p.amount), balance: 0,
      note: p.notes ?? undefined, by: "Admin",
    });
  }

  all.sort((a, b) => a._d.getTime() - b._d.getTime());

  // Honour the date filter. It was accepted as a parameter and then never used —
  // the user picked a range and silently got the all-time ledger back with no
  // indication the filter had been ignored. Salary/bonus/deduction rows are dated
  // from their month/year, salary payments from paidAt, so filtering the assembled
  // rows covers all four uniformly. The running balance is seeded from everything
  // before the window so the closing figure stays true.
  let bal = 0;
  let visible = all;
  if (dr?.gte || dr?.lte) {
    const before = all.filter((r) => (dr.gte ? r._d < dr.gte : false));
    bal = before.reduce((s, r) => s + r.debit - r.credit, 0);
    visible = all.filter(
      (r) => (!dr.gte || r._d >= dr.gte) && (!dr.lte || r._d <= dr.lte)
    );
  }

  const rows: LedgerRow[] = visible.map(({ _d, ...r }) => {
    bal += r.debit - r.credit;
    return { ...r, balance: bal };
  });

  // totalEarned = salary + bonuses (the debits). totalPaid must count ONLY actual
  // salary payments — deductions are ALSO credits but are not money paid to the
  // employee, so summing all credits (the old bug) overstated "Total paid".
  const totalEarned = rows.reduce((s, r) => s + r.debit, 0);
  const totalPaid   = rows.filter((r) => r.description.startsWith("Payment —")).reduce((s, r) => s + r.credit, 0);
  const wageLabel   = baseSalary > 0
    ? `Rs ${baseSalary.toLocaleString("en-PK")}/mo`
    : employee.dailyWage ? `Rs ${Number(employee.dailyWage).toLocaleString("en-PK")}/day` : "—";
  // bal > 0 → still owed; bal < 0 → paid in advance / carrying a credit. The old
  // Math.max(0, bal) hid advances and always showed "settled".
  const owed    = bal > 0.005;
  const advance = bal < -0.005;

  return { ok: true, data: {
    type: "employee",
    entityInfo: {
      name: employee.name, initials: ini(employee.name),
      avatarBg: "#EEEDFE", avatarTc: "#3C3489",
      meta: "Salary ledger — earnings, bonuses, deductions and payments",
      badges: [
        { label: employee.role ?? "Employee", cls: "purple" },
        { label: wageLabel, cls: "blue" },
        { label: owed ? `Owes ${rs(bal)}` : advance ? `Advance ${rs(-bal)}` : "Settled", cls: owed ? "red" : advance ? "blue" : "green" },
      ],
    },
    summary: [
      { label: owed ? "Balance to pay" : advance ? "Paid in advance" : "Balance to pay",
        value: rs(Math.abs(bal)), sub: owed ? "owed" : advance ? "credit / advance" : "settled",
        color: owed ? "#A32D2D" : advance ? "#185FA5" : "#3B6D11" },
      { label: "Total earned",   value: rs(totalEarned),      sub: "salary + bonuses",  color: "#185FA5" },
      { label: "Total paid",     value: rs(totalPaid),        sub: "salary payments",   color: "#3B6D11" },
      { label: "Wage",           value: wageLabel,             sub: baseSalary > 0 ? "fixed/month" : "daily", color: "#111" },
      { label: "Role",           value: employee.role ?? "—",  sub: "designation",       color: "#111" },
    ],
    rows,
  }};
}

// ── expense category ledger ───────────────────────────────────────────────────

async function expenseLedger(
  categoryId: string,
  dr?: { gte?: Date; lte?: Date }
): Promise<LedgerResult> {
  const now = new Date();
  const [category, expenses, budget] = await Promise.all([
    db.expenseCategory.findUnique({ where: { id: categoryId } }),
    db.expense.findMany({
      where: { categoryId, ...(dr ? { date: dr } : {}) },
      orderBy: { date: "asc" },
    }),
    // Every row for the month, summed: a budget may be split by item.
    db.monthlyBudget.aggregate({
      where: { categoryId, month: now.getMonth() + 1, year: now.getFullYear() },
      _sum: { amount: true },
    }),
  ]);
  if (!category) return { ok: false, error: "Category not found." };

  let runTotal = 0;
  const rows: LedgerRow[] = expenses.map((e) => {
    runTotal += Number(e.amount);
    return {
      id: e.id, date: e.date.toISOString(),
      description: e.description ?? "Expense",
      debit: Number(e.amount), credit: 0, balance: runTotal,
      head: HEAD_LABELS[e.head] ?? e.head,
      by: "Admin",
    };
  });

  const total     = rows.reduce((s, r) => s + r.debit, 0);
  const budgetAmt = Number(budget._sum.amount ?? 0);
  const remaining = budgetAmt - total;

  return { ok: true, data: {
    type: "expense",
    entityInfo: {
      name: category.name, initials: ini(category.name),
      avatarBg: "#FAEEDA", avatarTc: "#633806",
      meta: `Expense category — all entries under ${category.name}`,
      badges: [
        ...(budgetAmt > 0 ? [{ label: `Budget: ${rs(budgetAmt)}`, cls: "blue" }] : []),
        { label: `Spent: ${rs(total)}`, cls: "red" },
        ...(budgetAmt > 0 ? [{ label: remaining >= 0 ? `${rs(remaining)} left` : `Over by ${rs(-remaining)}`, cls: remaining >= 0 ? "green" : "red" }] : []),
      ],
    },
    summary: [
      { label: "Total spent",     value: rs(total),      sub: "in selected period", color: "#A32D2D" },
      { label: "Monthly budget",  value: budgetAmt > 0 ? rs(budgetAmt) : "Not set", sub: "allocated", color: "#185FA5" },
      { label: "Remaining",       value: budgetAmt > 0 ? rs(Math.max(0, remaining)) : "—", sub: remaining < 0 ? "Over budget" : "left", color: remaining < 0 ? "#A32D2D" : "#3B6D11" },
      { label: "Usage",           value: budgetAmt > 0 ? `${Math.round(total / budgetAmt * 100)}%` : "—", sub: "of budget used", color: total > budgetAmt && budgetAmt > 0 ? "#A32D2D" : "#854F0B" },
      { label: "Entries",         value: String(rows.length), sub: "expense entries", color: "#111" },
    ],
    rows,
  }};
}

// ── expense aggregate ledger (All / Retail / Farm) ────────────────────────────

function expenseAggregateFallback(group: string, _rows: LedgerRow[], _dr?: { gte?: Date; lte?: Date }): LedgerResult {
  const label = group.charAt(0).toUpperCase() + group.slice(1);
  return { ok: true, data: {
    type: "expense",
    entityInfo: {
      name: `${label} Expenses`,
      initials: label.slice(0, 2).toUpperCase(),
      avatarBg: "#FAEEDA", avatarTc: "#633806",
      meta: `No expense categories tagged as "${group}" yet. Tag categories in settings.`,
      badges: [{ label: `Group: ${label}`, cls: "blue" }, { label: "0 entries", cls: "gray" }],
    },
    summary: [
      { label: "Total spent", value: "Rs 0",  sub: "no entries", color: "#A32D2D" },
      { label: "Entries",     value: "0",      sub: "expense entries", color: "#111" },
    ],
    rows: [],
  }};
}

async function expenseAggregateLedger(
  group: string | null,
  dr?: { gte?: Date; lte?: Date }
): Promise<LedgerResult> {
  // Fetch categoryIds for the group filter first (avoids Prisma type issues with new `group` column)
  let categoryIdFilter: { categoryId: { in: string[] } } | Record<string, never> = {};
  if (group) {
    const cats = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ExpenseCategory" WHERE "group" = ${group} AND active = true
    `;
    if (cats.length === 0) {
      return expenseAggregateFallback(group, [], dr);
    }
    categoryIdFilter = { categoryId: { in: cats.map((c) => c.id) } };
  }

  const expenses = await db.expense.findMany({
    where: { ...categoryIdFilter, ...(dr ? { date: dr } : {}) },
    include: { category: { select: { name: true } } },
    orderBy: { date: "asc" },
  });

  let runTotal = 0;
  const rows: LedgerRow[] = expenses.map((e) => {
    runTotal += Number(e.amount);
    return {
      id: e.id,
      date: e.date.toISOString(),
      description: `${e.category.name}${e.description ? ` — ${e.description}` : ""}`,
      debit: Number(e.amount),
      credit: 0,
      balance: runTotal,
      head: HEAD_LABELS[e.head] ?? e.head,
      by: "Admin",
    };
  });

  const label = group ? (group.charAt(0).toUpperCase() + group.slice(1)) : "All";
  const total  = rows.reduce((s, r) => s + r.debit, 0);

  return { ok: true, data: {
    type: "expense",
    entityInfo: {
      name: `${label} Expenses`,
      initials: label === "All" ? "AL" : label.slice(0, 2).toUpperCase(),
      avatarBg: "#FAEEDA",
      avatarTc: "#633806",
      meta: group
        ? `Aggregate view — all ${label.toLowerCase()} expense categories`
        : "Aggregate view — all expense categories",
      badges: [
        { label: `Total: ${rs(total)}`,         cls: "red" },
        { label: `${rows.length} entries`,      cls: "gray" },
        ...(group ? [{ label: `Group: ${label}`, cls: "blue" }] : []),
      ],
    },
    summary: [
      { label: "Total spent", value: rs(total),          sub: "in selected period", color: "#A32D2D" },
      { label: "Entries",     value: String(rows.length), sub: "expense entries",   color: "#111" },
    ],
    rows,
  }};
}
