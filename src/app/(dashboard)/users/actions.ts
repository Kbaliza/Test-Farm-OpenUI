"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type Role } from "@prisma/client";
import { db } from "@/lib/db";
import { historyTotal, staffHistory } from "@/lib/staff-link";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireRole, requireUser, AuthError } from "@/lib/auth";
import { ASSIGNABLE_ROLES, ROLE_LABELS, USER_ADMIN_ROLES } from "@/lib/access";

// Staff accounts. Mirrors the proven rider flow (customers/riders/actions.ts):
// Supabase Auth owns the password; the DB User row owns identity + role.
//
// Admin protection (enforced HERE, never in the UI — the UI can be bypassed):
//   * Only ADMIN or MANAGER may reach this module at all.
//   * A MANAGER may not create, edit, deactivate or delete an ADMIN, nor promote
//     anyone to ADMIN. Only an ADMIN can touch an ADMIN.
//   * Nobody may deactivate/delete themselves, and the LAST active ADMIN can
//     never be removed (lock-out guard).

export type ActionResult = { ok: true } | { ok: false; error: string };

export type UserRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  roleLabel: string;
  active: boolean;
  hasLogin: boolean;
  isSelf: boolean;
  createdAt: string;
};

export type UsersPageData = {
  users: UserRow[];
  canManageAdmins: boolean;  // true only for ADMIN
  currentUserId: string;
  dbReady: boolean;
};

const BAN_FOREVER = "876600h"; // 100 years — the ban toggle used by riders

function fail(e: unknown): ActionResult {
  if (e instanceof AuthError) return { ok: false, error: e.message };
  return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
}

/** Guard: the ADMIN role may only be created/changed/removed by an ADMIN. */
async function assertMayTouchAdmin(actorRole: Role, targetRole: Role | null, newRole?: Role) {
  const touchesAdmin = targetRole === "ADMIN" || newRole === "ADMIN";
  if (touchesAdmin && actorRole !== "ADMIN") {
    throw new AuthError("Only an Admin can manage Admin accounts.");
  }
}

/** Guard: never remove the last active Admin — that would lock everyone out. */
async function assertNotLastAdmin(targetId: string) {
  const target = await db.user.findUnique({ where: { id: targetId }, select: { role: true, active: true } });
  if (target?.role !== "ADMIN" || !target.active) return;
  const activeAdmins = await db.user.count({ where: { role: "ADMIN", active: true } });
  if (activeAdmins <= 1) {
    throw new AuthError("This is the last active Admin — it cannot be removed or deactivated.");
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

export async function getUsersPageData(): Promise<UsersPageData> {
  try {
    const me = await requireRole(USER_ADMIN_ROLES);

    const users = await db.user.findMany({
      // Riders are not staff accounts — they are managed on the Riders page and
      // only sign in to the mobile app.
      where: { role: { not: "RIDER" } },
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: {
        id: true, name: true, email: true, phone: true,
        role: true, active: true, supabaseId: true, createdAt: true,
      },
    });

    return {
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        roleLabel: ROLE_LABELS[u.role] ?? u.role,
        active: u.active,
        hasLogin: !!u.supabaseId,
        isSelf: u.id === me.id,
        createdAt: u.createdAt.toISOString(),
      })),
      canManageAdmins: me.role === "ADMIN",
      currentUserId: me.id,
      dbReady: true,
    };
  } catch (e) {
    console.error("[users] getUsersPageData:", e);
    return { users: [], canManageAdmins: false, currentUserId: "", dbReady: false };
  }
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createUser(data: {
  name: string;
  email: string;
  password: string;
  role: Role;
  phone?: string;
}): Promise<ActionResult> {
  try {
    const me = await requireRole(USER_ADMIN_ROLES);

    if (!data.name.trim()) return { ok: false, error: "Name is required." };
    if (!data.email.trim()) return { ok: false, error: "Email is required." };
    if (!data.password || data.password.length < 6)
      return { ok: false, error: "Password must be at least 6 characters." };
    if (!ASSIGNABLE_ROLES.includes(data.role))
      return { ok: false, error: "Invalid role." };

    await assertMayTouchAdmin(me.role, null, data.role);

    const email = data.email.trim().toLowerCase();
    const name = data.name.trim();

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) return { ok: false, error: "A user with that email already exists." };

    // 1. Supabase Auth account (owns the password).
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: data.password,
      email_confirm: true,
      user_metadata: { name },
      app_metadata: { role: data.role },
    });
    if (authError || !authData.user) {
      return { ok: false, error: authError?.message ?? "Failed to create the login." };
    }
    const supabaseId = authData.user.id;

    // 2. DB User + Employee — roll the auth user back if anything fails, so the
    //    email stays reusable (same pattern as createRider).
    try {
      await db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name,
            email,
            phone: data.phone?.trim() || null,
            role: data.role,
            supabaseId,
            active: true,
          },
        });
        // Software users are staff too — give them an Employee record so they
        // show up in Attendance / Salaries.
        await tx.employee.create({
          data: {
            userId: user.id,
            name,
            role: ROLE_LABELS[data.role] ?? data.role,
            baseSalary: new Prisma.Decimal(0),
            joinedAt: new Date(),
          },
        });
      });
    } catch (e) {
      await supabaseAdmin.auth.admin.deleteUser(supabaseId).catch(() => null);
      return fail(e);
    }

    revalidatePath("/users");
    revalidatePath("/attendance");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── Update (name / phone / role) ──────────────────────────────────────────────

