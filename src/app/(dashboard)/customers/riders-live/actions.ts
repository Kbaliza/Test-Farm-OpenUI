"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { dateStrRangePKT, todayPKTString } from "@/lib/pkt";
import { pinsFor } from "@/lib/customer-pins";

// Today's rounds and who is riding them — the list beside the live map. The
// rider app broadcasts positions on a Realtime channel per rider and the browser
// listens (riders-live-client); the server keeps only each rider's latest point
// (rider-location-keeper) so the map has something to show the moment it opens.

/** One stop of a round, placed on the map from the customer's location pin. */
export type LiveStop = {
  customerId: string;
  name: string;
  code: string;
  stopNumber: number;
  /** delivered = green, pending = red, skipped = grey. */
  state: "delivered" | "pending" | "skipped";
  deliveredAt: string | null;
  skipReason: string | null;
  lat: number | null;
  lng: number | null;
  /**
   * Minutes since the delivery before it on this round (in the order the rider
   * marked them, as on the rider report) — or, for the round's first delivery,
   * since the round started. Null when there is nothing to measure from.
   */
  gapMinutes: number | null;
  gapFrom: "previous" | "start" | null;
};

/** Where the round started, from the first position heard once it was started. */
export type LiveStart = { lat: number; lng: number; at: string; /** Heard within a few minutes of the start. */ exact: boolean };

export type LiveRound = {
  routeId: string;
  shiftName: string;
  status: string;          // PENDING | IN_PROGRESS | COMPLETED
  startedAt: string | null;
  completedAt: string | null;
  stops: number;
  delivered: number;
  skipped: number;
  /** Stops whose customer has no readable location pin. */
  noPin: number;
  stopList: LiveStop[];
  start: LiveStart | null;
  /** The path since the round started: [lat, lng, ISO time]. */
  track: [number, number, string][];
};

export type LiveRider = {
  riderId: string;
  name: string;
  phone: string | null;
  rounds: LiveRound[];
  /** A round is out right now. */
  onRoad: boolean;
  /** The last position heard today, if any. */
  last: { lat: number; lng: number; accuracy: number | null; speed: number | null; bearing: number | null; at: string; routeId: string | null; shiftId: string | null } | null;
};

/** A point a little before the start still counts — the phone and the server clocks differ. */
const START_SLACK_MS = 2 * 60_000;
/** Heard within this long of the start, the first point is where the round started. */
const START_EXACT_MS = 10 * 60_000;

export type RidersLivePage = { date: string; riders: LiveRider[]; dbReady: boolean };

