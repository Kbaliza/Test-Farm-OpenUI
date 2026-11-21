import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, resetTestRole } from "../setup";
import { uniq } from "../helpers";
import { getChecklistHistory, pruneChecklistHistory } from "@/app/(dashboard)/checklists/actions";
import { checklistDayKey } from "@/lib/checklists";
import { retentionCutoff } from "@/lib/checklist-retention";
import { todayPKTString } from "@/lib/pkt";
import { requireUser } from "@/lib/auth";

afterEach(() => resetTestRole());

/** A checklist with one item, owned by the signed-in test user. */
async function makeChecklist() {
  // The same user the actions will see, so the checklist is genuinely "mine".
  const me = await requireUser();
  const list = await db.checklist.create({
    data: { title: uniq("list"), assigneeId: me.id, dueTime: "10:00" },
  });
  cleanups.push(async () => { await db.checklist.delete({ where: { id: list.id } }).catch(() => {}); });
  const item = await db.checklistItem.create({
    data: { checklistId: list.id, label: uniq("task"), order: 0 },
  });
  return { list, item, me };
}

/** Shift a "YYYY-MM-DD" by a number of days. */
function shiftDay(dayStr: string, by: number): string {
  const [y, m, d] = dayStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + by);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

describe("looking back at a past day", () => {
  it("shows who ticked what, when, and what they wrote", async () => {
    const { item, me } = await makeChecklist();
    const day = shiftDay(todayPKTString(), -5);

    await db.checklistCompletion.create({
      data: { itemId: item.id, date: checklistDayKey(day), doneById: me.id },
    });
    await db.checklistNote.create({
      data: { itemId: item.id, date: checklistDayKey(day), body: "chiller was slow", authorId: me.id },
    });

    const past = await getChecklistHistory(day);
    expect(past.dbReady).toBe(true);
    expect(past.date).toBe(day);

    const row = past.checklists.flatMap((c) => c.items).find((i) => i.id === item.id);
    expect(row).toBeTruthy();
    expect(row!.done).toBe(true);
    expect(row!.doneBy).toBe(me.name);
    expect(row!.doneAt).toBeTruthy();
    expect(row!.note).toBe("chiller was slow");
    expect(row!.noteBy).toBe(me.name);
  }, 180000);

  it("today's own view is unchanged by the history read", async () => {
    const { item } = await makeChecklist();
    const today = await getChecklistHistory(todayPKTString());
    const row = today.checklists.flatMap((c) => c.items).find((i) => i.id === item.id);
    expect(row?.done).toBe(false);
    expect(row?.note).toBeNull();
  }, 180000);

  it("lists the days that have something on them, for the calendar", async () => {
    const { item, me } = await makeChecklist();
    const day = shiftDay(todayPKTString(), -3);
    await db.checklistCompletion.create({
      data: { itemId: item.id, date: checklistDayKey(day), doneById: me.id },
    });

    const data = await getChecklistHistory(todayPKTString());
    expect(data.days.some((d) => d.date === day)).toBe(true);
    // Newest first.
    const dates = data.days.map((d) => d.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  }, 180000);

  it("an unfinished past day reads as not done rather than still pending", async () => {
    const { item } = await makeChecklist();
    const day = shiftDay(todayPKTString(), -2);
    // Nothing ticked at all on that day.
    const past = await getChecklistHistory(day);
    const row = past.checklists.flatMap((c) => c.items).find((i) => i.id === item.id);
    expect(row?.done).toBe(false);
  }, 180000);
});

describe("history older than the window is deleted", () => {
  it("prunes past the cutoff and keeps everything inside it", async () => {
    const { item, me } = await makeChecklist();
    const today = todayPKTString();
    const cutoff = retentionCutoff(today);
    const tooOld = shiftDay(cutoff, -1);
    const oldestKept = cutoff;

    await db.checklistCompletion.createMany({
      data: [
        { itemId: item.id, date: checklistDayKey(tooOld), doneById: me.id },
        { itemId: item.id, date: checklistDayKey(oldestKept), doneById: me.id },
      ],
    });
    await db.checklistNote.create({
      data: { itemId: item.id, date: checklistDayKey(tooOld), body: "ancient", authorId: me.id },
    });

    await pruneChecklistHistory(true);

    expect(await db.checklistCompletion.count({
      where: { itemId: item.id, date: checklistDayKey(tooOld) },
    })).toBe(0);
    expect(await db.checklistNote.count({
      where: { itemId: item.id, date: checklistDayKey(tooOld) },
    })).toBe(0);
    // The cutoff day itself survives — the window is inclusive of it.
    expect(await db.checklistCompletion.count({
      where: { itemId: item.id, date: checklistDayKey(oldestKept) },
    })).toBe(1);
  }, 180000);

  it("asking for a day outside the window says so instead of erroring", async () => {
    await makeChecklist();
    const ancient = shiftDay(retentionCutoff(todayPKTString()), -30);
    const data = await getChecklistHistory(ancient);
    expect(data.dbReady).toBe(true);
    expect(data.checklists).toHaveLength(0);
    expect(data.oldestKept > ancient).toBe(true);
  }, 180000);
});
