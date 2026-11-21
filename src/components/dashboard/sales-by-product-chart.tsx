// Sales by Product: a pie of the month's share, with the numbers beside it.
//
// Hand-rolled SVG like inventory-trend-chart, rather than a charting library —
// there is nothing to hover or click here, so this stays a server component and
// ships no JavaScript at all.
//
// The one thing worth reading carefully is how negatives are handled. Product
// sales are net of returns (see src/lib/product-sales.ts), so a product CAN come
// out negative in a month where more went back than went out. A negative slice
// of a pie is meaningless, so those are excluded from the circle and the share
// column, and still listed in the table with their real figure — dropping them
// would make the rows stop adding up to the header total.

import { unitLabel, type Unit } from "@/lib/units";

export type SalesByProductRow = {
  productId: string;
  name: string;
  unit: string;
  qty: number;
  value: number;
};

// Same ramp the inventory chart uses, so the two cards look related.
const SLICE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
const OTHER_COLOR = "var(--muted-foreground)";

function money(n: number) {
  const v = Math.round(n);
  return `${v < 0 ? "−" : ""}Rs ${Math.abs(v).toLocaleString("en-PK")}`;
}
const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** A slice's outline. `share` is 0..1 of the whole circle. */
function slicePath(cx: number, cy: number, r: number, from: number, to: number) {
  // Starting at 12 o'clock and going clockwise, which is how people read a pie.
  const a = (t: number) => (t * 2 - 0.5) * Math.PI;
  const x1 = cx + r * Math.cos(a(from));
  const y1 = cy + r * Math.sin(a(from));
  const x2 = cx + r * Math.cos(a(to));
  const y2 = cy + r * Math.sin(a(to));
  const large = to - from > 0.5 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

function labelPos(cx: number, cy: number, r: number, from: number, to: number) {
  const mid = (from + to) / 2;
  const a = (mid * 2 - 0.5) * Math.PI;
  return { x: cx + r * 0.62 * Math.cos(a), y: cy + r * 0.62 * Math.sin(a) };
}

export function SalesByProductChart({
  rows,
  total,
}: {
  rows: SalesByProductRow[];
  /** The month's sales headline, so the table foots to the same number the card's
      header shows. Passed in rather than re-summed here on purpose. */
  total: number;
}) {
  // Six named products plus a tail, so a farm with thirty SKUs still gets a
  // readable card.
  const top = rows.slice(0, 6);
  const rest = rows.slice(6);
  const restValue = rest.reduce((s, r) => s + r.value, 0);

  const listed: { key: string; name: string; meta: string; value: number; color: string }[] = [
    ...top.map((r, i) => ({
      key: r.productId,
      name: r.name,
      meta: `${fmtQty(r.qty)} ${unitLabel(r.unit as Unit)}`,
      value: r.value,
      color: SLICE_COLORS[i % SLICE_COLORS.length],
    })),
    ...(rest.length
      ? [{
          key: "__other__",
          name: `Other (${rest.length} product${rest.length === 1 ? "" : "s"})`,
          meta: "",
          value: restValue,
          color: OTHER_COLOR,
        }]
      : []),
  ];

  // Only what is actually positive can occupy an angle.
  const positive = listed.filter((r) => r.value > 0);
  const pieTotal = positive.reduce((s, r) => s + r.value, 0);

  let cursor = 0;
  const slices = positive.map((r) => {
    const share = r.value / pieTotal;
    const s = { ...r, share, from: cursor, to: cursor + share };
    cursor += share;
    return s;
  });

  const CX = 110, CY = 110, R = 92;
  const onlySlice = slices.length === 1;

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-6">
      {/* Pie */}
      <div className="shrink-0">
        <svg viewBox="0 0 220 220" className="h-[210px] w-[210px] sm:h-[250px] sm:w-[250px]" role="img" aria-label="Share of sales by product">
          {onlySlice ? (
            <circle cx={CX} cy={CY} r={R} fill={slices[0].color} stroke="var(--card)" strokeWidth="2" />
          ) : (
            slices.map((s) => (
              <path key={s.key} d={slicePath(CX, CY, R, s.from, s.to)} fill={s.color} stroke="var(--card)" strokeWidth="2" />
            ))
          )}
          {slices.map((s) => {
            // Below ~8% the text is wider than the wedge, so leave it to the table.
            if (s.share < 0.08) return null;
            const p = onlySlice ? { x: CX, y: CY } : labelPos(CX, CY, R, s.from, s.to);
            return (
              <text
                key={`l-${s.key}`}
                x={p.x}
                y={p.y}
                textAnchor="middle"
                dominantBaseline="central"
                className="fill-white text-[13px] font-bold"
              >
                {(s.share * 100).toFixed(1)}%
              </text>
            );
          })}
        </svg>
      </div>

      {/* The same numbers, written out */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          <span>Product</span>
          <span className="flex shrink-0 gap-4">
            <span className="w-[86px] text-right">Sales</span>
            <span className="w-11 text-right">Share</span>
          </span>
        </div>

        <div className="divide-y divide-border/60">
          {listed.map((r) => {
            const share = r.value > 0 ? r.value / pieTotal : null;
            return (
              <div key={r.key} className="flex items-center justify-between gap-3 py-1.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: r.color }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] leading-tight">{r.name}</span>
                    {r.meta ? (
                      <span className="block text-[10.5px] leading-tight text-muted-foreground">{r.meta}</span>
                    ) : null}
                  </span>
                </span>
                <span className="flex shrink-0 gap-4">
                  <span className={`num w-[86px] text-right text-[13px] ${r.value < 0 ? "text-rose-600" : ""}`}>
                    {money(r.value)}
                  </span>
                  <span className="num w-11 text-right text-[13px] text-muted-foreground">
                    {share === null ? "—" : `${(share * 100).toFixed(1)}%`}
                  </span>
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2 text-xs">
          <span className="font-medium uppercase tracking-wide text-muted-foreground">Total sales</span>
          <span className="num shrink-0 text-sm font-bold">{money(total)}</span>
        </div>
      </div>
    </div>
  );
}
