"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

export type TaskFollowupEntry = {
  id: string;
  body: string;
  createdAt: string;
};

export type TaskEntry = {
  id: string;
  title: string;
  note: string | null;
  assigneeId: string | null;
  assigneeName: string;
  deadline: string;       // ISO
  priority: string;       // NORMAL | HIGH | EXTREME
  status: string;         // PENDING | IN_PROGRESS | COMPLETED
  authorName: string;
  completedAt: string | null;
  createdAt: string;
  isOverdue: boolean;     // deadline passed and not completed (computed server-side)
  followups: TaskFollowupEntry[];
};

export type AssigneeOption = { id: string; name: string; role: string };

export type TasksResult = { tasks: TaskEntry[]; dbReady: boolean };
export type TaskResult = { ok: true } | { ok: false; error: string };

function mapTask(t: {
  id: string;
  title: string;
  note: string | null;
  assigneeId: string | null;
  assigneeName: string;
  deadline: Date;
  priority: string;
  status: string;
  authorName: string | null;
  completedAt: Date | null;
  createdAt: Date;
  followups: { id: string; body: string; createdAt: Date }[];
}, now: number): TaskEntry {
  return {
    id: t.id,
    title: t.title,
    note: t.note,
    assigneeId: t.assigneeId,
    assigneeName: t.assigneeName,
    deadline: t.deadline.toISOString(),
    priority: t.priority,
    status: t.status,
    authorName: t.authorName ?? "Admin",
    completedAt: t.completedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    isOverdue: t.status !== "COMPLETED" && t.deadline.getTime() < now,
    followups: t.followups.map((f) => ({
      id: f.id,
      body: f.body,
      createdAt: f.createdAt.toISOString(),
    })),
  };
}

export async function getTasks(): Promise<TasksResult> {
  await requireRole(FULL_ACCESS);
  try {
    const tasks = await db.task.findMany({
      include: { followups: { orderBy: { createdAt: "asc" } } },
      // Open tasks first (by soonest deadline), completed ones sink to the bottom.
      orderBy: [{ status: "asc" }, { deadline: "asc" }],
    });
    const now = Date.now();
    return { tasks: tasks.map((t) => mapTask(t, now)), dbReady: true };
  } catch {
    return { tasks: [], dbReady: false };
  }
}

// Assignable people = active employees + active riders (deduped by name).
export async function getAssignees(): Promise<AssigneeOption[]> {
  await requireRole(FULL_ACCESS);
  try {
    const [employees, riders] = await Promise.all([
      db.employee.findMany({
        where: { active: true },
        select: { id: true, name: true, role: true },
        orderBy: { name: "asc" },
      }),
      db.rider.findMany({
        where: { active: true },
        include: { user: { select: { name: true } } },
        orderBy: { user: { name: "asc" } },
      }),
    ]);

    const seen = new Set<string>();
    const out: AssigneeOption[] = [];
    for (const e of employees) {
      const key = e.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: e.id, name: e.name, role: e.role ?? "" });
    }
    for (const r of riders) {
      const name = r.user?.name ?? "";
      if (!name) continue;
      const key = name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: r.id, name, role: "Rider" });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function createTask(data: {
  title: string;
  note?: string;
  assigneeId?: string | null;
  assigneeName: string;
  deadline: string;        // ISO or datetime-local string
  priority: string;
  authorName: string;
}): Promise<TaskResult> {
  await requireRole(FULL_ACCESS);
  if (!data.title.trim()) return { ok: false, error: "Task description is required." };
  if (!data.assigneeName.trim()) return { ok: false, error: "Select who this is assigned to." };
  if (!data.deadline) return { ok: false, error: "Set a deadline." };

  const deadline = new Date(data.deadline);
  if (isNaN(deadline.getTime())) return { ok: false, error: "Invalid deadline." };

  try {
    await db.task.create({
      data: {
        title: data.title.trim(),
        note: data.note?.trim() || null,
        assigneeId: data.assigneeId || null,
        assigneeName: data.assigneeName.trim(),
        deadline,
        priority: data.priority as never,
        authorName: data.authorName.trim() || "Admin",
      },
    });
    revalidatePath("/tasks");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save task." };
  }
}

export async function updateTaskStatus(id: string, status: string): Promise<TaskResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.task.update({
      where: { id },
      data: {
        status: status as never,
        completedAt: status === "COMPLETED" ? new Date() : null,
      },
    });
    revalidatePath("/tasks");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update task." };
  }
}

export async function deleteTask(id: string): Promise<TaskResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.task.delete({ where: { id } });
    revalidatePath("/tasks");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete task." };
  }
}

export async function addTaskFollowup(taskId: string, body: string): Promise<TaskResult> {
  await requireRole(FULL_ACCESS);
  if (!body.trim()) return { ok: false, error: "Follow-up text is required." };
  try {
    await db.taskFollowup.create({ data: { taskId, body: body.trim() } });
    revalidatePath("/tasks");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to add follow-up." };
  }
}

// Count of open tasks whose deadline has passed — drives the topbar bell badge.
export async function getOverdueTaskCount(): Promise<{ overdue: number; dueToday: number }> {
  await requireRole(FULL_ACCESS);
  try {
    const now = new Date();
    const endOfToday = new Date(now.getTime() + 5 * 60 * 60 * 1000); // PKT day edge approx
    endOfToday.setUTCHours(23, 59, 59, 999);

    const [overdue, dueToday] = await Promise.all([
      db.task.count({
        where: { status: { not: "COMPLETED" }, deadline: { lt: now } },
      }),
      db.task.count({
        where: { status: { not: "COMPLETED" }, deadline: { gte: now, lte: endOfToday } },
      }),
    ]);
    return { overdue, dueToday };
  } catch {
    return { overdue: 0, dueToday: 0 };
  }
}
