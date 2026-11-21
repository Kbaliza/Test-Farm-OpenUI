import { Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getRiderPerformance, type RiderPerformanceData } from "@/lib/rider-performance";

const MONTHS = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];

function fmt(n: number) {
  return Math.round(n).toLocaleString("en-PK");
}

function barColor(pct: number) {
  if (pct >= 90) return "bg-emerald-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-rose-500";
}

function pctText(pct: number) {
  if (pct >= 90) return "text-emerald-600";
  if (pct >= 70) return "text-amber-600";
  return "text-rose-600";
}

function RiderPerformanceBody({ data }: { data: RiderPerformanceData }) {
  if (!data.dbReady) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
        <Users className="size-6 opacity-40" />
        <p className="text-sm">Couldn&apos;t load rider activity.</p>
      </div>
    );
  }

  const active = data.riders.filter((r) => r.expected > 0 || r.collected > 0);

  if (active.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
        <Users className="size-6 opacity-40" />
        <p className="text-sm">No billing or collection activity this month yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {active.map((r) => (
        <div key={r.riderId} className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium">{r.riderName}</p>
            <span className={`shrink-0 text-sm font-bold tabular-nums ${pctText(r.pct)}`}>
              {r.pct}%
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Collected{" "}
              <span className="font-medium text-foreground">Rs {fmt(r.collected)}</span>{" "}
              of Rs {fmt(r.expected)}
            </span>
            <span>
              Rs {fmt(Math.max(0, r.expected - r.collected))} left
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full ${barColor(r.pct)} transition-all`}
              style={{ width: `${Math.min(r.pct, 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// Self-contained server component: fetches collection data and renders the card.
export async function RiderPerformanceCard() {
  const data = await getRiderPerformance();
  const overallPct =
    data.totalExpected > 0 ? Math.round((data.totalCollected / data.totalExpected) * 100) : 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Rider Performance</CardTitle>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Cash collection · {MONTHS[data.month - 1]} {data.year}
          </p>
        </div>
        {data.dbReady && data.totalExpected > 0 ? (
          <div className="text-right">
            <p className={`text-sm font-bold tabular-nums ${pctText(overallPct)}`}>{overallPct}%</p>
            <p className="text-[11px] text-muted-foreground">
              Rs {fmt(data.totalCollected)} / Rs {fmt(data.totalExpected)}
            </p>
          </div>
        ) : (
          <Users className="size-4 text-muted-foreground" />
        )}
      </CardHeader>
      <CardContent>
        <RiderPerformanceBody data={data} />
      </CardContent>
    </Card>
  );
}
