import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { uniq } from "../helpers";
import { syncRidersToEmployees, ensureRiderEmployee } from "@/lib/rider-employees";

async function makeRiderUser(name: string) {
  const user = await db.user.create({ data: { email: uniq("rd") + "@t.local", name, role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const rider = await db.rider.create({ data: { userId: user.id, active: true } });
  cleanups.push(async () => {
    await db.checklistPenalty.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.employee.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return user;
}

describe("rider → staff record: one person, one record", () => {
  it("the sync never invents a staff record — that is how people were doubled", async () => {
    const user = await makeRiderUser("New Rider");
    await syncRidersToEmployees();
    expect(await db.employee.findUnique({ where: { userId: user.id } })).toBeNull();
  });

  it("REACTIVATES an inactive staff record that already holds the rider's userId", async () => {
    const user = await makeRiderUser("Returning Rider");
    await db.employee.create({ data: { userId: user.id, name: "Returning Rider", role: "Rider", active: false } });
    await syncRidersToEmployees();
    const e = await db.employee.findUnique({ where: { userId: user.id } });
    expect(e!.active).toBe(true);
  });

  it("ensureRiderEmployee links a same-named staff record the office already added, penalties and all", async () => {
    const name = uniq("Zeeshan");
    const user = await makeRiderUser(name);
    const existing = await db.employee.create({ data: { name, role: "Rider", dailyWage: 1800, category: "RETAIL", joinedAt: new Date("2026-09-22T07:00:00Z") } });
    cleanups.push(async () => { await db.employee.delete({ where: { id: existing.id } }).catch(() => {}); });
    // A penalty scored against the login before any staff record was linked.
    await db.checklistPenalty.create({ data: { userId: user.id, date: new Date("2026-10-01T07:00:00Z"), amount: 300, itemsTotal: 5, itemsDone: 1 } });

    const id = await ensureRiderEmployee(user.id, name);
    expect(id).toBe(existing.id);
    const e = await db.employee.findUnique({ where: { id: existing.id } });
    expect(e!.userId).toBe(user.id);
    expect(Number(e!.dailyWage)).toBe(1800);                      // the pay the office set is kept
    expect(await db.employee.count({ where: { userId: user.id } })).toBe(1);
    expect((await db.checklistPenalty.findFirst({ where: { userId: user.id } }))!.employeeId).toBe(existing.id);
  });

  it("ensureRiderEmployee creates when there is nobody to link, then reactivates + renames", async () => {
    const user = await makeRiderUser(uniq("Original"));
    await ensureRiderEmployee(user.id, "Original");
    expect((await db.employee.findUnique({ where: { userId: user.id } }))!.active).toBe(true);

    await db.employee.update({ where: { userId: user.id }, data: { active: false } });
    await ensureRiderEmployee(user.id, "Renamed");
    const e = await db.employee.findUnique({ where: { userId: user.id } });
    expect(e!.active).toBe(true);
    expect(e!.name).toBe("Renamed");
  });
});
