"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SUMMARY_REPORT_CSS } from "./summary-report-styles";
import type {
  SummaryReport, EmployeeRow, TrendPoint, CycleRow,
} from "@/app/(dashboard)/reports/summary/actions";
import type { ReportPeriod } from "@/lib/report-window";

// ── formatting ───────────────────────────────────────────────────────────────
// Digits alone. The report is entirely rupees, so a symbol on every figure was
// noise — and ₨ (U+20A8) is drawn as an ornate ligature by most fonts, which
// read as decoration beside plain numbers. Negatives keep a minus sign, since
// that is the one thing the digits cannot say for themselves.
const money = (n: number) => {
  const v = Math.round(n);
  return (v < 0 ? "−" : "") + Math.abs(v).toLocaleString("en-PK");
};
const num = (n: number) => Math.round(n).toLocaleString("en-PK");
// Quantities can be fractional (litres), so keep one decimal when there is one.
const qty = (n: number) => (Math.abs(n % 1) < 0.05 ? Math.round(n).toLocaleString("en-PK") : n.toFixed(1));
const pct0 = (n: number) => `${Math.round(n)}%`;
const unitLabel = (u: string) => (u === "LITER" ? "L" : u === "KG" ? "kg" : "pc");

const COLORS = ["#1A4D2E", "#1E3A5F", "#B45309", "#2D7A4F", "#8B2500", "#3C3489"];
const CIRC = 2 * Math.PI * 41;

function Info({ text }: { text: string }) {
  return (
    <i className="info-i" tabIndex={0}>
      i<span className="tip">{text}</span>
    </i>
  );
}

function Ring({ pct, color, size = 78 }: { pct: number; color: string; size?: number }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <svg viewBox="0 0 100 100" style={{ width: size, height: size }}>
      <circle cx="50" cy="50" r="41" fill="none" stroke="#EDE9DF" strokeWidth="11" />
      <circle
        cx="50" cy="50" r="41" fill="none" stroke={color} strokeWidth="11" strokeLinecap="round"
        strokeDasharray={`${((p / 100) * CIRC).toFixed(1)} ${CIRC.toFixed(1)}`}
      />
    </svg>
  );
}

function Delta({ cur, prev, goodWhenUp, note }: { cur: number; prev: number; goodWhenUp: boolean; note: string }) {
  // No previous figure means no honest comparison — show nothing rather than "+∞%".
  if (!prev) return null;
  const p = ((cur - prev) / Math.abs(prev)) * 100;
  const up = p >= 0;
  const good = goodWhenUp ? up : !up;
  const cls = Math.abs(p) < 0.1 ? "flat" : good ? "up" : "down";
  return (
    <span className={`dlt ${cls}`}>
      <span>{up ? "▲" : "▼"}</span>
      {p >= 0 ? "+" : ""}{p.toFixed(1)}% <em>{note}</em>
    </span>
  );
}

function Spark({ points, pick, color }: { points: TrendPoint[]; pick: (t: TrendPoint) => number; color: string }) {
  const vals = points.map(pick);
  const max = Math.max(...vals.map(Math.abs), 1);
  return (
    <>
      <div className="spark">
        {vals.map((v, i) => (
          <i
            key={i}
            style={{
              height: `${Math.max(6, Math.round((Math.abs(v) / max) * 100))}%`,
              background: i === vals.length - 1 ? color : "#C3D4C7",
            }}
          />
        ))}
      </div>
      <div className="spark-x">
        {points.map((t, i) => (
          <span key={i} style={i === points.length - 1 ? { color, fontWeight: 800 } : undefined}>{t.label}</span>
        ))}
      </div>
    </>
  );
}

