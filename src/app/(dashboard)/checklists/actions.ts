"use server";

import { requireRole, requireUser, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { DASHBOARD_ROLES, ROLE_LABELS } from "@/lib/access";
import { checklistDayKey, parseHHMM, pktNowMinutes } from "@/lib/checklists";
import { todayPKTString, toDateStrPKT } from "@/lib/pkt";
import { retentionCutoff, isWithinRetention } from "@/lib/checklist-retention";
import {
  isBelowThreshold, penaltyForDay, isExcusedStatus, PENALTY_START_DAY,
} from "@/lib/checklist-penalty";
import { isItemLate } from "@/lib/checklist-time";
import { normalizeNote, noteProblem } from "@/lib/checklist-note";
import { normalizePhone } from "@/lib/whatsapp";

// ── Types ────────────────────────────────────────────────────────────────────

export type ChecklistItemView = {
  id: string;
  label: string;
  done: boolean;
  /** When this item was ticked (ISO). Null while pending. */
  doneAt: string | null;
  /** Who ticked it. Null for rows recorded before the actor was captured. */
  doneBy: string | null;
  /** This task's own "HH:MM" (PKT) target, or null when it has none. */
  dueTime: string | null;
  /**
   * Ticked after its own time, or still pending past it. Shown in red and
   * nothing more — a late task never raises an alert. Only the checklist's own
   * dueTime does that.
   */
  late: boolean;
  /** Today's remark from the assignee, if they left one. */
  note: string | null;
  /** Who wrote it. Null when the author record is gone. */
  noteBy: string | null;
};
export type ChecklistView = {
  id: string;
  title: string;
  roleLabel: string | null;
  dueTime: string;
  assigneeId: string;
  assigneeName: string;
  assigneeRole: string; // ROLE_LABELS value
  items: ChecklistItemView[];
  done: number;
  total: number;
  pct: number;
  overdue: boolean;
  lastAt: string | null;
};
export type ActionResult = { ok: true } | { ok: false; error: string };

// A checklist row + today's completions, shaped for the UI.
const CHECKLIST_INCLUDE = (date: Date) =>
  ({
    assignee: { select: { name: true, role: true } },
    items: {
      orderBy: { order: "asc" as const },
      include: {
        completions: { where: { date }, select: { doneAt: true, doneBy: { select: { name: true } } } },
        // Kept apart from the tick on purpose: unticking a task must not throw
        // away what the person wrote about it.
        notes: { where: { date }, select: { body: true, author: { select: { name: true } } } },
      },
    },
  }) satisfies Prisma.ChecklistInclude;

type ChecklistRow = Prisma.ChecklistGetPayload<{ include: ReturnType<typeof CHECKLIST_INCLUDE> }>;

/** Minutes in a full day — used to judge a day that is already over. */
const END_OF_DAY_MINUTES = 24 * 60;

function toView(c: ChecklistRow, nowMinutesOverride?: number): ChecklistView {
  const nowMins = nowMinutesOverride ?? pktNowMinutes();
  const items: ChecklistItemView[] = c.items.map((it) => {
    const comp = it.completions[0];
    const note = it.notes[0];
    return {
      id: it.id,
      label: it.label,
      done: !!comp,
      doneAt: comp ? comp.doneAt.toISOString() : null,
      doneBy: comp?.doneBy?.name ?? null,
      dueTime: it.dueTime,
      late: isItemLate({ dueTime: it.dueTime, doneAt: comp?.doneAt ?? null, nowMinutes: nowMins }),
      note: note?.body ?? null,
      noteBy: note?.author?.name ?? null,
    };
  });
  const done = items.filter((i) => i.done).length;
  const total = items.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const due = parseHHMM(c.dueTime);
  const overdue = total > 0 && done < total && due !== null && nowMins > due;
  const times = items.map((i) => i.doneAt).filter(Boolean) as string[];
  return {
    id: c.id,
    title: c.title,
    roleLabel: c.roleLabel,
    dueTime: c.dueTime,
    assigneeId: c.assigneeId,
    assigneeName: c.assignee.name,
    assigneeRole: c.roleLabel || ROLE_LABELS[c.assignee.role] || c.assignee.role,
    items,
    done,
    total,
    pct,
    overdue,
    lastAt: times.length ? times.sort()[times.length - 1] : null,
  };
}

// ── Employee (self-fill) ─────────────────────────────────────────────────────

// The signed-in user's OWN checklists for today. Any signed-in dashboard user.
export async function getMyChecklists(): Promise<{ checklists: ChecklistView[]; dbReady: boolean }> {
  const user = await requireUser();
  try {
    const date = checklistDayKey();
    const rows = await db.checklist.findMany({
      where: { assigneeId: user.id, active: true },
      include: CHECKLIST_INCLUDE(date),
      orderBy: { createdAt: "asc" },
    });
    return { checklists: rows.map(toView), dbReady: true };
  } catch (e) {
    console.error("[getMyChecklists]", e);
    return { checklists: [], dbReady: false };
  }
}

// Tick / untick one item for TODAY. ONLY the checklist's own assignee may do this
// — the tick is that person's record, so admins/managers are rejected here too.
//
// Deliberately does NOT revalidate, the same way setAttendance does not.
//
// /checklists is force-dynamic, so there is no cache entry for revalidatePath to
// invalidate — all it did was make the server re-render the whole page and hand
// the router a fresh tree, which the tick then threw away: the client already
// flipped the task optimistically before the call and only shows a spinner on that
// one row. So the person tapping waited on a full page render to see something
// they could already see. Nothing is lost: every page that reads a tick is
// force-dynamic and fetches fresh the next time it is opened.
export async function toggleChecklistItem(
  itemId: string
): Promise<{ ok: true; done: boolean } | { ok: false; error: string }> {
  const date = checklistDayKey();

  // Three things used to happen one after another: the guard's user lookup, the
  // item lookup, then today's completion lookup — and only then the write. On this
  // pooler a round trip is 700-1700ms (see lib/prisma-options), so a tick cost
  // close to three seconds of waiting before it did anything.
  //
  // Now the item arrives WITH today's completion on it, which is one query instead
  // of two, and it is started before the guard rather than after it so the two
  // overlap. The write still happens only once both have come back, and only once
  // the guards below have passed — nothing about who may tick what has changed.
  //
  // Settled rather than awaited, so a read that fails while requireUser is still
  // running cannot surface as an unhandled rejection; the error is re-thrown inside
  // the try, exactly where it used to be handled.
  const itemRead = db.checklistItem
    .findUnique({
      where: { id: itemId },
      select: {
        checklist: { select: { assigneeId: true, active: true } },
        completions: { where: { date }, select: { id: true }, take: 1 },
      },
    })
    .then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

  // Outside the try, as before: an AuthError must reach the caller as a throw, not
  // be flattened into { ok: false }.
  const user = await requireUser();

  try {
    const read = await itemRead;
    if (!read.ok) throw read.e;
    const item = read.v;

    if (!item) return { ok: false, error: "Item not found." };
    if (!item.checklist.active) return { ok: false, error: "This checklist is no longer active." };
    if (item.checklist.assigneeId !== user.id) {
      return { ok: false, error: "This isn't your checklist — only the assigned person can tick it." };
    }

    const existing = item.completions[0];
    if (existing) {
      await db.checklistCompletion.delete({ where: { id: existing.id } }).catch(() => {});
      return { ok: true, done: false };
    }
    // create; if a concurrent tick already inserted it, treat as done (idempotent).
    await db.checklistCompletion.create({ data: { itemId, date, doneById: user.id } }).catch((e) => {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    });
    return { ok: true, done: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update." };
  }
}

// Write / update / clear the note on one item for TODAY. Like the tick, ONLY the
// checklist's own assignee may do this — it is that person's remark, so admins and
// managers are rejected here too; they read it on the roster.
//
// Deliberately independent of the tick: the note is keyed by item + day, so
// unticking a task keeps it, and tomorrow's sheet simply never reads it.
export async function setChecklistNote(
  itemId: string,
  body: string
): Promise<{ ok: true; note: string | null } | { ok: false; error: string }> {
  const user = await requireUser();
  try {
    const problem = noteProblem(body);
    if (problem) return { ok: false, error: problem };

    const item = await db.checklistItem.findUnique({
      where: { id: itemId },
      select: { checklist: { select: { assigneeId: true, active: true } } },
    });
    if (!item) return { ok: false, error: "Item not found." };
    if (!item.checklist.active) return { ok: false, error: "This checklist is no longer active." };
    if (item.checklist.assigneeId !== user.id) {
      return { ok: false, error: "This isn't your checklist — only the assigned person can add a note." };
    }

    const date = checklistDayKey();
    const note = normalizeNote(body);
    if (note === null) {
      await db.checklistNote.deleteMany({ where: { itemId, date } });
      revalidatePath("/checklists");
      return { ok: true, note: null };
    }

    await db.checklistNote.upsert({
      where: { itemId_date: { itemId, date } },
      create: { itemId, date, body: note, authorId: user.id },
      update: { body: note, authorId: user.id },
    });
    revalidatePath("/checklists");
    return { ok: true, note };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save the note." };
  }
}

// ── Admin (read-only oversight + management) ─────────────────────────────────

export async function getChecklistRoster(): Promise<{ checklists: ChecklistView[]; dbReady: boolean }> {
  await requireRole(FULL_ACCESS);
  try {
    const date = checklistDayKey();
    const rows = await db.checklist.findMany({
      where: { active: true },
      include: CHECKLIST_INCLUDE(date),
      orderBy: [{ assignee: { name: "asc" } }, { createdAt: "asc" }],
    });
    return { checklists: rows.map(toView), dbReady: true };
  } catch (e) {
    console.error("[getChecklistRoster]", e);
    return { checklists: [], dbReady: false };
  }
}

export type AssignableUser = { id: string; name: string; role: string; roleLabel: string };

export async function getAssignableUsers(): Promise<AssignableUser[]> {
  await requireRole(FULL_ACCESS);
  try {
    // Dashboard staff (who self-fill here) PLUS riders. Riders can't open the web
    // dashboard, so they tick their checklist in the rider mobile app — see the
    // /api/rider/checklists endpoint. Their completions still show in the admin roster.
    const users = await db.user.findMany({
      where: { active: true, role: { in: [...DASHBOARD_ROLES, "RIDER"] } },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    });
    return users.map((u) => ({ id: u.id, name: u.name, role: u.role, roleLabel: ROLE_LABELS[u.role] ?? u.role }));
  } catch {
    return [];
  }
}

type ChecklistInput = {
  assigneeId: string;
  title: string;
  roleLabel?: string | null;
  dueTime: string;
  items: { id?: string; label: string; dueTime?: string | null }[];
};

function validate(data: ChecklistInput): string | null {
  if (!data.assigneeId) return "Select who this checklist is for.";
  if (!data.title.trim()) return "Enter a checklist title.";
  if (parseHHMM(data.dueTime) === null) return "Enter a valid due time (HH:MM).";
  const items = data.items.filter((i) => i.label.trim());
  if (!items.length) return "Add at least one checklist item.";
  // A per-task time is optional, but a malformed one is rejected rather than
  // stored and silently ignored.
  for (const it of items) {
    const t = (it.dueTime ?? "").trim();
    if (t && parseHHMM(t) === null) return `"${it.label.trim()}": enter a valid time (HH:MM) or leave it blank.`;
  }
  return null;
}

// "" / whitespace / undefined all mean "no time on this task".
const itemDue = (v: string | null | undefined) => ((v ?? "").trim() || null);

export async function createChecklist(data: ChecklistInput): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  const err = validate(data);
  if (err) return { ok: false, error: err };
  try {
    const items = data.items.filter((i) => i.label.trim());
    await db.checklist.create({
      data: {
        title: data.title.trim(),
        roleLabel: data.roleLabel?.trim() || null,
        assigneeId: data.assigneeId,
        dueTime: data.dueTime.trim(),
        items: { create: items.map((it, i) => ({ label: it.label.trim(), order: i, dueTime: itemDue(it.dueTime) })) },
      },
    });
    revalidatePath("/checklists");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to create checklist." };
  }
}

// Update fields and SYNC items: update kept items (by id), create new ones, delete
// removed ones. Unchanged items keep their id, so today's ticks are preserved.
export async function updateChecklist(id: string, data: ChecklistInput): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  const err = validate(data);
  if (err) return { ok: false, error: err };
  try {
    const items = data.items.filter((i) => i.label.trim());
    const existing = await db.checklistItem.findMany({ where: { checklistId: id }, select: { id: true } });
    const keepIds = new Set(items.filter((i) => i.id).map((i) => i.id as string));
    const toDelete = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id);

    // Interactive and on `tx` — the batched array form hangs on this client
    // (see src/lib/db.ts). It also meant a checklist could be rewritten while
    // its items were not, leaving the two out of step.
    await db.$transaction(async (tx) => {
      await tx.checklist.update({
        where: { id },
        data: {
          title: data.title.trim(),
          roleLabel: data.roleLabel?.trim() || null,
          assigneeId: data.assigneeId,
          dueTime: data.dueTime.trim(),
        },
      });
      if (toDelete.length) {
        await tx.checklistItem.deleteMany({ where: { id: { in: toDelete } } });
      }
      for (const [i, it] of items.entries()) {
        if (it.id) {
          await tx.checklistItem.update({
            where: { id: it.id },
            data: { label: it.label.trim(), order: i, dueTime: itemDue(it.dueTime) },
          });
        } else {
          await tx.checklistItem.create({
            data: { checklistId: id, label: it.label.trim(), order: i, dueTime: itemDue(it.dueTime) },
          });
        }
      }
    });
    revalidatePath("/checklists");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update checklist." };
  }
}

