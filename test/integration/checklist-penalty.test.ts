import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, cleanups } from "../setup";
import { uniq } from "../helpers";
import {
  reconcileChecklistPenalties, waiveChecklistPenalty, unwaiveChecklistPenalty,
} from "@/app/(dashboard)/checklists/actions";
import { getSalariesPageData } from "@/app/(dashboard)/payments/salaries/actions";
import { checklistDayKey } from "@/lib/checklists";
import { PENALTY_PER_DAY } from "@/lib/checklist-penalty";
import { todayPKTString } from "@/lib/pkt";

// Far enough back to cover every day these tests construct.
const BACKDATE = "2000-01-01";

// Back-dating is global — the reconciler scores EVERY user, not just the ones made
// here — so these runs also score whatever real checklists the shared database
// holds. Anything this file caused is removed again afterwards, or the suite would
// leave live people carrying penalties nobody asked for.
let startedAt: Date;
beforeAll(() => { startedAt = new Date(); });
afterAll(async () => {
  await db.checklistPenalty.deleteMany({ where: { createdAt: { gte: startedAt } } }).catch(() => {});
});

// Rs 300 off a day somebody did under 70% of their checklist. The score is written
// down on the day rather than recomputed later, because completions are pruned at
// 60 days and item counts change — a recomputed past day would read 0% and fine
// everyone.

function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + by);
  return dt.toISOString().slice(0, 10);
}

// Long before any day these tests score. Both dates matter now: nobody is fined
// for a day before they joined, and no checklist is failed on a day it did not yet
// exist — so a fixture created "today" would be scored for nothing at all, and the
// tests below would pass while proving the opposite of what they say.
const LONG_AGO = new Date("2000-01-01T12:00:00.000Z");

