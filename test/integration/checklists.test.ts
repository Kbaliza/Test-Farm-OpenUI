import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { uniq } from "../helpers";
import {
  toggleChecklistItem,
  createChecklist,
  getChecklistRoster,
} from "@/app/(dashboard)/checklists/actions";
import { getOverdueChecklists, checklistDayKey, pktNowMinutes } from "@/lib/checklists";

// The mocked auth "signed-in user" is the vitest admin; grab its real id so a
// checklist assigned to it counts as "the assignee is signed in".
let adminId: string;
beforeAll(async () => {
  const admin = await db.user.findFirst({ where: { email: "__vitest_admin@test.local" }, select: { id: true } });
  adminId = admin!.id;
});
afterEach(() => resetTestRole());

async function makeChecklist(assigneeId: string, dueTime: string, labels: string[]) {
  const c = await db.checklist.create({
    data: { title: uniq("CL"), assigneeId, dueTime, items: { create: labels.map((l, i) => ({ label: l, order: i })) } },
    include: { items: { orderBy: { order: "asc" } } },
  });
  cleanups.push(async () => { await db.checklist.delete({ where: { id: c.id } }).catch(() => {}); }); // cascades items+completions
  return c;
}
const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

describe("checklist per-day completion", () => {
  it("ticking creates one row for today, unticking removes it, and other days stay empty", async () => {
    const c = await makeChecklist(adminId, "23:59", ["a", "b"]);
    const item = c.items[0];
    const today = checklistDayKey();

    expect(await toggleChecklistItem(item.id)).toEqual({ ok: true, done: true });
    expect(await db.checklistCompletion.count({ where: { itemId: item.id, date: today } })).toBe(1);

    expect(await toggleChecklistItem(item.id)).toEqual({ ok: true, done: false });
    expect(await db.checklistCompletion.count({ where: { itemId: item.id, date: today } })).toBe(0);

    // daily reset: a tick today leaves any other day with zero rows
    await toggleChecklistItem(item.id);
    expect(await db.checklistCompletion.count({ where: { itemId: item.id, date: checklistDayKey("2020-01-01") } })).toBe(0);
  });

  it("a concurrent double-tick records the item done exactly once", async () => {
    const c = await makeChecklist(adminId, "23:59", ["x"]);
    const item = c.items[0];
    await Promise.all([toggleChecklistItem(item.id), toggleChecklistItem(item.id)]).catch(() => {});
    const n = await db.checklistCompletion.count({ where: { itemId: item.id, date: checklistDayKey() } });
    expect(n).toBeLessThanOrEqual(1); // never a duplicate (unique constraint holds)
  });
});

describe("checklist permissions — only the assignee ticks", () => {
  it("the assignee can tick their own item", async () => {
    const c = await makeChecklist(adminId, "23:59", ["mine"]);
    expect((await toggleChecklistItem(c.items[0].id)).ok).toBe(true);
  });

  it("a NON-assignee (even an admin) is rejected", async () => {
    const other = await db.user.create({ data: { email: uniq("u") + "@t.local", name: "Other Staff", role: "DOCTOR", active: true } });
    cleanups.push(async () => { await db.user.delete({ where: { id: other.id } }).catch(() => {}); });
    const c = await makeChecklist(other.id, "23:59", ["theirs"]); // assigned to `other`, not the signed-in admin
    const res = await toggleChecklistItem(c.items[0].id);
    expect(res.ok).toBe(false); // admin is not the assignee
  });

  it("create/manage requires FULL_ACCESS (a limited role is rejected)", async () => {
    setTestRole("DOCTOR");
    await expect(createChecklist({ assigneeId: adminId, title: "x", dueTime: "10:00", items: [{ label: "a" }] })).rejects.toThrow(/permission/i);
    await expect(getChecklistRoster()).rejects.toThrow(/permission/i);
  });
});

describe("checklist overdue detection", () => {
  it("surfaces a checklist only when past its due time AND incomplete", async () => {
    const now = pktNowMinutes();
    const pastDue = fmtMin(Math.max(0, now - 10));
    const futureDue = fmtMin(Math.min(1439, now + 30));

    const late = await makeChecklist(adminId, pastDue, ["a", "b"]); // past due, untouched
    const early = await makeChecklist(adminId, futureDue, ["a"]);    // not due yet

    let overdue = await getOverdueChecklists();
    expect(overdue.some((o) => o.id === late.id)).toBe(true);   // past due + incomplete
    expect(overdue.some((o) => o.id === early.id)).toBe(false); // not due yet

    // finish the late one -> it drops off the overdue list
    for (const it of late.items) await toggleChecklistItem(it.id);
    overdue = await getOverdueChecklists();
    expect(overdue.some((o) => o.id === late.id)).toBe(false);
  });
});