export async function deleteChecklist(id: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.checklist.delete({ where: { id } }); // cascades items -> completions
    revalidatePath("/checklists");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete." };
  }
}

// Manual WhatsApp nudge to the assignee — no cron; the existing worker delivers it.
export async function sendChecklistReminder(checklistId: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    const c = await db.checklist.findUnique({
      where: { id: checklistId },
      select: { title: true, dueTime: true, assignee: { select: { name: true, phone: true } } },
    });
    if (!c) return { ok: false, error: "Checklist not found." };
    const phone = normalizePhone(c.assignee.phone ?? "");
    if (!phone) return { ok: false, error: `No phone number on file for ${c.assignee.name}.` };
    const body = `Reminder: please complete your "${c.title}" checklist (due ${c.dueTime}). — Banoori Dairy`;
    await db.whatsappMessageLog.create({ data: { phone, body, status: "PENDING" } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to queue reminder." };
  }
}

// ── History ──────────────────────────────────────────────────────────────────
//
// Every tick and remark has always been stored per PKT day, with who did it —
// there was simply no way to look at any day but today. These read a past day
// and list which days have anything on them, and they prune whatever has fallen
// out of the retention window on the way past.

export type ChecklistHistoryDay = {
  /** "YYYY-MM-DD" (PKT). */
  date: string;
  done: number;
  total: number;
  notes: number;
};

export type ChecklistHistoryData = {
  date: string;
  checklists: ChecklistView[];
  /** Days in the window that have anything recorded, for the calendar. */
  days: ChecklistHistoryDay[];
  oldestKept: string;
  today: string;
  dbReady: boolean;
};

// ── Checklist compliance penalties ────────────────────────────────────────────

/**
 * Scores the days that have closed and writes a penalty row for anyone who did
 * under 70% of their checklist.
 *
 * Reconcile-on-read and throttled, like reconcileAutoDeactivations() and
 * pruneChecklistHistory() — no cron to forget. Three things it has to get right
 * that those two do not have to worry about:
 *
 *  1. ONLY CLOSED DAYS. Scoring today would fine someone at 9am for a list due at
 *     6pm.
 *  2. IT MUST RUN BEFORE THE PRUNER. pruneChecklistHistory deletes completions
 *     older than 60 days and is itself called from getChecklistHistory — so if the
 *     prune went first, a day could be deleted before it was ever scored, and it
 *     would then look like 0% for ever. Hence the call order in every caller, and
 *     hence penalties being stored rather than derived.
 *  3. A PERSISTED WATERMARK, not a module-level `let`. That resets on every deploy
 *     and is per-process, so it would re-scan from scratch or skip days depending
 *     on which instance served the request. The watermark is the newest penalty row
 *     plus a bounded look-back.
 */
let lastPenaltyRun = 0;
const PENALTY_THROTTLE_MS = 30 * 60 * 1000;

/** Never look back further than the completions we still have — nor before the day
 *  the rule came into force. */
function scoringWindow(today: string, fromDay: string): string[] {
  const retention = retentionCutoff(today);
  const oldest = retention > fromDay ? retention : fromDay;
  const days: string[] = [];
  const d = new Date(`${oldest}T12:00:00.000Z`);
  const end = new Date(`${today}T12:00:00.000Z`);
  while (d < end) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days; // today itself is excluded — it has not closed
}

export async function reconcileChecklistPenalties(
  force = false,
  /** Override the day the rule starts from. Passing an earlier day back-dates it,
   *  which is the supported way to apply the rule to weeks already gone. */
  fromDay: string = PENALTY_START_DAY
): Promise<number> {
  const now = Date.now();
  if (!force && now - lastPenaltyRun < PENALTY_THROTTLE_MS) return 0;
  lastPenaltyRun = now;

  try {
    const today = todayPKTString();
    const days = scoringWindow(today, fromDay);
    if (!days.length) return 0;

    const [checklists, users] = await Promise.all([
      db.checklist.findMany({
        where: { active: true },
        // createdAt: a checklist cannot be failed on a day it did not exist.
        select: { id: true, assigneeId: true, createdAt: true, items: { select: { id: true } } },
      }),
      // joinedAt / leftAt: nobody may be fined for a day they did not work here.
      db.user.findMany({
        select: { id: true, employee: { select: { id: true, joinedAt: true, leftAt: true } } },
      }),
    ]);
    if (!checklists.length) return 0;

    const employeeOf = new Map(users.map((u) => [u.id, u.employee ?? null]));

    // Every item, grouped by the person who owns it, each carrying the day its
    // checklist came into being. The 70% is measured across ALL of someone's
    // checklists together, so two lists are one score — but only the lists that
    // existed on the day being scored.
    const itemsByUser = new Map<string, { id: string; since: string }[]>();
    for (const c of checklists) {
      if (!c.assigneeId) continue;
      const since = toDateStrPKT(c.createdAt);
      const cur = itemsByUser.get(c.assigneeId) ?? [];
      cur.push(...c.items.map((i) => ({ id: i.id, since })));
      itemsByUser.set(c.assigneeId, cur);
    }
    if (!itemsByUser.size) return 0;

    const from = checklistDayKey(days[0]);
    const to = checklistDayKey(days[days.length - 1]);
    const allItemIds = [...itemsByUser.values()].flat().map((i) => i.id);

    const [completions, attendance, existing] = await Promise.all([
      db.checklistCompletion.findMany({
        where: { itemId: { in: allItemIds }, date: { gte: from, lte: to } },
        select: { itemId: true, date: true },
      }),
      db.attendance.findMany({
        where: { date: { gte: from, lte: to } },
        select: { employeeId: true, date: true, status: true },
      }),
      db.checklistPenalty.findMany({
        where: { date: { gte: from, lte: to } },
        select: { userId: true, date: true },
      }),
    ]);

    const dayOf = (d: Date) => d.toISOString().slice(0, 10);
    const doneKey = (itemId: string, d: Date) => `${itemId}|${dayOf(d)}`;
    const doneSet = new Set(completions.map((c) => doneKey(c.itemId, c.date)));
    const attKey = (employeeId: string, day: string) => `${employeeId}|${day}`;
    const attMap = new Map(attendance.map((a) => [attKey(a.employeeId, dayOf(a.date)), a.status as string]));
    const already = new Set(existing.map((e) => `${e.userId}|${dayOf(e.date)}`));

    const rows: {
      userId: string; employeeId: string | null; date: Date;
      itemsTotal: number; itemsDone: number; amount: Prisma.Decimal;
    }[] = [];

    for (const day of days) {
      for (const [userId, items] of itemsByUser) {
        if (already.has(`${userId}|${day}`)) continue; // scored on an earlier run

        const emp = employeeOf.get(userId) ?? null;

        // No staff record, no fine. A penalty exists to come off a wage; one with
        // no employee attached can never reach payroll, so it is 93 rows of noise
        // on production and nothing else. Skipping rather than writing it also
        // means that once the login IS linked to a staff member, the window below
        // decides which days count — instead of the link silently back-dating a
        // fine to every day since the rule began.
        if (!emp) continue;

        // Nobody is fined for a day they did not work here. This is why Nouman
        // Ayaz, who joined on 4 October, carried 21 penalties dated 6 September to
        // 3 October: the checklist now assigned to him was created in August, and
        // every day since the rule began was scored against whoever holds the list
        // today. Reassigning a checklist handed the new person the old person's
        // history. 76 rows and PKR 22,800 went that way, in both directions —
        // Yaseen was still being fined a week after he left.
        const joined = toDateStrPKT(emp.joinedAt);
        if (day < joined) continue;
        if (emp.leftAt && day > toDateStrPKT(emp.leftAt)) continue;

        // Attendance excuses the day. A MISSING row does not: attendance is filled
        // in patchily, and waiting for it would make this rule do nothing at all.
        if (isExcusedStatus(attMap.get(attKey(emp.id, day)))) continue;

        // Only the checklists that existed on this day — otherwise adding a list
        // today would fail someone for every day before it was written.
        const live = items.filter((i) => i.since <= day);
        const total = live.length;
        if (total === 0) continue; // nothing to fall short of
        const dayKey = checklistDayKey(day);
        const done = live.filter((i) => doneSet.has(doneKey(i.id, dayKey))).length;
        if (!isBelowThreshold(done, total)) continue;

        rows.push({
          userId,
          employeeId: emp.id,
          date: dayKey,
          itemsTotal: total,
          itemsDone: done,
          amount: new Prisma.Decimal(penaltyForDay(done, total)),
        });
      }
    }

    if (!rows.length) return 0;
    // skipDuplicates, not an upsert: a day already scored keeps the score it was
    // given, even if the checklist has been edited since.
    const written = await db.checklistPenalty.createMany({ data: rows, skipDuplicates: true });
    if (written.count) {
      revalidatePath("/payments/salaries");
      revalidatePath("/checklists");
    }
    return written.count;
  } catch (e) {
    console.error("[reconcileChecklistPenalties]", e);
    return 0;
  }
}

/** Lifts a penalty without deleting the record of why it was raised. */
export async function waiveChecklistPenalty(id: string, reason: string): Promise<ActionResult> {
  const user = await requireRole(FULL_ACCESS);
  if (!reason.trim()) return { ok: false, error: "Give a reason for waiving it." };
  try {
    await db.checklistPenalty.update({
      where: { id },
      data: { waivedAt: new Date(), waivedById: user.id, waiveReason: reason.trim() },
    });
    revalidatePath("/payments/salaries");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to waive it." };
  }
}

/** Puts a waived penalty back. */
export async function unwaiveChecklistPenalty(id: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.checklistPenalty.update({
      where: { id },
      data: { waivedAt: null, waivedById: null, waiveReason: null },
    });
    revalidatePath("/payments/salaries");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to restore it." };
  }
}

