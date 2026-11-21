import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { uniq } from "../helpers";
import {
  toggleChecklistItem,
  getMyChecklists,
  getChecklistRoster,
} from "@/app/(dashboard)/checklists/actions";

const TEST_ADMIN_EMAIL = "__vitest_admin@test.local";

describe("checklist tick records when and by whom", () => {
  it("stamps doneAt + doneBy on tick, and clears them on untick", async () => {
    const me = await db.user.findUniqueOrThrow({ where: { email: TEST_ADMIN_EMAIL }, select: { id: true, name: true } });

    const list = await db.checklist.create({
      data: {
        title: uniq("checklist"),
        assigneeId: me.id,
        dueTime: "23:59",
        items: { create: [{ label: uniq("item"), order: 0 }] },
      },
      include: { items: true },
    });
    const itemId = list.items[0].id;
    cleanups.push(async () => { await db.checklist.delete({ where: { id: list.id } }).catch(() => {}); });

    // Tick it.
    const on = await toggleChecklistItem(itemId);
    expect(on).toEqual({ ok: true, done: true });

    const row = await db.checklistCompletion.findFirstOrThrow({
      where: { itemId },
      select: { doneAt: true, doneById: true },
    });
    expect(row.doneById).toBe(me.id);          // who
    expect(row.doneAt).toBeInstanceOf(Date);   // when
    expect(Date.now() - row.doneAt.getTime()).toBeLessThan(5 * 60_000);

    // Both surface to the person and to the admin oversight view.
    const mine = await getMyChecklists();
    const mineItem = mine.checklists.find((c) => c.id === list.id)?.items[0];
    expect(mineItem?.done).toBe(true);
    expect(mineItem?.doneAt).toBeTruthy();
    expect(mineItem?.doneBy).toBe(me.name);

    const roster = await getChecklistRoster();
    const adminItem = roster.checklists.find((c) => c.id === list.id)?.items[0];
    expect(adminItem?.doneAt).toBeTruthy();
    expect(adminItem?.doneBy).toBe(me.name);

    // Untick clears the record (unchanged behaviour).
    const off = await toggleChecklistItem(itemId);
    expect(off).toEqual({ ok: true, done: false });
    expect(await db.checklistCompletion.count({ where: { itemId } })).toBe(0);
  }, 240_000);

  it("refuses a tick on someone else's checklist (unchanged)", async () => {
    const other = await db.user.create({
      data: { email: uniq("other") + "@t.local", name: "Someone Else", role: "MANAGER", active: true, supabaseId: uniq("sb") },
    });
    const list = await db.checklist.create({
      data: { title: uniq("checklist"), assigneeId: other.id, dueTime: "23:59", items: { create: [{ label: uniq("item"), order: 0 }] } },
      include: { items: true },
    });
    cleanups.push(async () => {
      await db.checklist.delete({ where: { id: list.id } }).catch(() => {});
      await db.user.delete({ where: { id: other.id } }).catch(() => {});
    });

    const res = await toggleChecklistItem(list.items[0].id);
    expect(res.ok).toBe(false);
    expect(await db.checklistCompletion.count({ where: { itemId: list.items[0].id } })).toBe(0);
  }, 240_000);
});
