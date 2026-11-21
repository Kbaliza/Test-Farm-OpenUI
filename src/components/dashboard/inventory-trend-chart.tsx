"use client";

import { useMemo, useState } from "react";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDate(s: string) {
  const [, m, d] = s.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

// Stack colours, applied in the order the types arrive (largest volume first).
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const fmtL = (n: number) => `${Math.round(n)} L`;

// Curated round numbers for the axis max, so gridline labels stay clean
// instead of landing on an arbitrary power-of-ten fraction.
const NICE_MAX_CANDIDATES = [50, 100, 200, 400, 600, 800, 1000, 1200, 1600, 2000, 3000, 4000, 6000, 8000, 10000, 12000, 16000];
function niceMax(m: number): number {
  for (const c of NICE_MAX_CANDIDATES) if (c >= m) return c;
  return Math.ceil(m / 2000) * 2000;
}

export type MilkType = { id: string; name: string };
export type MilkTrendDay = { date: string; totalL: number; byType: Record<string, number> };

type Bucket = { label: string; total: number; byType: Record<string, number> };
type Range = "7D" | "30D" | "90D";

// 7D/30D pull the daily rows directly; 90D folds them into 7-day chunks (most
// recent chunk first, walking backward) — same shape as the daily case so the
// rest of the chart doesn't need to know which mode it's in.
function buildBuckets(data: MilkTrendDay[], range: Range): Bucket[] {
  const n = range === "7D" ? 7 : range === "30D" ? 30 : data.length;
  const slice = data.slice(-n);

  if (range !== "90D") {
    return slice.map((d) => ({ label: fmtDate(d.date), total: d.totalL, byType: d.byType }));
  }

  const buckets: Bucket[] = [];
  for (let end = slice.length; end > 0; end -= 7) {
    const start = Math.max(0, end - 7);
    const chunk = slice.slice(start, end);
    if (!chunk.length) continue;
    const byType: Record<string, number> = {};
    let total = 0;
    for (const d of chunk) {
      total += d.totalL;
      for (const [pid, v] of Object.entries(d.byType)) byType[pid] = (byType[pid] ?? 0) + v;
    }
    buckets.unshift({ label: fmtDate(chunk[chunk.length - 1].date), total, byType });
  }
  return buckets;
}

export function InventoryTrendChart({
  data,
  types,
}: {
  data: MilkTrendDay[];
  types: MilkType[];
}) {
  const [range, setRange] = useState<Range>("7D");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const buckets = useMemo(() => buildBuckets(data, range), [data, range]);

  // Only types that actually moved within the CURRENT range get a legend row —
  // recomputed per range, not carried over from the full 90-day window.
  const visibleTypes = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const b of buckets) for (const [pid, v] of Object.entries(b.byType)) totals[pid] = (totals[pid] ?? 0) + v;
    return types
      .map((t) => ({ ...t, totalL: totals[t.id] ?? 0 }))
      .filter((t) => t.totalL > 0)
      .sort((a, b) => b.totalL - a.totalL);
  }, [buckets, types]);

  if (!buckets.length || buckets.every((b) => b.total === 0)) {
    return (
      <div>
        <RangeTabs range={range} onChange={(r) => { setRange(r); setHoverIdx(null); }} />
        <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
          No inventory data in the selected range
        </div>
      </div>
    );
  }

  const W = 760, H = 220;
  const PAD_T = 14, PAD_B = 26, PAD_L = 46, PAD_R = 14;
  const iW = W - PAD_L - PAD_R;
  const iH = H - PAD_T - PAD_B;
  const cbase = PAD_T + iH;

  const n = buckets.length;
  const maxVal = Math.max(...buckets.map((b) => b.total), 1);
  const axisMax = niceMax(maxVal);
  const yOf = (v: number) => cbase - (v / axisMax) * iH;

  const band = iW / n;
  const barW = Math.min(band * 0.6, 46);
  const everyNth = n <= 14 ? 1 : Math.ceil(n / 16);

  const ticks = [0, 1, 2, 3, 4].map((k) => axisMax * k / 4);

  const grandTotal = buckets.reduce((s, b) => s + b.total, 0);
  const colorOf = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];
  const typeIndex = new Map(visibleTypes.map((t, i) => [t.id, i]));
  // Outsourced (bought-in) milk gets its own distinct colour, not a rotation slot.
  const colorForType = (t: { id: string }) =>
    t.id === "__outsourced__" ? "var(--chart-6)" : colorOf(typeIndex.get(t.id) ?? 0);

  const hovered = hoverIdx != null ? buckets[hoverIdx] : null;
  const caption = hovered
    ? `${hovered.label} · ${visibleTypes.map((t) => `${t.name} ${Math.round(hovered.byType[t.id] ?? 0)}`).join(" · ")} · ${Math.round(hovered.total).toLocaleString()} L`
    : `Stacked by milk type · litres per ${range === "90D" ? "week" : "day"}`;

  return (
    <div>
      <div className="mb-3 flex items-end justify-between gap-3">
        <p className="stat-label truncate">{caption}</p>
        <RangeTabs range={range} onChange={(r) => { setRange(r); setHoverIdx(null); }} />
      </div>

      {/* The viewBox is 760 wide. Left to scale freely it would render its 9px
          axis labels at under 4px on a phone — a chart you cannot read is worse
          than one you have to nudge sideways. So it keeps a floor width and the
          WRAPPER scrolls, which also keeps the page itself from scrolling
          horizontally. Above that floor it still fills the card as before. */}
      <div className="-mx-1 overflow-x-auto px-1">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full min-w-[600px] overflow-visible"
          role="img"
          onMouseLeave={() => setHoverIdx(null)}
        >
          {ticks.map((v) => {
            const y = yOf(v);
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

          {buckets.map((b, i) => {
            const bx = PAD_L + band * i + (band - barW) / 2;
            const ccx = bx + barW / 2;
            const dim = hoverIdx != null && hoverIdx !== i;
            const clipId = `bar-clip-${range}-${i}`;
            const barTop = yOf(b.total);
            const barH = Math.max(cbase - barTop, 0);

            let cum = 0;
            return (
              <g
                key={`${range}-${i}`}
                style={{
                  opacity: dim ? 0.38 : 1,
                  transition: "opacity .15s ease",
                  transformBox: "fill-box",
                  transformOrigin: "bottom",
                  animation: "growY .5s cubic-bezier(.2,.7,.2,1) both",
                  animationDelay: `${i * 0.015}s`,
                }}
              >
                <defs>
                  <clipPath id={clipId}>
                    <rect x={bx} y={barTop} width={barW} height={barH} rx="3" />
                  </clipPath>
                </defs>

                {b.total > 0 && (
                  <g clipPath={`url(#${clipId})`}>
                    {visibleTypes.map((t) => {
                      const v = b.byType[t.id] ?? 0;
                      if (v <= 0) return null;
                      const h = (v / axisMax) * iH;
                      const segY = cbase - cum - h;
                      cum += h;
                      const showLabel = barW >= 34 && h >= 11;
                      return (
                        <g key={t.id}>
                          <rect x={bx} y={segY} width={barW} height={Math.max(h - 1, 0.6)} fill={colorForType(t)} />
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

                {barW >= 20 && (
                  <text
                    x={ccx} y={barTop - 6} textAnchor="middle"
                    className="fill-foreground font-mono text-[10px] font-bold"
                    style={{ opacity: dim ? 0.5 : 1 }}
                  >
                    {Math.round(b.total).toLocaleString()}
                  </text>
                )}

                {(i % everyNth === 0 || i === n - 1) && (
                  <text x={ccx} y={H - 8} textAnchor="middle" className="fill-muted-foreground font-mono text-[9px]">
                    {b.label}
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

      {/* Legend + total */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3">
        {visibleTypes.map((t) => {
          return (
            <span key={t.id} className="flex items-center gap-2 text-xs">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: colorForType(t) }} />
              <span className="text-foreground">{t.name}</span>
              <span className="num text-muted-foreground">{fmtL(t.totalL)}</span>
            </span>
          );
        })}
        <span className="ml-auto flex items-center gap-2">
          <span className="stat-label">Total</span>
          <span className="num text-sm font-semibold text-foreground">{fmtL(grandTotal)}</span>
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

function RangeTabs({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  const opts: Range[] = ["7D", "30D", "90D"];
  return (
    <div className="flex shrink-0 gap-1 rounded-lg bg-muted p-0.5">
      {opts.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors ${
            range === r ? "bg-emerald-700 text-white" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}
