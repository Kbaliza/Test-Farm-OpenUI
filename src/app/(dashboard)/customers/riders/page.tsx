import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { RidersClient } from "@/components/customers/riders-client";
import { getRiders } from "./actions";

export const revalidate = 120;

export default async function RidersPage() {
  const { riders, dbReady } = await getRiders();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Riders"
        description="Manage delivery riders, assign shifts, and track contacts"
      />
      {!dbReady ? (
        <DbNotReady what="Riders" />
      ) : (
        <RidersClient initialRiders={riders} />
      )}
    </div>
  );
}
