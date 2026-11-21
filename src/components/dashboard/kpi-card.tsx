import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";

export type KpiTone = "default" | "success" | "warning" | "danger" | "info" | "violet" | "rose";

// Cards are white across the board; the tone reads through the icon tile alone.
const toneIcon: Record<KpiTone, string> = {
  default: "bg-muted text-muted-foreground",
  success: "bg-accent text-accent-foreground",
  warning: "bg-amber-100/80 text-amber-700",
  danger: "bg-rose-100/70 text-rose-700",
  info: "bg-sky-100/70 text-sky-700",
  violet: "bg-violet-100/70 text-violet-700",
  rose: "bg-rose-100/70 text-rose-700",
};

// Trend line across the foot of the card. Flat-lines when every point is equal
// (a month of zeroes shouldn't render as a jagged line through rounding noise).
function Sparkline({ points, stroke, idKey }: { points: number[]; stroke: string; idKey: string }) {
  const W = 240, H = 36, PAD = 3;
  const n = points.length;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min;

  const xOf = (i: number) => (n > 1 ? (i / (n - 1)) * W : W / 2);
  const yOf = (v: number) =>
    span === 0 ? H - PAD - (H - PAD * 2) / 2 : H - PAD - ((v - min) / span) * (H - PAD * 2);

  const line = points.map((v, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
  const area = `${line} L ${xOf(n - 1).toFixed(1)},${H} L ${xOf(0).toFixed(1)},${H} Z`;
  // Unique per card (label is unique) so cards sharing a stroke color don't emit duplicate gradient ids.
  const gid = `spark-${idKey.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mt-3 h-9 w-full"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.16" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function KpiCard({
  label,
  value,
  subValue,
  delta,
  deltaDir = "flat",
  icon: Icon,
  tone = "default",
  invertTrend = false,
  series,
  href,
}: {
  label: string;
  value: string;
  /** A compact second line under the main value — for merged/two-metric tiles. */
  subValue?: string;
  delta?: string;
  deltaDir?: "up" | "down" | "flat";
  icon?: LucideIcon;
  tone?: KpiTone;
  invertTrend?: boolean;
  /** Daily points for the sparkline. Omit for KPIs with no honest daily series. */
  series?: number[];
  /** When set, the whole card becomes a link to this page. */
  href?: string;
}) {
  const Trend = deltaDir === "up" ? TrendingUp : deltaDir === "down" ? TrendingDown : Minus;
  // "Good" depends on the metric: expenses rising is bad, sales rising is good.
  const good =
    deltaDir === "up" ? !invertTrend : deltaDir === "down" ? invertTrend : null;
  const deltaPill =
    good === null
      ? "bg-muted text-muted-foreground"
      : good
        ? "bg-accent text-accent-foreground"
        : "bg-destructive/10 text-destructive";

  // The line follows the trend, not the tone: a green "Collected" card still
  // draws a red line in a month where collection fell.
  const sparkStroke =
    good === null
      ? "var(--chart-3)"
      : good
        ? "var(--chart-2)"
        : "var(--destructive)";

  const card = (
    <Card className={cn(href && "h-full transition-shadow group-hover/kpi:shadow-md")}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <p className="stat-label pt-0.5">{label}</p>
          {Icon ? (
            <div className={cn("rounded-lg p-2", toneIcon[tone])}>
              <Icon className="size-4" />
            </div>
          ) : null}
        </div>
        <p className="stat-value mt-2.5">{value}</p>
        {subValue ? (
          <p className="mt-0.5 text-xs font-medium text-muted-foreground">{subValue}</p>
        ) : null}
        {delta !== undefined ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
                deltaPill
              )}
            >
              <Trend className="size-3" />
              <span className="num">{delta || "—"}</span>
            </span>
            <span className="hidden text-muted-foreground sm:inline">vs prev. month</span>
          </div>
        ) : null}
        {series && series.length > 1 ? (
          <Sparkline points={series} stroke={sparkStroke} idKey={label} />
        ) : null}
      </CardContent>
    </Card>
  );

  if (!href) return card;
  return (
    <Link
      href={href}
      className="group/kpi block rounded-xl transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {card}
    </Link>
  );
}
