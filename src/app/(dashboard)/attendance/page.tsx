import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { AttendanceClient } from "@/components/attendance/attendance-client";
import { getAttendancePageData } from "./actions";
import { todayPKTString } from "@/lib/pkt";

export const dynamic = "force-dynamic";

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const sp = await searchParams;
  const date =
    sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayPKTString();

  const data = await getAttendancePageData(date);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Attendance"
        description="Mark daily attendance for employees and riders"
      />
      {!data.dbReady ? (
        <DbNotReady what="Attendance" />
      ) : (
        <AttendanceClient initial={data} />
      )}
    </div>
  );
}
