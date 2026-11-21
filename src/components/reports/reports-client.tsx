"use client";

import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart, BarChart, LineChart, PieChart,
  Bar, Line, Pie, Cell, LabelList,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReportsData } from "@/app/(dashboard)/reports/actions";
import { isHeldHead, type PaymentHeadName } from "@/lib/payment-heads";

// Series colours — the same theme tokens the rest of the app's charts use, so
// the reports read as native and adapt to light/dark automatically.
const C = {
  in:    "var(--chart-2)",   // money in / positive → mid green
  out:   "var(--chart-5)",   // money out → red
  net:   "var(--chart-1)",   // net → forest
  sales: "var(--chart-1)",
  coll:  "var(--chart-2)",
  grid:  "var(--border)",
  axis:  "var(--muted-foreground)",
};
// Revenue vs Expenses → Net Profit: a distinct, CVD-safe hue triad from the same tokens.
const PL = {
  revenue: "var(--chart-4)", // blue
  expense: "var(--chart-5)", // red
  profit:  "var(--chart-2)", // green
};
const PIE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const HEAD_COLORS: Record<string, string> = {
  RIDER_CASH: "var(--chart-3)",
  HBL:        "var(--chart-4)",
  // Five chart colours for six heads: Meezan takes its own purple.
  MEEZAN:     "#7e22ce",
  JAZZCASH:   "var(--chart-5)",
  EASYPAISA:  "var(--chart-2)",
  CASH:       "var(--chart-1)",
} satisfies Record<PaymentHeadName, string>;

const money = (n: number) => {
  const v = Math.round(n);
  return `${v < 0 ? "−" : ""}₨ ${Math.abs(v).toLocaleString("en-PK")}`;
};
const litres = (n: number) => `${Math.round(n)} L`;
// recharts tooltip formatters receive a wide ValueType — coerce at the boundary.
const moneyFmt = (v: unknown) => money(Number(v));
const litresFmt = (v: unknown) => litres(Number(v));
const compact = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
};
// Short money for on-bar labels so they never overflow a narrow column.
const moneyCompact = (n: number) => `${n < 0 ? "−" : ""}₨${compact(Math.abs(n))}`;

// Shared tooltip styling — popover tokens so it works in both themes.
const tooltipStyle = {
  contentStyle: {
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    color: "var(--popover-foreground)",
    fontSize: 12,
  },
  labelStyle: { color: "var(--muted-foreground)", fontSize: 11, marginBottom: 4 },
  itemStyle: { color: "var(--popover-foreground)" },
} as const;

const axisProps = {
  tick: { fill: "var(--muted-foreground)", fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: "var(--border)" },
} as const;

