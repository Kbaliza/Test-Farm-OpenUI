import "server-only";
import { pktNoonToUTC, toDateStrPKT } from "@/lib/pkt";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

// Rules shared by every place that edits a staff record (Staff page, Salaries,
// Users), so they cannot drift apart.

type Client = Prisma.TransactionClient | typeof db;

/**
 * Whether this login belongs to an ACTIVE rider.
 *
 * An active rider's staff record is owned by the rider sync
 * (syncRidersToEmployees): it is switched back on and renamed from the
 * rider whenever a salary or expense page loads. Anything that disables, deletes,
 * renames or re-links it here would be quietly undone — so those changes belong on
 * the Riders page.
 */
export async function isActiveRider(client: Client, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const rider = await client.rider.findFirst({ where: { userId, active: true }, select: { id: true } });
  return !!rider;
}

/**
 * Why a staff record cannot be linked to `newUserId`, or null when it can.
 *
 * `employeeId` is null for a record that does not exist yet; `currentUserId` is
 * the login it is linked to today.
 */
export async function loginLinkProblem(
  client: Client,
  employeeId: string | null,
  currentUserId: string | null,
  newUserId: string | null
): Promise<string | null> {
  if (newUserId === currentUserId) return null;
  if (await isActiveRider(client, currentUserId)) {
    return "This staff member is a rider, and is linked to their login automatically — that can't be changed here.";
  }
  if (newUserId) {
    const user = await client.user.findUnique({
      where: { id: newUserId },
      select: { id: true, employee: { select: { id: true, name: true } } },
    });
    if (!user) return "That login no longer exists.";
    if (user.employee && user.employee.id !== employeeId) {
      return `That login is already linked to "${user.employee.name}". Unlink it there first.`;
    }
  }
  return null;
}

/**
 * Make checklist penalties follow a change of linked login. Call it inside the
 * same transaction that writes the link.
 *
 * Penalties are recorded against a LOGIN and attached to a staff record when the
 * day is scored. So: take off any that belong to a login this record is no longer
 * linked to, and bring on the new login's days that were scored before any staff
 * record was linked — left alone, those would never come off a salary.
 */
export async function carryPenaltiesToLink(
  tx: Prisma.TransactionClient,
  employeeId: string,
  newUserId: string | null
): Promise<void> {
  await tx.checklistPenalty.updateMany({
    where: { employeeId, ...(newUserId ? { userId: { not: newUserId } } : {}) },
    data: { employeeId: null },
  });
  if (newUserId) {
    // Only the days this person was actually employed for.
    //
    // Without the window this was a loaded gun. A login with no staff record still
    // collected penalties — 93 of them on production, PKR 27,900 — and linking it
    // brought the whole lot onto the staff record at once, including days from long
    // before they joined. That is the same fault that had Nouman Ayaz, who started
    // on 4 October, carrying 21 days of September: a fine attached to somebody for
    // a day they did not work here.
    const emp = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { joinedAt: true, leftAt: true },
    });
    // Compared day by day, not timestamp by timestamp. A penalty is keyed at PKT
    // noon while joinedAt carries whatever time of day the record was made, so a
    // raw >= would have thrown away the joining day itself whenever somebody was
    // added in the afternoon.
    const dayKey = (d: Date) => pktNoonToUTC(toDateStrPKT(d));
    await tx.checklistPenalty.updateMany({
      where: {
        userId: newUserId,
        employeeId: null,
        ...(emp
          ? { date: { gte: dayKey(emp.joinedAt), ...(emp.leftAt ? { lte: dayKey(emp.leftAt) } : {}) } }
          : {}),
      },
      data: { employeeId },
    });
  }
}

/** Everything that records work or pay against a staff member. */
export type StaffHistory = {
  attendance: number;
  payments: number;
  bonuses: number;
  deductions: number;
  penalties: number;
};

export const EMPTY_HISTORY: StaffHistory = { attendance: 0, payments: 0, bonuses: 0, deductions: 0, penalties: 0 };

export function historyTotal(h: StaffHistory): number {
  return h.attendance + h.payments + h.bonuses + h.deductions + h.penalties;
}

/**
 * How much history each staff member has.
 *
 * Deleting a staff record with ANY of this would either be refused by the database
 * or erase the record of when they worked and what they were paid — which is why a
 * staff member with history can only be disabled.
 */
export async function staffHistory(client: Client, employeeIds: string[]): Promise<Map<string, StaffHistory>> {
  const out = new Map<string, StaffHistory>(employeeIds.map((id) => [id, { ...EMPTY_HISTORY }]));
  if (employeeIds.length === 0) return out;
  const where = { employeeId: { in: employeeIds } };
  const [att, pay, bon, ded, pen] = await Promise.all([
    client.attendance.groupBy({ by: ["employeeId"], where, _count: { _all: true } }),
    client.salaryPayment.groupBy({ by: ["employeeId"], where, _count: { _all: true } }),
    client.bonus.groupBy({ by: ["employeeId"], where, _count: { _all: true } }),
    client.deduction.groupBy({ by: ["employeeId"], where, _count: { _all: true } }),
    client.checklistPenalty.groupBy({ by: ["employeeId"], where, _count: { _all: true } }),
  ]);
  const add = (rows: { employeeId: string | null; _count: { _all: number } }[], field: keyof StaffHistory) => {
    for (const r of rows) {
      const h = r.employeeId ? out.get(r.employeeId) : undefined;
      if (h) h[field] = r._count._all;
    }
  };
  add(att, "attendance");
  add(pay, "payments");
  add(bon, "bonuses");
  add(ded, "deductions");
  add(pen, "penalties");
  return out;
}

/** "31 attendance days, 2 salary payments" — for messages and the Staff list. */
export function describeHistory(h: StaffHistory): string {
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (h.attendance) parts.push(plural(h.attendance, "attendance day", "attendance days"));
  if (h.payments) parts.push(plural(h.payments, "salary payment", "salary payments"));
  if (h.bonuses) parts.push(plural(h.bonuses, "bonus", "bonuses"));
  if (h.deductions) parts.push(plural(h.deductions, "deduction", "deductions"));
  if (h.penalties) parts.push(plural(h.penalties, "checklist penalty", "checklist penalties"));
  return parts.join(", ");
}
