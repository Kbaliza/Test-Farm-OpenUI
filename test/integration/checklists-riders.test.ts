import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, resetTestRole } from "../setup";
import { uniq } from "../helpers";
import { getAssignableUsers, createChecklist, getChecklistRoster } from "@/app/(dashboard)/checklists/actions";
import { checklistDayKey } from "@/lib/checklists";

afterEach(() => resetTestRole());

async function makeRider(name = "Rider Test") {
  const u = await db.user.create({
    data: { email: uniq("rider") + "@t.local", name, role: "RIDER", active: true, supabaseId: uniq("sb") },
  });
  cleanups.push(async () => { await db.user.delete({ where: { id: u.id } }).catch(() => {}); });
  return u;
}

describe("checklists — riders can be assigned (they fill via the mobile app)", () => {
  it("getAssignableUsers includes an active rider", async () => {
    const rider = await makeRider();
    const users = await getAssignableUsers();
    const row = users.find((x) => x.id === rider.id);
    expect(row).toBeTruthy();
    expect(row!.role).toBe("RIDER");
    expect(row!.roleLabel).toMatch(/rider/i);
  });

  it("a rider's checklist appears in the roster and reflects a mobile-side tick", async () => {
    const rider = await makeRider("Wajid Khan");
    const res = await createChecklist({
      assigneeId: rider.id,
      title: uniq("CL"),
      dueTime: "09:00",
      items: [{ label: "Fuel checked" }, { label: "Crates loaded" }],
    });
    expect(res).toEqual({ ok: true });

    const cl = (await db.checklist.findFirst({ where: { assigneeId: rider.id }, include: { items: { orderBy: { order: "asc" } } } }))!;
    cleanups.push(async () => { await db.checklist.delete({ where: { id: cl.id } }).catch(() => {}); }); // cascades items + completions

    // Simulate exactly what the mobile API POST does: stamp today's completion.
    await db.checklistCompletion.create({ data: { itemId: cl.items[0].id, date: checklistDayKey() } });

    const roster = await getChecklistRoster();
    const view = roster.checklists.find((c) => c.id === cl.id)!;
    expect(view).toBeTruthy();
    expect(view.assigneeName).toBe("Wajid Khan");
    expect(view.assigneeRole).toMatch(/rider/i);
    expect(view.done).toBe(1);
    expect(view.total).toBe(2);
  });
});
