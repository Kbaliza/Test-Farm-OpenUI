import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { db } from "@/lib/db";
import { checklistDayKey, parseHHMM, pktNowMinutes } from "@/lib/checklists";
import { isItemLate } from "@/lib/checklist-time";
import { normalizeNote, noteProblem } from "@/lib/checklist-note";

// Rider checklist API for the MOBILE app (riders can't open the web dashboard).
//
// Auth: the rider's Supabase access token in `Authorization: Bearer <token>` — the
// same login the rider app already uses. We verify it with the service-role client
// and resolve the DB User (must be an active RIDER). proxy.ts excludes /api/, so this
// handler is responsible for its own auth.
//
//   GET  /api/rider/checklists            -> this rider's active checklists for today
//   POST /api/rider/checklists  { itemId, done }  -> tick/untick one item for today
//
// Completions are keyed by the canonical PKT day (checklistDayKey), so a new PKT day
// starts fresh with zero rows — identical to how the web self-fill works.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authRider(request: Request): Promise<{ userId: string } | { error: string; status: number }> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return { error: "Missing bearer token.", status: 401 };

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return { error: "Invalid or expired token.", status: 401 };

  const user = await db.user.findUnique({
    where: { supabaseId: data.user.id },
    select: { id: true, role: true, active: true },
  });
  if (!user || !user.active) return { error: "No active account.", status: 401 };
  if (user.role !== "RIDER") return { error: "Not a rider account.", status: 403 };
  return { userId: user.id };
}

export async function GET(request: Request) {
  try {
    const auth = await authRider(request);
    if ("error" in auth) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

    const date = checklistDayKey();
    const rows = await db.checklist.findMany({
      where: { assigneeId: auth.userId, active: true },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        title: true,
        dueTime: true,
        items: {
          orderBy: { order: "asc" },
          select: {
            id: true,
            label: true,
            dueTime: true,
            completions: { where: { date }, select: { doneAt: true } },
            notes: { where: { date }, select: { body: true } },
          },
        },
      },
    });

    const nowMins = pktNowMinutes();
    const checklists = rows.map((c) => {
      const items = c.items.map((it) => ({
        id: it.id,
        label: it.label,
        done: it.completions.length > 0,
        doneAt: it.completions[0] ? it.completions[0].doneAt.toISOString() : null,
        // Today's optional remark from the rider, kept separately from the tick so
        // unticking does not throw it away.
        note: it.notes[0]?.body ?? null,
        // Per-task target and whether it was missed. Additive and advisory — the
        // app may colour it red, but nothing here raises an alert.
        dueTime: it.dueTime,
        late: isItemLate({
          dueTime: it.dueTime,
          doneAt: it.completions[0]?.doneAt ?? null,
          nowMinutes: nowMins,
        }),
      }));
      const done = items.filter((i) => i.done).length;
      const due = parseHHMM(c.dueTime);
      return {
        id: c.id,
        title: c.title,
        dueTime: c.dueTime,
        done,
        total: items.length,
        overdue: items.length > 0 && done < items.length && due !== null && nowMins > due,
        items,
      };
    });

    return NextResponse.json({ ok: true, checklists });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Failed to load checklists." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authRider(request);
    if ("error" in auth) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

    const body = (await request.json().catch(() => null)) as
      | { itemId?: string; done?: boolean; note?: string | null }
      | null;
    const itemId = body?.itemId;
    const done = body?.done;
    if (!itemId || typeof done !== "boolean") {
      return NextResponse.json({ ok: false, error: "Provide { itemId, done }." }, { status: 400 });
    }

    // The item must belong to an ACTIVE checklist assigned to THIS rider.
    const item = await db.checklistItem.findUnique({
      where: { id: itemId },
      select: { checklist: { select: { assigneeId: true, active: true } } },
    });
    if (!item) return NextResponse.json({ ok: false, error: "Item not found." }, { status: 404 });
    if (!item.checklist.active) return NextResponse.json({ ok: false, error: "This checklist is no longer active." }, { status: 409 });
    if (item.checklist.assigneeId !== auth.userId) {
      return NextResponse.json({ ok: false, error: "This isn't your checklist." }, { status: 403 });
    }

    const date = checklistDayKey();
    if (done) {
      // Idempotent: a repeat tick (double-tap / retry) is a no-op, not a duplicate.
      await db.checklistCompletion.create({ data: { itemId, date, doneById: auth.userId } }).catch((e) => {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      });
    } else {
      await db.checklistCompletion.deleteMany({ where: { itemId, date } });
    }

    // The note is optional and independent of the tick: send it to set or update
    // it, send an empty string to clear it, omit the field to leave it alone.
    let note: string | null | undefined;
    if (body && "note" in body) {
      const problem = noteProblem(body.note);
      if (problem) return NextResponse.json({ ok: false, error: problem }, { status: 400 });
      note = normalizeNote(body.note);
      if (note === null) {
        await db.checklistNote.deleteMany({ where: { itemId, date } });
      } else {
        await db.checklistNote.upsert({
          where: { itemId_date: { itemId, date } },
          create: { itemId, date, body: note, authorId: auth.userId },
          update: { body: note, authorId: auth.userId },
        });
      }
    }

    return NextResponse.json({ ok: true, done, ...(note !== undefined ? { note } : {}) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Failed to update." }, { status: 500 });
  }
}
