"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { getDashboardData } from "../dashboard-data";
import { getMonthlyExpenses } from "../payments/expenses/actions";
import { getInventorySummary } from "../inventory/actions";
import type { HeadBalance } from "@/lib/head-balances";

const PKT = 5 * 60 * 60 * 1000; // PKT midnight = UTC − 5h
const num = (x: Prisma.Decimal | null) => Number(x ?? 0);

// PKT "YYYY-MM" bucket key for a stored UTC instant.
function pktMonthKey(d: Date): string {
  const t = new Date(d.getTime() + PKT);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type MonthPoint = { month: string; label: string; moneyIn: number; moneyOut: number; net: number };
export type SalesPoint = { month: string; label: string; sales: number; collected: number };

// Accrual profitability for one window (revenue billed − all costs incurred).
export type ProfitWindow = { revenue: number; expenses: number; netProfit: number; margin: number };
const ZERO_PROFIT: ProfitWindow = { revenue: 0, expenses: 0, netProfit: 0, margin: 0 };

// Revenue = subscription invoices (net of returns, + delivery fee) + OTC sales.
// All Expenses = operating expenses + salaries + OTC purchase cost (goods bought).
// Net Profit = Revenue − All Expenses (accrual). Margin = Net Profit ÷ Revenue.
// Invoices are keyed by month/year (no day column) so they filter on year/month;
// every dated table filters on its date/paidAt range.
async function windowProfit(dateGte: Date, dateLte: Date, invWhere: Prisma.InvoiceWhereInput): Promise<ProfitWindow> {
  const range = { gte: dateGte, lte: dateLte };
  const [invAgg, otcSalesAgg, expenseAgg, salaryAgg, otcPurchaseAgg] = await Promise.all([
    db.invoice.aggregate({ _sum: { deliveriesAmt: true, returnsAmt: true, deliveryCharge: true }, where: invWhere }),
    db.otcSale.aggregate({ _sum: { totalAmount: true }, where: { date: range } }),
    db.expense.aggregate({ _sum: { amount: true }, where: { date: range } }),
    db.salaryPayment.aggregate({ _sum: { amount: true }, where: { paidAt: range } }),
    db.otcPurchase.aggregate({ _sum: { totalAmount: true }, where: { date: range } }),
  ]);
  const revenue =
    num(invAgg._sum.deliveriesAmt) - num(invAgg._sum.returnsAmt) + num(invAgg._sum.deliveryCharge)
    + num(otcSalesAgg._sum.totalAmount);
  const expenses =
    num(expenseAgg._sum.amount) + num(salaryAgg._sum.amount) + num(otcPurchaseAgg._sum.totalAmount);
  const netProfit = revenue - expenses;
  const margin = revenue > 0 ? netProfit / revenue : 0;
  return { revenue, expenses, netProfit, margin };
}

export type ReportsData = {
  selectedMonth: string; // "YYYY-MM"
  dbReady: boolean;
  // Snapshot / single-month pieces (reused from existing aggregations)
  heads: HeadBalance[];
  collection: { billed: number; collected: number; pending: number };
  expenseByCategory: { name: string; amount: number }[];
  stockByProduct: { name: string; unit: string; inStorage: number }[];
  // 90-day milk trend (reused, feeds the stacked inventory chart)
  milkTrend: { date: string; totalL: number; byType: Record<string, number> }[];
  milkTypes: { id: string; name: string; totalL: number }[];
  // The only NEW aggregation — rolling last-12-months series.
  cashFlow: MonthPoint[];
  sales: SalesPoint[];
  // Accrual Revenue vs Expenses → Net Profit, for the selected month (MTD) and
  // Jan 1 → end of the selected month (YTD).
  profitability: { ytd: ProfitWindow; mtd: ProfitWindow };
};

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} ${String(y).slice(2)}`;
}

// Build the axis of the last 12 PKT months, oldest → newest, ending this month.
function last12Months(): string[] {
  const nowPKT = new Date(Date.now() + PKT);
  const y = nowPKT.getUTCFullYear();
  const m = nowPKT.getUTCMonth(); // 0-based
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export async function getReportsData(selectedMonth?: string): Promise<ReportsData> {
  await requireRole(FULL_ACCESS);

  const nowPKT = new Date(Date.now() + PKT);
  const curMonthKey = `${nowPKT.getUTCFullYear()}-${String(nowPKT.getUTCMonth() + 1).padStart(2, "0")}`;
  const selMonth = selectedMonth ?? curMonthKey;
  const [selY, selM] = selMonth.split("-").map(Number);

  try {
    const months = last12Months();
    // Window start = first day (PKT) of the oldest month in the axis, as a UTC instant.
    const [startY, startM] = months[0].split("-").map(Number);
    const windowStart = new Date(Date.UTC(startY, startM - 1, 1) - PKT);

    const [dash, monthlyExp, inv, paymentRows, expenseRows, salaryRows, otcRows, invoiceRows] =
      await Promise.all([
        getDashboardData(selMonth),
        getMonthlyExpenses(selM, selY),
        getInventorySummary("today"),
        db.payment.findMany({
          where: { date: { gte: windowStart } },
          select: { date: true, amount: true, customerId: true },
        }),
        db.expense.findMany({
          where: { date: { gte: windowStart } },
          select: { date: true, amount: true },
        }),
        db.salaryPayment.findMany({
          where: { paidAt: { gte: windowStart } },
          select: { paidAt: true, amount: true },
        }),
        db.otcSale.findMany({
          where: { date: { gte: windowStart } },
          select: { date: true, totalAmount: true },
        }),
        // Invoices are keyed by month/year (no day column), so scope by the axis range.
        db.invoice.findMany({
          where: { OR: [{ year: { gt: startY } }, { year: startY, month: { gte: startM } }] },
          select: { month: true, year: true, deliveriesAmt: true, returnsAmt: true, deliveryCharge: true },
        }),
      ]);

    // ── Bucket the 12-month series ────────────────────────────────────────────
    const mkMap = () => new Map<string, number>(months.map((m) => [m, 0]));
    const inMap = mkMap();        // all cash in (Payment)
    const collectedMap = mkMap(); // customer-attributed cash in (Payment w/ customerId)
    const outMap = mkMap();       // Expense + SalaryPayment
    const salesMap = mkMap();     // Invoice net + OTC sales

    for (const p of paymentRows) {
      const k = pktMonthKey(p.date);
      if (!inMap.has(k)) continue;
      inMap.set(k, inMap.get(k)! + num(p.amount));
      if (p.customerId) collectedMap.set(k, collectedMap.get(k)! + num(p.amount));
    }
    for (const e of expenseRows) {
      const k = pktMonthKey(e.date);
      if (outMap.has(k)) outMap.set(k, outMap.get(k)! + num(e.amount));
    }
    for (const s of salaryRows) {
      const k = pktMonthKey(s.paidAt);
      if (outMap.has(k)) outMap.set(k, outMap.get(k)! + num(s.amount));
    }
    for (const o of otcRows) {
      const k = pktMonthKey(o.date);
      if (salesMap.has(k)) salesMap.set(k, salesMap.get(k)! + num(o.totalAmount));
    }
    for (const inv2 of invoiceRows) {
      const k = `${inv2.year}-${String(inv2.month).padStart(2, "0")}`;
      if (!salesMap.has(k)) continue;
      salesMap.set(
        k,
        salesMap.get(k)! + num(inv2.deliveriesAmt) - num(inv2.returnsAmt) + num(inv2.deliveryCharge)
      );
    }

    const cashFlow: MonthPoint[] = months.map((m) => {
      const moneyIn = inMap.get(m)!;
      const moneyOut = outMap.get(m)!;
      return { month: m, label: monthLabel(m), moneyIn, moneyOut, net: moneyIn - moneyOut };
    });
    const sales: SalesPoint[] = months.map((m) => ({
      month: m,
      label: monthLabel(m),
      sales: salesMap.get(m)!,
      collected: collectedMap.get(m)!,
    }));

    // ── Profitability: YTD (Jan 1 → end of selected month) and MTD (selected month) ──
    const yearStart     = new Date(Date.UTC(selY, 0, 1) - PKT);
    const selMonthStart = new Date(Date.UTC(selY, selM - 1, 1) - PKT);
    const selMonthEnd   = new Date(Date.UTC(selY, selM, 1) - PKT - 1);
    const [ytd, mtd] = await Promise.all([
      windowProfit(yearStart, selMonthEnd, { year: selY, month: { lte: selM } }),
      windowProfit(selMonthStart, selMonthEnd, { year: selY, month: selM }),
    ]);

    return {
      selectedMonth: selMonth,
      dbReady: true,
      heads: dash.heads,
      collection: dash.collection,
      expenseByCategory: monthlyExp.byCategory
        .filter((c) => c.amount > 0)
        .map((c) => ({ name: c.name, amount: c.amount })),
      stockByProduct: inv.products
        .filter((p) => p.inStorage > 0.001)
        .map((p) => ({ name: p.productName, unit: p.unit, inStorage: p.inStorage })),
      milkTrend: dash.milkTrend,
      milkTypes: dash.milkTypes,
      cashFlow,
      sales,
      profitability: { ytd, mtd },
    };
  } catch {
    return {
      selectedMonth: selMonth,
      dbReady: false,
      heads: [],
      collection: { billed: 0, collected: 0, pending: 0 },
      expenseByCategory: [],
      stockByProduct: [],
      milkTrend: [],
      milkTypes: [],
      cashFlow: [],
      sales: [],
      profitability: { ytd: ZERO_PROFIT, mtd: ZERO_PROFIT },
    };
  }
}
