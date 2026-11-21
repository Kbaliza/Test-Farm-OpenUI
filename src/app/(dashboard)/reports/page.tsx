import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { ReportsClient } from "@/components/reports/reports-client";
import { getReportsData } from "./actions";
import { todayPKTString } from "@/lib/pkt";

export const dynamic = "force-dynamic";

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

export default async function ReportsPage({
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

  const data = await getReportsData(selectedMonth);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Reports"
        description="Inventory and cash-flow trends at a glance"
        actions={
          <div className="flex items-center gap-1">
            <Link
              href={`/reports?m=${prevMonth}`}
              className="inline-flex items-center justify-center rounded-md border border-border bg-background p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <ChevronLeft className="size-4" />
            </Link>
            <span className="w-24 text-center text-sm font-medium select-none">
              {monthLabel(selectedMonth)}
            </span>
            <Link
              href={isCurrentMonth ? "#" : `/reports?m=${nextMonth}`}
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

      {!data.dbReady ? (
        <DbNotReady what="Reports" />
      ) : (
        <div className="p-4 sm:p-6">
          <ReportsClient data={data} />
        </div>
      )}
    </div>
  );
}
