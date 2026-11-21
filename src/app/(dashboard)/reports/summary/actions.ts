"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { todayPKTString } from "@/lib/pkt";
import { computeCustomerOutstanding } from "@/lib/customer-balance";
import { getProductSales } from "@/lib/product-sales";
import { getBillingOverview } from "@/app/(dashboard)/billing/invoices/actions";
import {
  resolveWindow,
  trendBuckets,
  billingHalves,
  periodSubtitle,
  isValidDateStr,
  type ReportPeriod,
} from "@/lib/report-window";

// ── Payload ──────────────────────────────────────────────────────────────────

export type TrendPoint = { label: string; revenue: number; expenses: number; profit: number };
export type ProductRow = { name: string; unit: string; qty: number; value: number };
export type NamedValue = { name: string; value: number };
export type CycleRow = {
  label: string;
  billed: number;
  collected: number;
  pending: number;
  pct: number;
  cash: number;
  digital: number;
  riders: NamedValue[];
};
export type RiderRow = { name: string; out: string | null; back: string | null; stops: number; cash: number };
export type TaskRow = {
  label: string;
  doneCount: number;
  expected: number;
  lastDoneAt: string | null;
  lastDoneBy: string | null;
};
export type EmployeeRow = {
  id: string;
  name: string;
  role: string;
  done: number;
  total: number;
  pct: number;
  tasks: TaskRow[];
};
export type CostRow = { name: string; amount: number; share: number; budget: number; mtdUsed: number };

export type SummaryReport = {
  dbReady: boolean;
  period: ReportPeriod;
  dateStr: string;
  subtitle: string;
  windowLabel: string;
  compareLabel: string;
  finance: {
    revenue: number;
    expenses: number;
    profit: number;
    margin: number;
    prevRevenue: number;
    prevExpenses: number;
    prevProfit: number;
    trend: TrendPoint[];
  };
  collection: { billed: number; collected: number; pct: number };
  sales: {
    customerSales: number;
    retailSales: number;
    milkLitres: number;
    eggPieces: number;
    orders: number;
    wastageValue: number;
    activeCustomers: number;
    totalCustomers: number;
    lostCustomers: number;
    onCallCustomers: number;
    samplesAdded: number;
    converted: number;
    recoveryCustomer: number;
    recoveryMart: number;
    products: ProductRow[];
    marts: NamedValue[];
  };
  cycles: CycleRow[];
  delivery: {
    packagedAt: string | null;
    firstOut: string | null;
    lastBack: string | null;
    riders: RiderRow[];
    routeCash: number;
    digitalCash: number;
  };
  team: { totalDone: number; totalTasks: number; pct: number; employees: EmployeeRow[] };
  costs: { total: number; rows: CostRow[]; monthBudgetTotal: number; mtdTotal: number; monthLabel: string };
};

// ── Small helpers ────────────────────────────────────────────────────────────

const num = (v: unknown) => Number(v ?? 0);
const inWin = (d: Date, w: { start: Date; end: Date }) => d >= w.start && d <= w.end;
/** Never divide by zero — an empty period must read 0%, not NaN. */
const pctOf = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
/** UTC instant → "HH:MM" in PKT. */
const timeStr = (d: Date | null | undefined) =>
  d ? new Date(d.getTime() + 5 * 3600_000).toISOString().slice(11, 16) : null;

/** Cash heads; everything else counts as digital in the payment mix. */
const isCashHead = (head: string) => head === "RIDER_CASH" || head === "CASH";

