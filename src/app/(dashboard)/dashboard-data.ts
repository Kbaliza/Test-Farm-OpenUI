import "server-only";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { getHeadBalances, type HeadBalance } from "@/lib/head-balances";
import { getProductSales } from "@/lib/product-sales";
import { computeCustomerOutstanding } from "@/lib/customer-balance";

const PKT = 5 * 60 * 60 * 1000;

const num = (x: Prisma.Decimal | null) => Number(x ?? 0);

function monthRange(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1) - PKT);
  const end   = new Date(Date.UTC(year, month,     1) - PKT - 1);
  return { start, end };
}

function prevMonthOf(year: number, month: number): { year: number; month: number } {
  return month === 1
    ? { year: year - 1, month: 12 }
    : { year, month: month - 1 };
}

export type DashboardData = {
  heads: HeadBalance[];
  selectedMonth: string; // "YYYY-MM"
  kpis: {
    collected:      number;
    outstanding:    number;      // customer receivables (the customer half of pendingPayments)
    pendingPayments: number;     // what they owe us: customers + vendors, never netted against weOwe
    pendingVendors:  number;     // vendor half of pendingPayments (receivables)
    pendingRetail:   number;     // retail-mart half of pendingPayments (shops that owe for product they sold)
    weOwe:          number;      // what we owe vendors: unpaid vendor bills
    profit:         number;
    expenses:       number;
    monthlySales:   number; // subscription deliveries billed + Over-the-Counter sales
    /** What sold, by product, for the selected month. Sorted by value. Sums to
     *  `monthlySales` exactly, which makes the card a live check on the KPI. */
    salesByProduct: { productId: string; name: string; unit: string; qty: number; value: number }[];
    /** Animals, machinery, feed and scrap sold this month. Its own figure on
     *  purpose: an asset disposal is not revenue, so it is NOT in monthlySales
     *  and NOT in profit — see the payment query in this file. */
    farmSales:      number;
    otcPurchases:   number; // cost of goods bought over the counter (part of the profit deduction)
    activeCustomers: number;
    newCustomers:   number;
    lostCustomers:  number;   // cumulative total in Lost (matches the Lost tab)
    lostThisMonth:  number;   // how many became lost in the selected month
    // previous-month values for delta
    prevCollected:    number;
    prevProfit:       number;
    prevExpenses:     number;
    prevNew:          number;
    prevLost:         number;
    prevOutstanding:  number;
    prevMonthlySales: number;
  };
  budget: {
    total: number;
    spent: number;
    remaining: number;
    categories: { name: string; used: number; budget: number }[];
  };
  collection: { billed: number; collected: number; pending: number };
  milkInventory: { arrived: number; outsourced: number; delivered: number; wastage: number; netBalance: number };
  // Rolling 90 days ending today (independent of the selected month), so the
  // chart's 7D/30D/90D toggle always has enough real data to slice from.
  // Per-day litres, split by milk product. `byType` is keyed by product id.
  milkTrend: { date: string; totalL: number; byType: Record<string, number> }[];
  milkTypes: { id: string; name: string; totalL: number }[];
  // Daily series behind the KPI sparklines, scoped to the selected month.
  // Profit/Outstanding used to be omitted here because Invoice is keyed by
  // month/year with no day column — now that DeliveryEntry (dated) and OtcSale
  // (dated) are real per-day revenue events, and Invoice.generatedAt gives a
  // real day for subscription charges, both have an honest daily breakdown:
  // profit = (delivery + OTC sale revenue) - (expenses + OTC purchase cost) per
  // day; outstanding = running balance, cumulative from the prior month-end.
  series: {
    dates:        string[];
    collected:    number[];
    expenses:     number[];
    newCust:      number[];
    lostCust:     number[];
    profit:       number[];
    outstanding:  number[];
    monthlySales: number[];
  };
};

