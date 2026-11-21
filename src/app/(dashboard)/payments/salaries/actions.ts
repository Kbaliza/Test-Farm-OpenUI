"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { startOfMonth, endOfMonth } from "date-fns";
import { getHeadBalances, checkHeadFunds, guardHeadFundsTx } from "@/lib/head-balances";
import { PAYMENT_HEAD_LABELS } from "@/lib/payment-heads";
import { describeDay } from "@/lib/checklist-penalty";
import { reconcileChecklistPenalties } from "@/app/(dashboard)/checklists/actions";
import { syncRidersToEmployees } from "@/lib/rider-employees";
import { carryPenaltiesToLink, loginLinkProblem } from "@/lib/staff-link";
import { todayPKTString } from "@/lib/pkt";
import {
  attendanceCounts,
  balanceBroughtForward,
  daysInMonth,
  employedDaysInMonth,
  fromFirstWorkedMonth,
  grossForMonth,
  isBeforeMonth,
  monthKey,
  monthTouchesEmployment,
  payrollStart,
  type EmploymentWindow,
  type WorkedMonth,
} from "@/lib/salary-advance";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AttendanceStatus = "PRESENT" | "ABSENT" | "HALF_DAY" | "HOLIDAY";

export type AttendanceEntry = {
  id: string;
  date: string; // "YYYY-MM-DD"
  status: AttendanceStatus;
};

export type AdjEntry = {
  id: string;
  amount: number;
  description: string;
};

export type PayEntry = {
  id: string;
  amount: number;
  head: string;
  headLabel: string;
  notes: string;
  paidAt: string;
};

export type HeadBalance = {
  head: string;
  label: string;
  balance: number;
};

/** One day docked for not doing enough of a checklist. Kept apart from Deduction
 *  so auto-computed money is never confused with what a manager typed in, and so
 *  waiving is its own act rather than a delete. */
export type PenaltyEntry = {
  id: string;
  date: string;
  amount: number;
  itemsDone: number;
  itemsTotal: number;
  detail: string;
  waived: boolean;
  waiveReason: string | null;
};

export type EmployeeRow = {
  id: string;
  name: string;
  /** False when disabled on the Staff page — still listed for a month they have records in. */
  active: boolean;
  role: string;
  /** Which part of the business they work in — the Attendance page filters on this too. */
  category: string | null;
  wageType: "fixed" | "daily";
  baseSalary: number;
  dailyWage: number;
  joinedAt: string;
  /**
   * The day they stopped working here, or null for still working — and also null
   * for anyone disabled before this was recorded, so their past months read
   * exactly as they did.
   */
  leftAt: string | null;
  /**
   * The day pay actually starts from — the joining date, unless a salary was paid
   * for an earlier month, in which case that month is theirs too. See payrollStart.
   */
  payrollFrom: string;
  attendance: AttendanceEntry[];
  bonuses: AdjEntry[];
  deductions: AdjEntry[];
  penalties: PenaltyEntry[];
  payments: PayEntry[];
  /// The balance carried in from earlier months — see src/lib/salary-advance.ts.
  /// > 0 still owed to the worker (added to this month); < 0 extra paid (taken off).
  carryIn: number;
  /// The login this salary record is linked to. Checklist penalties are recorded
  /// against a LOGIN, so without this link they have no salary to come off.
  userId: string | null;
  linkedLogin: string | null;
};

/** A login that a salary record can be linked to. */
export type LoginOption = { id: string; name: string; role: string; linkedTo: string | null };

export type PageData = {
  employees: EmployeeRow[];
  headBalances: HeadBalance[];
  logins: LoginOption[];
  dbReady: boolean;
};

export type ActionResult = { ok: true } | { ok: false; error: string };

// ── Constants ─────────────────────────────────────────────────────────────────

const HEAD_LABELS: Record<string, string> = PAYMENT_HEAD_LABELS;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** How far back an unused advance is looked for. Older than this is long settled. */
const ADVANCE_LOOKBACK_MONTHS = 12;

