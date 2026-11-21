import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { UsersClient } from "@/components/users/users-client";
import { getUsersPageData } from "./actions";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const data = await getUsersPageData();

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Users"
        description="Software accounts and what each person can access"
      />
      {!data.dbReady ? (
        <DbNotReady what="Users" />
      ) : (
        <UsersClient data={data} />
      )}
    </div>
  );
}
