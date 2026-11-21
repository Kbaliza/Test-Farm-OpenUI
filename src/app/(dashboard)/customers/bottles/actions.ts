"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { addDaysToDateStr, todayPKTString } from "@/lib/pkt";
import { shiftOnRoad } from "@/lib/shift-lock";
import { bottleCustomers, bottleLedger, bottleShifts, bottleDay, type BottleCustomer, type BottleShift } from "@/lib/bottles";

export type BottlesPage = {
  from: string;
  to: string;
  shifts: BottleShift[];
  customers: BottleCustomer[];
  dbReady: boolean;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
type Result = { ok: true } | { ok: false; error: string };

export async function getBottlesPage(from: string, to: string): Promise<BottlesPage> {
  await requireRole(FULL_ACCESS);
  const today = todayPKTString();
  const t = DAY.test(to) ? to : today;
  const f = DAY.test(from) ? from : addDaysToDateStr(t, -6);
  const [lo, hi] = f <= t ? [f, t] : [t, f];
  try {
    const [shifts, customers] = await Promise.all([bottleShifts(), bottleCustomers(lo, hi)]);
    return { from: lo, to: hi, shifts, customers, dbReady: true };
  } catch (e) {
    console.error("[getBottlesPage]", e);
    return { from: lo, to: hi, shifts: [], customers: [], dbReady: false };
  }
}

export async function getBottleLedger(customerId: string) {
  await requireRole(FULL_ACCESS);
  return bottleLedger(customerId);
}

/**
 * Switch a shift to bottles from a day, or back to packets. Switching back keeps
 * every return and adjustment on record; only the counting stops.
 */
export async function setShiftBottles(shiftId: string, since: string | null): Promise<Result> {
  await requireRole(FULL_ACCESS);
  if (since !== null && !DAY.test(since)) return { ok: false, error: "Choose a date." };
  // Switching changes what today's deliveries count as; not while the round is out.
  const road = await shiftOnRoad(shiftId);
  if (road) return { ok: false, error: road };
  try {
    await db.shift.update({ where: { id: shiftId }, data: { bottlesSince: since ? bottleDay(since) : null } });
    revalidatePath("/customers/bottles");
    return { ok: true };
  } catch (e) {
    console.error("[setShiftBottles]", e);
    return { ok: false, error: "Could not update the shift." };
  }
}

/** Record (or correct) the empties a customer handed back on a day, from the office. */
export async function recordBottleReturn(input: { customerId: string; date: string; returned: number; note?: string | null }): Promise<Result> {
  const user = await requireRole(FULL_ACCESS);
  if (!DAY.test(input.date) || input.date > todayPKTString()) return { ok: false, error: "Choose a day that has happened." };
  const returned = Math.round(Number(input.returned));
  if (!Number.isFinite(returned) || returned < 0) return { ok: false, error: "Bottles must be 0 or more." };
  try {
    const date = bottleDay(input.date);
    if (returned === 0) {
      await db.bottleReturn.deleteMany({ where: { customerId: input.customerId, date } });
    } else {
      await db.bottleReturn.upsert({
        where: { customerId_date: { customerId: input.customerId, date } },
        create: { customerId: input.customerId, date, returned, source: "web", note: input.note?.trim() || null, enteredById: user.id, enteredByName: user.name },
        update: { returned, source: "web", note: input.note?.trim() || null, enteredById: user.id, enteredByName: user.name, riderId: null, routeId: null },
      });
    }
    revalidatePath("/customers/bottles");
    return { ok: true };
  } catch (e) {
    console.error("[recordBottleReturn]", e);
    return { ok: false, error: "Could not save the return." };
  }
}

/** A correction: bottles written off (negative) or an opening count (positive). */
export async function adjustBottles(input: { customerId: string; date: string; bottles: number; reason: string }): Promise<Result> {
  const user = await requireRole(FULL_ACCESS);
  if (!DAY.test(input.date) || input.date > todayPKTString()) return { ok: false, error: "Choose a day that has happened." };
  const bottles = Math.round(Number(input.bottles));
  if (!Number.isFinite(bottles) || bottles === 0) return { ok: false, error: "Enter how many bottles, plus or minus." };
  const reason = (input.reason ?? "").trim();
  if (!reason) return { ok: false, error: "Say why." };
  try {
    await db.bottleAdjustment.create({ data: { customerId: input.customerId, date: bottleDay(input.date), bottles, reason, enteredById: user.id, enteredByName: user.name } });
    revalidatePath("/customers/bottles");
    return { ok: true };
  } catch (e) {
    console.error("[adjustBottles]", e);
    return { ok: false, error: "Could not save the correction." };
  }
}
