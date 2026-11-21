import "server-only";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { carryPenaltiesToLink } from "@/lib/staff-link";

// One person, one staff record — even when they are a rider.
//
// A rider has a login (User + Rider) for the app and the checklists, and a staff
// record (Employee) for attendance, pay and penalties. The two are joined by
// Employee.userId. For a long time the sync below CREATED a staff record for
// every rider that had none, with a salary of 0. That is where the duplicates
// came from: the office had already added "Zeeshan Khattak" on the Staff page,
// the sync added a second one for his login, attendance and pay went on the
// first and the checklist penalties on the second — so nothing was ever
// deducted. The sync no longer creates anything. A rider's staff record is made
// exactly once, when the rider is created (from the Riders page or the Staff
// page), and if a same-named staff record is already there it is linked instead.

/**
 * Keep every active rider's staff record active and named like the login.
 * Nothing is created here — see above.
 */
export async function syncRidersToEmployees(): Promise<void> {
  const [riders, employees] = await Promise.all([
    db.rider.findMany({ where: { active: true }, select: { userId: true, user: { select: { name: true } } } }),
    db.employee.findMany({ where: { userId: { not: null } }, select: { id: true, userId: true, name: true, active: true } }),
  ]);
  const empByUser = new Map(employees.map((e) => [e.userId as string, e]));
  for (const r of riders) {
    const e = empByUser.get(r.userId);
    if (!e) continue;
    if (!e.active || e.name !== r.user.name) {
      // Back on means the spell is open again: an old leaving date would
      // otherwise keep cutting their months short.
      await db.employee.update({ where: { id: e.id }, data: { name: r.user.name, active: true, leftAt: null } });
    }
  }
}

export type RiderEmployeeDetails = {
  role?: string;
  category?: string | null;
  baseSalary?: number;
  dailyWage?: number | null;
  joinedAt?: Date;
};

/**
 * The staff record for a rider login: the one already linked, else an unlinked
 * staff record of the same name (the office added the person first), else a new
 * one. Linking carries the login's checklist penalties onto the record.
 */
export async function ensureRiderEmployee(userId: string, name: string, details: RiderEmployeeDetails = {}): Promise<string> {
  const clean = name.trim();
  const linked = await db.employee.findUnique({ where: { userId }, select: { id: true } });
  if (linked) {
    await db.employee.update({ where: { id: linked.id }, data: { name: clean, active: true, leftAt: null } });
    return linked.id;
  }
  const sameName = await db.employee.findFirst({
    where: { userId: null, name: { equals: clean, mode: "insensitive" } },
    orderBy: [{ active: "desc" }, { joinedAt: "asc" }],
    select: { id: true },
  });
  return db.$transaction(async (tx) => {
    if (sameName) {
      await tx.employee.update({
        where: { id: sameName.id },
        data: { userId, name: clean, active: true, leftAt: null, role: details.role ?? undefined },
      });
      await carryPenaltiesToLink(tx, sameName.id, userId);
      return sameName.id;
    }
    const created = await tx.employee.create({
      data: {
        userId,
        name: clean,
        role: details.role ?? "Rider",
        category: details.category ?? null,
        baseSalary: new Prisma.Decimal(details.baseSalary ?? 0),
        dailyWage: details.dailyWage != null ? new Prisma.Decimal(details.dailyWage) : null,
        joinedAt: details.joinedAt ?? new Date(),
      },
      select: { id: true },
    });
    await carryPenaltiesToLink(tx, created.id, userId);
    return created.id;
  });
}
