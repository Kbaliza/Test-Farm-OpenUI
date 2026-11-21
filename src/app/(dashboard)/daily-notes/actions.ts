"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { todayRangePKT, dateStrRangePKT } from "@/lib/pkt";

export type FollowupEntry = {
  id: string;
  body: string;
  createdAt: string;
};

export type NoteEntry = {
  id: string;
  date: string;
  type: string;
  priority: string;
  status: string;
  title: string;
  authorName: string;
  customerId: string | null;
  customerName: string | null;
  followups: FollowupEntry[];
};

export type CustomerOption = { id: string; name: string; code: string };

export type NotesResult = { notes: NoteEntry[]; dbReady: boolean };
export type NoteResult = { ok: true } | { ok: false; error: string };

function mapNote(n: Record<string, unknown> & {
  id: string;
  date: Date;
  type: string;
  priority: string;
  status: string;
  title: string;
  customerId: string | null;
  customer: { name: string } | null;
  followups: { id: string; body: string; createdAt: Date }[];
}): NoteEntry {
  return {
    id: n.id,
    date: n.date.toISOString(),
    type: n.type,
    priority: n.priority,
    status: n.status,
    title: n.title,
    authorName: (n.authorName as string | null) ?? "Admin",
    customerId: n.customerId,
    customerName: n.customer?.name ?? null,
    followups: n.followups.map((f) => ({
      id: f.id,
      body: f.body,
      createdAt: f.createdAt.toISOString(),
    })),
  };
}

export async function getDailyNotes(date?: string): Promise<NotesResult> {
  await requireRole(FULL_ACCESS);
  try {
    const range = date ? dateStrRangePKT(date) : todayRangePKT();
    const notes = await db.dailyNote.findMany({
      where: { date: range },
      include: {
        followups: { orderBy: { createdAt: "asc" } },
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return { notes: notes.map(mapNote), dbReady: true };
  } catch {
    return { notes: [], dbReady: false };
  }
}

// Lightweight active-customer list for the searchable picker in the note form.
export async function getNoteCustomers(): Promise<CustomerOption[]> {
  await requireRole(FULL_ACCESS);
  try {
    const customers = await db.customer.findMany({
      where: { status: { not: "DISABLED" } },
      select: { id: true, name: true, customerCode: true },
      orderBy: { name: "asc" },
    });
    return customers.map((c) => ({ id: c.id, name: c.name, code: c.customerCode }));
  } catch {
    return [];
  }
}

export async function createNote(data: {
  title: string;
  type: string;
  status: string;
  priority: string;
  authorName: string;
  customerId?: string | null;
}): Promise<NoteResult> {
  await requireRole(FULL_ACCESS);
  if (!data.title.trim()) return { ok: false, error: "Note text is required." };
  try {
    const note = await db.dailyNote.create({
      data: {
        title: data.title.trim(),
        type: data.type as never,
        status: data.status as never,
        priority: data.priority as never,
        customerId: data.customerId || null,
      },
    });
    // Set authorName via raw SQL — Prisma client may not have the field yet
    await db.$executeRaw`UPDATE "DailyNote" SET "authorName" = ${data.authorName.trim() || "Admin"} WHERE "id" = ${note.id}`;
    revalidatePath("/daily-notes");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save." };
  }
}

export async function updateNoteStatus(id: string, status: string): Promise<NoteResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.dailyNote.update({ where: { id }, data: { status: status as never } });
    revalidatePath("/daily-notes");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update." };
  }
}

export async function deleteNote(id: string): Promise<NoteResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.dailyNote.delete({ where: { id } });
    revalidatePath("/daily-notes");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete." };
  }
}

export async function addFollowup(noteId: string, body: string): Promise<NoteResult> {
  await requireRole(FULL_ACCESS);
  if (!body.trim()) return { ok: false, error: "Follow-up text is required." };
  try {
    await db.noteFollowup.create({ data: { noteId, body: body.trim() } });
    revalidatePath("/daily-notes");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to add follow-up." };
  }
}