export async function getRidersLive(): Promise<RidersLivePage> {
  await requireRole(FULL_ACCESS);
  const date = todayPKTString();
  try {
    const routes = await db.route.findMany({
      where: { date: dateStrRangePKT(date) },
      select: {
        id: true, status: true, startedAt: true, completedAt: true,
        shift: { select: { name: true, riderId: true, rider: { select: { id: true, user: { select: { name: true, phone: true } } } } } },
        stops: {
          select: { status: true, stopNumber: true, deliveredAt: true, skipReason: true, customer: { select: { id: true, name: true, customerCode: true } } },
          orderBy: { stopNumber: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    // Rounds still to run or running come first in the lookup budget; a finished
    // round's pins are nice to have, not needed to follow a rider now.
    const order = [...routes].sort((a, b) => Number(a.status === "COMPLETED") - Number(b.status === "COMPLETED"));
    const riderIds = [...new Set(routes.map((r) => r.shift.rider?.id).filter((id): id is string => !!id))];
    const dayStart = dateStrRangePKT(date).gte;
    const [pins, lastSeen, trackRows] = await Promise.all([
      pinsFor([...new Set(order.flatMap((r) => r.stops.map((s) => s.customer.id)))]),
      // A point from before today is not "where he is" for today's rounds.
      db.riderLocation.findMany({ where: { riderId: { in: riderIds }, at: { gte: dayStart } } }),
      db.riderTrackPoint.findMany({
        where: { riderId: { in: riderIds }, at: { gte: dayStart } },
        select: { riderId: true, routeId: true, lat: true, lng: true, at: true },
        orderBy: { at: "asc" },
      }),
    ]);
    const lastBy = new Map(lastSeen.map((l) => [l.riderId, l]));
    const trackBy = new Map<string, typeof trackRows>();
    for (const t of trackRows) (trackBy.get(t.riderId) ?? trackBy.set(t.riderId, []).get(t.riderId)!).push(t);
    const byRider = new Map<string, LiveRider>();
    for (const r of routes) {
      const rider = r.shift.rider;
      if (!rider) continue;
      const l = lastBy.get(rider.id);
      const entry = byRider.get(rider.id) ?? {
        riderId: rider.id, name: rider.user.name, phone: rider.user.phone ?? null, rounds: [], onRoad: false,
        last: l ? { lat: l.lat, lng: l.lng, accuracy: l.accuracy, speed: l.speed, bearing: l.bearing, at: l.at.toISOString(), routeId: l.routeId, shiftId: l.shiftId } : null,
      };
      const stopList: LiveStop[] = r.stops.map((s) => {
        const p = pins.get(s.customer.id);
        return {
          customerId: s.customer.id, name: s.customer.name, code: s.customer.customerCode, stopNumber: s.stopNumber,
          state: s.status === "DELIVERED" ? "delivered" : /SKIP/i.test(s.status) ? "skipped" : "pending",
          deliveredAt: s.deliveredAt?.toISOString() ?? null, skipReason: s.skipReason ?? null,
          lat: p?.lat ?? null, lng: p?.lng ?? null,
          gapMinutes: null, gapFrom: null,
        };
      });
      // Door to door, in the order the rider marked them — as on the rider report.
      let prevAt = r.startedAt?.getTime() ?? null, prevFrom: "previous" | "start" = "start";
      for (const s of stopList.filter((x) => x.state === "delivered" && x.deliveredAt).sort((a, b) => Date.parse(a.deliveredAt!) - Date.parse(b.deliveredAt!))) {
        const t = Date.parse(s.deliveredAt!);
        if (prevAt != null && t >= prevAt) { s.gapMinutes = Math.round((t - prevAt) / 60_000); s.gapFrom = prevFrom; }
        prevAt = t; prevFrom = "previous";
      }
      // The path while this round was out, and where it began.
      const from = r.startedAt?.getTime() ?? null, to = r.completedAt?.getTime() ?? Infinity;
      // Only the points the phone sent FOR THIS ROUND. One rider login can be out on
      // several rounds at once on different phones (27 Oct: four of Wajid's), and
      // joining them by rider and time drew a zig-zag between the phones. A point
      // with no round (an older app) still counts by time.
      const path = from == null ? [] : (trackBy.get(rider.id) ?? []).filter((t) =>
        t.routeId ? t.routeId === r.id : t.at.getTime() >= from - START_SLACK_MS && t.at.getTime() <= to);
      const first = path[0];
      const start: LiveStart | null = first ? { lat: first.lat, lng: first.lng, at: first.at.toISOString(), exact: from != null && first.at.getTime() - from <= START_EXACT_MS } : null;
      const round: LiveRound = {
        routeId: r.id, shiftName: r.shift.name, status: r.status,
        startedAt: r.startedAt?.toISOString() ?? null, completedAt: r.completedAt?.toISOString() ?? null,
        stops: r.stops.length,
        delivered: stopList.filter((s) => s.state === "delivered").length,
        skipped: stopList.filter((s) => s.state === "skipped").length,
        noPin: stopList.filter((s) => s.lat == null).length,
        stopList,
        start,
        track: path.map((t) => [t.lat, t.lng, t.at.toISOString()]),
      };
      entry.rounds.push(round);
      if (r.status === "IN_PROGRESS") entry.onRoad = true;
      byRider.set(rider.id, entry);
    }
    const riders = [...byRider.values()].sort((a, b) => Number(b.onRoad) - Number(a.onRoad) || a.name.localeCompare(b.name));
    return { date, riders, dbReady: true };
  } catch (e) {
    console.error("[getRidersLive]", e);
    return { date, riders: [], dbReady: false };
  }
}
