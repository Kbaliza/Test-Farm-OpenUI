"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { todayPKTString, toDateStrPKT } from "@/lib/pkt";
import { attendanceDateKey } from "@/lib/attendance-date";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AttendanceStatus = "PRESENT" | "ABSENT" | "HALF_DAY" | "HOLIDAY";

export type HistoryDay = {
  date: string; // "YYYY-MM-DD"
  status: AttendanceStatus | null;
};

export type PersonRow = {
  id: string; // employee id
  name: string;
  role: string;
  /** AGRICULTURE | RETAIL | FARM, or null when not set — for the category filter. */
  category: string | null;
  isRider: boolean;
  status: AttendanceStatus | null;
  history: HistoryDay[]; // the 7 days before the selected date, oldest → newest
};

export type AttendanceSummary = {
  total: number;
  present: number;
  absent: number;
  half: number;
  holiday: number;
  unmarked: number;
};

export type AttendancePageData = {
  date: string; // "YYYY-MM-DD"
  people: PersonRow[];
  summary: AttendanceSummary;
  dbReady: boolean;
};

export type ActionResult = { ok: true } | { ok: false; error: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

// Match the exact Date construction used by the salaries module so both pages
// read/write the SAME attendance records (unique key is [employeeId, date]).
// The one definition now lives in lib, because the Staff page writes attendance
// rows too (it marks the rest of the month absent when someone leaves) and both
// must key the day identically. Not exported: a "use server" file may only export
// async functions.
const dateStrToLocal = attendanceDateKey;

// Shift a "YYYY-MM-DD" string by a number of days (calendar-safe).
function shiftDateStr(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function buildSummary(people: PersonRow[]): AttendanceSummary {
  return {
    total:    people.length,
    present:  people.filter((p) => p.status === "PRESENT").length,
    absent:   people.filter((p) => p.status === "ABSENT").length,
    half:     people.filter((p) => p.status === "HALF_DAY").length,
    holiday:  people.filter((p) => p.status === "HOLIDAY").length,
    unmarked: people.filter((p) => p.status === null).length,
  };
}

// ── Data fetch ────────────────────────────────────────────────────────────────

export async function getAttendancePageData(dateStr: string): Promise<AttendancePageData> {
  await requireRole(FULL_ACCESS);
  try {
    const date = dateStrToLocal(dateStr);

    // All calendar days in the selected month (oldest → newest), including today.
    const [selY, selM] = dateStr.split("-").map(Number);
    const daysInMonth = new Date(selY, selM, 0).getDate();
    const histDays = Array.from({ length: daysInMonth }, (_, i) => {
      const day = String(i + 1).padStart(2, "0");
      return `${selY}-${String(selM).padStart(2, "0")}-${day}`;
    });
    const histStart = dateStrToLocal(histDays[0]);
    const histEnd   = dateStrToLocal(histDays[histDays.length - 1]);

    // These reads are independent — run them in parallel (connection_limit > 1).
    const [riders, employeesData, attendance, historyRows] = await Promise.all([
      db.rider.findMany({
        where: { active: true },
        include: { user: { select: { name: true } } },
        orderBy: { user: { name: "asc" } },
      }),
      db.employee.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
      db.attendance.findMany({ where: { date }, select: { employeeId: true, status: true } }),
      db.attendance.findMany({
        where: { date: { gte: histStart, lte: histEnd } },
        select: { employeeId: true, date: true, status: true },
      }),
    ]);
    const riderUserIds = new Set(riders.map((r) => r.userId));
    // A rider's staff record is made when the rider is (src/lib/rider-employees.ts);
    // this page only reads. It used to create one here for any rider without one,
    // which is how a person ended up on the sheet twice.
    // Only the people who were on the staff that day. Someone who joined in
    // October has no place on September's sheet, and someone who has left has
    // no place after their last day — the salaries page already pays by these
    // same dates.
    const employees = employeesData.filter((e) => onStaffOn(e, dateStr));

    const statusByEmp = new Map(attendance.map((a) => [a.employeeId, a.status as AttendanceStatus]));

    // Index history by "employeeId|YYYY-MM-DD"
    const histByEmpDate = new Map<string, AttendanceStatus>();
    for (const a of historyRows) {
      const ds = a.date.toISOString().split("T")[0];
      histByEmpDate.set(`${a.employeeId}|${ds}`, a.status as AttendanceStatus);
    }

    const people: PersonRow[] = employees.map((e) => ({
      id:      e.id,
      name:    e.name,
      role:    e.role ?? "",
      category: e.category ?? null,
      isRider: e.userId ? riderUserIds.has(e.userId) : false,
      status:  statusByEmp.get(e.id) ?? null,
      history: histDays.map((ds) => ({
        date:   ds,
        // For today's date use statusByEmp (same source as person.status) so
        // the calendar cell and the buttons are always in sync.
        status: ds === dateStr
          ? (statusByEmp.get(e.id) ?? null)
          : (histByEmpDate.get(`${e.id}|${ds}`) ?? null),
      })),
    }));

    return { date: dateStr, people, summary: buildSummary(people), dbReady: true };
  } catch (e) {
    console.error("[attendance] getAttendancePageData failed:", e);
    return {
      date: dateStr,
      people: [],
      summary: { total: 0, present: 0, absent: 0, half: 0, holiday: 0, unmarked: 0 },
      dbReady: false,
    };
  }
}

// ── Mark attendance ─────────────────────────────────────────────────────────────

/** Had this person joined by that day, and not yet left? */
function onStaffOn(e: { joinedAt: Date | null; leftAt: Date | null }, dateStr: string): boolean {
  if (e.joinedAt && toDateStrPKT(e.joinedAt) > dateStr) return false;
  if (e.leftAt && toDateStrPKT(e.leftAt) < dateStr) return false;
  return true;
}

export async function setAttendance(
  employeeId: string,
  dateStr: string,
  status: AttendanceStatus
): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    const date = dateStrToLocal(dateStr);
    const emp = await db.employee.findUnique({ where: { id: employeeId }, select: { joinedAt: true, leftAt: true } });
    if (!emp) return { ok: false, error: "That person is not on the staff list." };
    if (!onStaffOn(emp, dateStr)) return { ok: false, error: "They were not on the staff that day." };
    await db.attendance.upsert({
      where:  { employeeId_date: { employeeId, date } },
      update: { status },
      create: { employeeId, date, status },
    });
    // Deliberately NOT revalidating here.
    //
    // Marking someone is optimistic on the client, so it has the new state
    // already. Revalidating made the server re-render the whole page on every
    // tap and hand the router a fresh tree, which threw away the scroll
    // position in <main> — mark someone near the bottom of the list and you
    // were bounced to the top before you could mark the next one.
    //
    // Nothing is lost by skipping it: /attendance is force-dynamic, and
    // /payments/salaries reads the session cookie in requireRole, so neither is
    // cached. There is no cache entry to invalidate — both pages fetch fresh
    // the next time they are opened.
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update attendance." };
  }
}