/** Sorts "2026-9" style keys chronologically. */
function byMonthKey(a: [string, unknown], b: [string, unknown]): number {
  const [ay, am] = a[0].split("-").map(Number);
  const [by, bm] = b[0].split("-").map(Number);
  return ay - by || am - bm;
}

function dateStrToLocal(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

// ── Data fetch ────────────────────────────────────────────────────────────────

export async function getSalariesPageData(
  month: number,
  year: number
): Promise<PageData> {
  await requireRole(FULL_ACCESS);
  try {
    const monthStart = startOfMonth(new Date(year, month - 1, 1));
    const monthEnd   = endOfMonth(new Date(year, month - 1, 1));

    // Make sure every active rider has an active Employee row (create/reactivate),
    // so riders always appear here — then read the up-to-date active list.
    await syncRidersToEmployees();
    // Materialise any day that has closed since the last look — a past day's
    // score cannot be recomputed later, so it has to be written down.
    await reconcileChecklistPenalties();

    // All month-scoped reads are independent — run in parallel.
    const [
      attendance,
      bonuses,
      deductions,
      salaryPayments,
      headBalances,
      employees,
      penalties,
    ] = await Promise.all([
      db.attendance.findMany({ where: { date: { gte: monthStart, lte: monthEnd } } }),
      db.bonus.findMany({ where: { month, year } }),
      db.deduction.findMany({ where: { month, year } }),
      db.salaryPayment.findMany({ where: { month, year } }),
      // Single source of truth for head balances.
      getHeadBalances(),
      // Riders (now synced) + non-rider staff added via attendance.
      // Everyone, disabled included — filtered just below to who belongs in this month.
      db.employee.findMany({ orderBy: { name: "asc" } }),
      db.checklistPenalty.findMany({
        where: { date: { gte: monthStart, lte: monthEnd }, employeeId: { not: null } },
        orderBy: { date: "asc" },
      }),
    ]);

    // Index by employeeId
    const attByEmp = new Map<string, typeof attendance>();
    const bonByEmp = new Map<string, typeof bonuses>();
    const dedByEmp = new Map<string, typeof deductions>();
    const payByEmp = new Map<string, typeof salaryPayments>();
    const penByEmp = new Map<string, typeof penalties>();

    for (const a of attendance) {
      const list = attByEmp.get(a.employeeId) ?? [];
      list.push(a);
      attByEmp.set(a.employeeId, list);
    }
    for (const b of bonuses) {
      const list = bonByEmp.get(b.employeeId) ?? [];
      list.push(b);
      bonByEmp.set(b.employeeId, list);
    }
    for (const d of deductions) {
      const list = dedByEmp.get(d.employeeId) ?? [];
      list.push(d);
      dedByEmp.set(d.employeeId, list);
    }
    const dayOf = (d: Date) => d.toISOString().split("T")[0];
    // A penalty dated outside somebody's employment is not theirs to pay.
    //
    // Defence in depth. reconcileChecklistPenalties no longer writes these, but 76
    // of them (PKR 22,800) were written before it was fixed: a checklist created in
    // August was scored back to the day the rule began against whoever holds it
    // today, so Nouman Ayaz — who joined on 4 October — carried 21 days of
    // September, and Yaseen was still being fined a week after he left.
    //
    // Dropping them HERE keeps them out of the deductions and out of
    // hasMonthRecords, which is the thing that was pulling a brand-new starter onto
    // September's list. Judged against the real employment dates, not payrollStart:
    // a payment can prove someone worked an earlier month, but it cannot make them
    // liable for a checklist on a day they had not started.
    const employmentOf = new Map(
      employees.map((e) => [e.id, { from: dayOf(e.joinedAt), to: e.leftAt ? dayOf(e.leftAt) : null }]),
    );
    for (const p of penalties) {
      if (!p.employeeId) continue; // no staff record — recorded, but never deducted
      const w = employmentOf.get(p.employeeId);
      if (w) {
        const day = dayOf(p.date);
        if (day < w.from) continue;
        if (w.to && day > w.to) continue;
      }
      const list = penByEmp.get(p.employeeId) ?? [];
      list.push(p);
      penByEmp.set(p.employeeId, list);
    }
    for (const p of salaryPayments) {
      const list = payByEmp.get(p.employeeId) ?? [];
      list.push(p);
      payByEmp.set(p.employeeId, list);
    }

    // Who belongs in this month.
    //
    // Three rules, and a record always wins over all of them: anything already
    // written down for this month — attendance, a bonus, a payment, a penalty —
    // keeps the person listed, so nothing anybody did can be hidden by a date.
    //
    //   1. Not yet joined. A new starter used to appear on every month the farm has
    //      ever run, with a full salary against each of them.
    //   2. Still working — listed.
    //   3. Left, and the leaving date is known — listed up to and including that
    //      month, not dropped from the month they worked half of. Disabled with no
    //      leaving date is the old behaviour, records only.
    // The earliest month anybody was actually paid a salary for. A payment for August
    // is proof they worked in August, whatever joining date was typed in afterwards —
    // see payrollStart. One row per person per month, so the table is cheap to read
    // whole and reduce here.
    const allPayMonths = await db.salaryPayment.findMany({ select: { employeeId: true, year: true, month: true } });
    const firstPaid = new Map<string, { year: number; month: number }>();
    for (const p of allPayMonths) {
      const cur = firstPaid.get(p.employeeId);
      if (!cur || p.year < cur.year || (p.year === cur.year && p.month < cur.month)) {
        firstPaid.set(p.employeeId, { year: p.year, month: p.month });
      }
    }

    const hasMonthRecords = (id: string) =>
      attByEmp.has(id) || bonByEmp.has(id) || dedByEmp.has(id) || payByEmp.has(id) || penByEmp.has(id);
    const windowOf = (e: { id: string; joinedAt: Date; leftAt: Date | null }): EmploymentWindow => ({
      from: payrollStart(dayOf(e.joinedAt), firstPaid.get(e.id) ?? null),
      to: e.leftAt ? dayOf(e.leftAt) : null,
    });
    const listed = employees.filter((e) => {
      if (hasMonthRecords(e.id)) return true;
      const w = windowOf(e);
      if (!monthTouchesEmployment(year, month, { from: w.from })) return false; // 1
      if (e.active) return true;                                                // 2
      return w.to ? monthTouchesEmployment(year, month, w) : false;              // 3
    });

    // ── What each worker carries in from earlier months ──────────────────────
    // A month that was underpaid or overpaid used to simply end: August showed
    // "owed", and September started again from zero. The balance now carries either
    // way — see src/lib/salary-advance.ts for the three rules.
    //
    // A worker's carry starts at their first month with attendance or a payment
    // (R3). The page counts an unmarked day as worked, so a month holding nothing
    // but a bonus row would otherwise be valued as a whole month of wages nobody
    // worked, and carried forward as owed.
    const lookbackFirst = startOfMonth(new Date(year, month - 1 - ADVANCE_LOOKBACK_MONTHS, 1));
    const [pastAtt, pastBon, pastDed, pastPay, pastPen] = await Promise.all([
      db.attendance.findMany({ where: { date: { gte: lookbackFirst, lt: monthStart } } }),
      db.bonus.findMany({ where: { year: { gte: lookbackFirst.getFullYear(), lte: year } } }),
      db.deduction.findMany({ where: { year: { gte: lookbackFirst.getFullYear(), lte: year } } }),
      db.salaryPayment.findMany({ where: { year: { gte: lookbackFirst.getFullYear(), lte: year } } }),
      db.checklistPenalty.findMany({
        where: { date: { gte: lookbackFirst, lt: monthStart }, employeeId: { not: null }, waivedAt: null },
      }),
    ]);

    const lookbackYear = lookbackFirst.getFullYear();
    const lookbackMonth = lookbackFirst.getMonth() + 1;
    const inWindow = (y: number, m: number) =>
      isBeforeMonth(monthKey(y, m), year, month) &&
      !isBeforeMonth(monthKey(y, m), lookbackYear, lookbackMonth);

    type PastMonth = { bonus: number; ded: number; pen: number; paid: number; att: Map<string, string>; worked: boolean };
    const pastByEmp = new Map<string, Map<string, PastMonth>>();
    const bucket = (empId: string, y: number, m: number): PastMonth => {
      const months = pastByEmp.get(empId) ?? new Map<string, PastMonth>();
      pastByEmp.set(empId, months);
      const key = monthKey(y, m);
      const cur = months.get(key) ?? { bonus: 0, ded: 0, pen: 0, paid: 0, att: new Map<string, string>(), worked: false };
      months.set(key, cur);
      return cur;
    };

    for (const a of pastAtt) {
      const ds = a.date.toISOString().split("T")[0];
      const [yy, mm] = ds.split("-").map(Number);
      if (!inWindow(yy, mm)) continue;
      const month = bucket(a.employeeId, yy, mm);
      month.att.set(ds, a.status);
      month.worked = true; // R3: a real attendance mark
    }
    for (const b of pastBon) {
      if (!inWindow(b.year, b.month)) continue;
      bucket(b.employeeId, b.year, b.month).bonus += Number(b.amount);
    }
    for (const d of pastDed) {
      if (!inWindow(d.year, d.month)) continue;
      bucket(d.employeeId, d.year, d.month).ded += Number(d.amount);
    }
    for (const p of pastPay) {
      if (!inWindow(p.year, p.month)) continue;
      const month = bucket(p.employeeId, p.year, p.month);
      month.paid += Number(p.amount);
      month.worked = true; // R3: money actually handed over
    }
    for (const p of pastPen) {
      if (!p.employeeId) continue;
      const ds = p.date.toISOString().split("T")[0];
      // Same rule as the current month above: a day they were not employed on is
      // not theirs to pay. Without this an out-of-window penalty was not merely
      // shown on the wrong month, it was CARRIED FORWARD as a debt into every month
      // after it.
      const w = employmentOf.get(p.employeeId);
      if (w && (ds < w.from || (w.to && ds > w.to))) continue;
      const [yy, mm] = ds.split("-").map(Number);
      if (!inWindow(yy, mm)) continue;
      bucket(p.employeeId, yy, mm).pen += Number(p.amount);
    }

    const todayStr = todayPKTString();
    const carryByEmp = new Map<string, number>();
    for (const e of listed) {
      const months = pastByEmp.get(e.id);
      if (!months) continue;
      const wageType: "fixed" | "daily" = e.dailyWage && Number(e.dailyWage) > 0 ? "daily" : "fixed";
      const w = windowOf(e);
      const valued: WorkedMonth[] = [...months.entries()].sort(byMonthKey).map(([key, b]) => {
        const [yy, mm] = key.split("-").map(Number);
        return {
          key,
          worked: b.worked,
          // Valued through the same employment window as the month on screen. An
          // earlier month is otherwise worth a whole month of wages nobody worked,
          // and carries forward as money owed.
          gross: grossForMonth({
            wageType,
            baseSalary: Number(e.baseSalary),
            dailyWage: Number(e.dailyWage ?? 0),
            effectiveDays: attendanceCounts(yy, mm, b.att, todayStr, w).effectiveDays,
            bonusTotal: b.bonus,
            dedTotal: b.ded,
            penTotal: b.pen,
            employedDays: employedDaysInMonth(yy, mm, w),
            monthDays: daysInMonth(yy, mm),
          }),
          paid: b.paid,
        };
      });
      carryByEmp.set(e.id, balanceBroughtForward(fromFirstWorkedMonth(valued)));
    }

    // Logins a salary record can be linked to (see updateEmployee).
    const loginRows = await db.user.findMany({
      where: { active: true },
      select: { id: true, name: true, role: true, employee: { select: { name: true } } },
      orderBy: { name: "asc" },
    });
    const loginName = new Map(loginRows.map((u) => [u.id, u.name]));

    const rows: EmployeeRow[] = listed.map((e) => ({
      id:         e.id,
      name:       e.name,
      role:       e.role ?? "",
      category:   e.category ?? null,
      active:     e.active,
      wageType:   e.dailyWage && Number(e.dailyWage) > 0 ? "daily" : "fixed",
      baseSalary: Number(e.baseSalary),
      dailyWage:  Number(e.dailyWage ?? 0),
      joinedAt:   e.joinedAt.toISOString().split("T")[0],
      leftAt:     e.leftAt ? e.leftAt.toISOString().split("T")[0] : null,
      payrollFrom: windowOf(e).from ?? dayOf(e.joinedAt),
      attendance: (attByEmp.get(e.id) ?? []).map((a) => ({
        id:     a.id,
        date:   a.date.toISOString().split("T")[0],
        status: a.status as AttendanceStatus,
      })),
      bonuses: (bonByEmp.get(e.id) ?? []).map((b) => ({
        id:          b.id,
        amount:      Number(b.amount),
        description: b.description ?? "",
      })),
      deductions: (dedByEmp.get(e.id) ?? []).map((d) => ({
        id:          d.id,
        amount:      Number(d.amount),
        description: d.description ?? "",
      })),
      carryIn: carryByEmp.get(e.id) ?? 0,
      userId: e.userId,
      linkedLogin: e.userId ? loginName.get(e.userId) ?? null : null,
      penalties: (penByEmp.get(e.id) ?? []).map((p) => ({
        id:         p.id,
        date:       p.date.toISOString(),
        amount:     Number(p.amount),
        itemsDone:  p.itemsDone,
        itemsTotal: p.itemsTotal,
        detail:     describeDay(p.itemsDone, p.itemsTotal),
        waived:     !!p.waivedAt,
        waiveReason: p.waiveReason,
      })),
      payments: (payByEmp.get(e.id) ?? []).map((p) => ({
        id:        p.id,
        amount:    Number(p.amount),
        head:      p.head,
        headLabel: HEAD_LABELS[p.head] ?? p.head,
        notes:     p.notes ?? "",
        paidAt:    p.paidAt.toLocaleDateString("en-GB", {
          day: "2-digit", month: "short", timeZone: "Asia/Karachi",
        }),
      })),
    }));

    // headBalances comes straight from getHeadBalances() (canonical helper).
    const logins: LoginOption[] = loginRows.map((u) => ({
      id: u.id, name: u.name, role: u.role, linkedTo: u.employee?.name ?? null,
    }));
    return { employees: rows, headBalances, logins, dbReady: true };
  } catch (e) {
    console.error("[salaries] getSalariesPageData failed:", e);
    return { employees: [], headBalances: [], logins: [], dbReady: false };
  }
}

// ── Salary configuration (wage / join date per rider) ────────────────────────

export async function updateEmployee(
  id: string,
  data: {
    role: string;
    wageType: "fixed" | "daily";
    wage: number;
    joinedAt: string;
    /** Leave out to keep the current link; null to unlink; a user id to link that login. */
    userId?: string | null;
  }
): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    const emp = await db.employee.findUnique({ where: { id }, select: { id: true, userId: true } });
    if (!emp) return { ok: false, error: "Salary record not found." };

    const newUserId = data.userId ?? null;
    const relinking = data.userId !== undefined && newUserId !== emp.userId;

    // Same rules the Staff page uses — see src/lib/staff-link.ts.
    if (relinking) {
      const problem = await loginLinkProblem(db, id, emp.userId, newUserId);
      if (problem) return { ok: false, error: problem };
    }

    await db.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id },
        data: {
          role:      data.role.trim() || null,
          baseSalary: data.wageType === "fixed" ? new Prisma.Decimal(data.wage) : new Prisma.Decimal(0),
          dailyWage:  data.wageType === "daily" ? new Prisma.Decimal(data.wage) : null,
          joinedAt:   data.joinedAt ? new Date(data.joinedAt) : undefined,
          ...(relinking ? { userId: newUserId } : {}),
        },
      });
      if (relinking) await carryPenaltiesToLink(tx, id, newUserId);
    });
    revalidatePath("/payments/salaries");
    revalidatePath("/staff");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update." };
  }
}