function emptyReport(period: ReportPeriod, dateStr: string, dbReady: boolean): SummaryReport {
  const w = resolveWindow(period, dateStr);
  return {
    dbReady,
    period,
    dateStr,
    subtitle: periodSubtitle(period, dateStr),
    windowLabel: w.label,
    compareLabel:
      period === "day" ? "vs previous day" : period === "week" ? "vs previous week" : "vs previous month",
    finance: {
      revenue: 0, expenses: 0, profit: 0, margin: 0,
      prevRevenue: 0, prevExpenses: 0, prevProfit: 0, trend: [],
    },
    collection: { billed: 0, collected: 0, pct: 0 },
    sales: {
      customerSales: 0, retailSales: 0, milkLitres: 0, eggPieces: 0, orders: 0, wastageValue: 0,
      activeCustomers: 0, totalCustomers: 0, lostCustomers: 0, onCallCustomers: 0,
      samplesAdded: 0, converted: 0, recoveryCustomer: 0, recoveryMart: 0,
      products: [], marts: [],
    },
    cycles: [],
    delivery: { packagedAt: null, firstOut: null, lastBack: null, riders: [], routeCash: 0, digitalCash: 0 },
    team: { totalDone: 0, totalTasks: 0, pct: 0, employees: [] },
    costs: { total: 0, rows: [], monthBudgetTotal: 0, mtdTotal: 0, monthLabel: "" },
  };
}

// ── The report ───────────────────────────────────────────────────────────────

