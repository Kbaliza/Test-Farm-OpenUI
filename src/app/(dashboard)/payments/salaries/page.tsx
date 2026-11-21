import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { SalariesClient } from "@/components/payments/salaries-client";
import { getSalariesPageData } from "./actions";


function parseMonthParam(m: string | undefined): { year: number; month: number } {
  if (m && /^\d{4}-\d{2}$/.test(m)) {
    const [y, mo] = m.split("-").map(Number);
    if (y >= 2020 && y <= 2100 && mo >= 1 && mo <= 12) return { year: y, month: mo };
  }
  const now = new Date(Date.now() + 5 * 60 * 60 * 1000);
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

export default async function SalariesPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const { m } = await searchParams;
  const { year, month } = parseMonthParam(m);
  const data = await getSalariesPageData(month, year);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Salaries"
        description="Employee wages, attendance, bonuses, deductions and salary payments"
      />
      {!data.dbReady ? (
        <DbNotReady what="Salaries" />
      ) : (
        <SalariesClient data={data} month={month} year={year} />
      )}
    </div>
  );
}

