"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { DASHBOARD_ROLES, canAccess, landingFor } from "@/lib/access";

export type LoginState = { error: string | null; redirectTo?: string };

/**
 * Sign in. Runs entirely on the SERVER (Next's recommended auth pattern), so
 * Supabase writes the session cookies via Set-Cookie before we hand back control.
 *
 * We return the destination instead of calling redirect(). redirect() makes the
 * client router do a soft transition, which keeps the login page (and its
 * spinner) mounted while it fetches the dashboard's RSC payload AND compiles its
 * client chunks — on a heavy dashboard that looks like a hang. The client turns
 * this into a full document navigation, which paints the server-rendered page
 * immediately (exactly what a manual refresh does).
 */
export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "");

  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    return { error: "Incorrect email or password." };
  }

  // A correct password only proves WHO they are. Customers, sample leads and
  // riders all live in the same Supabase auth namespace — only a staff User row
  // with a dashboard role may come in here. (Riders keep their mobile login.)
  const user = await db.user.findUnique({
    where: { supabaseId: data.user.id },
    select: { role: true, active: true },
  });

  if (!user || !user.active || !DASHBOARD_ROLES.includes(user.role)) {
    await supabase.auth.signOut();
    return { error: "This account cannot access the admin app." };
  }

  // Send them where they asked to go, if their role allows it; otherwise home.
  //
  // `next` is attacker-controllable (?next= on the login URL). startsWith("/") is
  // NOT sufficient: "//evil.com" and "/\evil.com" are protocol-relative URLs that
  // browsers happily send off-site, and canAccess() can't catch them because it
  // returns true immediately for ADMIN/MANAGER ("*") without inspecting the path —
  // so the check failed open on exactly the highest-privilege accounts. Require a
  // single leading slash not followed by another slash or a backslash.
  const isLocalPath = /^\/(?![/\\])/.test(next);
  const target =
    isLocalPath && canAccess(user.role, next) ? next : landingFor(user.role);

  return { error: null, redirectTo: target };
}

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
