import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { uniq } from "../helpers";
import { setStaffActive } from "@/app/(dashboard)/staff/actions";
import { attendanceDateKey, daysAfterInMonth } from "@/lib/attendance-date";
import { pktNoonToUTC, todayPKTString } from "@/lib/pkt";

// Disabling someone asks for their last working day, stamps it, and marks the rest
// of that month absent.
//
// The absences are NOT what pro-rates the salary — the employment window already
// does that and ignores every day outside it. They are there for the day someone
// is taken back on: attendanceCounts reads an UNMARKED day as present, so without
// them a returning employee would be paid for the whole gap they were away.

const TODAY = todayPKTString();
const [Y, M] = TODAY.split("-").map(Number);
const DAY = Number(TODAY.slice(8, 10));
const str = (day: number) => `${Y}-${String(M).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

async function staff(joinedAt: Date) {
  const e = await db.employee.create({
    data: { name: uniq("leaver"), role: "Helper", baseSalary: 30_000, dailyWage: null, joinedAt, active: true },
  });
  cleanups.push(async () => {
    await db.attendance.deleteMany({ where: { employeeId: e.id } });
    await db.employee.delete({ where: { id: e.id } }).catch(() => {});
  });
  return e;
}

const marks = async (id: string) =>
  new Map(
    (await db.attendance.findMany({ where: { employeeId: id }, select: { date: true, status: true } }))
      .map((a) => [a.date.toISOString(), a.status] as const),
  );

describe("the leaving date, when someone is disabled", () => {
  it("is stored as given, not as today", async () => {
    // Needs a day earlier in the month to be distinguishable from today.
    if (DAY < 3) return;
    const leaving = str(2);
    const e = await staff(pktNoonToUTC(str(1)));

    expect((await setStaffActive(e.id, false, leaving)).ok).toBe(true);

    const after = await db.employee.findUnique({ where: { id: e.id }, select: { active: true, leftAt: true } });
    expect(after!.active).toBe(false);
    expect(after!.leftAt?.toISOString()).toBe(pktNoonToUTC(leaving).toISOString());
  }, 180_000);

  it("marks every later day of that month absent, and leaves the leaving day alone", async () => {
    if (DAY < 3) return;
    const leaving = str(2);
    const e = await staff(pktNoonToUTC(str(1)));
    // The leaving day is already marked present — it must survive.
    await db.attendance.create({ data: { employeeId: e.id, date: attendanceDateKey(leaving), status: "PRESENT" } });

    expect((await setStaffActive(e.id, false, leaving)).ok).toBe(true);

    const got = await marks(e.id);
    expect(got.get(attendanceDateKey(leaving).toISOString())).toBe("PRESENT");
    for (const ds of daysAfterInMonth(leaving)) {
      expect(got.get(attendanceDateKey(ds).toISOString())).toBe("ABSENT");
    }
  }, 180_000);

  it("overwrites a day already marked present — marking the month present in one go is common", async () => {
    if (DAY < 4) return;
    const leaving = str(2);
    const e = await staff(pktNoonToUTC(str(1)));
    const laterDay = str(3);
    await db.attendance.create({ data: { employeeId: e.id, date: attendanceDateKey(laterDay), status: "PRESENT" } });

    expect((await setStaffActive(e.id, false, leaving)).ok).toBe(true);

    const got = await marks(e.id);
    expect(got.get(attendanceDateKey(laterDay).toISOString())).toBe("ABSENT");
  }, 180_000);

  it("falls back to today when no date is given, so an older caller behaves as before", async () => {
    const e = await staff(pktNoonToUTC(str(1)));
    expect((await setStaffActive(e.id, false)).ok).toBe(true);
    const after = await db.employee.findUnique({ where: { id: e.id }, select: { leftAt: true } });
    expect(after!.leftAt?.toISOString()).toBe(pktNoonToUTC(TODAY).toISOString());
  }, 180_000);

  it("refuses a date before they joined", async () => {
    if (DAY < 3) return;
    const e = await staff(pktNoonToUTC(str(2)));
    const res = await setStaffActive(e.id, false, str(1));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/joined on/i);
    // Refused means untouched.
    const after = await db.employee.findUnique({ where: { id: e.id }, select: { active: true, leftAt: true } });
    expect(after!.active).toBe(true);
    expect(after!.leftAt).toBeNull();
  }, 180_000);

  it("refuses a date in the future", async () => {
    const e = await staff(pktNoonToUTC(str(1)));
    const nextYear = `${Y + 1}-01-15`;
    const res = await setStaffActive(e.id, false, nextYear);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/future/i);
  }, 180_000);

  it("refuses something that is not a date, rather than storing a bad one", async () => {
    const e = await staff(pktNoonToUTC(str(1)));
    expect((await setStaffActive(e.id, false, "last friday")).ok).toBe(false);
    const after = await db.employee.findUnique({ where: { id: e.id }, select: { leftAt: true } });
    expect(after!.leftAt).toBeNull();
  }, 180_000);
});

describe("taking someone back on", () => {
  it("clears the leaving date and drops the absences from today on, keeping the gap", async () => {
    // Needs a day before today inside this month to hold the gap.
    if (DAY < 3) return;
    const leaving = str(1);
    const e = await staff(pktNoonToUTC(str(1)));
    expect((await setStaffActive(e.id, false, leaving)).ok).toBe(true);

    // The gap (day 2 .. yesterday) and today onwards are all ABSENT right now.
    const before = await marks(e.id);
    expect(before.get(attendanceDateKey(str(2)).toISOString())).toBe("ABSENT");
    expect(before.get(attendanceDateKey(TODAY).toISOString())).toBe("ABSENT");

    expect((await setStaffActive(e.id, true)).ok).toBe(true);

    const after = await db.employee.findUnique({ where: { id: e.id }, select: { active: true, leftAt: true } });
    expect(after!.active).toBe(true);
    expect(after!.leftAt).toBeNull();

    const got = await marks(e.id);
    // Today and later are unmarked again — they are working, and an unmarked day
    // reads as present.
    expect(got.has(attendanceDateKey(TODAY).toISOString())).toBe(false);
    // The days they were actually away stay absent, or the gap would be paid.
    expect(got.get(attendanceDateKey(str(2)).toISOString())).toBe("ABSENT");
  }, 180_000);
});

describe("the days a part month leaves behind", () => {
  it("counts from the day after, and stops at the end of the month", () => {
    expect(daysAfterInMonth("2026-10-29")).toEqual(["2026-10-30", "2026-10-31"]);
    expect(daysAfterInMonth("2026-10-31")).toEqual([]);
    expect(daysAfterInMonth("2026-02-27")).toEqual(["2026-02-28"]); // 2026 is not a leap year
    expect(daysAfterInMonth("2024-02-27")).toEqual(["2024-02-28", "2024-02-29"]);
    expect(daysAfterInMonth("2026-09-29")).toEqual(["2026-09-30"]);
  });

  it("keys a day the way every attendance row already written keys it", () => {
    const k = attendanceDateKey("2026-10-04");
    expect(k.getFullYear()).toBe(2026);
    expect(k.getMonth()).toBe(9);
    expect(k.getDate()).toBe(4);
    expect(k.getHours()).toBe(12);
  });
});