// A PKT calendar-day key ("YYYY-MM-DD") for a stored UTC instant.
function pktDayKey(d: Date): string {
  const t = new Date(d.getTime() + PKT);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

// Bucket dated rows onto a fixed day axis, so gaps read as 0 rather than closing up.
function bucketByDay(
  rows: { at: Date; value: number }[],
  days: string[]
): number[] {
  const sums = new Map<string, number>(days.map((d) => [d, 0]));
  for (const r of rows) {
    const k = pktDayKey(r.at);
    if (sums.has(k)) sums.set(k, (sums.get(k) ?? 0) + r.value);
  }
  return days.map((d) => sums.get(d) ?? 0);
}

export async function getDashboardData(selectedMonth: string): Promise<DashboardData> {
  const [selYear, selMonth] = selectedMonth.split("-").map(Number);
  const cur  = monthRange(selYear, selMonth);
  const prev = prevMonthOf(selYear, selMonth);
  const prv  = monthRange(prev.year, prev.month);

  // ── Sparkline day axis ──────────────────────────────────────────────────────
  // Every day of the selected month, truncated at today when it's the running
  // month so the line doesn't trail off across days that haven't happened yet.
  // Built up here rather than after the fetch because getProductSales fills the
  // Monthly Sales series in the same pass — which is what finally makes the
  // sparkline sum to the KPI above it.
  const todayKey   = pktDayKey(new Date());
  const daysInMon  = new Date(Date.UTC(selYear, selMonth, 0)).getUTCDate();
  const seriesDates: string[] = [];
  for (let d = 1; d <= daysInMon; d++) {
    const key = `${selYear}-${String(selMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (key > todayKey) break;
    seriesDates.push(key);
  }
  const dayBuckets = seriesDates.map((key) => ({
    key,
    start: new Date(`${key}T00:00:00.000Z`),
    end: new Date(`${key}T23:59:59.999Z`),
  }));

  const [
    heads,
    // current month
    invoiceAgg,
    // previous month
    prevCollectedAgg,
    prevExpenseAgg,
    prevSalaryAgg,
    prevInvoiceAgg,
    prevNew,
    prevLost,
    // Outstanding — just the customer ids that existed by each cutoff (a
    // customer who joined this month can't have contributed to what was owed
    // last month). The actual balance is computed by the shared helper below,
    // via computeCustomerOutstanding() — same formula Recovery/WhatsApp use.
    customerIdsToCurEnd,
    customerIdsToPrevEnd,
    // active customers (always current)
    activeCustomers,
    // budget
    budgets,
    categories,
    monthExpenseByCat,
    salaryBudgetAgg,
    // Current-month dated rows. These carry the same data the collected /
    // expense / new / lost aggregates used to fetch separately, so those five
    // queries are gone — the totals are summed from these rows instead, and the
    // same rows also feed the KPI sparklines. Identical where-clauses, one trip.
    paymentRows,
    expenseRows,
    salaryRows,
    newCustRows,
    lostCustRows,
    // Over-the-Counter activity this month + last month (Monthly Sales KPI,
    // Profit, and — for the dated rows — the daily Profit/Outstanding series).
    otcSalesMonthRows,
    otcPurchasesMonthRows,
    // Non-milk sales (animals, machinery, feed). Deliberately kept OUT of Monthly
    // Sales and Profit — see the payment query above — and surfaced on their own.
    farmSalesMonthRows,
    // THE sales figure — deliveries + counter + consignment, one definition shared
    // with the summary report. See lib/product-sales for what is excluded and why.
    productSales,
    prevProductSales,
    prevOtcSalesAgg,
    prevOtcPurchasesAgg,
    // Real dated revenue events for the daily Profit series.
    deliveryRevenueRows,
    // Real dated subscription charges (the day each invoice was actually
    // generated) for the daily Outstanding series.
    invoiceGeneratedRows,
    // Live vendor payable / receivable rows.
    vendorBillRows,
    vendorReceivableRows,
    retailReceivableRows,
    retailPaymentMonthRows,
  ] = await Promise.all([
    getHeadBalances(),
    db.invoice.aggregate({
      _sum: { deliveriesAmt: true, returnsAmt: true, deliveryCharge: true, discount: true },
      where: { month: selMonth, year: selYear },
    }),
    // previous month
    db.payment.aggregate({ _sum: { amount: true }, where: { date: { gte: prv.start, lte: prv.end } } }),
    db.expense.aggregate({ _sum: { amount: true }, where: { date: { gte: prv.start, lte: prv.end } } }),
    db.salaryPayment.aggregate({ _sum: { amount: true }, where: { paidAt: { gte: prv.start, lte: prv.end } } }),
    db.invoice.aggregate({
      _sum: { deliveriesAmt: true, returnsAmt: true, deliveryCharge: true, discount: true },
      where: { month: prev.month, year: prev.year },
    }),
    db.customer.count({ where: { joinDate: { gte: prv.start, lte: prv.end } } }),
    db.customer.count({ where: { status: { in: ["INACTIVE", "DISABLED"] }, updatedAt: { gte: prv.start, lte: prv.end } } }),
    // Outstanding — see comment above on the destructured names.
    db.customer.findMany({ where: { joinDate: { lte: cur.end } }, select: { id: true } }),
    db.customer.findMany({ where: { joinDate: { lte: prv.end } }, select: { id: true } }),
    // active customers
    db.customer.count({ where: { status: "ACTIVE" } }),
    // budget (always current calendar month)
    db.monthlyBudget.findMany({ where: { month: selMonth, year: selYear } }),
    db.expenseCategory.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    db.expense.groupBy({ by: ["categoryId"], where: { date: { gte: cur.start, lte: cur.end } }, _sum: { amount: true } }),
    db.salaryPayment.aggregate({ _sum: { amount: true }, where: { month: selMonth, year: selYear } }),
    // Sparkline rows. Each hits an indexed date column and is scoped to one month.
    db.payment.findMany({
      // `farmSale: null` leaves out the cash from selling an animal, a machine or a
      // trolley of silage. That money is real and IS in the head — head balances and
      // the head ledger both count it — but selling an asset is not earning, and
      // Profit here is `collected − expenses`, so a Rs 265,000 buffalo would make a
      // month look wildly profitable and bury the milk margin. It gets its own KPI
      // below instead. Filtered on the relation, never on notes text.
      where: { date: { gte: cur.start, lte: cur.end }, farmSale: null },
      select: { date: true, amount: true, customerId: true },
    }),
    db.expense.findMany({
      where: { date: { gte: cur.start, lte: cur.end } },
      select: { date: true, amount: true },
    }),
    db.salaryPayment.findMany({
      where: { paidAt: { gte: cur.start, lte: cur.end } },
      select: { paidAt: true, amount: true },
    }),
    db.customer.findMany({
      where: { joinDate: { gte: cur.start, lte: cur.end } },
      select: { joinDate: true },
    }),
    db.customer.findMany({
      where: { status: { in: ["INACTIVE", "DISABLED"] }, updatedAt: { gte: cur.start, lte: cur.end } },
      select: { updatedAt: true },
    }),
    db.otcSale.findMany({
      where: { date: { gte: cur.start, lte: cur.end } },
      select: { date: true, totalAmount: true, paidAmount: true, paymentStatus: true },
    }),
    db.otcPurchase.findMany({
      where: { date: { gte: cur.start, lte: cur.end } },
      select: { date: true, totalAmount: true },
    }),
    db.farmSale.findMany({
      where: { date: { gte: cur.start, lte: cur.end } },
      select: { date: true, totalAmount: true },
    }),
    getProductSales(cur, { buckets: dayBuckets }),
    getProductSales(prv),
    db.otcSale.aggregate({
      _sum: { totalAmount: true },
      where: { date: { gte: prv.start, lte: prv.end } },
    }),
    db.otcPurchase.aggregate({
      _sum: { totalAmount: true },
      where: { date: { gte: prv.start, lte: prv.end } },
    }),
    db.deliveryEntry.findMany({
      where: { date: { gte: cur.start, lte: cur.end } },
      select: { date: true, quantity: true, unitRate: true, isReturn: true, isReplacement: true },
    }),
    db.invoice.findMany({
      where: { generatedAt: { gte: cur.start, lte: cur.end } },
      select: { generatedAt: true, deliveriesAmt: true, returnsAmt: true, deliveryCharge: true, discount: true },
    }),
    // Live vendor payable (what WE owe them) and receivable (what THEY owe us),
    // for the "Outstanding (we owe them)" tile and the vendor half of "Pending
    // Payments (they owe us)". Current balances — the same numbers the Vendors
    // page shows — not month-scoped snapshots (paid/received are mutable running
    // totals with no dated history to reconstruct an as-of-month-end figure).
    db.vendorBill.findMany({ select: { amount: true, paid: true } }),
    db.vendorReceivable.findMany({ select: { amount: true, received: true } }),
    db.retailReceivable.findMany({ select: { amount: true, received: true } }),
    db.retailPayment.findMany({ where: { date: { gte: cur.start, lte: cur.end } }, select: { amount: true } }),
  ]);

  // Current month KPIs — summed from the same rows that feed the sparklines,
  // rather than re-querying the database for totals it already handed us.
  const sumAmt = (rows: { amount: Prisma.Decimal }[]) =>
    rows.reduce((s, r) => s + num(r.amount), 0);

  const collected      = sumAmt(paymentRows);
  const expensesMonth  = sumAmt(expenseRows) + sumAmt(salaryRows);
  const newCustomers   = newCustRows.length;
  // Card shows the cumulative total lost (INACTIVE + DISABLED) so it matches the
  // Lost tab every month; the monthly flow is surfaced as a "+N this month" sub-line.
  const lostThisMonth  = lostCustRows.length;
  const lostCustomers  = await db.customer.count({ where: { status: { in: ["INACTIVE", "DISABLED"] } } });
  const salesMonth   =
    num(invoiceAgg._sum.deliveriesAmt) -
    num(invoiceAgg._sum.returnsAmt) +
    num(invoiceAgg._sum.deliveryCharge) -
    // A one-off allowance on a bill is money never charged, so it is not revenue.
    num(invoiceAgg._sum.discount);

  // Monthly Sales = subscription deliveries billed + Over-the-Counter sales.
  // A credit OTC sale counts immediately (it's revenue earned, not yet
  // collected) — same principle Invoice charges already follow.
  const farmSalesMonth = farmSalesMonthRows.reduce((s, r) => s + num(r.totalAmount), 0);
  const otcSalesMonth = otcSalesMonthRows.reduce((s, r) => s + num(r.totalAmount), 0);
  // Retail marts are counted when the shop actually PAYS, not when they report a
  // sale: product sitting on their shelf is not revenue, and what they have
  // reported but not paid for is a receivable (below), not a sale.
  const retailSalesMonth = retailPaymentMonthRows.reduce((s, r) => s + num(r.amount), 0);
  const otcPurchasesMonth = otcPurchasesMonthRows.reduce((s, r) => s + num(r.totalAmount), 0);
  // One definition, and it no longer waits for bills to be generated. `salesMonth`
  // (Invoice) and `retailSalesMonth` (RetailPayment) are still computed above for
  // the Collection Status card, which is about BILLING and COLLECTION rather than
  // about product sold — two different questions that shared one number before.
  const monthlySales = productSales.total;

  // Profit is CASH-basis: money actually collected this month minus expenses
  // actually paid (expense payments + salaries). It is NOT accrual (billed sales
  // minus accrued costs) — a delivery that hasn't been paid for, or a bill we
  // haven't settled, doesn't move profit until the cash actually changes hands.
  const profit = collected - expensesMonth;

  // Previous month KPIs
  const prevCollected = num(prevCollectedAgg._sum.amount);
  const prevExpenses  = num(prevExpenseAgg._sum.amount) + num(prevSalaryAgg._sum.amount);
  const prevSales     =
    num(prevInvoiceAgg._sum.deliveriesAmt) -
    num(prevInvoiceAgg._sum.returnsAmt) +
    num(prevInvoiceAgg._sum.deliveryCharge) -
    num(prevInvoiceAgg._sum.discount);
  const prevOtcSalesMonth = num(prevOtcSalesAgg._sum.totalAmount);
  const prevOtcPurchasesMonth = num(prevOtcPurchasesAgg._sum.totalAmount);
  const prevMonthlySales = prevProductSales.total;
  // Same cash-basis definition as the current month (collected − expenses paid).
  const prevProfit = prevCollected - prevExpenses;

  // Outstanding — balance as of the end of the selected month, and as of the
  // end of the month before it (for the delta), via the same shared helper
  // Recovery/WhatsApp use — so this number can never again silently drift
  // out of sync with what those pages consider "outstanding."
  const [outstandingByCust, prevOutstandingByCust] = await Promise.all([
    computeCustomerOutstanding(customerIdsToCurEnd.map((c) => c.id), { year: selYear, month: selMonth, asOfDate: cur.end }),
    computeCustomerOutstanding(customerIdsToPrevEnd.map((c) => c.id), { year: prev.year, month: prev.month, asOfDate: prv.end }),
  ]);
  const outstanding = [...outstandingByCust.values()].reduce((s, v) => s + v, 0);
  const prevOutstanding = [...prevOutstandingByCust.values()].reduce((s, v) => s + v, 0);

  // Two directional money tiles (live balances):
  //   weOwe            = unpaid vendor bills               → "Outstanding (what we owe them)"
  //   pendingPayments  = customers + vendors owe us        → "Pending Payments (what they owe us)"
  // Payable and receivable are tracked separately and never netted (see Vendors
  // page). The customer half reuses `outstanding` (as of month-end); the vendor
  // halves are current live balances.
  const weOwe = vendorBillRows.reduce((s, b) => s + Math.max(0, num(b.amount) - num(b.paid)), 0);
  const vendorReceivable = vendorReceivableRows.reduce((s, r) => s + Math.max(0, num(r.amount) - num(r.received)), 0);
  // What the shops still owe for product they have reported sold.
  const retailReceivable = retailReceivableRows.reduce((s, r) => s + Math.max(0, num(r.amount) - num(r.received)), 0);
  const pendingPayments = outstanding + vendorReceivable + retailReceivable;

  // Budget
  const spentByCat: Record<string, number> = {};
  for (const e of monthExpenseByCat) spentByCat[e.categoryId] = num(e._sum.amount);
  const salaryCat = categories.find((c) => c.name.toLowerCase().includes("salar"));
  if (salaryCat) spentByCat[salaryCat.id] = (spentByCat[salaryCat.id] ?? 0) + num(salaryBudgetAgg._sum.amount);
  // A category's budget is the sum of its rows — it may be split by item.
  const budgetByCat  = new Map<string, number>();
  for (const b of budgets) budgetByCat.set(b.categoryId, (budgetByCat.get(b.categoryId) ?? 0) + num(b.amount));
  const totalBudget  = budgets.reduce((s, b) => s + num(b.amount), 0);
  const budgetCategories = categories.map((c) => ({
    name:   c.name,
    used:   spentByCat[c.id] ?? 0,
    budget: budgetByCat.get(c.id) ?? 0,
  }));

  // Collection status. `billed` and `collected` must describe the SAME universe —
  // sales — or Pending is wrong. Billed = monthlySales (subscription deliveries +
  // every OTC sale). Collected against sales = customer payments (customerId set) +
  // OTC sales actually paid. The top-level `collected` KPI counts ALL cash-in
  // (incl. vendor receipts and contra settlements, which are NOT sales); folding
  // those in here understated Pending, so they're deliberately excluded.
  const salesCollected =
    paymentRows.filter((r) => r.customerId).reduce((s, r) => s + num(r.amount), 0)
    // Cash actually taken on OTC sales = the paid slice of each (full, partial, or 0).
    + otcSalesMonthRows.reduce((s, r) => s + num(r.paidAmount), 0)
    // Money a mart handed over. Now that consignment counts as SOLD when the shop
    // reports it, its cash has to count as COLLECTED here too — otherwise every
    // mart sale would sit in `billed` with nothing ever matching it and Pending
    // would creep up for ever. Retail payments carry no customerId, so they are
    // not already in the first term.
    + retailSalesMonth;
  const billed  = monthlySales;
  const pending = Math.max(0, billed - salesCollected);

  // Milk inventory for selected month + 90-day trend (rolling, ending today,
  // independent of the selected month — the chart's 7D/30D/90D toggle slices
  // this client-side, so all 90 days of real data need to be here up front).
  const literProducts = await db.product.findMany({
    where: { unit: "LITER", active: true, retailOnly: false },
    select: { id: true, name: true },
  });
  const literIds = literProducts.map((p) => p.id);
  const literName = new Map(literProducts.map((p) => [p.id, p.name]));

  const TREND_DAYS = 90;
  const pktNow = new Date(Date.now() + PKT);
  const trendDates: string[] = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const d = new Date(pktNow.getTime() - i * 86_400_000);
    trendDates.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
    );
  }
  const [ty0, tm0, td0] = trendDates[0].split("-").map(Number);
  const trendStart = new Date(Date.UTC(ty0, tm0 - 1, td0) - PKT);

  const [[milkWastageAgg, milkDeliveredAgg, milkOutsourcedAgg], retailDispatches, retailArrivedRows, trendFarmDispatches, trendCounterPurchases] = await Promise.all([
    Promise.all([
      db.inventoryMovement.aggregate({
        _sum: { quantity: true },
        where: { date: { gte: cur.start, lte: cur.end }, type: "WASTAGE", productId: { in: literIds } },
      }),
      db.deliveryEntry.aggregate({
        _sum: { quantity: true },
        where: {
          date: { gte: cur.start, lte: cur.end },
          isReturn: false,
          isReplacement: false,
          productId: { in: literIds },
        },
      }),
      // Outsourced milk = milk bought from outside via an Over-the-Counter purchase.
      db.inventoryMovement.aggregate({
        _sum: { quantity: true },
        where: { date: { gte: cur.start, lte: cur.end }, type: "COUNTER_PURCHASE", productId: { in: literIds } },
      }),
    ]),
    db.retailDispatch.findMany({ select: { id: true } }),
    db.inventoryMovement.findMany({
      where: {
        date: { gte: cur.start, lte: cur.end },
        type: "ARRIVED",
        productId: { in: literIds },
      },
      select: { quantity: true, reference: true },
    }),
    // One query for the whole 90-day window (not one query per day — that
    // would be 90 round trips against a 5-connection pool) — bucketed by day
    // in JS below via pktDayKey, same helper the KPI sparklines already use.
    db.farmDispatch.findMany({
      where: { date: { gte: trendStart, lte: pktNow } },
      select: { date: true, declaredItems: true, receivedItems: true },
    }),
    // Outsourced milk over the 90-day trend window, for the chart's distinct series.
    db.inventoryMovement.findMany({
      where: { date: { gte: trendStart, lte: pktNow }, type: "COUNTER_PURCHASE", productId: { in: literIds } },
      select: { date: true, quantity: true },
    }),
  ]);

  const trendFarmDispatchesByDay = new Map<string, { declaredItems: unknown; receivedItems: unknown }[]>();
  for (const d of trendFarmDispatches) {
    const key = pktDayKey(d.date);
    if (!trendFarmDispatchesByDay.has(key)) trendFarmDispatchesByDay.set(key, []);
    trendFarmDispatchesByDay.get(key)!.push(d);
  }

  type FDItem = { productId: string; unit: string; quantity: number };
  // Same rows sumFD always walked — now kept split by product so the trend can
  // stack by milk type instead of collapsing to a single total.
  const splitFD = (
    dispatches: { declaredItems: unknown; receivedItems: unknown }[]
  ): Record<string, number> => {
    const byType: Record<string, number> = {};
    for (const d of dispatches) {
      const items = (d.receivedItems ?? d.declaredItems) as FDItem[];
      for (const item of items) {
        if (item.unit === "LITER" && literIds.includes(item.productId)) {
          byType[item.productId] = (byType[item.productId] ?? 0) + Number(item.quantity);
        }
      }
    }
    return byType;
  };

  const retailIds   = new Set(retailDispatches.map((r) => r.id));
  const milkArrived = retailArrivedRows
    .filter((m) => m.reference && retailIds.has(m.reference))
    .reduce((sum, m) => sum + Number(m.quantity), 0);
  const milkWastage    = num(milkWastageAgg._sum.quantity);
  const milkDelivered  = num(milkDeliveredAgg._sum.quantity);
  const milkOutsourced = num(milkOutsourcedAgg._sum.quantity);

  // Outsourced milk bucketed per day for the chart (its own stacked series).
  const OUTSOURCED_KEY = "__outsourced__";
  const outsourcedByDay = new Map<string, number>();
  for (const m of trendCounterPurchases) {
    const key = pktDayKey(m.date);
    outsourcedByDay.set(key, (outsourcedByDay.get(key) ?? 0) + Number(m.quantity));
  }

  const milkTrend = trendDates.map((date) => {
    const byType = splitFD(trendFarmDispatchesByDay.get(date) ?? []);
    const out = outsourcedByDay.get(date) ?? 0;
    if (out > 0) byType[OUTSOURCED_KEY] = (byType[OUTSOURCED_KEY] ?? 0) + out;
    const totalL = Object.values(byType).reduce((s, v) => s + v, 0);
    return { date, totalL, byType };
  });

  // Only the milk types that actually moved in the window get a stack + legend row.
  const typeTotals: Record<string, number> = {};
  for (const day of milkTrend) {
    for (const [pid, litres] of Object.entries(day.byType)) {
      typeTotals[pid] = (typeTotals[pid] ?? 0) + litres;
    }
  }
  const milkTypes = Object.entries(typeTotals)
    .filter(([, totalL]) => totalL > 0)
    .map(([id, totalL]) => ({ id, name: id === OUTSOURCED_KEY ? "Outsourced" : (literName.get(id) ?? "Unknown"), totalL }))
    .sort((a, b) => b.totalL - a.totalL);

  const expenseDaily = bucketByDay(
    [
      ...expenseRows.map((r) => ({ at: r.date,   value: num(r.amount) })),
      ...salaryRows.map((r)  => ({ at: r.paidAt, value: num(r.amount) })),
    ],
    seriesDates
  );
  const collectedDaily = bucketByDay(paymentRows.map((r) => ({ at: r.date, value: num(r.amount) })), seriesDates);
  // Customer-only collections for the Outstanding running balance. The full
  // collectedDaily also carries OTC cash sales, vendor receipts and contra
  // settlements (customerId = null) which were never customer debt — subtracting
  // those made the Outstanding trend drift below the Outstanding KPI. The KPI and
  // the seed (prevOutstanding) are both customer-only, so this keeps them in step.
  const customerCollectedDaily = bucketByDay(
    paymentRows.filter((r) => r.customerId).map((r) => ({ at: r.date, value: num(r.amount) })),
    seriesDates
  );

  // Revenue per day (delivery + OTC sales) — still feeds the Monthly Sales
  // sparkline. Profit itself is now cash-basis (collected − expenses paid), so it
  // is built from collectedDaily/expenseDaily below, not from this accrual revenue.
  const deliveryRevenueDaily = bucketByDay(
    deliveryRevenueRows
      .filter((r) => !r.isReplacement)
      .map((r) => ({ at: r.date, value: (r.isReturn ? -1 : 1) * num(r.quantity) * num(r.unitRate) })),
    seriesDates
  );
  // Straight from the same call the KPI uses, so Σ series === kpis.monthlySales.
  // It used to be a third definition whose comment claimed it matched.
  const monthlySalesDaily = seriesDates.map((d) => productSales.buckets[d] ?? 0);
  // Cash-basis profit per day — money collected minus expenses paid — so the sum
  // over the month equals the Profit KPI (collected − expensesMonth).
  const profitDaily = seriesDates.map((_, i) => collectedDaily[i] - expenseDaily[i]);

  // Outstanding per day — a real cumulative running balance, consistent with the
  // DeliveryEntry-based Pending-Payments KPI: starts at the previous month-end
  // snapshot, then adds each day's ACTUAL deliveries (not the plan, not projected
  // invoice amounts), the flat delivery-charge fee on the day each invoice was
  // generated, and OTC credit sales — minus real dated payments.
  const invoiceFeeDaily = bucketByDay(
    invoiceGeneratedRows.map((r) => ({ at: r.generatedAt, value: num(r.deliveryCharge) - num(r.discount) })),
    seriesDates
  );
  // The unpaid remainder of each OTC sale (total − paid) adds to outstanding.
  const otcCreditSaleDaily = bucketByDay(
    otcSalesMonthRows.map((r) => ({ at: r.date, value: num(r.totalAmount) - num(r.paidAmount) })),
    seriesDates
  );
  let runningOutstanding = prevOutstanding;
  const outstandingDaily = seriesDates.map((_, i) => {
    runningOutstanding += deliveryRevenueDaily[i] + invoiceFeeDaily[i] + otcCreditSaleDaily[i] - customerCollectedDaily[i];
    return runningOutstanding;
  });

  const series = {
    dates:       seriesDates,
    collected:   collectedDaily,
    expenses:    expenseDaily,
    newCust:     bucketByDay(newCustRows.map((r)  => ({ at: r.joinDate,  value: 1 })), seriesDates),
    lostCust:    bucketByDay(lostCustRows.map((r) => ({ at: r.updatedAt, value: 1 })), seriesDates),
    profit:      profitDaily,
    outstanding: outstandingDaily,
    monthlySales: monthlySalesDaily,
  };

  return {
    heads,
    selectedMonth,
    kpis: {
      collected,
      outstanding,
      pendingPayments,
      pendingVendors: vendorReceivable,
      pendingRetail: retailReceivable,
      weOwe,
      profit,
      expenses: expensesMonth,
      monthlySales,
      farmSales: farmSalesMonth,
      salesByProduct: productSales.rows,
      otcPurchases: otcPurchasesMonth,
      activeCustomers,
      newCustomers:  newCustomers,
      lostCustomers: lostCustomers,
      lostThisMonth: lostThisMonth,
      prevCollected,
      prevProfit,
      prevExpenses,
      prevNew:  prevNew,
      prevLost: prevLost,
      prevOutstanding,
      prevMonthlySales,
    },
    budget: { total: totalBudget, spent: expensesMonth, remaining: totalBudget - expensesMonth, categories: budgetCategories },
    collection: { billed, collected: salesCollected, pending },
    milkInventory: {
      arrived:    milkArrived,
      outsourced: milkOutsourced,
      delivered:  milkDelivered,
      wastage:    milkWastage,
      netBalance: Math.max(0, milkArrived + milkOutsourced - milkDelivered - milkWastage),
    },
    milkTrend,
    milkTypes,
    series,
  };
}
