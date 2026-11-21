"use server";

import { requireRole, requireAdmin, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { dateStrRangePKT, todayPKTString } from "@/lib/pkt";
import { shiftOnRoad, shiftsOnRoad } from "@/lib/shift-lock";

export type AreaScheduleInput = {
  scheduleType: string;          // DAILY | EVERY_N | CUSTOM
  scheduleInterval: number;      // N for EVERY_N
  scheduleAnchor: string | null; // "YYYY-MM-DD"
  customDates: string[];         // "YYYY-MM-DD"[]
};

export type AreaEntry = {
  id: string;
  name: string;
  defaultDeliveryCharge: number;
  scheduleType: string;
  scheduleInterval: number;
  scheduleAnchor: string | null;
  customDates: string[];
  customerCount: number;
};

export type AreaResult = { ok: true } | { ok: false; error: string };

export async function getAreas(): Promise<{ areas: AreaEntry[]; dbReady: boolean }> {
  await requireRole(FULL_ACCESS);
  try {
    const areas = await db.area.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { customers: true } } },
    });
    return {
      areas: areas.map((a) => ({
        id: a.id,
        name: a.name,
        defaultDeliveryCharge: Number(a.defaultDeliveryCharge),
        scheduleType: a.scheduleType,
        scheduleInterval: a.scheduleInterval,
        scheduleAnchor: a.scheduleAnchor,
        customDates: a.customDates,
        customerCount: a._count.customers,
      })),
      dbReady: true,
    };
  } catch {
    return { areas: [], dbReady: false };
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Normalize + validate a schedule so bad input can never produce a nonsensical
// (or "delivers every day when it shouldn't") schedule.
function cleanSchedule(s: AreaScheduleInput): AreaScheduleInput | { error: string } {
  const type = s.scheduleType === "EVERY_N" || s.scheduleType === "CUSTOM" ? s.scheduleType : "DAILY";
  if (type === "EVERY_N") {
    const interval = Math.round(s.scheduleInterval);
    if (!(interval >= 2)) return { error: "Choose a valid interval (every 2nd or 3rd day)." };
    if (!s.scheduleAnchor || !ISO_DATE.test(s.scheduleAnchor)) return { error: "Pick a cycle start date." };
    return { scheduleType: "EVERY_N", scheduleInterval: interval, scheduleAnchor: s.scheduleAnchor, customDates: [] };
  }
  if (type === "CUSTOM") {
    const dates = [...new Set((s.customDates ?? []).filter((d) => ISO_DATE.test(d)))].sort();
    if (dates.length === 0) return { error: "Pick at least one delivery date on the calendar." };
    return { scheduleType: "CUSTOM", scheduleInterval: 1, scheduleAnchor: null, customDates: dates };
  }
  return { scheduleType: "DAILY", scheduleInterval: 1, scheduleAnchor: null, customDates: [] };
}

export async function createArea(data: {
  name: string;
  defaultDeliveryCharge: number;
  schedule: AreaScheduleInput;
}): Promise<AreaResult> {
  await requireRole(FULL_ACCESS);
  if (!data.name.trim()) return { ok: false, error: "Area name is required." };
  const sched = cleanSchedule(data.schedule);
  if ("error" in sched) return { ok: false, error: sched.error };
  try {
    await db.area.create({
      data: {
        name: data.name.trim(),
        defaultDeliveryCharge: new Prisma.Decimal(data.defaultDeliveryCharge),
        scheduleType: sched.scheduleType,
        scheduleInterval: sched.scheduleInterval,
        scheduleAnchor: sched.scheduleAnchor,
        customDates: sched.customDates,
      },
    });
    revalidatePath("/customers/areas");
    revalidatePath("/customers/new");
    revalidatePath("/customers/pre-delivery");
    return { ok: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return { ok: false, error: "An area with that name already exists." };
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save." };
  }
}

export async function updateArea(
  id: string,
  data: { name: string; defaultDeliveryCharge: number; schedule: AreaScheduleInput }
): Promise<AreaResult> {
  await requireRole(FULL_ACCESS);
  if (!data.name.trim()) return { ok: false, error: "Area name is required." };
  const sched = cleanSchedule(data.schedule);
  if ("error" in sched) return { ok: false, error: sched.error };
  try {
    await db.area.update({
      where: { id },
      data: {
        name: data.name.trim(),
        defaultDeliveryCharge: new Prisma.Decimal(data.defaultDeliveryCharge),
        scheduleType: sched.scheduleType,
        scheduleInterval: sched.scheduleInterval,
        scheduleAnchor: sched.scheduleAnchor,
        customDates: sched.customDates,
      },
    });
    revalidatePath("/customers/areas");
    revalidatePath("/customers/new");
    revalidatePath("/customers/pre-delivery");
    return { ok: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return { ok: false, error: "An area with that name already exists." };
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save." };
  }
}

export async function deleteArea(id: string): Promise<AreaResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.area.delete({ where: { id } });
    revalidatePath("/customers/areas");
    revalidatePath("/customers/new");
    return { ok: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003")
      return { ok: false, error: "Cannot delete — customers are assigned to this area." };
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete." };
  }
}

// ── Shift types ───────────────────────────────────────────────────────────────

export type ShiftType = "MORNING" | "EVENING" | "CUSTOM";

export type ShiftEntry = {
  id: string;
  name: string;
  type: ShiftType;
  startTime: string | null;
  riderId: string | null;
  riderName: string | null;
  areaIds: string[];
  areaNames: string[];
  customerCount: number;
  /** Today's round has been loaded and is not finished: the shift cannot be changed. ISO. */
  onRoadSince: string | null;
  onRoadBy: string | null;
};

export type RiderOption = {
  id: string;
  name: string;
};

export type ShiftResult = { ok: true; moved?: number; held?: number } | { ok: false; error: string };

type Moves = { moved: number; held: number };

/**
 * Customers who are a stop on a round today that is not finished yet.
 *
 * They are never moved off their shift until that round is done. The rider app
 * only shows a rider the customers whose shift is his, so moving one mid-round
 * takes the stop off the phone of the rider carrying the milk — on 15 Oct 26 of
 * Wajid's stops vanished that way, and cash for them could not be recorded.
 * Save the shift again once the round is finished and they move then.
 */
async function customersOnUnfinishedRounds(tx: Prisma.TransactionClient): Promise<string[]> {
  const stops = await tx.routeStop.findMany({
    where: { route: { date: dateStrRangePKT(todayPKTString()), status: { not: "COMPLETED" } } },
    select: { customerId: true },
  });
  return [...new Set(stops.map((s) => s.customerId))];
}

/**
 * An area's customers go where the area goes.
 *
 * A customer carries his own shift (Customer.shiftId); the area list on a shift
 * only decides which days it runs. So moving an area to a new shift used to leave
 * every customer in it behind on the old one — on 14 Oct "Bahria Phase 8 Bike"
 * got four areas and not one customer, and the shift editor said "No customers".
 *
 * Moved: customers in these areas with no shift, or on a shift that no longer
 * holds their area. A customer whose shift still lists the area stays put — an
 * area shared by two shifts is split on purpose, customer by customer.
 */
async function bringAreaCustomers(tx: Prisma.TransactionClient, shiftId: string, riderId: string | null, areaIds: string[], busy: string[]): Promise<Moves> {
  const out: Moves = { moved: 0, held: 0 };
  for (const aid of areaIds) {
    const due: Prisma.CustomerWhereInput = {
      areaId: aid,
      OR: [{ shiftId: null }, { shiftId: { not: shiftId }, shift: { areas: { none: { id: aid } } } }],
    };
    const r = await tx.customer.updateMany({ where: { ...due, id: { notIn: busy } }, data: { shiftId, riderId } });
    out.moved += r.count;
    if (busy.length) out.held += await tx.customer.count({ where: { ...due, id: { in: busy } } });
  }
  return out;
}

/**
 * The other half: customers left on this shift in an area it has just given up.
 *
 * Moving an area is often done in two saves — add it to the new shift (the old
 * one still has it, so it is shared and nobody moves yet), then take it off the
 * old one. Without this, that second save stranded the customers on a shift that
 * no longer runs their area. They go to the shift that now holds the area — only
 * when exactly one does; with none or several, there is no right answer and they
 * stay where they are.
 */
async function sendAwayAreaCustomers(tx: Prisma.TransactionClient, shiftId: string, removedAreaIds: string[], busy: string[]): Promise<Moves> {
  const out: Moves = { moved: 0, held: 0 };
  for (const aid of removedAreaIds) {
    const holders = await tx.shift.findMany({ where: { areas: { some: { id: aid } } }, select: { id: true, riderId: true } });
    if (holders.length !== 1) continue;
    const r = await tx.customer.updateMany({
      where: { shiftId, areaId: aid, id: { notIn: busy } },
      data: { shiftId: holders[0].id, riderId: holders[0].riderId },
    });
    out.moved += r.count;
    if (busy.length) out.held += await tx.customer.count({ where: { shiftId, areaId: aid, id: { in: busy } } });
  }
  return out;
}

// ── Shift data fetch ──────────────────────────────────────────────────────────

export async function getShiftsData(): Promise<{
  shifts: ShiftEntry[];
  riders: RiderOption[];
  dbReady: boolean;
}> {
  await requireRole(FULL_ACCESS);
  try {
    const [shifts, riders, onRoad] = await Promise.all([
      db.shift.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          type: true,
          startTime: true,
          riderId: true,
          rider: { select: { user: { select: { name: true } } } },
          areas: { select: { id: true, name: true } },
          _count: { select: { customers: true } },
        },
      }),
      db.rider.findMany({
        where: { active: true },
        include: { user: { select: { name: true } } },
      }),
      shiftsOnRoad(),
    ]);

    return {
      shifts: shifts.map((s) => ({
        onRoadSince: onRoad.get(s.id)?.since ?? null,
        onRoadBy: onRoad.get(s.id)?.byName ?? null,
        id: s.id,
        name: s.name,
        type: s.type as ShiftType,
        startTime: s.startTime ?? null,
        riderId: s.riderId ?? null,
        riderName: s.rider?.user.name ?? null,
        areaIds: [...(s.areas as { id: string; name: string }[])].sort((a, b) => a.name.localeCompare(b.name)).map((a) => a.id),
        areaNames: [...(s.areas as { id: string; name: string }[])].sort((a, b) => a.name.localeCompare(b.name)).map((a) => a.name),
        customerCount: s._count.customers,
      })),
      riders: riders.map((r) => ({ id: r.id, name: r.user.name })),
      dbReady: true,
    };
  } catch {
    return { shifts: [], riders: [], dbReady: false };
  }
}

