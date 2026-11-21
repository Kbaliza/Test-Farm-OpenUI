import Link from "next/link";
import { AlertTriangle, CheckCircle2, ClipboardCheck, Wallet, Bell, ShoppingBag } from "lucide-react";
import { getAlerts, type AppAlert, type AlertCategory } from "./actions";

export const dynamic = "force-dynamic";

// One column per topic. Colours are per COLUMN, not per severity — a single yellow
// list was the thing that made these unreadable.
const COLUMNS: {
  key: AlertCategory;
  title: string;
  icon: typeof ClipboardCheck;
  card: string;   // alert card
  head: string;   // column heading
  icon_: string;  // icon tint
  empty: string;
}[] = [
  {
    key: "checklist",
    title: "Checklist alerts",
    icon: ClipboardCheck,
    card: "border-orange-200 bg-orange-50 text-orange-900",
    head: "border-orange-200 bg-orange-100 text-orange-900",
    icon_: "text-orange-500",
    empty: "No checklist alerts.",
  },
  {
    key: "riderCash",
    title: "Rider cash alerts",
    icon: Wallet,
    card: "border-amber-200 bg-amber-50 text-amber-900",
    head: "border-amber-200 bg-amber-100 text-amber-900",
    icon_: "text-amber-500",
    empty: "No rider cash alerts.",
  },
  {
    key: "retail",
    title: "Retail mart alerts",
    icon: ShoppingBag,
    card: "border-sky-200 bg-sky-50 text-sky-900",
    head: "border-sky-200 bg-sky-100 text-sky-900",
    icon_: "text-sky-500",
    empty: "No mart visits overdue.",
  },
  {
    key: "other",
    title: "Other alerts",
    icon: Bell,
    card: "border-violet-200 bg-violet-50 text-violet-900",
    head: "border-violet-200 bg-violet-100 text-violet-900",
    icon_: "text-violet-500",
    empty: "No other alerts.",
  },
];

function AlertCard({ alert, cardCls, iconCls }: { alert: AppAlert; cardCls: string; iconCls: string }) {
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-3 py-3 ${cardCls}`}>
      <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${iconCls}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug">{alert.title}</p>
        <p className="mt-0.5 text-[13px] leading-snug opacity-80">{alert.message}</p>
        {alert.link && (
          <Link
            href={alert.link}
            className="mt-1.5 inline-block text-xs font-medium underline underline-offset-2 opacity-70 hover:opacity-100"
          >
            View →
          </Link>
        )}
      </div>
    </div>
  );
}

export default async function AlertsPage() {
  const { alerts, dbReady } = await getAlerts();

  // Anything without a recognised category still shows, under "Other".
  const known = new Set(COLUMNS.map((c) => c.key));
  const bucket = (a: AppAlert): AlertCategory => (known.has(a.category) ? a.category : "other");

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Alerts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Active alerts requiring your attention, grouped by topic.
        </p>
      </div>

      {!dbReady && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          Database not connected — alerts unavailable.
        </div>
      )}

      {dbReady && alerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
          <CheckCircle2 className="mb-3 size-10 text-emerald-500" />
          <p className="text-base font-medium">All clear</p>
          <p className="mt-1 text-sm text-muted-foreground">No active alerts at the moment.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => {
            const mine = alerts.filter((a) => bucket(a) === col.key);
            const Icon = col.icon;
            return (
              <section key={col.key} className="flex flex-col gap-3">
                <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${col.head}`}>
                  <Icon className="size-4" />
                  <h2 className="text-sm font-semibold">{col.title}</h2>
                  <span className="ml-auto rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-bold">
                    {mine.length}
                  </span>
                </div>
                {mine.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                    {col.empty}
                  </p>
                ) : (
                  mine.map((a) => <AlertCard key={a.id} alert={a} cardCls={col.card} iconCls={col.icon_} />)
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