/** A user with a staff record and a checklist of `itemCount` items. */
async function staffWithChecklist(itemCount: number, joinedAt: Date = LONG_AGO) {
  const name = uniq("staff");
  const user = await db.user.create({
    data: { name, email: `${name}@test.local`, role: "PACKAGING", active: true },
  });
  const employee = await db.employee.create({
    data: { userId: user.id, name, baseSalary: 30000, active: true, joinedAt },
  });
  const list = await db.checklist.create({
    data: { title: uniq("list"), assigneeId: user.id, dueTime: "10:00", createdAt: LONG_AGO },
  });
  const items = [];
  for (let i = 0; i < itemCount; i++) {
    items.push(await db.checklistItem.create({ data: { checklistId: list.id, label: uniq("task"), order: i } }));
  }
  cleanups.push(async () => {
    await db.checklistPenalty.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await db.checklist.delete({ where: { id: list.id } }).catch(() => {});
    await db.attendance.deleteMany({ where: { employeeId: employee.id } }).catch(() => {});
    await db.employee.delete({ where: { id: employee.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return { user, employee, list, items };
}

async function tick(itemId: string, day: string, userId: string) {
  await db.checklistCompletion.create({
    data: { itemId, date: checklistDayKey(day), doneById: userId },
  });
}

const penaltiesFor = (userId: string) => db.checklistPenalty.findMany({ where: { userId } });

describe("scoring a closed day", () => {
  it("penalises 6 of 10 and leaves 7 of 10 alone", async () => {
    const day = shiftDay(todayPKTString(), -2);

    const low = await staffWithChecklist(10);
    for (let i = 0; i < 6; i++) await tick(low.items[i].id, day, low.user.id);

    const ok = await staffWithChecklist(10);
    for (let i = 0; i < 7; i++) await tick(ok.items[i].id, day, ok.user.id);

    await reconcileChecklistPenalties(true, BACKDATE);

    const lowPen = (await penaltiesFor(low.user.id)).filter((p) => p.date.toISOString().slice(0, 10) === day);
    expect(lowPen).toHaveLength(1);
    expect(Number(lowPen[0].amount)).toBe(PENALTY_PER_DAY);
    expect(lowPen[0].itemsDone).toBe(6);
    expect(lowPen[0].itemsTotal).toBe(10);

    const okPen = (await penaltiesFor(ok.user.id)).filter((p) => p.date.toISOString().slice(0, 10) === day);
    expect(okPen).toHaveLength(0);
  }, 180000);

  it("never scores today — a list due at 6pm must not be judged at 9am", async () => {
    const s = await staffWithChecklist(10); // nothing ticked at all
    await reconcileChecklistPenalties(true, BACKDATE);
    const today = todayPKTString();
    const mine = await penaltiesFor(s.user.id);
    expect(mine.some((p) => p.date.toISOString().slice(0, 10) === today)).toBe(false);
  }, 180000);

  it("a person with no checklist items is never penalised", async () => {
    const s = await staffWithChecklist(0);
    await reconcileChecklistPenalties(true, BACKDATE);
    expect(await penaltiesFor(s.user.id)).toHaveLength(0);
  }, 180000);
});

describe("attendance excuses a day", () => {
  it("marked absent means no penalty, even with nothing ticked", async () => {
    const day = shiftDay(todayPKTString(), -3);
    const s = await staffWithChecklist(10);
    await db.attendance.create({
      data: { employeeId: s.employee.id, date: checklistDayKey(day), status: "ABSENT" },
    });

    await reconcileChecklistPenalties(true, BACKDATE);
    const mine = (await penaltiesFor(s.user.id)).filter((p) => p.date.toISOString().slice(0, 10) === day);
    expect(mine).toHaveLength(0);
  }, 180000);

  it("a MISSING attendance row does not excuse it", async () => {
    // Attendance is barely filled in on the real data — waiting for it would make
    // this rule do nothing at all.
    const day = shiftDay(todayPKTString(), -4);
    const s = await staffWithChecklist(10);
    await reconcileChecklistPenalties(true, BACKDATE);
    const mine = (await penaltiesFor(s.user.id)).filter((p) => p.date.toISOString().slice(0, 10) === day);
    expect(mine).toHaveLength(1);
  }, 180000);
});

describe("running it again", () => {
  it("is idempotent — a day is scored once, not once per page load", async () => {
    const day = shiftDay(todayPKTString(), -5);
    const s = await staffWithChecklist(10);

    await reconcileChecklistPenalties(true, BACKDATE);
    await reconcileChecklistPenalties(true, BACKDATE);
    await reconcileChecklistPenalties(true, BACKDATE);

    const mine = (await penaltiesFor(s.user.id)).filter((p) => p.date.toISOString().slice(0, 10) === day);
    expect(mine).toHaveLength(1);
  }, 180000);

  it("does not re-score a day after the checklist has been edited", async () => {
    // The score is what it was on the day. Adding items later must not retroactively
    // change whether somebody was fined.
    const day = shiftDay(todayPKTString(), -6);
    const s = await staffWithChecklist(10);
    for (let i = 0; i < 6; i++) await tick(s.items[i].id, day, s.user.id);
    await reconcileChecklistPenalties(true, BACKDATE);

    const before = (await penaltiesFor(s.user.id)).find((p) => p.date.toISOString().slice(0, 10) === day)!;
    expect(before.itemsTotal).toBe(10);

    await db.checklistItem.create({ data: { checklistId: s.list.id, label: uniq("extra"), order: 99 } });
    await reconcileChecklistPenalties(true, BACKDATE);

    const after = (await penaltiesFor(s.user.id)).find((p) => p.date.toISOString().slice(0, 10) === day)!;
    expect(after.itemsTotal).toBe(10); // unchanged
    expect(after.id).toBe(before.id);
  }, 180000);
});

describe("what the salary page shows", () => {
  it("the penalty reduces what is owed, and waiving it puts the money back", async () => {
    const day = shiftDay(todayPKTString(), -7);
    const s = await staffWithChecklist(10);
    await reconcileChecklistPenalties(true, BACKDATE);

    const [y, m] = day.split("-").map(Number);
    const before = await getSalariesPageData(m, y);
    const rowBefore = before.employees.find((e) => e.id === s.employee.id);
    expect(rowBefore).toBeTruthy();
    const pen = rowBefore!.penalties.find((p) => p.date.slice(0, 10) === day);
    expect(pen).toBeTruthy();
    expect(pen!.amount).toBe(PENALTY_PER_DAY);
    expect(pen!.detail).toContain("0 of 10");
    expect(pen!.waived).toBe(false);

    expect((await waiveChecklistPenalty(pen!.id, "was on approved leave")).ok).toBe(true);

    const after = await getSalariesPageData(m, y);
    const penAfter = after.employees.find((e) => e.id === s.employee.id)!.penalties
      .find((p) => p.id === pen!.id)!;
    // Still listed — the record of what happened is the point — but not counted.
    expect(penAfter.waived).toBe(true);
    expect(penAfter.waiveReason).toBe("was on approved leave");

    expect((await unwaiveChecklistPenalty(pen!.id)).ok).toBe(true);
    const restored = await getSalariesPageData(m, y);
    expect(restored.employees.find((e) => e.id === s.employee.id)!.penalties
      .find((p) => p.id === pen!.id)!.waived).toBe(false);
  }, 180000);

  it("waiving needs a reason", async () => {
    const s = await staffWithChecklist(10);
    await reconcileChecklistPenalties(true, BACKDATE);
    const pen = (await penaltiesFor(s.user.id))[0];
    if (!pen) return;
    expect((await waiveChecklistPenalty(pen.id, "   ")).ok).toBe(false);
  }, 180000);
});

describe("a checklist owner with no staff record", () => {
  it("is not scored at all — a fine with nobody to charge is a fine waiting to misfire", async () => {
    const day = shiftDay(todayPKTString(), -8);
    const name = uniq("nostaff");
    const user = await db.user.create({
      data: { name, email: `${name}@test.local`, role: "PACKAGING", active: true },
    });
    const list = await db.checklist.create({
      data: { title: uniq("list"), assigneeId: user.id, dueTime: "10:00" },
    });
    await db.checklistItem.create({ data: { checklistId: list.id, label: uniq("t"), order: 0 } });
    cleanups.push(async () => {
      await db.checklistPenalty.deleteMany({ where: { userId: user.id } }).catch(() => {});
      await db.checklist.delete({ where: { id: list.id } }).catch(() => {});
      await db.user.delete({ where: { id: user.id } }).catch(() => {});
    });

    await reconcileChecklistPenalties(true, BACKDATE);
    const mine = (await penaltiesFor(user.id)).filter((p) => p.date.toISOString().slice(0, 10) === day);
    // These used to be written down "so the shortfall is visible, with no salary to
    // take it from". 93 of them had built up on production, PKR 27,900 — and they
    // were not inert: carryPenaltiesToLink brought every one onto a staff record the
    // moment the login was linked, whatever its date, which is the same fault that
    // had a 4 October starter carrying 21 days of September.
    expect(mine).toHaveLength(0);
  }, 180000);
});

// Nobody is fined for a day they did not work here.
//
// This is what went wrong: a checklist created in August stayed assigned to
// whoever holds it today, and every day since the rule began was scored against
// them. Nouman Ayaz joined on 4 October and carried 21 penalties dated 6 September
// to 3 October — PKR 6,300 — which then pulled him onto September's salary list,
// because any record in a month keeps a person listed in it. Yaseen was still
// being fined a week after he left. 76 rows and PKR 22,800 in total, both
// directions.

describe("the employment window bounds a penalty", () => {
  it("does not fine a day before the person joined", async () => {
    const day = shiftDay(todayPKTString(), -3);
    // Joined the day AFTER the day being scored, and ticks nothing.
    const s = await staffWithChecklist(10, new Date(`${shiftDay(day, 1)}T12:00:00.000Z`));

    await reconcileChecklistPenalties(true, BACKDATE);

    const mine = await penaltiesFor(s.user.id);
    expect(mine.some((p) => p.date.toISOString().slice(0, 10) === day)).toBe(false);
  }, 180_000);

  it("fines the joining day itself, whatever time of day the record was made", async () => {
    const day = shiftDay(todayPKTString(), -3);
    // Afternoon on the very day being scored — a raw timestamp compare would have
    // thrown this day away.
    const s = await staffWithChecklist(10, new Date(`${day}T17:30:00.000Z`));

    await reconcileChecklistPenalties(true, BACKDATE);

    const mine = await penaltiesFor(s.user.id);
    expect(mine.some((p) => p.date.toISOString().slice(0, 10) === day)).toBe(true);
  }, 180_000);

  it("does not fine a day after the person left", async () => {
    const day = shiftDay(todayPKTString(), -3);
    const s = await staffWithChecklist(10);
    // Left the day BEFORE the day being scored.
    await db.employee.update({
      where: { id: s.employee.id },
      data: { active: false, leftAt: new Date(`${shiftDay(day, -1)}T12:00:00.000Z`) },
    });

    await reconcileChecklistPenalties(true, BACKDATE);

    const mine = await penaltiesFor(s.user.id);
    expect(mine.some((p) => p.date.toISOString().slice(0, 10) === day)).toBe(false);
  }, 180_000);

  it("still fines a day inside the window", async () => {
    const day = shiftDay(todayPKTString(), -3);
    const s = await staffWithChecklist(10, new Date(`${shiftDay(day, -5)}T12:00:00.000Z`));
    await db.employee.update({
      where: { id: s.employee.id },
      data: { leftAt: new Date(`${shiftDay(day, 5)}T12:00:00.000Z`) },
    });

    await reconcileChecklistPenalties(true, BACKDATE);

    const mine = await penaltiesFor(s.user.id);
    expect(mine.some((p) => p.date.toISOString().slice(0, 10) === day)).toBe(true);
  }, 180_000);
});

describe("a checklist cannot be failed before it existed", () => {
  it("skips days before the list was created", async () => {
    const day = shiftDay(todayPKTString(), -4);
    const s = await staffWithChecklist(10);
    // The list came into being the day AFTER the day being scored.
    await db.checklist.update({
      where: { id: s.list.id },
      data: { createdAt: new Date(`${shiftDay(day, 1)}T12:00:00.000Z`) },
    });

    await reconcileChecklistPenalties(true, BACKDATE);

    const mine = await penaltiesFor(s.user.id);
    expect(mine.some((p) => p.date.toISOString().slice(0, 10) === day)).toBe(false);
  }, 180_000);

  it("scores only the items whose list existed, when somebody holds two", async () => {
    const day = shiftDay(todayPKTString(), -4);
    const s = await staffWithChecklist(10); // created LONG_AGO, 10 items, none ticked
    // A second list added only yesterday must not change the score for `day`.
    const later = await db.checklist.create({
      data: {
        title: uniq("later"), assigneeId: s.user.id, dueTime: "10:00",
        createdAt: new Date(`${shiftDay(todayPKTString(), -1)}T12:00:00.000Z`),
        items: { create: [{ label: uniq("t"), order: 0 }, { label: uniq("t"), order: 1 }] },
      },
    });
    cleanups.push(async () => { await db.checklist.delete({ where: { id: later.id } }).catch(() => {}); });

    await reconcileChecklistPenalties(true, BACKDATE);

    const onDay = (await penaltiesFor(s.user.id)).find((p) => p.date.toISOString().slice(0, 10) === day);
    expect(onDay).toBeTruthy();
    // 10, not 12 — the second list did not exist yet.
    expect(onDay!.itemsTotal).toBe(10);
  }, 180_000);
});

describe("penalties already written outside the window", () => {
  it("are left out of the month's figures and out of who is listed", async () => {
    // A starter who joined today, with a penalty wrongly dated before that — the
    // exact shape found on production. The row is NOT removed; the salaries page
    // simply must not act on it.
    const today = todayPKTString();
    const s = await staffWithChecklist(10, new Date(`${today}T12:00:00.000Z`));
    const stray = shiftDay(today, -20);
    const [sy, sm] = stray.split("-").map(Number);
    await db.checklistPenalty.create({
      data: {
        userId: s.user.id, employeeId: s.employee.id, date: checklistDayKey(stray),
        itemsTotal: 10, itemsDone: 0, amount: PENALTY_PER_DAY,
      },
    });

    const page = await getSalariesPageData(sm, sy);
    const row = page.employees.find((e) => e.id === s.employee.id);
    // Not pulled onto a month he had not started, and nothing to deduct there.
    expect(row === undefined || row.penalties.length === 0).toBe(true);
  }, 180_000);
});
