import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { TasksClient } from "@/components/tasks/tasks-client";
import { getTasks, getAssignees } from "./actions";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const { tasks, dbReady } = await getTasks();
  const assignees = dbReady ? await getAssignees() : [];

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Task Management"
        description="Assign work to employees and riders, set deadlines, and track progress"
      />
      {!dbReady ? (
        <DbNotReady what="Task Management" />
      ) : (
        <TasksClient initialTasks={tasks} assignees={assignees} />
      )}
    </div>
  );
}