// ── Attendance ────────────────────────────────────────────────────────────────

export async function upsertAttendance(
  employeeId: string,
  dateStr: string,
  status: AttendanceStatus
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  try {
    const date = dateStrToLocal(dateStr);
    const record = await db.attendance.upsert({
      where: { employeeId_date: { employeeId, date } },
      update: { status },
      create: { employeeId, date, status },
    });
    return { ok: true, id: record.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update attendance." };
  }
}

// ── Bonuses ───────────────────────────────────────────────────────────────────

export async function addBonus(
  employeeId: string,
  month: number,
  year: number,
  amount: number,
  description: string
): Promise<{ ok: true; entry: AdjEntry } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  if (amount <= 0)           return { ok: false, error: "Amount must be greater than 0." };
  if (!description.trim())   return { ok: false, error: "Description is required." };
  try {
    const b = await db.bonus.create({
      data: { employeeId, month, year, amount: new Prisma.Decimal(amount), description: description.trim() },
    });
    revalidatePath("/payments/salaries");
    return { ok: true, entry: { id: b.id, amount: Number(b.amount), description: b.description ?? "" } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to add bonus." };
  }
}

export async function removeBonus(id: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.bonus.delete({ where: { id } });
    revalidatePath("/payments/salaries");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to remove." };
  }
}

