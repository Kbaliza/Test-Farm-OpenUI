import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { db } from "@/lib/db";
import { dateStrRangePKT, todayPKTString } from "@/lib/pkt";

// Keeps each rider's last position, so Riders live can show where a rider was
// the moment the page opens instead of waiting for the phone's next point.
//
// The rider app broadcasts on a private Realtime channel per rider and stores
// nothing. This listener joins the channel of every rider on today's rounds with
// the service role (which the channel rules do not restrict), and writes the
// newest point to RiderLocation — at most one write per rider every WRITE_EVERY_MS.
// It only listens: nothing is ever sent on a rider's channel.
//
// It also keeps the path: a RiderTrackPoint whenever the rider has moved
// TRACK_MIN_METRES since the last one kept (see keepForTrack), pruned after
// TRACK_KEEP_DAYS.

const RIDERS_EVERY_MS = 2 * 60_000;
const WRITE_EVERY_MS = 15_000;
const TRACK_MIN_METRES = 15;
const TRACK_MIN_MS = 5_000;
/** A fix vaguer than this would draw a zig-zag, not a road. */
const TRACK_MAX_ACCURACY = 50;
const TRACK_KEEP_DAYS = 30;
const PRUNE_EVERY_MS = 60 * 60_000;

export type Point = { routeId: string | null; shiftId: string | null; lat: number; lng: number; accuracy: number | null; speed: number | null; bearing: number | null; at: Date };

let started = false;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A broadcast payload as a point, or null when it is not a usable fix. */
export function toPoint(payload: unknown): Point | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const lat = num(p.lat), lng = num(p.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const at = typeof p.at === "string" ? new Date(p.at) : new Date();
  if (Number.isNaN(at.getTime())) return null;
  // A phone with its clock ahead must not pin a point in the future.
  const now = Date.now();
  return {
    routeId: typeof p.routeId === "string" ? p.routeId : null,
    shiftId: typeof p.shiftId === "string" ? p.shiftId : null,
    lat, lng, accuracy: num(p.accuracy), speed: num(p.speed), bearing: num(p.bearing),
    at: at.getTime() > now ? new Date(now) : at,
  };
}

/** Metres between two points (haversine). */
export function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Whether a new point goes on the path. The first point of a round always does
 * (it marks where the round started); after that only a point that has moved
 * far enough, and is sharp enough to trust — a rider standing at a door must
 * not draw a scribble.
 */
export function keepForTrack(last: Point | undefined, p: Point) {
  if (!last || last.routeId !== p.routeId) return true;
  if (p.accuracy != null && p.accuracy > TRACK_MAX_ACCURACY) return false;
  if (p.at.getTime() - last.at.getTime() < TRACK_MIN_MS) return false;
  return metres(last, p) >= TRACK_MIN_METRES;
}

export function startRiderLocationKeeper() {
  if (started) return;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("[rider-location] no Supabase URL or service key; not listening"); return; }
  started = true;

  const supabase: SupabaseClient = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const channels = new Map<string, RealtimeChannel>();
  const latest = new Map<string, Point>();   // newest point heard, per rider
  const written = new Map<string, number>(); // when it was last written, per rider
  const pending = new Set<string>();
  // Last point put on the path, per rider AND round: one rider login can be out
  // on several rounds at once on different phones, and each round has its own path.
  const tracked = new Map<string, Point>();
  let prunedAt = 0;

  const write = async (riderId: string) => {
    const p = latest.get(riderId);
    if (!p) return;
    written.set(riderId, Date.now());
    pending.delete(riderId);
    const data = { routeId: p.routeId, shiftId: p.shiftId, lat: p.lat, lng: p.lng, accuracy: p.accuracy, speed: p.speed, bearing: p.bearing, at: p.at };
    try {
      await db.riderLocation.upsert({ where: { riderId }, create: { riderId, ...data }, update: data });
    } catch (e) {
      console.error("[rider-location] write failed", riderId, e instanceof Error ? e.message : e);
    }
  };

  const heard = (riderId: string, payload: unknown) => {
    const p = toPoint(payload);
    if (!p) return;
    const prev = latest.get(riderId);
    if (prev && prev.at > p.at) return;
    latest.set(riderId, p);
    const pathKey = `${riderId}:${p.routeId ?? ""}`;
    if (keepForTrack(tracked.get(pathKey), p)) {
      tracked.set(pathKey, p);
      db.riderTrackPoint.create({ data: { riderId, routeId: p.routeId, lat: p.lat, lng: p.lng, accuracy: p.accuracy, at: p.at } })
        .catch((e) => console.error("[rider-location] track write failed", riderId, e instanceof Error ? e.message : e));
    }
    const since = Date.now() - (written.get(riderId) ?? 0);
    if (since >= WRITE_EVERY_MS) void write(riderId);
    else if (!pending.has(riderId)) {
      // Not lost, only held back: the newest point is written when the gap is up.
      pending.add(riderId);
      setTimeout(() => void write(riderId), WRITE_EVERY_MS - since);
    }
  };

  // Join the channels of riders on today's rounds; leave the ones no longer on any.
  const syncRiders = async () => {
    if (Date.now() - prunedAt > PRUNE_EVERY_MS) {
      prunedAt = Date.now();
      db.riderTrackPoint.deleteMany({ where: { at: { lt: new Date(Date.now() - TRACK_KEEP_DAYS * 86_400_000) } } })
        .catch((e) => console.error("[rider-location] track prune failed", e instanceof Error ? e.message : e));
    }
    try {
      const routes = await db.route.findMany({
        where: { date: dateStrRangePKT(todayPKTString()) },
        select: { shift: { select: { riderId: true } } },
      });
      const want = new Set(routes.map((r) => r.shift.riderId).filter((id): id is string => !!id));
      for (const riderId of want) {
        if (channels.has(riderId)) continue;
        const ch = supabase
          .channel(`rider-location:${riderId}`, { config: { private: true } })
          .on("broadcast", { event: "location" }, ({ payload }: { payload: unknown }) => heard(riderId, payload))
          .subscribe((status: string, err?: Error) => {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") console.error("[rider-location] channel", riderId, status, err?.message ?? "");
          });
        channels.set(riderId, ch);
      }
      for (const [riderId, ch] of channels) {
        if (want.has(riderId)) continue;
        void supabase.removeChannel(ch);
        channels.delete(riderId);
      }
    } catch (e) {
      console.error("[rider-location] riders lookup failed", e instanceof Error ? e.message : e);
    }
  };

  // A little after start-up, so the server is serving before it does any work.
  setTimeout(() => void syncRiders(), 20_000);
  setInterval(() => void syncRiders(), RIDERS_EVERY_MS);
}