/**
 * Unmarks a day — the way out of a mistaken tap.
 *
 * Deletes the row rather than storing a fifth "UNMARKED" status, because
 * "no row" is already what an unmarked day means everywhere else: the page
 * builds its status map from the rows that exist, and the checklist penalty
 * treats a missing row as "not excused". Inventing a status value would have
 * meant teaching both of those about it.
 *
 * deleteMany, not delete: tapping twice quickly, or on a day that was never
 * marked, should be a no-op and not a P2025 crash.
 */
export async function clearAttendance(
  employeeId: string,
  dateStr: string
): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    const date = dateStrToLocal(dateStr);
    await db.attendance.deleteMany({ where: { employeeId, date } });
    // Not revalidating, for the same reason setAttendance does not — see there.
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to clear attendance." };
  }
}

export async function markAttendanceBulk(
  employeeIds: string[],
  dateStr: string,
  status: AttendanceStatus
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  if (employeeIds.length === 0) return { ok: true, count: 0 };
  // Mark-all skips anyone who was not on the staff that day.
  const staff = await db.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, joinedAt: true, leftAt: true } });
  employeeIds = staff.filter((e) => onStaffOn(e, dateStr)).map((e) => e.id);
  if (employeeIds.length === 0) return { ok: true, count: 0 };
  try {
    const date = dateStrToLocal(dateStr);
    // Two bulk queries instead of N upserts: update any existing rows, then
    // insert the rest (skipDuplicates ignores ones the update already covered).
    await db.attendance.updateMany({
      where: { employeeId: { in: employeeIds }, date },
      data:  { status },
    });
    await db.attendance.createMany({
      data: employeeIds.map((employeeId) => ({ employeeId, date, status })),
      skipDuplicates: true,
    });
    // Same reasoning as setAttendance: optimistic on the client, and neither
    // page is cached, so revalidating only cost the scroll position.
    return { ok: true, count: employeeIds.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update attendance." };
  }
}

// ── Staff management ────────────────────────────────────────────────────────────

// Add a standalone (non-rider) employee, e.g. farm worker / office staff.
// Adding, disabling and deleting staff live on the Staff page (../staff/actions.ts).

// ── Topbar quick summary ────────────────────────────────────────────────────────

export async function getTodayAttendanceSummary(): Promise<{ present: number; marked: number; total: number }> {
  await requireRole(FULL_ACCESS);
  try {
    const date = dateStrToLocal(todayPKTString());
    const [total, grouped] = await Promise.all([
      db.employee.count({ where: { active: true } }),
      db.attendance.groupBy({ by: ["status"], where: { date }, _count: { _all: true } }),
    ]);
    const marked  = grouped.reduce((s, g) => s + g._count._all, 0);
    const present = grouped.find((g) => g.status === "PRESENT")?._count._all ?? 0;
    return { present, marked, total };
  } catch {
    return { present: 0, marked: 0, total: 0 };
  }
}
