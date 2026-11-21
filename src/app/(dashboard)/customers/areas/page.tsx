import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { AreasClient } from "@/components/customers/areas-client";
import { getAreas, getShiftsData } from "./actions";
import { getSessionUser } from "@/lib/auth";

export const revalidate = 120;

export default async function AreasPage() {
  const [{ areas, dbReady }, { shifts, riders, dbReady: shiftsReady }, user] =
    await Promise.all([getAreas(), getShiftsData(), getSessionUser()]);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Areas / Shifts"
        description="Manage delivery areas, shifts, and rider assignments"
      />
      {!dbReady || !shiftsReady ? (
        <DbNotReady what="Areas / Shifts" />
      ) : (
        <AreasClient
          initialAreas={areas}
          initialShifts={shifts}
          riders={riders}
          canHandOver={user?.role === "ADMIN"}
        />
      )}
    </div>
  );
}
