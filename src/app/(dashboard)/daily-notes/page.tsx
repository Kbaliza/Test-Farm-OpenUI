import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { DailyNotesClient } from "@/components/daily-notes/daily-notes-client";
import { getDailyNotes, getNoteCustomers } from "./actions";

export const dynamic = "force-dynamic";

export default async function DailyNotesPage() {
  const { notes, dbReady } = await getDailyNotes();
  const customers = dbReady ? await getNoteCustomers() : [];

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Daily Notes"
        description="Order changes, tasks, complaints, requests and follow-ups"
      />
      {!dbReady ? (
        <DbNotReady what="Daily Notes" />
      ) : (
        <DailyNotesClient initialNotes={notes} customers={customers} />
      )}
    </div>
  );
}
