import { getDashboardUser, FULL_ACCESS } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { getChecklistRoster, getMyChecklists, getAssignableUsers, getChecklistHistory } from "./actions";
import { ChecklistHistory } from "@/components/checklists/checklist-history";
import { todayPKTString } from "@/lib/pkt";
import { ChecklistsAdmin } from "@/components/checklists/checklists-admin";
import { ChecklistsEmployee } from "@/components/checklists/checklists-employee";

export const dynamic = "force-dynamic";

export default async function ChecklistsPage() {
  const user = await getDashboardUser();
  if (!user) return null; // the layout already redirects; belt-and-braces

  const isManager = FULL_ACCESS.includes(user.role);

  if (isManager) {
    const roster = await getChecklistRoster();
    if (!roster.dbReady) {
      return (
        <>
          <PageHeader title="Daily Checklists" description="Assign daily checklists and track completion." />
          <DbNotReady what="Checklists" />
        </>
      );
    }
    const [assignees, mine, history] = await Promise.all([
      getAssignableUsers(),
      getMyChecklists(),
      getChecklistHistory(todayPKTString()),
    ]);
    return (
      <>
        <PageHeader title="Daily Checklists" description="Assign daily checklists and track completion (read-only — each person ticks their own)." />
        <div className="space-y-6 p-4 sm:p-6">
          {mine.checklists.length > 0 && (
            <section>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">My checklist</h2>
              <ChecklistsEmployee checklists={mine.checklists} compact />
            </section>
          )}
          <ChecklistsAdmin checklists={roster.checklists} assignees={assignees} />

          <section>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              History
            </h2>
            <ChecklistHistory initial={history} />
          </section>
        </div>
      </>
    );
  }

  // Limited-role staff: only their own sheet, self-fill.
  const [mine, myHistory] = await Promise.all([
    getMyChecklists(),
    getChecklistHistory(todayPKTString()),
  ]);
  if (!mine.dbReady) {
    return (
      <>
        <PageHeader title="My Checklist" />
        <DbNotReady what="Checklists" />
      </>
    );
  }
  return (
    <>
      <PageHeader title="My Checklist" description="Tick each task as you complete it today." />
      <div className="space-y-6 p-4 sm:p-6">
        <ChecklistsEmployee checklists={mine.checklists} />
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            History
          </h2>
          <ChecklistHistory initial={myHistory} />
        </section>
      </div>
    </>
  );
}