export async function getSummaryReport(
  period: ReportPeriod = "day",
  dateStr?: string
): Promise<SummaryReport> {
  await requireRole(FULL_ACCESS);
  const p: ReportPeriod = period === "week" || period === "month" ? period : "day";
  const anchor = dateStr && isValidDateStr(dateStr) ? dateStr : todayPKTString();

  try {
    const win = resolveWindow(p, anchor);
    const buckets = trendBuckets(p, anchor);
    // The selected window IS the last bucket, so one fetch across the whole trend
    // span feeds both the sparklines and the headline figures — they can never
    // disagree — and the bucket before it gives the comparison.
    const span = { start: buckets[0].start, end: buckets[buckets.length - 1].end };

    const [deliveries, expenses, salaries, otcSales, otcPurchases, products] = await Promise.all([
      db.deliveryEntry.findMany({
        where: { date: { gte: span.start, lte: span.end } },
        select: {
          date: true, quantity: true, unitRate: true,
          isReturn: true, isReplacement: true, productId: true, customerId: true,
        },
      }),
      db.expense.findMany({
        where: { date: { gte: span.start, lte: span.end } },
        select: { date: true, amount: true, categoryId: true, category: { select: { name: true } } },
      }),
      db.salaryPayment.findMany({
        where: { paidAt: { gte: span.start, lte: span.end } },
        select: { paidAt: true, amount: true },
      }),
      db.otcSale.findMany({
        where: { date: { gte: span.start, lte: span.end } },
        select: {
          date: true, totalAmount: true, vendorId: true,
          vendor: { select: { name: true } },
          lines: { select: { productId: true, quantity: true, amount: true } },
        },
      }),
      db.otcPurchase.findMany({
        where: { date: { gte: span.start, lte: span.end } },
        select: { date: true, totalAmount: true },
      }),
      db.product.findMany({ select: { id: true, name: true, unit: true, defaultRate: true, retailOnly: true } }),
    ]);

    const prod = new Map(products.map((x) => [x.id, x]));

    // ONE definition of revenue, shared with the dashboard's Monthly Sales — see
    // lib/product-sales. Three things change here as a result: consignment counts
    // when the shop REPORTS it sold rather than when it pays, OTC delivery charges
    // stop being counted as product, and a counter sale to a mart is no longer
    // counted twice (once at sale, again on payment).
    const salesSpan = await getProductSales(
      { start: span.start, end: span.end },
      { buckets: buckets.map((b) => ({ key: b.label, start: b.start, end: b.end })) }
    );

    const bucketTotals: TrendPoint[] = buckets.map((b) => {
      const rev = salesSpan.buckets[b.label] ?? 0;
      const exp =
        expenses.filter((e) => inWin(e.date, b)).reduce((s, e) => s + num(e.amount), 0) +
        salaries.filter((e) => inWin(e.paidAt, b)).reduce((s, e) => s + num(e.amount), 0) +
        otcPurchases.filter((e) => inWin(e.date, b)).reduce((s, e) => s + num(e.totalAmount), 0);
      // Profit matches the Reports page: revenue − expenses. Wastage is reported
      // separately so it is never double-counted against purchase cost.
      return { label: b.label, revenue: rev, expenses: exp, profit: rev - exp };
    });

    const cur = bucketTotals[bucketTotals.length - 1];
    const prev =
      bucketTotals.length > 1
        ? bucketTotals[bucketTotals.length - 2]
        : { revenue: 0, expenses: 0, profit: 0 };

    // ── Window-scoped slices ──
    const winDeliveries = deliveries.filter((e) => inWin(e.date, win));
    const winOtc = otcSales.filter((o) => inWin(o.date, win));
    const salesWin = await getProductSales({ start: win.start, end: win.end });
    const customerSales = salesWin.bySource.DELIVERY;
    // Counter and consignment together. Consignment counts when the shop reports it
    // sold, so a mart sale shows in the month it happened rather than the month the
    // cash arrived; what is reported-but-unpaid shows under Recovery Due.
    const retailSales = salesWin.bySource.OTC + salesWin.bySource.CONSIGNMENT;

    // Quantities net of returns; replacements move stock but are not sales.
    let milkLitres = 0;
    let eggPieces = 0;
    for (const e of winDeliveries) {
      const meta = prod.get(e.productId);
      if (!meta) continue;
      const signedQty = num(e.quantity) * (e.isReturn ? -1 : 1);
      if (!e.isReplacement && !meta.retailOnly) {
        // "Litres of milk" and "eggs" are farm figures. A retail product is
        // counted in the product mix above (it is real revenue) but never here —
        // it was never produced, and a pack unit is not litres anyway.
        if (meta.unit === "LITER") milkLitres += signedQty;
        if (meta.unit === "PIECE") eggPieces += signedQty;
      }
    }
    // The product mix comes from the shared aggregator, so it sums to the revenue
    // figure above and finally includes consignment — product sold at a mart never
    // appeared in this list before, because nothing here read the resolutions.
    const productRows: ProductRow[] = salesWin.rows.map((r) => ({
      name: r.name, unit: r.unit, qty: r.qty, value: r.value,
    }));

    const martMap = new Map<string, number>();
    for (const o of winOtc) {
      const name = o.vendor?.name ?? "Counter sale";
      martMap.set(name, (martMap.get(name) ?? 0) + num(o.totalAmount));
    }
    // `marts` is assembled after the retail collections are fetched below.

    // "Orders" = customers actually served in the window, not delivery lines.
    const orders = new Set(
      winDeliveries.filter((e) => !e.isReturn && !e.isReplacement).map((e) => e.customerId)
    ).size;

    const [
      wastageRows,
      custCounts,
      lostInWindow,
      samples,
      vendorRecv,
      allCustomerIds,
      retailRecv,
      retailPayments,
      retailSpoilage,
    ] = await Promise.all([
      db.inventoryMovement.findMany({
        where: { type: "WASTAGE", date: { gte: win.start, lte: win.end } },
        select: { productId: true, quantity: true },
      }),
      db.customer.groupBy({ by: ["status"], _count: { _all: true } }),
      db.customer.count({
        where: { status: { in: ["INACTIVE", "DISABLED"] }, updatedAt: { gte: win.start, lte: win.end } },
      }),
      db.sampleLead.findMany({
        where: { createdAt: { gte: win.start, lte: win.end } },
        select: { status: true },
      }),
      db.vendorReceivable.findMany({ select: { amount: true, received: true } }),
      db.customer.findMany({ select: { id: true } }),
      db.retailReceivable.findMany({ select: { amount: true, received: true } }),
      // Counted when the shop PAYS — a report of "sold" that has not been paid for
      // is a receivable, not revenue (see recoveryMart below).
      db.retailPayment.findMany({
        where: { date: { gte: win.start, lte: win.end } },
        select: { amount: true, retailVendor: { select: { name: true } } },
      }),
      // Expired on a shop's shelf. Read from the retail records rather than a
      // WASTAGE movement, so it can never double-deduct stock.
      db.retailResolutionLine.findMany({
        where: {
          wastedQty: { gt: 0 },
          resolution: { date: { gte: win.start, lte: win.end } },
          // Retail products never entered inventory, so their loss is a retail
          // figure, not part of the farm's wastage value.
          placementLine: { product: { retailOnly: false } },
        },
        select: { wastedQty: true, rate: true },
      }),
    ]);

    // Wastage stores a quantity only, so it is valued at the product's rate.
    // Product that expired on a shop's shelf is added at the rate that shop
    // agreed, which is what it would have fetched.
    const wastageValue =
      wastageRows.reduce((s, m) => s + num(m.quantity) * num(prod.get(m.productId)?.defaultRate), 0) +
      retailSpoilage.reduce((s, r) => s + num(r.wastedQty) * num(r.rate), 0);

    // Consignment shops join the same breakdown, counted by what they actually
    // paid in this window — the same rule the retail total follows.
    for (const rp of retailPayments) {
      const name = rp.retailVendor.name;
      martMap.set(name, (martMap.get(name) ?? 0) + num(rp.amount));
    }
    const marts = [...martMap.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    const countOf = (s: string) => custCounts.find((c) => c.status === s)?._count._all ?? 0;
    const totalCustomers = custCounts.reduce((s, c) => s + c._count._all, 0);

    const outstanding = await computeCustomerOutstanding(allCustomerIds.map((c) => c.id));
    let recoveryCustomer = 0;
    for (const v of outstanding.values()) if (v > 0) recoveryCustomer += v;
    // "Marts" here covers both: vendors we sold to over the counter, and the
    // consignment shops on the Retail page.
    const recoveryMart =
      vendorRecv.reduce((s, r) => s + Math.max(0, num(r.amount) - num(r.received)), 0) +
      retailRecv.reduce((s, r) => s + Math.max(0, num(r.amount) - num(r.received)), 0);

    // ── Billing cycles: the canonical Bills figures, so the screens agree ──
    const halves = billingHalves(anchor);
    const overviews = await Promise.all(halves.map((h) => getBillingOverview(h.year, h.month, h.half)));

    const cyclePayments = await db.payment.findMany({
        // Farm-sale cash is excluded: it is not a route collection, and folding
        // an asset disposal into the cash-vs-digital mix would misread the
        // month. It has its own figure in `sales`.
      where: { date: { gte: halves[0].window.start, lte: halves[1].window.end }, farmSale: null },
      select: {
        date: true, amount: true, head: true, riderId: true,
        rider: { select: { user: { select: { name: true } } } },
      },
    });

    const cycles: CycleRow[] = halves.map((h, i) => {
      const t = overviews[i]?.totals ?? { billed: 0, collected: 0, outstanding: 0, generated: 0, pending: 0 };
      const pays = cyclePayments.filter((x) => inWin(x.date, h.window));
      const cash = pays.filter((x) => isCashHead(x.head)).reduce((s, x) => s + num(x.amount), 0);
      const digital = pays.filter((x) => !isCashHead(x.head)).reduce((s, x) => s + num(x.amount), 0);
      const perRider = new Map<string, number>();
      for (const x of pays) {
        if (!x.riderId || !isCashHead(x.head)) continue;
        const nm = x.rider?.user?.name ?? "Rider";
        perRider.set(nm, (perRider.get(nm) ?? 0) + num(x.amount));
      }
      return {
        label: h.label,
        billed: t.billed,
        collected: t.collected,
        pending: Math.max(0, t.billed - t.collected),
        pct: Math.round(pctOf(t.collected, t.billed)),
        cash,
        digital,
        riders: [...perRider.entries()]
          .map(([name, value]) => ({ name, value }))
          .sort((a, b) => b.value - a.value),
      };
    });

    // ── Delivery timeline ──
    const [routes, dispatchMoves, winPayments] = await Promise.all([
      db.route.findMany({
        where: { date: { gte: win.start, lte: win.end } },
        select: {
          startedAt: true,
          completedAt: true,
          shift: { select: { name: true, rider: { select: { user: { select: { name: true } } } } } },
          stops: { select: { deliveredAt: true } },
        },
      }),
      db.inventoryMovement.findMany({
        where: { type: "DISPATCHED", date: { gte: win.start, lte: win.end } },
        orderBy: { date: "asc" },
        take: 1,
        select: { date: true },
      }),
      db.payment.findMany({
        // Farm-sale cash is excluded: it is not a route collection, and folding
        // an asset disposal into the cash-vs-digital mix would misread the
        // month. It has its own figure in `sales`.
        where: { date: { gte: win.start, lte: win.end }, farmSale: null },
        select: {
          amount: true, head: true, riderId: true,
          rider: { select: { user: { select: { name: true } } } },
        },
      }),
    ]);

    const riderRows: RiderRow[] = routes
      .map((r) => {
        const delivered = r.stops.filter((s) => s.deliveredAt);
        const times = delivered.map((s) => s.deliveredAt!.getTime());
        const name = r.shift?.rider?.user?.name ?? r.shift?.name ?? "Unassigned";
        const cash = winPayments
          .filter((x) => isCashHead(x.head) && x.rider?.user?.name === name)
          .reduce((s, x) => s + num(x.amount), 0);
        return {
          name,
          out: timeStr(r.startedAt ?? (times.length ? new Date(Math.min(...times)) : null)),
          // completedAt is not written by the rider app today, so fall back to the
          // last stop actually delivered — otherwise the timeline never closes.
          back: timeStr(r.completedAt ?? (times.length ? new Date(Math.max(...times)) : null)),
          stops: delivered.length,
          cash,
        };
      })
      .filter((r) => r.out || r.stops > 0);

    const outs = riderRows.map((r) => r.out).filter(Boolean) as string[];
    const backs = riderRows.map((r) => r.back).filter(Boolean) as string[];
    const routeCash = winPayments.filter((x) => isCashHead(x.head)).reduce((s, x) => s + num(x.amount), 0);
    const digitalCash = winPayments.filter((x) => !isCashHead(x.head)).reduce((s, x) => s + num(x.amount), 0);

    // ── Team: checklist completion over the window ──
    const dayCount = Math.max(1, Math.round((win.end.getTime() - win.start.getTime() + 1) / 86_400_000));
    const checklists = await db.checklist.findMany({
      where: { active: true },
      select: {
        id: true,
        roleLabel: true,
        assignee: { select: { id: true, name: true, role: true } },
        items: {
          orderBy: { order: "asc" },
          select: {
            id: true,
            label: true,
            completions: {
              where: { date: { gte: win.start, lte: win.end } },
              select: { doneAt: true, doneBy: { select: { name: true } } },
              orderBy: { doneAt: "desc" },
            },
          },
        },
      },
    });

    const empMap = new Map<string, EmployeeRow>();
    for (const c of checklists) {
      const key = c.assignee.id;
      const row =
        empMap.get(key) ??
        {
          id: key,
          name: c.assignee.name,
          role: c.roleLabel ?? String(c.assignee.role),
          done: 0,
          total: 0,
          pct: 0,
          tasks: [] as TaskRow[],
        };
      for (const it of c.items) {
        const doneCount = it.completions.length;
        row.done += doneCount;
        row.total += dayCount;
        row.tasks.push({
          label: it.label,
          doneCount,
          expected: dayCount,
          lastDoneAt: it.completions[0]?.doneAt?.toISOString() ?? null,
          lastDoneBy: it.completions[0]?.doneBy?.name ?? null,
        });
      }
      empMap.set(key, row);
    }
    const employees = [...empMap.values()]
      .map((e) => ({ ...e, pct: Math.round(pctOf(e.done, e.total)) }))
      .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
    const totalDone = employees.reduce((s, e) => s + e.done, 0);
    const totalTasks = employees.reduce((s, e) => s + e.total, 0);

    // ── Costs: window spend by category + month-to-date against budget ──
    const [y, m] = anchor.split("-").map(Number);
    const monthWin = resolveWindow("month", anchor);
    const [budgets, monthExpenses] = await Promise.all([
      db.monthlyBudget.findMany({
        where: { month: m, year: y },
        select: { categoryId: true, amount: true },
      }),
      db.expense.findMany({
        where: { date: { gte: monthWin.start, lte: monthWin.end } },
        select: { categoryId: true, amount: true },
      }),
    ]);
    const winExpenses = expenses.filter((e) => inWin(e.date, win));
    const catWin = new Map<string, { name: string; amount: number }>();
    for (const e of winExpenses) {
      const row = catWin.get(e.categoryId) ?? { name: e.category.name, amount: 0 };
      row.amount += num(e.amount);
      catWin.set(e.categoryId, row);
    }
    const mtdByCat = new Map<string, number>();
    for (const e of monthExpenses) mtdByCat.set(e.categoryId, (mtdByCat.get(e.categoryId) ?? 0) + num(e.amount));
    // Summed: a category's budget may be split by item into several rows.
    const budgetByCat = new Map<string, number>();
    for (const b of budgets) budgetByCat.set(b.categoryId, (budgetByCat.get(b.categoryId) ?? 0) + num(b.amount));

    // Salaries are real spend but carry no category — shown as their own row.
    const winSalaries = salaries.filter((e) => inWin(e.paidAt, win)).reduce((s, e) => s + num(e.amount), 0);
    const costTotalWindow = [...catWin.values()].reduce((s, c) => s + c.amount, 0) + winSalaries;

    const costRows: CostRow[] = [...catWin.entries()]
      .map(([id, c]) => ({
        name: c.name,
        amount: c.amount,
        share: pctOf(c.amount, costTotalWindow),
        budget: budgetByCat.get(id) ?? 0,
        mtdUsed: mtdByCat.get(id) ?? 0,
      }))
      .sort((a, b) => b.amount - a.amount);
    if (winSalaries > 0) {
      costRows.push({
        name: "Salaries paid",
        amount: winSalaries,
        share: pctOf(winSalaries, costTotalWindow),
        budget: 0,
        mtdUsed: 0,
      });
    }

    const monthBudgetTotal = budgets.reduce((s, b) => s + num(b.amount), 0);
    const mtdTotal = monthExpenses.reduce((s, e) => s + num(e.amount), 0);

    const cycleBilled = cycles.reduce((s, c) => s + c.billed, 0);
    const cycleCollected = cycles.reduce((s, c) => s + c.collected, 0);

    return {
      dbReady: true,
      period: p,
      dateStr: anchor,
      subtitle: periodSubtitle(p, anchor),
      windowLabel: win.label,
      compareLabel:
        p === "day" ? "vs previous day" : p === "week" ? "vs previous week" : "vs previous month",
      finance: {
        revenue: cur.revenue,
        expenses: cur.expenses,
        profit: cur.profit,
        margin: pctOf(cur.profit, cur.revenue),
        prevRevenue: prev.revenue,
        prevExpenses: prev.expenses,
        prevProfit: prev.profit,
        trend: bucketTotals,
      },
      collection: {
        billed: cycleBilled,
        collected: cycleCollected,
        pct: Math.round(pctOf(cycleCollected, cycleBilled)),
      },
      sales: {
        customerSales,
        // NOT `+ retailCollected`. That used to be here because consignment only
        // counted when the shop paid — now it counts when they report it sold, so
        // adding the cash on top would count a mart sale twice all over again.
        retailSales,
        milkLitres,
        eggPieces,
        orders,
        wastageValue,
        activeCustomers: countOf("ACTIVE"),
        totalCustomers,
        lostCustomers: lostInWindow,
        onCallCustomers: countOf("ON_CALL"),
        samplesAdded: samples.length,
        converted: samples.filter((s) => s.status === "CONVERTED").length,
        recoveryCustomer,
        recoveryMart,
        products: productRows,
        marts,
      },
      cycles,
      delivery: {
        packagedAt: timeStr(dispatchMoves[0]?.date ?? null),
        firstOut: outs.length ? outs.slice().sort()[0] : null,
        lastBack: backs.length ? backs.slice().sort().reverse()[0] : null,
        riders: riderRows.sort((a, b) => b.stops - a.stops),
        routeCash,
        digitalCash,
      },
      team: { totalDone, totalTasks, pct: Math.round(pctOf(totalDone, totalTasks)), employees },
      costs: { total: costTotalWindow, rows: costRows, monthBudgetTotal, mtdTotal, monthLabel: monthWin.label },
    };
  } catch (e) {
    console.error("[getSummaryReport]", e);
    return emptyReport(p, anchor, false);
  }
}