// ── Shift CRUD ────────────────────────────────────────────────────────────────

export async function createShift(data: {
  name: string;
  type: ShiftType;
  startTime: string | null;
  riderId: string | null;
  areaIds: string[];
}): Promise<ShiftResult> {
  await requireRole(FULL_ACCESS);
  if (!data.name.trim()) return { ok: false, error: "Shift name is required." };
  try {
    const moves = await db.$transaction(async (tx) => {
      const shift = await tx.shift.create({
        data: {
          name: data.name.trim(),
          type: data.type,
          startTime: data.startTime || null,
          riderId: data.riderId || null,
          areas: data.areaIds.length > 0
            ? { connect: data.areaIds.map((id) => ({ id })) }
            : undefined,
        },
        select: { id: true },
      });
      return bringAreaCustomers(tx, shift.id, data.riderId || null, data.areaIds, await customersOnUnfinishedRounds(tx));
    });
    revalidatePath("/customers/areas");
    revalidatePath("/customers/new");
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/customers");
    return { ok: true, moved: moves.moved, held: moves.held };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return { ok: false, error: "A shift with that name already exists." };
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save." };
  }
}

export async function updateShift(
  id: string,
  data: {
    name: string;
    type: ShiftType;
    startTime: string | null;
    riderId: string | null;
    areaIds: string[];
  }
): Promise<ShiftResult> {
  await requireRole(FULL_ACCESS);
  if (!data.name.trim()) return { ok: false, error: "Shift name is required." };
  // Nothing about a shift changes while its round is on the road — see shift-lock.
  const road = await shiftOnRoad(id);
  if (road) return { ok: false, error: road };
  try {
    const riderId = data.riderId || null;
    // Handing a shift to another rider must also re-mirror every customer on
    // it — otherwise Customer.riderId goes stale and the old rider keeps
    // getting credited for the new rider's collections (past payments are
    // unaffected — they carry their own Payment.riderId stamp). The Shift
    // Editor no longer assigns riders itself; this is the only path now.
    // Interactive and on `tx` — the batched array form hangs on this client
    // (see src/lib/db.ts). Atomicity matters especially here: the shift moving
    // to a new rider without the customers following is exactly the stale
    // Customer.riderId this code exists to prevent.
    const moves = await db.$transaction(async (tx) => {
      const before = await tx.shift.findUnique({ where: { id }, select: { areas: { select: { id: true } } } });
      const removed = (before?.areas ?? []).map((a) => a.id).filter((aid) => !data.areaIds.includes(aid));
      await tx.shift.update({
        where: { id },
        data: {
          name: data.name.trim(),
          type: data.type,
          startTime: data.startTime || null,
          riderId,
          areas: { set: data.areaIds.map((aid) => ({ id: aid })) },
        },
      });
      await tx.customer.updateMany({ where: { shiftId: id }, data: { riderId } });
      const busy = await customersOnUnfinishedRounds(tx);
      const a = await bringAreaCustomers(tx, id, riderId, data.areaIds, busy);
      const b = await sendAwayAreaCustomers(tx, id, removed, busy);
      return { moved: a.moved + b.moved, held: a.held + b.held };
    });
    revalidatePath("/customers/areas");
    revalidatePath("/customers/new");
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/customers");
    revalidatePath("/payments/rider-cash");
    revalidatePath("/");
    return { ok: true, moved: moves.moved, held: moves.held };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return { ok: false, error: "A shift with that name already exists." };
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save." };
  }
}

