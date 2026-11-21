"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { revalidatePath } from "next/cache";
import { ensureRiderEmployee } from "@/lib/rider-employees";
import { createRiderAccount } from "@/lib/create-rider";

export type RiderEntry = {
  id: string;
  userId: string;
  name: string;
  phone: string | null;
  email: string;
  vehicle: string | null;
  cnic: string | null;
  active: boolean;
  hasAuth: boolean;
  assignedShifts: string[];
  customerCount: number;
};

export type RiderResult = { ok: true } | { ok: false; error: string };

export async function getRiders(): Promise<{ riders: RiderEntry[]; dbReady: boolean }> {
  await requireRole(FULL_ACCESS);
  try {
    const riders = await db.rider.findMany({
      include: {
        user: true,
        shifts: { select: { name: true } },
        _count: { select: { customers: true } },
      },
      orderBy: { user: { name: "asc" } },
    });
    return {
      riders: riders.map((r) => ({
        id: r.id,
        userId: r.userId,
        name: r.user.name,
        phone: r.user.phone,
        email: r.user.email,
        vehicle: r.vehicle,
        cnic: (r as Record<string, unknown>).cnic as string | null ?? null,
        active: r.active,
        hasAuth: !!(r.user as Record<string, unknown>).supabaseId,
        assignedShifts: r.shifts.map((s) => s.name),
        customerCount: r._count.customers,
      })),
      dbReady: true,
    };
  } catch {
    return { riders: [], dbReady: false };
  }
}

export async function createRider(data: {
  name: string;
  email: string;
  password: string;
  phone?: string;
  vehicle?: string;
  cnic?: string;
}): Promise<RiderResult> {
  await requireRole(FULL_ACCESS);
  // The same steps the Staff page takes for "give this person a rider login",
  // so a rider ends up with exactly one staff record either way.
  const res = await createRiderAccount(data);
  if (!res.ok) return res;
  revalidatePath("/customers/riders");
  revalidatePath("/staff");
  revalidatePath("/payments/salaries");
  revalidatePath("/payments/expenses");
  return { ok: true };
}

export async function updateRider(
  riderId: string,
  data: { name: string; phone?: string; vehicle?: string; cnic?: string; newPassword?: string }
): Promise<RiderResult> {
  await requireRole(FULL_ACCESS);
  if (!data.name.trim()) return { ok: false, error: "Name is required." };
  if (data.newPassword && data.newPassword.length < 6)
    return { ok: false, error: "Password must be at least 6 characters." };

  try {
    const rider = await db.rider.findUnique({
      where: { id: riderId },
      include: { user: true },
    });
    if (!rider) return { ok: false, error: "Rider not found." };

    // Update DB records
    await Promise.all([
      db.user.update({
        where: { id: rider.userId },
        data: { name: data.name.trim(), phone: data.phone?.trim() || null },
      }),
      db.rider.update({
        where: { id: riderId },
        data: {
          vehicle: data.vehicle?.trim() || null,
          ...({ cnic: data.cnic?.trim() || null } as object),
        } as Parameters<typeof db.rider.update>[0]["data"],
      }),
    ]);

    // Keep the rider's Employee row in step (name + reactivate) so salary lists match.
    await ensureRiderEmployee(rider.userId, data.name.trim());

    // Update password in Supabase Auth if provided
    const supabaseId = (rider.user as Record<string, unknown>).supabaseId as string | null;
    if (data.newPassword && supabaseId) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(
        supabaseId,
        { password: data.newPassword }
      );
      if (error) return { ok: false, error: `Rider updated but password change failed: ${error.message}` };
    }

    revalidatePath("/customers/riders");
    revalidatePath("/payments/salaries");
    revalidatePath("/payments/expenses");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update rider." };
  }
}

export async function toggleRiderActive(riderId: string): Promise<RiderResult> {
  await requireRole(FULL_ACCESS);
  try {
    const rider = await db.rider.findUnique({
      where: { id: riderId },
      include: { user: true },
    });
    if (!rider) return { ok: false, error: "Rider not found." };
    const next = !rider.active;

    await Promise.all([
      db.rider.update({ where: { id: riderId }, data: { active: next } }),
      db.user.update({ where: { id: rider.userId }, data: { active: next } }),
    ]);

    // Disable/enable in Supabase Auth too
    const sid = (rider.user as Record<string, unknown>).supabaseId as string | null;
    if (sid) {
      await supabaseAdmin.auth.admin.updateUserById(sid, {
        ban_duration: next ? "none" : "876600h",
      }).catch(() => null);
    }

    revalidatePath("/customers/riders");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update." };
  }
}