function Empty({ label }: { label: string }) {
  return (
    <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function ChartCard({ title, subtitle, action, children }: {
  title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            {subtitle ? <p className="stat-label mt-1">{subtitle}</p> : null}
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

type Range = "7D" | "30D" | "90D";
function RangeTabs({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  const opts: Range[] = ["7D", "30D", "90D"];
  return (
    <div className="flex gap-1 rounded-lg bg-muted p-0.5">
      {opts.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={`rounded-md px-2 py-1 font-mono text-[11px] font-semibold transition-colors ${
            range === o ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

// ── Profitability (Revenue vs Expenses → Net Profit) ──────────────────────────
type ProfitWin = { revenue: number; expenses: number; netProfit: number; margin: number };

// Ring gauge showing the net-profit margin; green when profitable, red on a loss.
function MarginGauge({ w }: { w: ProfitWin }) {
  const positive = w.netProfit >= 0;
  const color = positive ? PL.profit : PL.expense;
  const frac = Math.max(0, Math.min(1, w.margin)); // arc fill (a loss shows an empty ring)
  const gauge = [{ value: frac }, { value: 1 - frac }];
  return (
    <div className="relative mx-auto h-44 w-44">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={gauge} dataKey="value" cx="50%" cy="50%"
            startAngle={90} endAngle={-270}
            innerRadius="72%" outerRadius="92%" stroke="none" cornerRadius={6}
            isAnimationActive={false}
          >
            <Cell fill={color} />
            <Cell fill="var(--muted)" />
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold tabular-nums" style={{ color }}>{(w.margin * 100).toFixed(1)}%</span>
        <span className="stat-label mt-0.5">margin</span>
      </div>
    </div>
  );
}

// Revenue / All Expenses / Net Profit as three labelled bars for one window.
function ProfitBars({ w }: { w: ProfitWin }) {
  const rows = [
    { label: "Revenue",      value: w.revenue,   fill: PL.revenue },
    { label: "All Expenses", value: w.expenses,  fill: PL.expense },
    { label: "Net Profit",   value: w.netProfit, fill: PL.profit },
  ];
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 24, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid stroke={C.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} tickFormatter={compact} width={44} />
          <Tooltip {...tooltipStyle} formatter={moneyFmt} cursor={{ fill: "var(--muted)" }} />
          <Bar dataKey="value" radius={[3, 3, 0, 0]} maxBarSize={54}>
            {rows.map((r) => <Cell key={r.label} fill={r.fill} />)}
            <LabelList
              dataKey="value" position="top"
              formatter={(v: unknown) => moneyCompact(Number(v))}
              style={{ fill: "var(--foreground)", fontSize: 11, fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ReportsClient({ data }: { data: ReportsData }) {
  const [milkRange, setMilkRange] = useState<Range>("30D");

  // Slice the 90-day milk trend to the selected window and shape it for recharts:
  // one row per day with a numeric column per milk type.
  const milkChart = useMemo(() => {
    const n = milkRange === "7D" ? 7 : milkRange === "30D" ? 30 : 90;
    const slice = data.milkTrend.slice(-n);
    return slice.map((d) => {
      const [, m, day] = d.date.split("-").map(Number);
      const row: Record<string, number | string> = { label: `${m}/${day}` };
      for (const t of data.milkTypes) row[t.name] = d.byType[t.id] ?? 0;
      return row;
    });
  }, [data.milkTrend, data.milkTypes, milkRange]);

  const collectionBreakdown = useMemo(() => ([
    { name: "Collected", value: Math.max(0, data.collection.collected), color: "var(--chart-2)" },
    { name: "Pending",   value: Math.max(0, data.collection.pending),   color: "var(--chart-3)" },
  ]), [data.collection]);

  const hasCashFlow = data.cashFlow.some((p) => p.moneyIn !== 0 || p.moneyOut !== 0);
  const hasSales = data.sales.some((p) => p.sales !== 0 || p.collected !== 0);
  // Cash the farm holds — Meezan is owed to the owners, not cash, so it is not here.
  const heldHeads = data.heads.filter((h) => isHeldHead(h.head));
  const hasHeads = heldHeads.some((h) => Math.abs(h.balance) > 0.001);
  const hasExpenses = data.expenseByCategory.length > 0;
  const hasStock = data.stockByProduct.length > 0;
  const hasMilk = data.milkTypes.length > 0 && milkChart.some((r) => data.milkTypes.some((t) => Number(r[t.name]) > 0));

  const p = data.profitability;
  const hasProfit = p.ytd.revenue !== 0 || p.ytd.expenses !== 0 || p.mtd.revenue !== 0 || p.mtd.expenses !== 0;

  return (
    <div className="space-y-5">
      {/* Profit & Loss — Revenue vs Expenses → Net Profit */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <ChartCard title="Net profit" subtitle="Year to date · margin">
          {hasProfit ? (
            <div className="flex flex-col items-center">
              <MarginGauge w={p.ytd} />
              <div className="mt-3 flex items-baseline gap-2">
                <span
                  className="text-2xl font-bold tabular-nums"
                  style={{ color: p.ytd.netProfit >= 0 ? PL.profit : PL.expense }}
                >
                  {money(p.ytd.netProfit)}
                </span>
              </div>
              <p className="mt-1 text-center text-[11px] text-muted-foreground">
                {money(p.ytd.revenue)} revenue − {money(p.ytd.expenses)} expenses
              </p>
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                This month: <span className="font-semibold text-foreground">{(p.mtd.margin * 100).toFixed(1)}%</span> margin ·{" "}
                <span className="font-semibold text-foreground">{money(p.mtd.netProfit)}</span> net
              </p>
            </div>
          ) : <Empty label="No revenue or expenses recorded yet." />}
        </ChartCard>

        <ChartCard title="Revenue vs Expenses" subtitle="Year to date">
          {hasProfit ? <ProfitBars w={p.ytd} /> : <Empty label="No data for this year yet." />}
        </ChartCard>

        <ChartCard title="Revenue vs Expenses" subtitle="Month to date">
          {hasProfit ? <ProfitBars w={p.mtd} /> : <Empty label="No data for this month yet." />}
        </ChartCard>
      </div>

      {/* Cash flow over time */}
      <ChartCard title="Cash flow" subtitle="Money in vs out · last 12 months">
        {hasCashFlow ? (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data.cashFlow} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={C.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" {...axisProps} />
                <YAxis {...axisProps} tickFormatter={compact} width={44} />
                <Tooltip {...tooltipStyle} formatter={moneyFmt} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="moneyIn" name="Money in" fill={C.in} radius={[3, 3, 0, 0]} maxBarSize={22} />
                <Bar dataKey="moneyOut" name="Money out" fill={C.out} radius={[3, 3, 0, 0]} maxBarSize={22} />
                <Line dataKey="net" name="Net" stroke={C.net} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : <Empty label="No cash movement in the last 12 months yet." />}
      </ChartCard>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Cash by head */}
        <ChartCard title="Cash by account" subtitle="Current balance per head">
          {hasHeads ? (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={heldHeads} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid stroke={C.grid} strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" {...axisProps} tickFormatter={compact} />
                  <YAxis type="category" dataKey="label" {...axisProps} width={78} />
                  <Tooltip {...tooltipStyle} formatter={moneyFmt} cursor={{ fill: "var(--muted)" }} />
                  <Bar dataKey="balance" name="Balance" radius={[0, 3, 3, 0]} maxBarSize={26}>
                    {heldHeads.map((h) => (
                      <Cell key={h.head} fill={HEAD_COLORS[h.head] ?? "var(--chart-1)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <Empty label="No account balances yet." />}
        </ChartCard>

        {/* Expenses by category */}
        <ChartCard title="Expenses by category" subtitle="Selected month">
          {hasExpenses ? (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.expenseByCategory}
                    dataKey="amount"
                    nameKey="name"
                    innerRadius="55%"
                    outerRadius="80%"
                    paddingAngle={2}
                    stroke="var(--card)"
                  >
                    {data.expenseByCategory.map((_, i) => (
                      <Cell key={i} fill={PIE[i % PIE.length]} />
                    ))}
                  </Pie>
                  <Tooltip {...tooltipStyle} formatter={moneyFmt} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : <Empty label="No expenses recorded this month." />}
        </ChartCard>
      </div>

      {/* Milk inventory trend */}
      <ChartCard
        title="Milk inventory trend"
        subtitle="Litres per milk type per day"
        action={<RangeTabs range={milkRange} onChange={setMilkRange} />}
      >
        {hasMilk ? (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={milkChart} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={C.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" {...axisProps} minTickGap={16} />
                <YAxis {...axisProps} tickFormatter={(v: number) => `${v}`} width={40} />
                <Tooltip {...tooltipStyle} formatter={litresFmt} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {data.milkTypes.map((t, i) => (
                  <Bar key={t.id} dataKey={t.name} stackId="milk" fill={PIE[i % PIE.length]} maxBarSize={28} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : <Empty label="No milk inventory movement in this window." />}
      </ChartCard>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Stock by product */}
        <ChartCard title="Stock on hand" subtitle="Current quantity per product">
          {hasStock ? (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.stockByProduct} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid stroke={C.grid} strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" {...axisProps} />
                  <YAxis type="category" dataKey="name" {...axisProps} width={92} />
                  <Tooltip
                    {...tooltipStyle}
                    cursor={{ fill: "var(--muted)" }}
                    formatter={(v: unknown, _n: unknown, p: { payload?: { unit?: string } }) => {
                      const unit = (p?.payload?.unit === "LITER" ? "L" : p?.payload?.unit === "KG" ? "kg" : "pc");
                      return `${Math.round(Number(v))} ${unit}`;
                    }}
                  />
                  <Bar dataKey="inStorage" name="In storage" fill="var(--chart-2)" radius={[0, 3, 3, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <Empty label="No stock on hand." />}
        </ChartCard>

        {/* Sales & collection */}
        <ChartCard title="Sales & collection" subtitle="Billed vs collected · last 12 months">
          {hasSales ? (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.sales} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                  <CartesianGrid stroke={C.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" {...axisProps} />
                  <YAxis {...axisProps} tickFormatter={compact} width={44} />
                  <Tooltip {...tooltipStyle} formatter={moneyFmt} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line dataKey="sales" name="Sales" stroke={C.sales} strokeWidth={2} dot={false} />
                  <Line dataKey="collected" name="Collected" stroke={C.coll} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : <Empty label="No sales in the last 12 months yet." />}
        </ChartCard>
      </div>

      {/* This month's collection status */}
      <ChartCard title="Collection status" subtitle="This month · billed vs collected vs pending">
        {data.collection.billed > 0 || data.collection.collected > 0 ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="h-48 w-full sm:w-1/2">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={collectionBreakdown} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="80%" paddingAngle={2} stroke="var(--card)">
                    {collectionBreakdown.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip {...tooltipStyle} formatter={moneyFmt} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="grid flex-1 grid-cols-3 gap-3">
              {[
                { label: "Billed", value: data.collection.billed },
                { label: "Collected", value: data.collection.collected },
                { label: "Pending", value: data.collection.pending },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-border bg-muted/40 p-3">
                  <p className="stat-label">{s.label}</p>
                  <p className="num mt-1 text-sm font-semibold">{money(s.value)}</p>
                </div>
              ))}
            </div>
          </div>
        ) : <Empty label="Nothing billed this month yet." />}
      </ChartCard>
    </div>
  );
}
