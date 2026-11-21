import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { uniq } from "../helpers";
import { getRiderReportContext } from "@/app/(dashboard)/customers/rider-report/actions";
import { isShiftLockedOnDateStr } from "@/lib/schedule";
import { todayPKTString, addDaysToDateStr } from "@/lib/pkt";

// The Rider Report's shift picker offered every shift a rider holds, whether or
// not it ran on the date being viewed. On production every route area is
// every-2nd-day, so Wajid Khan's three shifts showed on a day only one of them was
// due. The context now carries each shift's area schedules and the picker drops
// the ones locked on that date.

const TODAY = todayPKTString();

async function riderWithShifts() {
  const user = await db.user.create({ data: { email: uniq("rr") + "@t.local", name: uniq("Rider"), role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const rider = await db.rider.create({ data: { userId: user.id } });
  // Due today: anchored on today. Not due today: anchored on yesterday.
  const dueArea = await db.area.create({ data: { name: uniq("due"), scheduleType: "EVERY_N", scheduleInterval: 2, scheduleAnchor: TODAY } });
  const offArea = await db.area.create({ data: { name: uniq("off"), scheduleType: "EVERY_N", scheduleInterval: 2, scheduleAnchor: addDaysToDateStr(TODAY, -1) } });
  const due = await db.shift.create({ data: { name: uniq("due"), riderId: rider.id, areas: { connect: { id: dueArea.id } } } });
  const off = await db.shift.create({ data: { name: uniq("off"), riderId: rider.id, areas: { connect: { id: offArea.id } } } });
  const bare = await db.shift.create({ data: { name: uniq("bare"), riderId: rider.id } });
  cleanups.push(async () => {
    for (const s of [due, off, bare]) await db.shift.delete({ where: { id: s.id } }).catch(() => {});
    for (const a of [dueArea, offArea]) await db.area.delete({ where: { id: a.id } }).catch(() => {});
    await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return { rider, due, off, bare };
}

const dueOn = (ctx: Awaited<ReturnType<typeof getRiderReportContext>>, riderId: string, date: string) =>
  ctx.shifts.filter((s) => s.riderId === riderId && !isShiftLockedOnDateStr(s.schedules, date)).map((s) => s.id);

describe("the Rider Report shift picker", () => {
  it("carries each shift's area schedules", async () => {
    const { rider, due, bare } = await riderWithShifts();
    const ctx = await getRiderReportContext();
    const d = ctx.shifts.find((s) => s.id === due.id)!;
    expect(d.riderId).toBe(rider.id);
    expect(d.schedules).toEqual([{ scheduleType: "EVERY_N", scheduleInterval: 2, scheduleAnchor: TODAY, customDates: [] }]);
    expect(ctx.shifts.find((s) => s.id === bare.id)!.schedules).toEqual([]);
  }, 180_000);

  it("offers only the shifts due on the date — and the other ones on the next day", async () => {
    const { rider, due, off, bare } = await riderWithShifts();
    const ctx = await getRiderReportContext();

    const today = dueOn(ctx, rider.id, TODAY);
    expect(today).toContain(due.id);
    expect(today).not.toContain(off.id);
    // A shift with no areas is never locked — same fail-open rule as the Shift Editor.
    expect(today).toContain(bare.id);

    const tomorrow = dueOn(ctx, rider.id, addDaysToDateStr(TODAY, 1));
    expect(tomorrow).toContain(off.id);
    expect(tomorrow).not.toContain(due.id);
  }, 180_000);
});