export async function deleteShift(id: string): Promise<ShiftResult> {
  await requireRole(FULL_ACCESS);
  const road = await shiftOnRoad(id);
  if (road) return { ok: false, error: road };
  try {
    await db.shift.delete({ where: { id } });
    revalidatePath("/customers/areas");
    revalidatePath("/customers/new");
    revalidatePath("/customers/pre-delivery");
    return { ok: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003")
      return { ok: false, error: "Cannot delete — customers or routes are assigned to this shift." };
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete." };
  }
}

/**
 * The one way to change the rider of a shift whose round is on the road.
 *
 * An admin, a named new rider and a reason. The round, its stops and its
 * customers go to the new rider — on his phone (the app shows a rider the
 * customers of his shifts) and on the returns summary (a round is counted
 * against whoever carried it, see roundHandovers). The reason goes into the
 * audit log with the change. The database's own lock on Shift.riderId
 * (trg_shift_rider_lock) is lifted for this transaction only.
 */
export async function handOverRound(shiftId: string, newRiderId: string, reason: string): Promise<ShiftResult> {
  const user = await requireAdmin();
  const why = reason.trim();
  if (!newRiderId) return { ok: false, error: "Choose the rider taking over." };
  if (why.length < 3) return { ok: false, error: "Say why the round is being handed over." };
  try {
    const [shift, rider] = await Promise.all([
      db.shift.findUnique({ where: { id: shiftId }, select: { name: true, riderId: true } }),
      db.rider.findUnique({ where: { id: newRiderId }, select: { active: true, user: { select: { name: true } } } }),
    ]);
    if (!shift) return { ok: false, error: "That shift no longer exists." };
    if (!rider || !rider.active) return { ok: false, error: "That rider is not active." };
    if (shift.riderId === newRiderId) return { ok: false, error: `${rider.user.name} already has this shift.` };
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.shift_handover', 'on', true),
        set_config('app.actor_name', ${`${user.name} — handed ${shift.name} to ${rider.user.name}: ${why}`}, true)`;
      await tx.shift.update({ where: { id: shiftId }, data: { riderId: newRiderId } });
      await tx.customer.updateMany({ where: { shiftId }, data: { riderId: newRiderId } });
    });
    revalidatePath("/customers/areas");
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/inventory/rider-returns");
    revalidatePath("/customers");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not hand the round over." };
  }
}
