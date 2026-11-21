"use server";

// Staff — one place to add, edit, disable, enable and delete everyone who works at
// the farm. It used to be spread over Attendance (add / remove) and Salaries (pay).
//
// Disable, not delete, is the normal way to take someone off: attendance, salary
// payments, bonuses, deductions and checklist penalties all point at the staff
// record, so deleting it would erase when they worked and what they were paid.
// Delete is only allowed for a record with none of that — typically one added by
// mistake. A rider can be added here too ("give this person a rider login"):
// it makes the app login, the rider and this staff record in one go, the same
// as the Riders page does, so nobody ends up with two records.

import { Prisma } from "@prisma/client";
import { pktNoonToUTC, todayPKTString } from "@/lib/pkt";
import { attendanceDateKey, daysAfterInMonth } from "@/lib/attendance-date";
import { revalidatePath } from "next/cache";
import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncRidersToEmployees } from "@/lib/rider-employees";
import { createRiderAccount } from "@/lib/create-rider";
import { isStaffCategory } from "@/lib/staff-category";
import {
  carryPenaltiesToLink,
  describeHistory,
  EMPTY_HISTORY,
  historyTotal,
  isActiveRider,
  loginLinkProblem,
  staffHistory,
  type StaffHistory,
} from "@/lib/staff-link";

export type StaffRow = {
  id: string;
  name: string;
  role: string;
  wageType: "fixed" | "daily";
  baseSalary: number;
  dailyWage: number;
  /** "YYYY-MM-DD" */
  joinedAt: string;
  active: boolean;
  /** AGRICULTURE | RETAIL | FARM, or null when not set yet. */
  category: string | null;
  userId: string | null;
  linkedLogin: string | null;
  /** An active rider — disable, delete and renaming happen on the Riders page. */
  isRider: boolean;
  history: StaffHistory;
};

export type LoginOption = { id: string; name: string; role: string; linkedTo: string | null };

export type StaffPageData = { staff: StaffRow[]; logins: LoginOption[]; dbReady: boolean };

export type StaffInput = {
  name: string;
  role: string;
  wageType: "fixed" | "daily";
  wage: number;
  /** "YYYY-MM-DD", or "" to leave it (today for a new record). */
  joinedAt: string;
  userId: string | null;
  /**
   * AGRICULTURE | RETAIL | FARM, null to clear it, or left out to keep what is
   * saved — so a caller that does not know about categories can never wipe one.
   */
  category?: string | null;
  /** Make this person a rider as well: an app login and a rider record, linked to the staff record. Add only. */
  rider?: { email: string; password: string; phone?: string; vehicle?: string; cnic?: string } | null;
};

export type StaffResult = { ok: true } | { ok: false; error: string };

function revalidateStaff() {
  for (const p of ["/staff", "/attendance", "/payments/salaries", "/payments/expenses", "/ledgers", "/tasks"]) {
    revalidatePath(p);
  }
}

function inputProblem(d: StaffInput): string | null {
  const name = (d.name ?? "").trim();
  if (!name) return "Enter the staff member's name.";
  if (name.length > 80) return "Keep the name under 80 characters.";
  if (d.wageType !== "fixed" && d.wageType !== "daily") return "Choose monthly salary or daily wage.";
  if (!Number.isFinite(d.wage) || d.wage < 0) return "Enter a salary of 0 or more.";
  if (d.joinedAt && !/^\d{4}-\d{2}-\d{2}$/.test(d.joinedAt)) return "Enter a valid join date.";
  if (d.category != null && !isStaffCategory(d.category)) return "Choose Agriculture, Retail or Farm.";
  return null;
}

function wageFields(d: StaffInput) {
  return {
    baseSalary: d.wageType === "fixed" ? new Prisma.Decimal(d.wage) : new Prisma.Decimal(0),
    dailyWage: d.wageType === "daily" ? new Prisma.Decimal(d.wage) : null,
  };
}

function friendly(e: unknown, fallback: string): string {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") return "That login is already linked to another staff member.";
    if (e.code === "P2003") return "This staff member has records that depend on them, so they can't be deleted. Disable them instead.";
  }
  return e instanceof Error ? e.message : fallback;
}

