import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { StaffClient } from "@/components/staff/staff-client";
import { getStaffPageData } from "./actions";

export const dynamic = "force-dynamic";

export default async function StaffPage() {
  const data = await getStaffPageData();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Staff"
        description="Everyone who works at the farm — add, edit, disable or delete staff here"
      />
      {!data.dbReady ? <DbNotReady what="Staff" /> : <StaffClient data={data} />}
    </div>
  );
}
