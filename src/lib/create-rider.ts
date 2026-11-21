import "server-only";
import { db } from "@/lib/db";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { ensureRiderEmployee, type RiderEmployeeDetails } from "@/lib/rider-employees";

// Making a rider: the app login (Supabase), the User, the Rider, and the staff
// record — in that order, and all or nothing. Used by the Riders page and by the
// Staff page's "give this person a rider login", so there is one way to do it
// and it always ends with exactly one staff record.

export type NewRider = {
  name: string;
  email: string;
  password: string;
  phone?: string;
  vehicle?: string;
  cnic?: string;
  /** Pay and dates for the staff record; a same-named unlinked record is reused. */
  employee?: RiderEmployeeDetails;
};

export type CreateRiderResult = { ok: true; userId: string; riderId: string; employeeId: string } | { ok: false; error: string };

export async function createRiderAccount(data: NewRider): Promise<CreateRiderResult> {
  const name = data.name.trim();
  const email = data.email.trim().toLowerCase();
  if (!name) return { ok: false, error: "Name is required." };
  if (!email) return { ok: false, error: "Email is required." };
  if (!data.password || data.password.length < 6) return { ok: false, error: "Password must be at least 6 characters." };

  // 1. The app login.
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: data.password,
    email_confirm: true,
    user_metadata: { name, role: "RIDER" },
  });
  if (authError || !authData.user) {
    if (authError?.message.includes("already registered") || authError?.message.includes("already been registered")) {
      return { ok: false, error: "An account with this email already exists." };
    }
    return { ok: false, error: authError?.message ?? "Failed to create auth account." };
  }
  const supabaseId = authData.user.id;

  // 2. User + Rider + staff record; the login is removed again if any of it fails.
  try {
    const user = await db.user.create({
      data: { name, email, phone: data.phone?.trim() || null, role: "RIDER", active: true },
    });
    await db.$executeRaw`UPDATE "User" SET "supabaseId" = ${supabaseId} WHERE "id" = ${user.id}`;
    const rider = await db.rider.create({
      data: {
        userId: user.id,
        vehicle: data.vehicle?.trim() || null,
        active: true,
        ...({ cnic: data.cnic?.trim() || null } as object),
      } as Parameters<typeof db.rider.create>[0]["data"],
      select: { id: true },
    });
    const employeeId = await ensureRiderEmployee(user.id, name, data.employee ?? {});
    return { ok: true, userId: user.id, riderId: rider.id, employeeId };
  } catch (e) {
    await supabaseAdmin.auth.admin.deleteUser(supabaseId).catch(() => null);
    const msg = e instanceof Error ? e.message : "Failed to create rider.";
    if (msg.includes("Unique constraint") && msg.includes("email")) return { ok: false, error: "A user with this email already exists in the system." };
    return { ok: false, error: msg };
  }
}