export async function getStaffPageData(): Promise<StaffPageData> {
  await requireRole(FULL_ACCESS);
  try {
    // Riders get their staff record from the rider sync; run it so a new rider is listed.
    await syncRidersToEmployees();
    const [employees, users, riders] = await Promise.all([
      db.employee.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
      db.user.findMany({
        select: { id: true, name: true, role: true, active: true, employee: { select: { name: true } } },
        orderBy: { name: "asc" },
      }),
      db.rider.findMany({ where: { active: true }, select: { userId: true } }),
    ]);
    const history = await staffHistory(db, employees.map((e) => e.id));
    const loginName = new Map(users.map((u) => [u.id, u.name]));
    const riderLogins = new Set(riders.map((r) => r.userId));

    return {
      dbReady: true,
      staff: employees.map((e) => ({
        id: e.id,
        name: e.name,
        role: e.role ?? "",
        wageType: e.dailyWage && Number(e.dailyWage) > 0 ? "daily" : "fixed",
        baseSalary: Number(e.baseSalary),
        dailyWage: Number(e.dailyWage ?? 0),
        joinedAt: e.joinedAt.toISOString().slice(0, 10),
        active: e.active,
        category: e.category ?? null,
        userId: e.userId,
        linkedLogin: e.userId ? loginName.get(e.userId) ?? null : null,
        isRider: !!e.userId && riderLogins.has(e.userId),
        history: history.get(e.id) ?? { ...EMPTY_HISTORY },
      })),
      logins: users
        .filter((u) => u.active)
        .map((u) => ({ id: u.id, name: u.name, role: u.role, linkedTo: u.employee?.name ?? null })),
    };
  } catch (e) {
    console.error("[staff] getStaffPageData failed:", e);
    return { staff: [], logins: [], dbReady: false };
  }
}

export async function createStaff(input: StaffInput): Promise<StaffResult> {
  await requireRole(FULL_ACCESS);
  const problem = inputProblem(input);
  if (problem) return { ok: false, error: problem };

  // A rider: the login, the rider and the staff record together, exactly as the
  // Riders page makes them. The pay and dates entered here go on that record.
  if (input.rider) {
    const w = wageFields(input);
    const res = await createRiderAccount({
      name: input.name,
      email: input.rider.email,
      password: input.rider.password,
      phone: input.rider.phone,
      vehicle: input.rider.vehicle,
      cnic: input.rider.cnic,
      employee: {
        role: input.role.trim() || "Rider",
        category: input.category ?? null,
        baseSalary: Number(w.baseSalary),
        dailyWage: w.dailyWage ? Number(w.dailyWage) : null,
        joinedAt: input.joinedAt ? new Date(input.joinedAt) : new Date(),
      },
    });
    if (!res.ok) return res;
    revalidateStaff();
    revalidatePath("/customers/riders");
    return { ok: true };
  }

  const userId = input.userId || null;
  try {
    const linkProblem = await loginLinkProblem(db, null, null, userId);
    if (linkProblem) return { ok: false, error: linkProblem };

    await db.$transaction(async (tx) => {
      const created = await tx.employee.create({
        data: {
          name: input.name.trim(),
          role: input.role.trim() || null,
          ...wageFields(input),
          joinedAt: input.joinedAt ? new Date(input.joinedAt) : new Date(),
          category: input.category ?? null,
          userId,
        },
        select: { id: true },
      });
      if (userId) await carryPenaltiesToLink(tx, created.id, userId);
    });
    revalidateStaff();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendly(e, "Could not add the staff member.") };
  }
}

export async function updateStaff(id: string, input: StaffInput): Promise<StaffResult> {
  await requireRole(FULL_ACCESS);
  const problem = inputProblem(input);
  if (problem) return { ok: false, error: problem };
  try {
    const emp = await db.employee.findUnique({ where: { id }, select: { id: true, name: true, userId: true } });
    if (!emp) return { ok: false, error: "That staff member no longer exists." };

    // A rider's name is copied from the Riders page on every sync; a rename here
    // would be put back within minutes.
    if (input.name.trim() !== emp.name && (await isActiveRider(db, emp.userId))) {
      return { ok: false, error: "This is a rider — change their name on the Riders page. It is copied here automatically." };
    }

    const newUserId = input.userId || null;
    const relinking = newUserId !== emp.userId;
    if (relinking) {
      const linkProblem = await loginLinkProblem(db, id, emp.userId, newUserId);
      if (linkProblem) return { ok: false, error: linkProblem };
    }

    await db.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id },
        data: {
          name: input.name.trim(),
          role: input.role.trim() || null,
          ...wageFields(input),
          joinedAt: input.joinedAt ? new Date(input.joinedAt) : undefined,
          // undefined = keep it; null = clear it.
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(relinking ? { userId: newUserId } : {}),
        },
      });
      if (relinking) await carryPenaltiesToLink(tx, id, newUserId);
    });
    revalidateStaff();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendly(e, "Could not save the changes.") };
  }
}