function BarRow({ name, meta, value, pct, color, small }: {
  name: string; meta?: string; value: string; pct: number; color: string; small?: boolean;
}) {
  return (
    <div className={small ? "prow prow-sm" : "prow"}>
      <div className="prow-top">
        <div>
          <span className="prow-name">{name}</span>
          {meta && <span className="prow-qty">{meta}</span>}
        </div>
        <span className="prow-val">{value}</span>
      </div>
      <div className="bar">
        <div className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
      </div>
    </div>
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

export function SummaryReportClient({ data }: { data: SummaryReport }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [openEmp, setOpenEmp] = useState<EmployeeRow | null>(null);

  const go = (p: ReportPeriod, d: string) =>
    start(() => router.push(`/reports/summary?p=${p}&d=${d}`));

  const f = data.finance;
  const s = data.sales;

  const maxProduct = useMemo(() => Math.max(...s.products.map((p) => Math.abs(p.value)), 1), [s.products]);
  const maxMart = useMemo(() => Math.max(...s.marts.map((m) => Math.abs(m.value)), 1), [s.marts]);

  // Timeline scale, from the earliest mark to the latest, in minutes.
  const tl = useMemo(() => {
    const toMin = (t: string | null) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
    const marks = [data.delivery.packagedAt, data.delivery.firstOut, data.delivery.lastBack]
      .map(toMin).filter((x): x is number => x !== null);
    const riderMins = data.delivery.riders.flatMap((r) => [toMin(r.out), toMin(r.back)]).filter((x): x is number => x !== null);
    const all = [...marks, ...riderMins];
    if (!all.length) return null;
    const lo = Math.floor(Math.min(...all) / 60) * 60 - 30;
    const hi = Math.ceil(Math.max(...all) / 60) * 60 + 30;
    const span = Math.max(60, hi - lo);
    const pos = (t: string | null) => {
      const m = toMin(t);
      return m === null ? null : ((m - lo) / span) * 100;
    };
    const ticks: { left: number; label: string }[] = [];
    for (let h = Math.ceil(lo / 60) * 60; h <= hi; h += 60) {
      const hh = Math.floor(h / 60) % 24;
      const ap = hh >= 12 ? "PM" : "AM";
      const h12 = hh % 12 === 0 ? 12 : hh % 12;
      ticks.push({ left: ((h - lo) / span) * 100, label: `${h12}${ap}` });
    }
    return { pos, ticks };
  }, [data.delivery]);

  const costMax = Math.max(...data.costs.rows.map((r) => r.amount), 1);
  const donutStops = useMemo(() => {
    let acc = 0;
    return data.costs.rows.map((r, i) => {
      const from = acc;
      acc += (r.amount / Math.max(1, data.costs.total)) * 100;
      return `${COLORS[i % COLORS.length]} ${from.toFixed(2)}% ${acc.toFixed(2)}%`;
    }).join(",");
  }, [data.costs]);

  const budPct = data.costs.monthBudgetTotal > 0 ? (data.costs.mtdTotal / data.costs.monthBudgetTotal) * 100 : 0;
  const budOver = budPct > 100;
  const budCol = budOver ? "#991B1B" : budPct >= 90 ? "#B45309" : "#166534";

  return (
    <div className="sr-root" style={pending ? { opacity: 0.6 } : undefined}>
      <style dangerouslySetInnerHTML={{ __html: SUMMARY_REPORT_CSS }} />
      <div className="wrap">

        {/* ── Masthead ── */}
        <div className="mast">
          <div className="mast-l">
            <svg className="seal" viewBox="0 0 48 48" aria-hidden="true">
              <circle cx="24" cy="24" r="23" fill="none" stroke="#1A4D2E" strokeWidth="1" strokeDasharray="2.2 3.2" opacity=".55" />
              <circle cx="24" cy="24" r="18.5" fill="#1A4D2E" />
              <text x="24" y="30.5" textAnchor="middle" fontFamily="Georgia, serif" fontSize="19" fontWeight="600" fill="#F4F1E9">B</text>
            </svg>
            <div>
              <div className="eyebrow">Banoori Dairy</div>
              <div className="mast-t">Summary Report</div>
              <div className="mast-s">{data.subtitle}</div>
            </div>
          </div>
          <div className="mast-r">
            <div className="seg" role="group" aria-label="Reporting period">
              {(["day", "week", "month"] as const).map((p) => (
                <button key={p} className={data.period === p ? "on" : ""} onClick={() => go(p, data.dateStr)}>
                  {p === "day" ? "Day" : p === "week" ? "Week" : "Month"}
                </button>
              ))}
            </div>
            <input
              type="date"
              className="date-input"
              value={data.dateStr}
              max={new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10)}
              onChange={(e) => e.target.value && go(data.period, e.target.value)}
              aria-label="Reporting date"
            />
            <button className="btn-pdf" onClick={() => window.print()}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M8 1.8v8.4M4.8 7.2 8 10.4l3.2-3.2M2.4 12.2v1.2a.8.8 0 0 0 .8.8h9.6a.8.8 0 0 0 .8-.8v-1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Export PDF
            </button>
          </div>
        </div>

        {/* ── Finance ── */}
        <div className="sec">
          <div className="rail"><span>Finance</span></div>
          <div className="sec-b">
            <div className="row">
              <div className="mets">
                <div>
                  <div className="met-l">Total Revenue<Info text="Customer deliveries (net of returns) plus over-the-counter and mart sales in this period. Delivery charges are billed per cycle and appear under Collections." /></div>
                  <div className="met-v">{money(f.revenue)}</div>
                  <Delta cur={f.revenue} prev={f.prevRevenue} goodWhenUp note={data.compareLabel} />
                  <Spark points={f.trend} pick={(t) => t.revenue} color="#1A4D2E" />
                </div>
                <div>
                  <div className="met-l">Total Expenses<Info text="Operating expenses, salaries paid and the cost of goods bought over the counter." /></div>
                  <div className="met-v">{money(f.expenses)}</div>
                  <Delta cur={f.expenses} prev={f.prevExpenses} goodWhenUp={false} note={data.compareLabel} />
                  <Spark points={f.trend} pick={(t) => t.expenses} color="#8B2500" />
                </div>
                <div>
                  <div className="met-l">Profit<Info text="Revenue minus expenses — the same definition the Reports page uses, so the two always agree. Wastage is shown separately so it is not counted twice." /></div>
                  <div className="met-v" style={{ color: f.profit >= 0 ? "#1A4D2E" : "#991B1B" }}>{money(f.profit)}</div>
                  <Delta cur={f.profit} prev={f.prevProfit} goodWhenUp note={data.compareLabel} />
                  <Spark points={f.trend} pick={(t) => t.profit} color="#2D7A4F" />
                </div>
              </div>
              <div className="rings">
                <div className="ring">
                  <Ring pct={f.margin} color={f.profit >= 0 ? "#1A4D2E" : "#991B1B"} />
                  <div>
                    <div className="ring-v">{pct0(f.margin)}</div>
                    <div className="ring-l">Profit margin<Info text="Profit as a share of revenue — how much of every rupee earned you keep." /></div>
                    <div className="ring-s">{money(f.profit)} kept of {money(f.revenue)}</div>
                  </div>
                </div>
                <div className="ring">
                  <Ring pct={data.collection.pct} color={data.collection.pct >= 75 ? "#166534" : data.collection.pct >= 50 ? "#B45309" : "#991B1B"} />
                  <div>
                    <div className="ring-v">{pct0(data.collection.pct)}</div>
                    <div className="ring-l">Collection rate<Info text="Share of this month's billed sales already collected, across both 15-day cycles." /></div>
                    <div className="ring-s">{money(Math.max(0, data.collection.billed - data.collection.collected))} still to collect</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Sales ── */}
        <div className="sec">
          <div className="rail"><span>Sales</span></div>
          <div className="sec-b">
            <div className="sec-h">
              <div>
                <div className="sec-t">Sales &amp; customers</div>
                <div className="sec-s">Where the money came from and who is still buying</div>
              </div>
              <span className="tag t-neutral">{num(s.orders)} customers served</span>
            </div>

            <div className="kpis" style={{ marginBottom: 16 }}>
              <div className="kpi">
                <div className="kpi-l">Customer Sales<Info text="Value of deliveries to home customers, net of returns." /></div>
                <div className="kpi-v" style={{ color: "#166534" }}>{money(s.customerSales)}</div>
                <div className="kpi-s">door-to-door</div>
              </div>
              <div className="kpi">
                <div className="kpi-l">Retail / Mart Sales<Info text="Over-the-counter sales, including those billed to marts and vendors." /></div>
                <div className="kpi-v" style={{ color: "#166534" }}>{money(s.retailSales)}</div>
                <div className="kpi-s">over the counter</div>
              </div>
              <div className="kpi">
                <div className="kpi-l">Milk Delivered<Info text="Litres of every milk product delivered, net of returns." /></div>
                <div className="kpi-v">{qty(s.milkLitres)} L</div>
                <div className="kpi-s">all milk products</div>
              </div>
              <div className="kpi">
                <div className="kpi-l">Eggs Delivered<Info text="Eggs delivered, counted in pieces as the catalogue stores them." /></div>
                <div className="kpi-v">{num(s.eggPieces)}</div>
                <div className="kpi-s">pieces</div>
              </div>
              <div className="kpi">
                <div className="kpi-l">Wastage Loss<Info text="Estimated: wastage is logged as a quantity, valued here at the product's standard rate." /></div>
                <div className="kpi-v" style={{ color: "#991B1B" }}>{money(s.wastageValue)}</div>
                <div className="kpi-s">{pct0((s.wastageValue / Math.max(1, f.revenue)) * 100)} of revenue · est.</div>
              </div>
            </div>

            <div className="kpis">
              <div className="kpi">
                <div className="kpi-l">Active Customers<Info text="Customers currently marked Active. They drop out automatically after 20 days without a delivery." /></div>
                <div className="kpi-v" style={{ color: "#1E3A5F" }}>{num(s.activeCustomers)}</div>
                <div className="kpi-s">of {num(s.totalCustomers)} on the books</div>
              </div>
              <div className="kpi">
                <div className="kpi-l">Customers Lost<Info text="Customers moved to Inactive or Disabled during this period." /></div>
                <div className="kpi-v" style={{ color: "#991B1B" }}>{num(s.lostCustomers)}</div>
                <div className="kpi-s">in this period</div>
              </div>
              <div className="kpi">
                <div className="kpi-l">On Call<Info text="Customers served only when they phone in — never routed automatically." /></div>
                <div className="kpi-v" style={{ color: "#B45309" }}>{num(s.onCallCustomers)}</div>
                <div className="kpi-s">on request only</div>
              </div>
              <div className="kpi">
                <div className="kpi-l">Samples · Converted<Info text="Sample leads added in this period, and how many became paying customers." /></div>
                <div className="kpi-v" style={{ color: "#166534" }}>{num(s.samplesAdded)} · {num(s.converted)}</div>
                <div className="kpi-s">{pct0((s.converted / Math.max(1, s.samplesAdded)) * 100)} converted</div>
              </div>
              <div className="kpi">
                <div className="kpi-l">Recovery Due<Info text="Everything still to be collected right now: unpaid customer balances plus outstanding mart receivables. Receivable, not lost." /></div>
                <div className="kpi-v" style={{ color: "#C2410C" }}>{money(s.recoveryCustomer + s.recoveryMart)}</div>
                <div className="kpi-s">{money(s.recoveryCustomer)} cust · {money(s.recoveryMart)} marts</div>
              </div>
            </div>

            <div className="two" style={{ marginTop: 16 }}>
              <div className="panel">
                <div className="panel-t">
                  <span>Sales by product<Info text="Revenue and volume per product, combining deliveries and counter sales." /></span>
                  <span className="mono" style={{ color: "var(--ink)", fontSize: 11 }}>
                    {money(s.products.reduce((a, p) => a + p.value, 0))}
                  </span>
                </div>
                {s.products.length === 0 ? (
                  <p className="empty">No sales recorded in this period.</p>
                ) : (
                  s.products.map((p, i) => (
                    <BarRow
                      key={p.name}
                      name={p.name}
                      meta={`${qty(p.qty)} ${unitLabel(p.unit)}`}
                      value={money(p.value)}
                      pct={(Math.abs(p.value) / maxProduct) * 100}
                      color={COLORS[i % COLORS.length]}
                    />
                  ))
                )}
              </div>
              <div className="panel">
                <div className="panel-t">
                  <span>Mart &amp; counter sales<Info text="Over-the-counter revenue split by mart or vendor." /></span>
                  <span className="mono" style={{ color: "var(--ink)", fontSize: 11 }}>
                    {money(s.marts.reduce((a, m) => a + m.value, 0))}
                  </span>
                </div>
                {s.marts.length === 0 ? (
                  <p className="empty">No counter or mart sales in this period.</p>
                ) : (
                  s.marts.map((m) => (
                    <BarRow key={m.name} name={m.name} value={money(m.value)} pct={(Math.abs(m.value) / maxMart) * 100} color="#1E3A5F" />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Costs ── */}
        <div className="sec">
          <div className="rail"><span>Costs</span></div>
          <div className="sec-b">
            <div className="sec-h">
              <div>
                <div className="sec-t">Expense breakdown<Info text="Every expense category for the selected period, with its share and how much of the month's budget is used." /></div>
                <div className="sec-s">Where the money went</div>
              </div>
              <span className="tag t-neutral">{money(data.costs.total)} total</span>
            </div>
            <div className="row">
              <div style={{ overflowX: "auto" }}>
                {data.costs.rows.length === 0 ? (
                  <p className="empty">No expenses recorded in this period.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Category</th>
                        <th className="right">Amount</th>
                        <th className="right">Share</th>
                        <th className="right">Month budget</th>
                        <th className="right" style={{ minWidth: 112 }}>
                          Budget used<Info text="Month-to-date spend against this category's monthly budget — always the full month, whichever period is selected. Red means over budget." />
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.costs.rows.map((r, i) => {
                        const used = r.budget > 0 ? (r.mtdUsed / r.budget) * 100 : 0;
                        const over = used > 100;
                        const col = over ? "#991B1B" : used >= 90 ? "#B45309" : "#166534";
                        return (
                          <tr key={r.name}>
                            <td>
                              <span className="swatch" style={{ background: COLORS[i % COLORS.length] }} />
                              <span style={{ fontWeight: 600 }}>{r.name}</span>
                            </td>
                            <td className="right mono">{money(r.amount)}</td>
                            <td className="right mono" style={{ color: "var(--mute)" }}>{r.share.toFixed(1)}%</td>
                            <td className="right mono" style={{ color: "var(--mute)" }}>{r.budget > 0 ? money(r.budget) : "—"}</td>
                            <td className="right">
                              {r.budget > 0 ? (
                                <>
                                  <div className="mono" style={{ fontWeight: 700, color: col }}>{pct0(used)}{over ? " ⚠" : ""}</div>
                                  <div className="bar" style={{ height: 4, marginTop: 4 }}>
                                    <div className="bar-fill" style={{ width: `${Math.min(100, used)}%`, background: col }} />
                                  </div>
                                </>
                              ) : <span className="mono" style={{ color: "#C3BFB3" }}>—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="panel">
                <div
                  className="donut"
                  style={data.costs.total > 0 ? { background: `conic-gradient(${donutStops})` } : { background: "#EDE9DF" }}
                >
                  <div className="donut-c">
                    <div className="donut-v">{money(data.costs.total)}</div>
                    <div className="donut-l">Total spend</div>
                  </div>
                </div>
                <div style={{ marginTop: 14 }}>
                  {data.costs.rows.map((r, i) => (
                    <div key={r.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, padding: "3px 0" }}>
                      <span style={{ color: "var(--mute)", fontWeight: 600 }}>
                        <span className="swatch" style={{ background: COLORS[i % COLORS.length] }} />{r.name}
                      </span>
                      <span className="mono" style={{ fontWeight: 700 }}>{Math.round(r.share)}%</span>
                    </div>
                  ))}
                </div>
                <div className="cyc-sub">
                  <div className="cyc-sub-t">
                    <span>Month budget<Info text="All categories combined: spend so far this month against the total monthly budget." /></span>
                    <b style={{ color: budCol }}>{pct0(budPct)} used</b>
                  </div>
                  <div className="bar" style={{ height: 9, marginTop: 8 }}>
                    <div className="bar-fill" style={{ width: `${Math.min(100, budPct)}%`, background: budCol }} />
                  </div>
                  <div className="split-l" style={{ marginTop: 7 }}>
                    <span>Spent · <b>{money(data.costs.mtdTotal)}</b></span>
                    <span>{budOver ? "Over" : "Left"} · <b>{money(Math.abs(data.costs.monthBudgetTotal - data.costs.mtdTotal))}</b></span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Collections ── */}
        <div className="sec">
          <div className="rail"><span>Collections</span></div>
          <div className="sec-b">
            <div className="sec-h">
              <div>
                <div className="sec-t">Billing cycles &amp; cash in<Info text="Sales are billed in two 15-day cycles each month. These always show the calendar month of the selected date, whichever period is chosen above." /></div>
                <div className="sec-s">{data.costs.monthLabel} · two 15-day cycles · cash vs digital per cycle</div>
              </div>
              <span className="tag t-warn">{money(Math.max(0, data.collection.billed - data.collection.collected))} pending</span>
            </div>
            <div className="cycs">
              {data.cycles.map((c: CycleRow) => {
                const col = c.pct >= 75 ? "#166534" : c.pct >= 50 ? "#B45309" : "#991B1B";
                const inTot = c.cash + c.digital;
                const cashPct = inTot > 0 ? Math.round((c.cash / inTot) * 100) : 0;
                const maxRider = Math.max(...c.riders.map((r) => r.value), 1);
                return (
                  <div className="cyc" key={c.label}>
                    <div className="cyc-top">
                      <Ring pct={c.pct} color={col} size={74} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="cyc-name">{c.label}</div>
                        <div className="cyc-grid">
                          <div><div className="cyc-l">Billed</div><div className="cyc-v">{money(c.billed)}</div></div>
                          <div><div className="cyc-l">Collected</div><div className="cyc-v" style={{ color: "#166534" }}>{money(c.collected)}</div></div>
                          <div><div className="cyc-l">Pending</div><div className="cyc-v" style={{ color: col }}>{money(c.pending)}</div></div>
                        </div>
                      </div>
                    </div>

                    <div className="cyc-sub">
                      <div className="cyc-sub-t"><span>Payment mix</span><b>{money(inTot)} in</b></div>
                      <div className="split">
                        {cashPct > 0 && <div style={{ width: `${cashPct}%`, background: "#1A4D2E" }}>{cashPct}%</div>}
                        {cashPct < 100 && inTot > 0 && <div style={{ width: `${100 - cashPct}%`, background: "#1E3A5F" }}>{100 - cashPct}%</div>}
                      </div>
                      <div className="split-l">
                        <span>Cash · <b>{money(c.cash)}</b></span>
                        <span>Digital · <b>{money(c.digital)}</b></span>
                      </div>
                    </div>

                    <div className="cyc-sub">
                      <div className="cyc-sub-t"><span>Cash per rider</span><b>{c.riders.length} riders</b></div>
                      {c.riders.length === 0 ? (
                        <p className="empty">No rider cash recorded in this cycle.</p>
                      ) : (
                        c.riders.map((r) => (
                          <BarRow key={r.name} name={r.name} value={money(r.value)} pct={(r.value / maxRider) * 100} color="#1A4D2E" small />
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Delivery ── */}
        <div className="sec">
          <div className="rail"><span>Delivery</span></div>
          <div className="sec-b">
            <div className="sec-h">
              <div>
                <div className="sec-t">Route timeline<Info text="When packaging dispatched, when riders went out and when the last delivery was recorded." /></div>
                <div className="sec-s">Packaging → first rider out → last delivery</div>
              </div>
              <span className="tag t-neutral">
                {data.delivery.firstOut && data.delivery.lastBack ? `${data.delivery.firstOut} – ${data.delivery.lastBack}` : "No route yet"}
              </span>
            </div>

            {!tl || data.delivery.riders.length === 0 ? (
              <p className="empty">No delivery activity recorded in this period.</p>
            ) : (
              <>
                <div className="tl-axis">
                  {tl.ticks.map((t, i) => <span key={i} style={{ left: `${t.left}%` }}>{t.label}</span>)}
                </div>
                <div className="tl-row">
                  <div className="tl-name">Farm<small>prep</small></div>
                  <div className="tl-track">
                    {data.delivery.packagedAt && <div className="tl-mark" style={{ left: `${tl.pos(data.delivery.packagedAt)}%`, background: "#B45309" }} />}
                    {data.delivery.firstOut && <div className="tl-mark" style={{ left: `${tl.pos(data.delivery.firstOut)}%`, background: "#1A4D2E" }} />}
                    {data.delivery.lastBack && <div className="tl-mark" style={{ left: `${tl.pos(data.delivery.lastBack)}%`, background: "#991B1B" }} />}
                  </div>
                </div>
                {data.delivery.riders.map((r) => {
                  const left = tl.pos(r.out);
                  const right = tl.pos(r.back);
                  const width = left !== null && right !== null ? Math.max(2, right - left) : null;
                  return (
                    <div className="tl-row" key={r.name}>
                      <div className="tl-name">{r.name}<small>{num(r.stops)} stops · {money(r.cash)}</small></div>
                      <div className="tl-track">
                        {left !== null && width !== null && (
                          <div className="tl-span" style={{ left: `${left}%`, width: `${width}%` }}>
                            <b>{r.out}</b>{r.back && r.back !== r.out && <b>{r.back}</b>}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div className="tl-legend">
                  <div className="tl-lg"><span className="tl-dot" style={{ background: "#B45309" }} />Packaging {data.delivery.packagedAt ?? "—"}</div>
                  <div className="tl-lg"><span className="tl-dot" style={{ background: "#1A4D2E" }} />First out {data.delivery.firstOut ?? "—"}</div>
                  <div className="tl-lg"><span className="tl-dot" style={{ background: "#991B1B" }} />Last delivery {data.delivery.lastBack ?? "—"}</div>
                  <div className="tl-lg" style={{ marginLeft: "auto" }}>
                    Collected on route <strong style={{ color: "var(--ink)" }}>{money(data.delivery.routeCash)} cash · {money(data.delivery.digitalCash)} digital</strong>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Team ── */}
        <div className="sec">
          <div className="rail"><span>Team</span></div>
          <div className="sec-b">
            <div className="sec-h">
              <div>
                <div className="sec-t">Checklist completion<Info text="Assigned daily checklist items ticked versus expected across this period. Click a person to see each task and when it was ticked." /></div>
                <div className="sec-s">
                  {num(data.team.totalDone)} of {num(data.team.totalTasks)} ticks · {num(Math.max(0, data.team.totalTasks - data.team.totalDone))} missed
                </div>
              </div>
              <span className={`tag ${data.team.pct >= 90 ? "t-ok" : data.team.pct >= 75 ? "t-warn" : "t-bad"}`}>{pct0(data.team.pct)} done</span>
            </div>
            <div className="row">
              <div>
                {data.team.employees.length === 0 ? (
                  <p className="empty">No active checklists assigned.</p>
                ) : (
                  data.team.employees.map((e) => {
                    const col = e.pct >= 90 ? "#166534" : e.pct >= 75 ? "#B45309" : "#991B1B";
                    return (
                      <button type="button" className="emp" key={e.id} onClick={() => setOpenEmp(e)}>
                        <div className="emp-top">
                          <div className="emp-l">
                            <div className="emp-av">{e.name.slice(0, 2).toUpperCase()}</div>
                            <div>
                              <div className="emp-name">{e.name}</div>
                              <div className="emp-role">{e.role}</div>
                            </div>
                          </div>
                          <div className="emp-pct" style={{ color: col }}>{pct0(e.pct)}</div>
                        </div>
                        <div className="bar"><div className="bar-fill" style={{ width: `${Math.min(100, e.pct)}%`, background: col }} /></div>
                        <div className="emp-meta">{e.done} done · {Math.max(0, e.total - e.done)} missed of {e.total}</div>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="rings">
                <div className="ring">
                  <Ring pct={data.team.pct} color={data.team.pct >= 90 ? "#166534" : data.team.pct >= 75 ? "#B45309" : "#991B1B"} />
                  <div>
                    <div className="ring-v">{pct0(data.team.pct)}</div>
                    <div className="ring-l">Tasks completed</div>
                    <div className="ring-s">{num(Math.max(0, data.team.totalTasks - data.team.totalDone))} missed across {data.team.employees.length} staff</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="foot">Banoori Dairy · {data.windowLabel} · generated {new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</div>
      </div>

      {/* ── Checklist detail ── */}
      {openEmp && (
        <div className="ov" onClick={(e) => e.target === e.currentTarget && setOpenEmp(null)}>
          <div className="ov-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div className="emp-av" style={{ width: 42, height: 42, fontSize: 14, borderRadius: 13 }}>
                  {openEmp.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <div style={{ fontFamily: "var(--sr-serif), Georgia, serif", fontSize: 19, fontWeight: 600 }}>{openEmp.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--mute)", fontWeight: 600 }}>{openEmp.role}</div>
                </div>
              </div>
              <button onClick={() => setOpenEmp(null)} aria-label="Close"
                style={{ background: "none", border: "none", fontSize: 24, color: "var(--mute)", cursor: "pointer", lineHeight: 1 }}>×</button>
            </div>

            <div style={{ display: "flex", gap: 10, margin: "18px 0", padding: 14, borderRadius: 14, background: "#FAF9F5", border: "1px solid var(--line)" }}>
              <div style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "var(--pos)", textTransform: "uppercase", letterSpacing: ".1em", fontWeight: 800 }}>Done</div>
                <div style={{ fontFamily: "var(--sr-serif), serif", fontSize: 22, fontWeight: 600, color: "var(--pos)" }}>{openEmp.done}</div>
              </div>
              <div style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "var(--neg)", textTransform: "uppercase", letterSpacing: ".1em", fontWeight: 800 }}>Missed</div>
                <div style={{ fontFamily: "var(--sr-serif), serif", fontSize: 22, fontWeight: 600, color: "var(--neg)" }}>{Math.max(0, openEmp.total - openEmp.done)}</div>
              </div>
              <div style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "var(--mute)", textTransform: "uppercase", letterSpacing: ".1em", fontWeight: 800 }}>Completion</div>
                <div style={{ fontFamily: "var(--sr-serif), serif", fontSize: 22, fontWeight: 600 }}>{pct0(openEmp.pct)}</div>
              </div>
            </div>

            <div style={{ fontSize: 9.5, fontWeight: 800, color: "var(--mute)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 9 }}>
              Task checklist
            </div>
            {openEmp.tasks.length === 0 ? (
              <p className="empty">No checklist items.</p>
            ) : (
              openEmp.tasks.map((t, i) => {
                const done = t.doneCount > 0;
                const when = t.lastDoneAt
                  ? new Date(t.lastDoneAt).toLocaleString("en-GB", {
                      timeZone: "Asia/Karachi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
                    })
                  : null;
                return (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 11, padding: "11px 13px", borderRadius: 11,
                    background: done ? "#F1F8F2" : "#FCF1F1", marginBottom: 6,
                  }}>
                    <div style={{ width: 20, textAlign: "center", color: done ? "#166534" : "#991B1B", fontSize: 15 }}>
                      {done ? "✓" : "✕"}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t.label}</div>
                      <div style={{ fontSize: 10.5, color: "var(--mute)", marginTop: 2, fontWeight: 500 }}>
                        {when
                          ? `Last ticked ${when}${t.lastDoneBy ? ` by ${t.lastDoneBy}` : ""}`
                          : "Not ticked"}
                        {t.expected > 1 && ` · ${t.doneCount} of ${t.expected} days`}
                      </div>
                    </div>
                    <span style={{
                      fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".08em",
                      color: done ? "#166534" : "#991B1B",
                    }}>
                      {done ? "Done" : "Missed"}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
