"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Truck, ShoppingBag, ShoppingCart, Trash2, Scale, CalendarDays } from "lucide-react";
import { todayPKTString, addDaysToDateStr } from "@/lib/pkt";
import { getMilkChartData } from "@/app/(dashboard)/milk-chart-actions";
import { OUTSOURCED_KEY, type MilkChartData, type MilkChartDay } from "@/lib/milk-chart";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtDate = (s: string) => { const [, m, d] = s.split("-").map(Number); return `${MONTHS[m - 1]} ${d}`; };
const fmtL = (n: number) => `${Math.round(n).toLocaleString()} L`;

// The chart this grew out of: one stacked bar per day, coloured by milk type.
// Each day now carries a second bar beside it for sales, in the same colours, so
// what came in and what went out are read against each other.
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const NICE_MAX_CANDIDATES = [50, 100, 200, 400, 600, 800, 1000, 1200, 1600, 2000, 3000, 4000, 6000, 8000, 10000, 12000, 16000, 20000];
function niceMax(m: number): number {
  for (const c of NICE_MAX_CANDIDATES) if (c >= m) return c;
  return Math.ceil(m / 2000) * 2000;
}

type Preset = "TODAY" | "YESTERDAY" | "7D" | "30D" | "CUSTOM";

function rangeFor(p: Exclude<Preset, "CUSTOM">): { from: string; to: string } {
  const today = todayPKTString();
  if (p === "TODAY") return { from: today, to: today };
  if (p === "YESTERDAY") { const y = addDaysToDateStr(today, -1); return { from: y, to: y }; }
  return { from: addDaysToDateStr(today, p === "7D" ? -6 : -29), to: today };
}

const tiles = (d: MilkChartData) => [
  { label: "Arrived",   value: d.totals.arrived,    icon: Truck,        tone: "bg-emerald-100 text-emerald-700" },
  { label: "Bought in", value: d.totals.outsourced, icon: ShoppingBag,  tone: "bg-violet-100 text-violet-700" },
  { label: "Sales",     value: d.totals.sales,      icon: ShoppingCart, tone: "bg-amber-100 text-amber-700" },
  { label: "Wastage",   value: d.totals.wastage,    icon: Trash2,       tone: "bg-rose-100 text-rose-700" },
  { label: "Net",       value: d.totals.net,        icon: Scale,        tone: "bg-sky-100 text-sky-700" },
];

