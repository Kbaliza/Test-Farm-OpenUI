import "server-only";
import { cache } from "react";
import { setAuditActor } from "@/lib/audit-actor";
import type { Role } from "@prisma/client";
import { db } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { DASHBOARD_ROLES } from "@/lib/access";

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
};

/**
 * The signed-in staff member, or null.
 *
 * The DB `User` row is the source of truth — the Supabase session only tells us
 * WHO is signed in. Customers and sample leads share the same Supabase auth
 * namespace but have no `User` row, so they resolve to null and are rejected.
 *
 * `cache()` de-dupes this across a single request (layout + page + actions).
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  const user = await db.user.findUnique({
    where: { supabaseId: data.user.id },
    select: { id: true, name: true, email: true, role: true, active: true },
  });
  if (!user || !user.active) return null;

  // Every write action calls one of the guards below, and each of them comes
  // through here — so the audit log learns who is acting without a single action
  // having to remember to tell it.
  setAuditActor({ id: user.id, name: user.name, role: user.role });
  return user;
});

/** The signed-in user, restricted to those allowed into the web dashboard. */
export async function getDashboardUser(): Promise<SessionUser | null> {
  const user = await getSessionUser();
  if (!user || !DASHBOARD_ROLES.includes(user.role)) return null;
  return user;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Guard for server actions. Middleware and the layout gate PAGES, but a server
 * action is a directly-invocable POST endpoint — a signed-in user with a limited
 * role could otherwise replay an action from a module they can't even see. Every
 * mutating action calls this.
 */
export async function requireRole(roles: Role[]): Promise<SessionUser> {
  const user = await getDashboardUser();
  if (!user) throw new AuthError("You are not signed in.");
  if (!roles.includes(user.role)) throw new AuthError("You do not have permission to do that.");
  return user;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getDashboardUser();
  if (!user) throw new AuthError("You are not signed in.");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  return requireRole(["ADMIN"]);
}

/** Full access — everything except the limited single-module roles. */
export const FULL_ACCESS: Role[] = ["ADMIN", "MANAGER"];

/**
 * Who may work the consignment module: the two full-access roles, plus the role
 * that exists to run it.
 *
 * A separate list rather than a wider FULL_ACCESS — FULL_ACCESS guards every
 * other module in the app, so adding a limited role to it would hand that role
 * the whole system. Only the actions under /retail use this, and voiding a drop
 * stays admin-only, as it always was.
 */
export const RETAIL_ACCESS: Role[] = ["ADMIN", "MANAGER", "RETAIL_MANAGER"];

/**
 * Who may work the Over the Counter sale and purchase pages: the two full-access
 * roles, plus packaging. Separate for the same reason as RETAIL_ACCESS. Only the
 * actions under /over-the-counter/sale and /over-the-counter/purchase use this;
 * farm sales stays FULL_ACCESS.
 */
export const OTC_ACCESS: Role[] = ["ADMIN", "MANAGER", "PACKAGING"];