// Deleting on read, throttled, mirrors reconcileAutoDeactivations(): no cron to
// forget, and the work is a single indexed DELETE that is almost always a no-op.
let lastPruneRun = 0;
const PRUNE_THROTTLE_MS = 60 * 60 * 1000;

export async function pruneChecklistHistory(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastPruneRun < PRUNE_THROTTLE_MS) return 0;
  lastPruneRun = now;
  try {
    const cutoff = checklistDayKey(retentionCutoff(todayPKTString()));
    const [completions, notes] = await Promise.all([
      db.checklistCompletion.deleteMany({ where: { date: { lt: cutoff } } }),
      db.checklistNote.deleteMany({ where: { date: { lt: cutoff } } }),
    ]);
    return completions.count + notes.count;
  } catch {
    return 0;
  }
}

/**
 * One past day, shaped exactly like today's view.
 *
 * A manager sees everyone; anyone else sees only their own, the same split the
 * live screens use. Days outside the window return nothing rather than an error:
 * the data is genuinely gone, and saying so is the honest answer.
 */
export async function getChecklistHistory(dateStr: string): Promise<ChecklistHistoryData> {
  const user = await requireUser();
  const today = todayPKTString();
  const oldestKept = retentionCutoff(today);
  const empty: ChecklistHistoryData = {
    date: dateStr, checklists: [], days: [], oldestKept, today, dbReady: false,
  };
  try {
    // Score first, prune second — the prune deletes the very completions the
    // scoring reads, so the other order loses days.
    await reconcileChecklistPenalties();
    await pruneChecklistHistory();
    const isManager = FULL_ACCESS.includes(user.role);
    const mine = isManager ? {} : { assigneeId: user.id };

    if (!isWithinRetention(dateStr, today) || dateStr > today) {
      return { ...empty, dbReady: true, days: await historyDays(user.id, isManager) };
    }

    const date = checklistDayKey(dateStr);
    const rows = await db.checklist.findMany({
      where: { ...mine },
      orderBy: [{ dueTime: "asc" }, { title: "asc" }],
      include: CHECKLIST_INCLUDE(date),
    });

    // A finished day is judged against its end, not against the clock right now —
    // otherwise every past day would read as "still pending".
    const closed = dateStr < today;
    return {
      date: dateStr,
      checklists: rows.map((c) => toView(c, closed ? END_OF_DAY_MINUTES : undefined)),
      days: await historyDays(user.id, isManager),
      oldestKept,
      today,
      dbReady: true,
    };
  } catch {
    return empty;
  }
}

