import "server-only";
import { db } from "@/lib/db";
import { dateStrRangePKT, todayPKTString } from "@/lib/pkt";

// A shift on the road cannot be changed.
//
// From the moment the rider confirms loading today's round in the app (the first
// HANDED_OVER row referencing the route), or starts it, until the round is
// finished — by him, or by the midnight close — the shift is frozen: its rider,
// its areas, the extras given to him, the customers on the round, and whether
// it counts bottles. On 18 October the office gave Islamabad Suzuki to Ahsan the
// minute after Zeeshan had confirmed its load; the round left Zeeshan's phone,
// and the returns summary charged 76 L to each of them. The rider's own work in
// the app is not touched by this: that is his record, and the round is his.
//
// An admin may still hand a running round to another rider, on purpose and with
// a reason, through handOverRound in the Shifts actions — nothing else gets past.

export type RunningRound = {
  routeId: string;
  shiftName: string;
  /** When the load was confirmed (or the round started), ISO. */
  since: string;
  /** Who confirmed the load, if the app said. */
  byName: string | null;
};

/** Today's round for this shift if it has been accepted and is not yet finished. */
export async function runningRound(shiftId: string, date = todayPKTString()): Promise<RunningRound | null> {
  const route = await db.route.findFirst({
    where: { shiftId, date: dateStrRangePKT(date), status: { not: "COMPLETED" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, startedAt: true, createdAt: true, shift: { select: { name: true } } },
  });
  if (!route) return null;
  const load = await db.inventoryMovement.findFirst({
    where: { type: "HANDED_OVER", reference: route.id },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, rider: { select: { user: { select: { name: true } } } } },
  });
  if (!load && route.status !== "IN_PROGRESS") return null;
  return { routeId: route.id, shiftName: route.shift.name, since: sinceOf(load?.createdAt, route.startedAt, route.createdAt), byName: load?.rider?.user.name ?? null };
}

/** The earliest of the load confirmation and the start; the route's own creation as a last resort. */
function sinceOf(loadedAt: Date | undefined, startedAt: Date | null, createdAt: Date): string {
  const times = [loadedAt, startedAt].filter((d): d is Date => !!d);
  return (times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : createdAt).toISOString();
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });

/** The message a refused change shows, or null when the shift is free. */
export async function shiftOnRoad(shiftId: string): Promise<string | null> {
  const r = await runningRound(shiftId);
  if (!r) return null;
  return `${r.shiftName} is on the road (loaded ${clock(r.since)}${r.byName ? ` by ${r.byName}` : ""}). It can be changed once the round is finished.`;
}

/** The shifts whose round is running right now, for the badges. */
export async function shiftsOnRoad(): Promise<Map<string, RunningRound>> {
  const routes = await db.route.findMany({
    where: { date: dateStrRangePKT(todayPKTString()), status: { not: "COMPLETED" } },
    select: { id: true, shiftId: true, status: true, startedAt: true, createdAt: true, shift: { select: { name: true } } },
  });
  if (!routes.length) return new Map();
  const loads = await db.inventoryMovement.findMany({
    where: { type: "HANDED_OVER", reference: { in: routes.map((r) => r.id) } },
    orderBy: { createdAt: "asc" },
    select: { reference: true, createdAt: true, rider: { select: { user: { select: { name: true } } } } },
  });
  const first = new Map<string, (typeof loads)[number]>();
  for (const l of loads) if (l.reference && !first.has(l.reference)) first.set(l.reference, l);
  const out = new Map<string, RunningRound>();
  for (const r of routes) {
    const l = first.get(r.id);
    if (!l && r.status !== "IN_PROGRESS") continue;
    if (!out.has(r.shiftId)) out.set(r.shiftId, { routeId: r.id, shiftName: r.shift.name, since: sinceOf(l?.createdAt, r.startedAt, r.createdAt), byName: l?.rider?.user.name ?? null });
  }
  return out;
}