// ── Deductions ────────────────────────────────────────────────────────────────

export async function addDeduction(
  employeeId: string,
  month: number,
  year: number,
  amount: number,
  description: string
): Promise<{ ok: true; entry: AdjEntry } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  if (amount <= 0)           return { ok: false, error: "Amount must be greater than 0." };
  if (!description.trim())   return { ok: false, error: "Description is required." };
  try {
    const d = await db.deduction.create({
      data: { employeeId, month, year, amount: new Prisma.Decimal(amount), description: description.trim() },
    });
    revalidatePath("/payments/salaries");
    return { ok: true, entry: { id: d.id, amount: Number(d.amount), description: d.description ?? "" } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to add deduction." };
  }
}

export async function removeDeduction(id: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.deduction.delete({ where: { id } });
    revalidatePath("/payments/salaries");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to remove." };
  }
}

// ── Salary payment ────────────────────────────────────────────────────────────

export async function recordSalaryPayment(data: {
  employeeId: string;
  month: number;
  year: number;
  amount: number;
  head: string;
  notes: string;
}): Promise<{ ok: true; entry: PayEntry } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  if (!data.amount || data.amount <= 0) return { ok: false, error: "Amount must be greater than 0." };
  if (!data.head)                       return { ok: false, error: "Select a payment head." };
  try {
    const guard = await checkHeadFunds(data.head, data.amount); // fast pre-check for UX
    if (!guard.ok) return guard;
    const p = await db.$transaction(async (tx) => {
      await guardHeadFundsTx(tx, data.head, data.amount); // race-free guard inside the write
      return tx.salaryPayment.create({
        data: {
          employeeId: data.employeeId,
          month:      data.month,
          year:       data.year,
          amount:     new Prisma.Decimal(data.amount),
          head:       data.head as never,
          notes:      data.notes.trim() || null,
        },
      });
    });
    revalidatePath("/payments/salaries");
    revalidatePath("/payments/expenses"); // salary payments also show in the expenses feed
    revalidatePath("/"); // dashboard head-balance / expenses / profit tiles
    return {
      ok: true,
      entry: {
        id:        p.id,
        amount:    Number(p.amount),
        head:      p.head,
        headLabel: HEAD_LABELS[p.head] ?? p.head,
        notes:     p.notes ?? "",
        paidAt:    p.paidAt.toLocaleDateString("en-GB", {
          day: "2-digit", month: "short", timeZone: "Asia/Karachi",
        }),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to record payment." };
  }
}