/** Which days in the window have anything on them, for the calendar markers. */
async function historyDays(userId: string, isManager: boolean): Promise<ChecklistHistoryDay[]> {
  const cutoff = checklistDayKey(retentionCutoff(todayPKTString()));
  const scope = isManager ? {} : { item: { checklist: { assigneeId: userId } } };
  const [comps, notes, totals] = await Promise.all([
    db.checklistCompletion.groupBy({
      by: ["date"],
      where: { date: { gte: cutoff }, ...scope },
      _count: { _all: true },
    }),
    db.checklistNote.groupBy({
      by: ["date"],
      where: { date: { gte: cutoff }, ...scope },
      _count: { _all: true },
    }),
    db.checklistItem.count({
      where: isManager ? {} : { checklist: { assigneeId: userId } },
    }),
  ]);
  const byDay = new Map<string, ChecklistHistoryDay>();
  for (const c of comps) {
    const key = toDateStrPKT(c.date);
    byDay.set(key, { date: key, done: c._count._all, total: totals, notes: 0 });
  }
  for (const n of notes) {
    const key = toDateStrPKT(n.date);
    const row = byDay.get(key) ?? { date: key, done: 0, total: totals, notes: 0 };
    row.notes = n._count._all;
    byDay.set(key, row);
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}