export function MilkInventorySales({ initial }: { initial: MilkChartData }) {
  const [data, setData] = useState(initial);
  const [preset, setPreset] = useState<Preset>("TODAY");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [showDates, setShowDates] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [loading, start] = useTransition();

  // Re-read whenever the chosen range changes. The first render already carries
  // today's figures from the server, so the card never starts empty.
  useEffect(() => {
    if (from === data.from && to === data.to) return;
    start(async () => {
      setData(await getMilkChartData(from, to));
      setHoverIdx(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  function pick(p: Exclude<Preset, "CUSTOM">) {
    const r = rangeFor(p);
    setPreset(p);
    setShowDates(false);
    setFrom(r.from);
    setTo(r.to);
  }

  // Only types that actually moved in THIS range get a stack and a legend row.
  const visibleTypes = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const d of data.days) {
      for (const [id, v] of Object.entries(d.inventory)) totals[id] = (totals[id] ?? 0) + v;
      for (const [id, v] of Object.entries(d.sales)) totals[id] = (totals[id] ?? 0) + v;
    }
    return data.types.filter((t) => (totals[t.id] ?? 0) > 0);
  }, [data]);

  const controls = (
    <div className="flex shrink-0 flex-wrap gap-1 rounded-lg bg-muted p-0.5">
      {([["TODAY", "Today"], ["YESTERDAY", "Yesterday"], ["7D", "7D"], ["30D", "30D"]] as const).map(([p, label]) => (
        <button
          key={p}
          type="button"
          onClick={() => pick(p)}
          className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors ${
            preset === p ? "bg-emerald-700 text-white" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => { setPreset("CUSTOM"); setShowDates((v) => !v); }}
        className={`flex items-center gap-1 rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors ${
          preset === "CUSTOM" ? "bg-emerald-700 text-white" : "text-muted-foreground hover:text-foreground"
        }`}
        title="Pick any dates"
      >
        <CalendarDays className="size-3.5" />
      </button>
    </div>
  );

  const rangeLabel = data.from === data.to ? fmtDate(data.from) : `${fmtDate(data.from)} – ${fmtDate(data.to)}`;

  const datePickers = (showDates || preset === "CUSTOM") && (
    <div className="mb-3 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/30 p-2.5">
      <label className="text-xs text-muted-foreground">
        From
        <input
          type="date" value={from} max={todayPKTString()}
          onChange={(e) => { setPreset("CUSTOM"); setFrom(e.target.value || from); }}
          className="ml-2 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
        />
      </label>
      <label className="text-xs text-muted-foreground">
        To
        <input
          type="date" value={to} max={todayPKTString()}
          onChange={(e) => { setPreset("CUSTOM"); setTo(e.target.value || to); }}
          className="ml-2 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
        />
      </label>
    </div>
  );

  const statTiles = (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles(data).map((t) => (
        <div key={t.label} className="rounded-lg border border-border bg-muted/50 p-3">
          <div className="flex items-center gap-2">
            <div className={`rounded-md p-1.5 ${t.tone}`}><t.icon className="size-3.5" /></div>
            <p className="stat-label">{t.label}</p>
          </div>
          <p className="mt-2 text-xl font-bold tabular-nums">{fmtL(t.value)}</p>
        </div>
      ))}
    </div>
  );

  if (!data.days.length || data.days.every((d) => d.inventoryTotal <= 0 && d.salesTotal <= 0)) {
    return (
      <div className={loading ? "opacity-60" : undefined}>
        {statTiles}
        {datePickers}
        <div className="mb-3 flex items-end justify-between gap-3">
          <p className="stat-label truncate">{rangeLabel}</p>
          {controls}
        </div>
        <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
          No milk recorded in the selected range
        </div>
      </div>
    );
  }

  const W = 760, H = 220;
  const PAD_T = 14, PAD_B = 26, PAD_L = 46, PAD_R = 14;
  const iW = W - PAD_L - PAD_R;
  const iH = H - PAD_T - PAD_B;
  const cbase = PAD_T + iH;

  const days = data.days;
  const n = days.length;
  const maxVal = Math.max(...days.map((d) => Math.max(d.inventoryTotal, d.salesTotal)), 1);
  const axisMax = niceMax(maxVal);

  const band = iW / n;
  // Two bars per day now, so each takes a little under half the band.
  const gap = Math.min(band * 0.08, 6);
  const barW = Math.min((band * 0.72 - gap) / 2, 34);
  const everyNth = n <= 14 ? 1 : Math.ceil(n / 16);

  const ticks = [0, 1, 2, 3, 4].map((k) => (axisMax * k) / 4);

  const colorOf = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];
  const typeIndex = new Map(visibleTypes.map((t, i) => [t.id, i]));
  // Bought-in milk gets its own distinct colour, not a rotation slot.
  const colorForType = (t: { id: string }) =>
    t.id === OUTSOURCED_KEY ? "var(--chart-6)" : colorOf(typeIndex.get(t.id) ?? 0);

  const hovered = hoverIdx != null ? days[hoverIdx] : null;
  const breakdown = (d: MilkChartDay, kind: "inventory" | "sales") =>
    visibleTypes
      .map((t) => ({ name: t.name, v: (kind === "inventory" ? d.inventory : d.sales)[t.id] ?? 0 }))
      .filter((x) => x.v !== 0)
      .map((x) => `${x.name} ${Math.round(x.v)}`)
      .join(" · ") || "—";

  const caption = hovered
    ? `${fmtDate(hovered.date)} · Inventory ${Math.round(hovered.inventoryTotal).toLocaleString()} L (${breakdown(hovered, "inventory")}) · Sales ${Math.round(hovered.salesTotal).toLocaleString()} L (${breakdown(hovered, "sales")})`
    : `Inventory vs sales · stacked by milk type · litres per day${loading ? " · loading…" : ""}`;

  const grandInv = data.totals.inventory;
  const grandSales = data.totals.sales;

  return (
    <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
      {statTiles}
      {datePickers}

      <div className="mb-3 flex items-end justify-between gap-3">
        <p className="stat-label truncate">{caption}</p>
        {controls}
      </div>

      <div className="-mx-1 overflow-x-auto px-1">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full min-w-[600px] overflow-visible"
          role="img"
          onMouseLeave={() => setHoverIdx(null)}
        >
          {ticks.map((v) => {
            const y = cbase - (v / axisMax) * iH;
            return (
              <g key={v}>
                <line
                  x1={PAD_L} y1={y} x2={W - PAD_R} y2={y}
                  className="stroke-border"
                  strokeWidth="1"
                  strokeDasharray={v === 0 ? undefined : "3 3"}
                />
                <text x={PAD_L - 8} y={y + 3.5} textAnchor="end" className="fill-muted-foreground font-mono text-[9px]">
                  {v >= 1000 ? `${Math.round(v / 100) / 10}k` : Math.round(v)}
                </text>
              </g>
            );
          })}

          {days.map((d, i) => {
            const dim = hoverIdx != null && hoverIdx !== i;
            const pairW = barW * 2 + gap;
            const x0 = PAD_L + band * i + (band - pairW) / 2;

            return (
              <g
                key={`${data.from}-${d.date}`}
                style={{
                  opacity: dim ? 0.38 : 1,
                  transition: "opacity .15s ease",
                  transformBox: "fill-box",
                  transformOrigin: "bottom",
                  animation: "growY .5s cubic-bezier(.2,.7,.2,1) both",
                  animationDelay: `${i * 0.015}s`,
                }}
              >
                {(["inventory", "sales"] as const).map((kind, k) => {
                  const total = kind === "inventory" ? d.inventoryTotal : d.salesTotal;
                  const bx = x0 + k * (barW + gap);
                  const ccx = bx + barW / 2;
                  const barTop = cbase - (total / axisMax) * iH;
                  const barH = Math.max(cbase - barTop, 0);
                  const clipId = `mis-${data.from}-${i}-${kind}`;
                  let cum = 0;
                  return (
                    <g key={kind}>
                      <defs>
                        <clipPath id={clipId}>
                          <rect x={bx} y={barTop} width={barW} height={barH} rx="3" />
                        </clipPath>
                      </defs>

                      {total > 0 && (
                        <g clipPath={`url(#${clipId})`}>
                          {visibleTypes.map((t) => {
                            const v = (kind === "inventory" ? d.inventory : d.sales)[t.id] ?? 0;
                            if (v <= 0) return null;
                            const h = (v / axisMax) * iH;
                            const segY = cbase - cum - h;
                            cum += h;
                            const showLabel = barW >= 26 && h >= 11;
                            return (
                              <g key={t.id}>
                                <rect
                                  x={bx} y={segY} width={barW} height={Math.max(h - 1, 0.6)}
                                  fill={colorForType(t)}
                                  // Sales keep the type's colour, a shade lighter, so a
                                  // pair reads as one day rather than two unrelated bars.
                                  opacity={kind === "sales" ? 0.55 : 1}
                                />
                                {showLabel && (
                                  <text
                                    x={ccx} y={segY + h / 2 + 3}
                                    textAnchor="middle"
                                    fill="#fff"
                                    stroke="rgba(15,35,22,.4)"
                                    strokeWidth="0.7"
                                    paintOrder="stroke"
                                    className="font-mono text-[8.5px] font-bold"
                                  >
                                    {Math.round(v)}
                                  </text>
                                )}
                              </g>
                            );
                          })}
                        </g>
                      )}

                      {barW >= 16 && (
                        <text
                          x={ccx} y={barTop - 6} textAnchor="middle"
                          className="fill-foreground font-mono text-[10px] font-bold"
                          style={{ opacity: dim ? 0.5 : 1 }}
                        >
                          {Math.round(total).toLocaleString()}
                        </text>
                      )}

                      {barW >= 22 && (
                        <text
                          x={ccx} y={H - 17} textAnchor="middle"
                          className="fill-muted-foreground font-mono text-[8px] uppercase tracking-wide"
                        >
                          {kind === "inventory" ? "Inv" : "Sales"}
                        </text>
                      )}
                    </g>
                  );
                })}

                {(i % everyNth === 0 || i === n - 1) && (
                  <text
                    x={PAD_L + band * i + band / 2} y={H - 6}
                    textAnchor="middle"
                    className="fill-muted-foreground font-mono text-[9px]"
                  >
                    {fmtDate(d.date)}
                  </text>
                )}

                <rect
                  x={PAD_L + band * i} y={PAD_T} width={band} height={iH}
                  fill="transparent"
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHoverIdx(i)}
                />
              </g>
            );
          })}

          <text
            transform={`translate(13,${PAD_T + iH / 2}) rotate(-90)`}
            textAnchor="middle"
            className="fill-muted-foreground font-mono text-[9px] tracking-[0.12em] uppercase"
          >
            Litres
          </text>
        </svg>
      </div>

      {/* Legend + totals */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3">
        {visibleTypes.map((t) => (
          <span key={t.id} className="flex items-center gap-2 text-xs">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: colorForType(t) }} />
            <span className="text-foreground">{t.name}</span>
          </span>
        ))}
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-2.5 shrink-0 rounded-[3px] bg-foreground/70" />
          Inventory
          <span className="ml-2 size-2.5 shrink-0 rounded-[3px] bg-foreground/30" />
          Sales (lighter)
        </span>
        <span className="ml-auto flex items-center gap-4">
          <span className="flex items-center gap-2">
            <span className="stat-label">Inventory</span>
            <span className="num text-sm font-semibold text-foreground">{fmtL(grandInv)}</span>
          </span>
          <span className="flex items-center gap-2">
            <span className="stat-label">Sales</span>
            <span className="num text-sm font-semibold text-foreground">{fmtL(grandSales)}</span>
          </span>
        </span>
      </div>

      <style>{`
        @keyframes growY {
          from { transform: scaleY(0); }
          to   { transform: scaleY(1); }
        }
      `}</style>
    </div>
  );
}
