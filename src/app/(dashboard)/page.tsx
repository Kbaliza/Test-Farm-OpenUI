import {
  Wallet,
  AlertCircle,
  TrendingUp,
  Receipt,
  Users,
  UserMinus,
  Milk,
  ShoppingBag,
  LineChart,
  ChevronLeft,
  ChevronRight,
  Banknote,
  Building2,
  Smartphone,
  Coins,
  Tractor,
} from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { getSamplePipeline } from "./samples/actions";
import { reconcileAutoDeactivations } from "./customers/actions";
import { getDashboardData } from "./dashboard-data";
import { RiderPerformanceCard } from "@/components/dashboard/rider-performance-card";
import { MilkInventorySales } from "@/components/dashboard/milk-inventory-sales";
import { getMilkChartData } from "./milk-chart-actions";
import { SalesByProductChart } from "@/components/dashboard/sales-by-product-chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { todayPKTString } from "@/lib/pkt";
import { isHeldHead, OWNERS_HEAD, type PaymentHeadName } from "@/lib/payment-heads";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function monthLabel(m: string) {
  const [y, mon] = m.split("-").map(Number);
  return `${MONTH_NAMES[mon - 1]} ${y}`;
}

function adjacentMonth(m: string, delta: number) {
  const [y, mon] = m.split("-").map(Number);
  const d = new Date(y, mon - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const tileTone = {
  emerald: "bg-emerald-100 text-emerald-700",
  amber: "bg-amber-100 text-amber-700",
  rose: "bg-rose-100 text-rose-700",
  sky: "bg-sky-100 text-sky-700",
  violet: "bg-violet-100 text-violet-700",
  purple: "bg-purple-100 text-purple-700",
};

const HEAD_META: Record<string, { icon: React.ElementType; tone: keyof typeof tileTone }> = {
  RIDER_CASH: { icon: Coins, tone: "emerald" },
  HBL: { icon: Building2, tone: "sky" },
  MEEZAN: { icon: Building2, tone: "purple" },
  JAZZCASH: { icon: Smartphone, tone: "rose" },
  EASYPAISA: { icon: Smartphone, tone: "emerald" },
  CASH: { icon: Banknote, tone: "amber" },
} satisfies Record<PaymentHeadName, { icon: React.ElementType; tone: keyof typeof tileTone }>;


function money(n: number) {
  const v = Math.round(n);
  return `${v < 0 ? "−" : ""}Rs ${Math.abs(v).toLocaleString("en-PK")}`;
}

function budgetTone(used: number, budget: number) {
  if (budget === 0) return "bg-muted";
  const ratio = used / budget;
  if (ratio > 1) return "bg-rose-500";
  if (ratio >= 0.8) return "bg-amber-500";
  return "bg-emerald-500";
}

function numDelta(current: number, prev: number, higherIsBetter = true) {
  const diff = current - prev;
  if (diff === 0 || prev === 0) return { delta: "—", deltaDir: "flat" as const };
  const sign = diff > 0 ? "+" : "";
  const dir = (diff > 0) === higherIsBetter ? "up" : "down";
  return {
    delta: `${sign}${Math.round(diff).toLocaleString("en-PK")}`,
    deltaDir: dir as "up" | "down",
  };
}

function countDelta(current: number, prev: number, higherIsBetter = true) {
  const diff = current - prev;
  if (diff === 0) return { delta: "—", deltaDir: "flat" as const };
  const sign = diff > 0 ? "+" : "";
  const dir = (diff > 0) === higherIsBetter ? "up" : "down";
  return { delta: `${sign}${diff}`, deltaDir: dir as "up" | "down" };
}

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const sp = await searchParams;
  const todayMonth = todayPKTString().slice(0, 7);
  const selectedMonth = sp.m ?? todayMonth;
  const prevMonth = adjacentMonth(selectedMonth, -1);
  const nextMonth = adjacentMonth(selectedMonth, +1);
  const isCurrentMonth = selectedMonth === todayMonth;

  // Auto-deactivate customers with no delivery for 20+ days (throttled, no cron).
  await reconcileAutoDeactivations();

  const todayStr = todayPKTString();
  const [samplePipeline, dash, milkChart] = await Promise.all([
    getSamplePipeline(),
    getDashboardData(selectedMonth),
    // Today's milk, for the card's first paint; the card re-reads when a
    // different day or range is picked.
    getMilkChartData(todayStr, todayStr),
  ]);

  const leadStages = [
    { label: "Total",     value: samplePipeline.total },
    { label: "Assigned",  value: samplePipeline.assigned },
    { label: "Delivered", value: samplePipeline.delivered },
    { label: "Followup",  value: samplePipeline.followup },
    { label: "Converted", value: samplePipeline.converted },
  ];

  const { kpis } = dash;

  const collectedDelta    = numDelta(kpis.collected,    kpis.prevCollected,    true);
  const profitDelta       = numDelta(kpis.profit,       kpis.prevProfit,       true);
  const expensesDelta     = numDelta(kpis.expenses,     kpis.prevExpenses,     true);
  const outstandingDelta  = numDelta(kpis.outstanding,  kpis.prevOutstanding,  true);
  const monthlySalesDelta = numDelta(kpis.monthlySales, kpis.prevMonthlySales, true);
  const newDelta         = countDelta(kpis.newCustomers,  kpis.prevNew,  true);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Dashboard"
        description="Health of the business at a glance"
        actions={
          <div className="flex items-center gap-1">
            <Link
              href={`/?m=${prevMonth}`}
              className="inline-flex items-center justify-center rounded-md border border-border bg-background p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <ChevronLeft className="size-4" />
            </Link>
            <span className="w-24 text-center text-sm font-medium select-none">
              {monthLabel(selectedMonth)}
            </span>
            <Link
              href={isCurrentMonth ? "#" : `/?m=${nextMonth}`}
              aria-disabled={isCurrentMonth}
              className={`inline-flex items-center justify-center rounded-md border border-border bg-background p-1.5 transition-colors ${
                isCurrentMonth
                  ? "pointer-events-none text-muted-foreground/30"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <ChevronRight className="size-4" />
            </Link>
          </div>
        }
      />

      <div className="space-y-5 p-4 sm:p-6">
        {/* KPI Row */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {/* Every payment account added up, with the accounts themselves listed
              inside it. Two rows tall and first, because the total on its own
              always prompted the same question — "made up of what?" — which used
              to mean scrolling to a separate Head Balances panel further down the
              page. The two belong together, so they are one card.

              Unlike the rest of this row it is NOT month-scoped — a head balance
              is a position right now, not a flow — so the subline says so and
              there is deliberately no delta or sparkline to imply one. Money a
              rider has collected but not yet handed over is excluded: it is in no
              account until the handover is confirmed. */}
          <Card className="col-span-2 sm:col-span-1 sm:row-span-2">
            <CardContent className="flex h-full flex-col p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="stat-label pt-0.5">Total in All Accounts</p>
                <div className="rounded-lg bg-sky-100/70 p-2 text-sky-700">
                  <Coins className="size-4" />
                </div>
              </div>
              <p className="stat-value mt-2.5">
                {/* Meezan is not money the farm holds — it is owed to the owners. */}
                {money(dash.heads.filter((h) => isHeldHead(h.head)).reduce((sum, h) => sum + h.balance, 0))}
              </p>
              <p className="mt-0.5 text-xs font-medium text-muted-foreground">
                Cash + bank, across every head · right now
              </p>

              {/* One per line: the card is a single column wide now, so two-up
                  would truncate the labels rather than save space. */}
              <div className="mt-3.5 flex flex-1 flex-col gap-1.5 border-t border-border pt-3.5">
                {[...dash.heads.filter((h) => isHeldHead(h.head)), ...dash.heads.filter((h) => !isHeldHead(h.head))].map((h) => {
                  const owed = h.head === OWNERS_HEAD;
                  const meta = HEAD_META[h.head] ?? { icon: Banknote, tone: "amber" as const };
                  const Icon = meta.icon;
                  return (
                    <div
                      key={h.head}
                      className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 ${owed ? "border-rose-200 bg-rose-50/60" : "border-border bg-muted/30"}`}
                      title={owed ? "What the farm owes Sajjad and Moiz — not counted in the total above" : undefined}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`shrink-0 rounded-md p-1 ${tileTone[meta.tone]}`}>
                          <Icon className="size-3" />
                        </span>
                        <span className="truncate text-[13px]">{h.label}{owed && <span className="text-muted-foreground"> · owed to owners</span>}</span>
                      </span>
                      <span
                        className={`num shrink-0 text-[13px] font-semibold ${h.balance < 0 ? "text-rose-600" : ""}`}
                      >
                        {money(h.balance)}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 flex flex-col gap-2">
                <Button asChild variant="outline" size="sm" className="h-8 w-full justify-between text-xs">
                  <Link href="/payments/transfers">Move funds <ChevronRight className="size-3.5" /></Link>
                </Button>
                <Button asChild variant="outline" size="sm" className="h-8 w-full justify-between text-xs">
                  <Link href="/ledgers">All ledgers <ChevronRight className="size-3.5" /></Link>
                </Button>
              </div>
            </CardContent>
          </Card>
          <KpiCard
            label="Collected (month)"
            value={money(kpis.collected)}
            delta={collectedDelta.delta}
            deltaDir={collectedDelta.deltaDir}
            icon={Wallet}
            tone="success"
            series={dash.series.collected}
            href="/billing/payment-receiving"
          />
          <KpiCard
            label="Pending Payments"
            // Value, delta and trend are all the CUSTOMER receivable so they describe
            // the same quantity (vendor receivables have no daily history, so folding
            // them into the headline made the +/- pill and sparkline disagree with the
            // number). Any vendor receivable is surfaced separately in the subline.
            value={money(kpis.outstanding)}
            subValue={(() => {
              // Vendor and mart receivables have no daily history, so they stay out
              // of the headline (which the delta and sparkline describe) and are
              // named here instead.
              const others: string[] = [];
              if (kpis.pendingVendors > 0) others.push(`Vendors ${money(kpis.pendingVendors)}`);
              if (kpis.pendingRetail > 0) others.push(`Marts ${money(kpis.pendingRetail)}`);
              return others.length ? `Customers owe us · ${others.join(" · ")}` : "What customers owe us";
            })()}
            delta={outstandingDelta.delta}
            deltaDir={outstandingDelta.deltaDir}
            icon={AlertCircle}
            tone="warning"
            invertTrend
            series={dash.series.outstanding}
            href="/billing/payment-receiving"
          />
          <KpiCard
            label="Outstanding"
            value={money(kpis.weOwe)}
            subValue="What we owe vendors (unpaid bills)"
            icon={Banknote}
            tone="danger"
            invertTrend
            href="/payments/vendors"
          />
          <KpiCard
            label="Profit (month)"
            value={money(kpis.profit)}
            subValue={`${money(kpis.collected)} collected − ${money(kpis.expenses)} expenses`}
            delta={profitDelta.delta}
            deltaDir={profitDelta.deltaDir}
            icon={TrendingUp}
            tone="info"
            series={dash.series.profit}
            href="/reports"
          />
          <KpiCard
            label="Expenses (month)"
            value={money(kpis.expenses)}
            delta={expensesDelta.delta}
            deltaDir={expensesDelta.deltaDir}
            icon={Receipt}
            tone="danger"
            invertTrend
            series={dash.series.expenses}
            href="/payments/expenses"
          />
          {/* Deliberately its own card rather than folded into Monthly Sales or
              Profit: selling an animal or a machine is disposing of an asset, not
              earning, and one buffalo would dwarf a month of milk. */}
          <KpiCard
            label="Farm Sales (month)"
            value={money(kpis.farmSales)}
            subValue="Animals, machinery, feed · not counted in profit"
            icon={Tractor}
            tone="violet"
            href="/over-the-counter/farm-sales"
          />
          <KpiCard
            label="Monthly Sales"
            value={money(kpis.monthlySales)}
            delta={monthlySalesDelta.delta}
            deltaDir={monthlySalesDelta.deltaDir}
            icon={ShoppingBag}
            tone="success"
            series={dash.series.monthlySales}
            href="/billing/invoices"
          />
          <KpiCard
            label="Active Customers"
            value={String(kpis.activeCustomers)}
            subValue={`+${kpis.newCustomers} new this month`}
            delta={newDelta.delta}
            deltaDir={newDelta.deltaDir}
            icon={Users}
            tone="violet"
            series={dash.series.newCust}
            href="/customers"
          />
          <KpiCard
            label="Lost customers"
            value={String(kpis.lostCustomers)}
            subValue={kpis.lostThisMonth > 0 ? `+${kpis.lostThisMonth} this month` : "none this month"}
            icon={UserMinus}
            tone="rose"
            series={dash.series.lostCust}
            href="/customers?tab=lost"
          />
        </div>

        {/* Milk Inventory — full width. It used to share this row with a Head
            Balances panel, which now lives inside the Total in All Accounts card
            at the top of the page, so the trend chart gets the whole width. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-3">
              <span className="rounded-lg bg-accent p-2 text-accent-foreground">
                <Milk className="size-4" />
              </span>
              <span className="leading-tight">
                <span className="block text-base font-semibold">Milk Inventory &amp; Sales</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  In litres — pick a day or a range
                </span>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MilkInventorySales initial={milkChart} />
          </CardContent>
        </Card>

        {/* Budget Tracker */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Budget Tracker — {monthLabel(selectedMonth)}</CardTitle>
            <Button asChild size="sm" variant="outline" className="h-8 text-xs">
              <Link href="/payments/budgets">Set budgets</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {dash.budget.total === 0 && (
              <p className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                No budgets set for this month — use <span className="font-medium">Set budgets</span> to give each expense category a monthly limit.
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Total Budget
                </p>
                <p className="mt-1 text-2xl font-bold">{money(dash.budget.total)}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Total Spent
                </p>
                <p className="mt-1 text-2xl font-bold">{money(dash.budget.spent)}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Remaining
                </p>
                <p className={`mt-1 text-2xl font-bold ${dash.budget.remaining < 0 ? "text-rose-600" : ""}`}>{money(dash.budget.remaining)}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {dash.budget.categories.map((c) => {
                const ratio = c.budget ? Math.min(c.used / c.budget, 1.2) : 0;
                return (
                  <div
                    key={c.name}
                    className="rounded-lg border border-border bg-card p-3"
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">{c.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Rs {Math.round(c.used).toLocaleString("en-PK")} / {c.budget ? `Rs ${Math.round(c.budget).toLocaleString("en-PK")}` : "—"}
                      </p>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full ${budgetTone(c.used, c.budget)} transition-all`}
                        style={{ width: `${Math.min(ratio * 100, 100)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Sales / Riders / Leads / Collection */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* This was a hardcoded "No sales data yet" panel with no query behind it —
              it was never wired, rather than empty. It reads the same figure as the
              Monthly Sales KPI, and the chart foots to it, so the total row is a
              live check that the parts and the headline agree. */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sales by Product</CardTitle>
            </CardHeader>
            <CardContent>
              {kpis.salesByProduct.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <LineChart className="size-6 opacity-40" />
                  <p className="text-sm">No product sales recorded in {monthLabel(selectedMonth)}.</p>
                </div>
              ) : (
                <SalesByProductChart rows={kpis.salesByProduct} total={kpis.monthlySales} />
              )}
            </CardContent>
          </Card>

          <RiderPerformanceCard />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Leads Pipeline</CardTitle>
              <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
                <Link href="/samples">
                  Samples <ChevronRight className="size-3.5" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-5">
                {leadStages.map((s) => (
                  <Link
                    key={s.label}
                    href="/samples"
                    className="rounded-md border border-border bg-muted/30 p-3 transition-colors hover:bg-muted/60"
                  >
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                    <p className="mt-1 text-lg font-bold tabular-nums">{s.value}</p>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Collection Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {[
                  { label: "Billed (month)", value: dash.collection.billed },
                  { label: "Collected (month)", value: dash.collection.collected },
                  { label: "Pending", value: dash.collection.pending },
                ].map((row) => {
                  const pct = dash.collection.billed > 0
                    ? Math.min(100, Math.round((row.value / dash.collection.billed) * 100))
                    : 0;
                  return (
                    <div key={row.label}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{row.label}</span>
                        <span className="font-medium">{money(row.value)}</span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