/**
 * Disable (hide from every list, keep every record) or enable again.
 *
 * Disabling stamps the day they left, because the month they are leaving in is
 * theirs up to that day: a wage worker is paid for the days worked and a fixed
 * salary is paid pro rata. Without a date the whole month either paid in full or
 * vanished. Taking someone back on clears it, so the new spell is open-ended.
 *
 * `leftAt` is stored at PKT noon, the way every other date-only value here is, so
 * the day cannot slip either side of midnight. The caller passes the day; it
 * falls back to today only so an older caller that never knew about it still
 * behaves exactly as it did.
 *
 * The rest of that month is then marked ABSENT. That is NOT what pro-rates the
 * salary — `employedDaysInMonth` and the employment window already do that, and
 * they ignore every day outside it. It matters for the day someone is taken back
 * on: `attendanceCounts` reads an unmarked day as PRESENT, so without these rows
 * a returning employee would be paid for every day of the gap they were away.
 */
export async function setStaffActive(
  id: string,
  active: boolean,
  /** "YYYY-MM-DD", their last working day. Ignored when enabling. */
  leftAtStr?: string
): Promise<StaffResult> {
  await requireRole(FULL_ACCESS);
  try {
    const emp = await db.employee.findUnique({
      where: { id },
      select: { id: true, name: true, active: true, userId: true, joinedAt: true },
    });
    if (!emp) return { ok: false, error: "That staff member no longer exists." };
    if (emp.active === active) return { ok: true };
    if (!active && (await isActiveRider(db, emp.userId))) {
      return { ok: false, error: `${emp.name} is an active rider. Turn the rider off on the Riders page — their staff record follows automatically.` };
    }

    const today = todayPKTString();

    if (!active) {
      const left = (leftAtStr ?? today).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(left)) {
        return { ok: false, error: "Give the leaving date as a real date." };
      }
      const joined = emp.joinedAt.toISOString().slice(0, 10);
      if (left < joined) {
        return { ok: false, error: `${emp.name} joined on ${joined}, so they cannot have left on ${left}.` };
      }
      if (left > today) {
        return { ok: false, error: "The leaving date cannot be in the future." };
      }

      // Days after the leaving day, in the leaving month only. Later months need
      // nothing: a disabled employee is off every list, so there is no unmarked
      // day there to be read as present.
      const rest = daysAfterInMonth(left).map(attendanceDateKey);

      await db.$transaction(async (tx) => {
        await tx.employee.update({ where: { id }, data: { active: false, leftAt: pktNoonToUTC(left) } });
        if (rest.length) {
          // Overwrite, then fill the gaps. Overwriting matters: marking everyone
          // present for the month in one go is common, so these days usually
          // already carry a PRESENT row that is now wrong.
          await tx.attendance.updateMany({
            where: { employeeId: id, date: { in: rest } },
            data: { status: "ABSENT" },
          });
          await tx.attendance.createMany({
            data: rest.map((date) => ({ employeeId: id, date, status: "ABSENT" as const })),
            skipDuplicates: true,
          });
        }
      });
    } else {
      // Back on. Clear the leaving date, and drop the absences that were written
      // ahead for days they had not yet reached — from today on they are working
      // again, and an unmarked day reads as present, which is what is wanted.
      // Absences BEFORE today stay: that gap is real and must not be paid.
      const fromToday = attendanceDateKey(today);
      await db.$transaction(async (tx) => {
        await tx.employee.update({ where: { id }, data: { active: true, leftAt: null } });
        await tx.attendance.deleteMany({
          where: { employeeId: id, status: "ABSENT", date: { gte: fromToday } },
        });
      });
    }

    revalidateStaff();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendly(e, "Could not change the staff member.") };
  }
}

/** Delete for good — only a record with no history at all. */
export async function deleteStaff(id: string): Promise<StaffResult> {
  await requireRole(FULL_ACCESS);
  try {
    const result = await db.$transaction(async (tx): Promise<StaffResult> => {
      const emp = await tx.employee.findUnique({ where: { id }, select: { id: true, name: true, userId: true } });
      if (!emp) return { ok: false, error: "That staff member no longer exists." };
      if (await isActiveRider(tx, emp.userId)) {
        return { ok: false, error: `${emp.name} is an active rider — manage them on the Riders page.` };
      }
      // Counted inside the transaction, so a record added a moment ago still blocks it.
      const h = (await staffHistory(tx, [id])).get(id) ?? { ...EMPTY_HISTORY };
      if (historyTotal(h) > 0) {
        return { ok: false, error: `${emp.name} has ${describeHistory(h)}. Deleting would erase that, so disable them instead.` };
      }
      await tx.employee.delete({ where: { id } });
      return { ok: true };
    });
    if (result.ok) revalidateStaff();
    return result;
  } catch (e) {
    return { ok: false, error: friendly(e, "Could not delete the staff member.") };
  }
}