export async function updateUser(
  id: string,
  data: { name: string; phone?: string; role: Role }
): Promise<ActionResult> {
  try {
    const me = await requireRole(USER_ADMIN_ROLES);

    const target = await db.user.findUnique({
      where: { id },
      select: { role: true, supabaseId: true },
    });
    if (!target) return { ok: false, error: "User not found." };
    if (!ASSIGNABLE_ROLES.includes(data.role)) return { ok: false, error: "Invalid role." };
    if (!data.name.trim()) return { ok: false, error: "Name is required." };

    // Blocks a Manager from editing an Admin AND from promoting anyone to Admin.
    await assertMayTouchAdmin(me.role, target.role, data.role);

    // Demoting the only Admin would lock everyone out just as surely as deleting.
    if (target.role === "ADMIN" && data.role !== "ADMIN") {
      await assertNotLastAdmin(id);
    }

    await db.user.update({
      where: { id },
      data: { name: data.name.trim(), phone: data.phone?.trim() || null, role: data.role },
    });

    // Keep the role visible to the mobile app (DB stays the source of truth).
    if (target.supabaseId) {
      await supabaseAdmin.auth.admin
        .updateUserById(target.supabaseId, { app_metadata: { role: data.role } })
        .catch(() => null);
    }

    revalidatePath("/users");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── Reset password ────────────────────────────────────────────────────────────

export async function resetUserPassword(id: string, password: string): Promise<ActionResult> {
  try {
    const me = await requireRole(USER_ADMIN_ROLES);
    if (!password || password.length < 6)
      return { ok: false, error: "Password must be at least 6 characters." };

    const target = await db.user.findUnique({
      where: { id },
      select: { role: true, supabaseId: true },
    });
    if (!target) return { ok: false, error: "User not found." };
    if (!target.supabaseId) return { ok: false, error: "This user has no login." };

    await assertMayTouchAdmin(me.role, target.role);

    const { error } = await supabaseAdmin.auth.admin.updateUserById(target.supabaseId, { password });
    if (error) return { ok: false, error: error.message };

    revalidatePath("/users");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── Activate / deactivate (revokes the login) ─────────────────────────────────

export async function setUserActive(id: string, active: boolean): Promise<ActionResult> {
  try {
    const me = await requireRole(USER_ADMIN_ROLES);

    const target = await db.user.findUnique({
      where: { id },
      select: { role: true, supabaseId: true },
    });
    if (!target) return { ok: false, error: "User not found." };

    await assertMayTouchAdmin(me.role, target.role);
    if (id === me.id && !active) return { ok: false, error: "You cannot deactivate your own account." };
    if (!active) await assertNotLastAdmin(id);

    await db.user.update({ where: { id }, data: { active } });

    // Banning is what actually stops them signing in (same trick as riders).
    if (target.supabaseId) {
      await supabaseAdmin.auth.admin
        .updateUserById(target.supabaseId, { ban_duration: active ? "none" : BAN_FOREVER })
        .catch(() => null);
    }

    revalidatePath("/users");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── Remove ────────────────────────────────────────────────────────────────────
// Hard-delete only when the user owns no records; otherwise deactivate, which
// revokes the login while preserving the audit trail (enteredBy / salaries).

export async function removeUser(id: string): Promise<ActionResult> {
  try {
    const me = await requireRole(USER_ADMIN_ROLES);

    const target = await db.user.findUnique({
      where: { id },
      select: {
        role: true, supabaseId: true,
        employee: { select: { id: true } },
        _count: { select: { payments: true, expenses: true, ledgerEntries: true, inventory: true, notes: true } },
      },
    });
    if (!target) return { ok: false, error: "User not found." };

    await assertMayTouchAdmin(me.role, target.role);
    if (id === me.id) return { ok: false, error: "You cannot remove your own account." };
    await assertNotLastAdmin(id);

    const hasHistory =
      target._count.payments + target._count.expenses + target._count.ledgerEntries +
      target._count.inventory + target._count.notes > 0;

    // Kill the login either way.
    if (target.supabaseId) {
      await supabaseAdmin.auth.admin.deleteUser(target.supabaseId).catch(() => null);
    }

    if (hasHistory) {
      // Keep the row so their entries stay attributable.
      await db.user.update({ where: { id }, data: { active: false, supabaseId: null } });
    } else {
      await db.$transaction(async (tx) => {
        if (target.employee) {
          // A staff record with attendance or salary history can't be deleted without
          // erasing that history (and the database refuses it). Keep the record —
          // unlinked from the login — and delete only the login.
          const h = (await staffHistory(tx, [target.employee.id])).get(target.employee.id);
          if (h && historyTotal(h) > 0) {
            await tx.employee.update({ where: { id: target.employee.id }, data: { userId: null } });
          } else {
            await tx.employee.delete({ where: { id: target.employee.id } });
          }
        }
        await tx.user.delete({ where: { id } });
      });
    }

    revalidatePath("/users");
    revalidatePath("/attendance");
    revalidatePath("/staff");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Used by the client to decide what to show — never as the security boundary. */
export async function getCurrentUser() {
  // requireUser() rather than a bare getSessionUser(): this is an exported server
  // action, i.e. a directly-invocable POST endpoint, and getSessionUser only checks
  // for an active User row — it does NOT apply DASHBOARD_ROLES. That made this the
  // one dashboard action a RIDER (who holds a valid Supabase session for the mobile
  // app) could call. It only ever returns the caller's own row, so the impact was
  // small, but every other action in the app guards and this shouldn't be the gap.
  return requireUser();
}
