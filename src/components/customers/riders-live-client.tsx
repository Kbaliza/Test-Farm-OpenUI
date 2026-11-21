"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Phone, Radio, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabaseBrowser } from "@/lib/supabase-browser";
import type { RidersLivePage, LiveRider, LiveRound } from "@/app/(dashboard)/customers/riders-live/actions";
import type { MapRider, MapStop, MapTrack } from "@/components/customers/riders-map";

// Leaflet needs the browser; never render the map on the server.
const RidersMap = dynamic(() => import("@/components/customers/riders-map"), { ssr: false, loading: () => <div className="grid h-full place-items-center text-sm text-muted-foreground">Loading map…</div> });

/** What the rider app broadcasts on rider-location:<riderId>, event "location". */
type RiderPoint = { riderId: string; routeId: string; shiftId: string; lat: number; lng: number; accuracy: number; speed?: number; bearing?: number; at: string };

/** A point older than this is shown grey: no signal, phone off, or the app force-stopped. */
const STALE_MS = 2 * 60_000;

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });
function ago(ms: number) {
  if (ms < 15_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  return `${Math.round(ms / 3_600_000)} h ago`;
}

function lastPoints(data: RidersLivePage): Record<string, RiderPoint> {
  const out: Record<string, RiderPoint> = {};
  for (const r of data.riders) {
    const l = r.last;
    if (!l) continue;
    out[r.riderId] = {
      riderId: r.riderId, routeId: l.routeId ?? "", shiftId: l.shiftId ?? "", lat: l.lat, lng: l.lng, accuracy: l.accuracy ?? 0,
      ...(l.speed != null ? { speed: l.speed } : {}), ...(l.bearing != null ? { bearing: l.bearing } : {}), at: l.at,
    };
  }
  return out;
}

/** "45m", "2h 05m". */
const span = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m` : `${min}m`);

/** Metres between two points — enough to tell a move from GPS jitter. */
function metres(a: [number, number], b: [number, number]) {
  const rad = Math.PI / 180, x = (b[1] - a[1]) * rad * Math.cos(((a[0] + b[0]) / 2) * rad), y = (b[0] - a[0]) * rad;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

/**
 * A round's clock, as on the rider report: when it started, how long it has
 * been out (to its end, or to now while it runs), and the average time per
 * delivery — from the start to the latest delivery, over the deliveries made.
 */
function roundTimes(x: LiveRound, now: number) {
  if (!x.startedAt) return null;
  const start = Date.parse(x.startedAt);
  const end = x.completedAt ? Date.parse(x.completedAt) : now;
  const times = x.stopList.filter((s) => s.state === "delivered" && s.deliveredAt).map((s) => Date.parse(s.deliveredAt!));
  const last = times.length ? Math.max(...times) : null;
  return {
    started: clock(x.startedAt),
    ended: x.completedAt ? clock(x.completedAt) : null,
    onRoute: span(Math.max(0, Math.round((end - start) / 60_000))),
    avg: last != null && last > start ? span(Math.max(1, Math.round((last - start) / 60_000 / times.length))) : null,
  };
}

const PILL = "inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4";

// A colour per shift, so rounds are told apart at a glance. Today's shifts take
// the colours in name order — distinct, and the same all day. No green or red:
// those mean done and not delivered on this page.
const SHIFT_TONES = [
  "bg-sky-100 text-sky-800", "bg-violet-100 text-violet-800", "bg-orange-100 text-orange-800",
  "bg-cyan-100 text-cyan-800", "bg-pink-100 text-pink-800", "bg-indigo-100 text-indigo-800",
  "bg-yellow-100 text-yellow-800", "bg-fuchsia-100 text-fuchsia-800", "bg-teal-100 text-teal-800",
];

/** The shift the map opens on: one on the road (the latest started), else all. */
function defaultFocus(data: RidersLivePage): string | null {
  const out = data.riders.flatMap((r) => r.rounds).filter((x) => x.status === "IN_PROGRESS");
  out.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return out[0]?.routeId ?? null;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function RidersLiveClient({ data }: { data: RidersLivePage }) {
  const router = useRouter();
  // Points heard on the channels since the page opened.
  const [heard, setHeard] = useState<Record<string, RiderPoint>>({});
  // ...on top of the last point the server kept, so a refreshed page is not
  // empty until each phone sends again. Whichever is newer wins.
  const points = useMemo(() => {
    const out = lastPoints(data);
    for (const [id, p] of Object.entries(heard)) if (!out[id] || out[id].at <= p.at) out[id] = p;
    return out;
  }, [data, heard]);
  // Newest point heard for each ROUND. One rider login can be out on several
  // rounds at once on different phones, so a rider's latest point says little
  // about where any one round is.
  const [heardRound, setHeardRound] = useState<Record<string, RiderPoint>>({});
  // The path heard since the page opened, per round, added to what the server kept.
  const [trail, setTrail] = useState<Record<string, [number, number, string][]>>({});
  const [now, setNow] = useState(() => Date.now());
  // The map shows one shift at a time (a round's routeId), or every shift (null).
  // It opens on the shift that is on the road — every stop of every shift on one
  // map was a pile of pins.
  const [focus, setFocus] = useState<string | null>(() => defaultFocus(data));
  const [link, setLink] = useState<"connecting" | "live" | "error">("connecting");
  const riderIds = useMemo(() => data.riders.map((r) => r.riderId), [data.riders]);
  const subscribed = useRef<string>("");

  // One channel per rider on today's rounds, joined with the office user's own login.
  useEffect(() => {
    const key = riderIds.join(",");
    if (!riderIds.length || subscribed.current === key) return;
    subscribed.current = key;
    const supabase = supabaseBrowser();
    let cancelled = false;
    const channels: ReturnType<typeof supabase.channel>[] = [];
    (async () => {
      const { data: s } = await supabase.auth.getSession();
      if (!s.session) { setLink("error"); return; }
      await supabase.realtime.setAuth(s.session.access_token);
      if (cancelled) return;
      for (const riderId of riderIds) {
        const ch = supabase
          .channel(`rider-location:${riderId}`, { config: { private: true } })
          .on("broadcast", { event: "location" }, ({ payload }: { payload: unknown }) => {
            const p = payload as RiderPoint;
            if (!p || typeof p.lat !== "number" || typeof p.lng !== "number") return;
            setHeard((prev) => (prev[riderId] && prev[riderId].at > p.at ? prev : { ...prev, [riderId]: { ...p, riderId } }));
            const routeId = typeof p.routeId === "string" && p.routeId ? p.routeId : null;
            if (routeId) setHeardRound((prev) => (prev[routeId] && prev[routeId].at > p.at ? prev : { ...prev, [routeId]: { ...p, riderId } }));
            // Only a real move goes on the line — a rider standing at a door must not scribble.
            if (typeof p.accuracy === "number" && p.accuracy > 50) return;
            const lineKey = routeId ?? riderId;
            setTrail((prev) => {
              const line = prev[lineKey] ?? [];
              const last = line[line.length - 1];
              if (last && (last[2] >= p.at || metres([last[0], last[1]], [p.lat, p.lng]) < 15)) return prev;
              return { ...prev, [lineKey]: [...line, [p.lat, p.lng, p.at]] };
            });
          })
          .subscribe((status: string) => {
            if (status === "SUBSCRIBED") setLink("live");
            else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setLink("error");
          });
        channels.push(ch);
      }
    })();
    return () => { cancelled = true; subscribed.current = ""; for (const ch of channels) supabase.removeChannel(ch); };
  }, [riderIds]);

  // The clock the "last seen" labels read from, and a quiet refresh of the stop
  // counts every minute (the positions themselves keep flowing in between).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    const r = setInterval(() => router.refresh(), 60_000);
    return () => { clearInterval(t); clearInterval(r); };
  }, [router]);

  const shiftTones = useMemo(() => {
    const names = [...new Set(data.riders.flatMap((r) => r.rounds.map((x) => x.shiftName)))].sort((a, b) => a.localeCompare(b));
    return new Map(names.map((n, i) => [n, SHIFT_TONES[i % SHIFT_TONES.length]]));
  }, [data.riders]);
  const shiftTone = (name: string) => shiftTones.get(name) ?? SHIFT_TONES[0];

  // A refresh can drop the round being shown (deleted, moved); then show them all.
  const rounds = useMemo(() => data.riders.flatMap((r) => r.rounds.map((x) => ({ rider: r, round: x }))), [data.riders]);
  const focused = focus ? rounds.find((o) => o.round.routeId === focus) ?? null : null;
  const selected = focused?.rider.riderId ?? null;
  const focusIdEarly = focused?.round.routeId ?? null;

  // A rider's shift to show: the one on the road, else the latest started, else the first.
  const riderFocus = useCallback((riderId: string) => {
    const mine = data.riders.find((r) => r.riderId === riderId)?.rounds ?? [];
    const pick = mine.find((x) => x.status === "IN_PROGRESS")
      ?? [...mine].filter((x) => x.startedAt).sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0]
      ?? mine[0];
    return pick?.routeId ?? null;
  }, [data.riders]);
  // Tapping an arrow on the map shows that round (each arrow is one round).
  const onSelect = useCallback((routeId: string) => setFocus(routeId), []);

  // On a phone the map is above the list; choosing from the list brings it back into view.
  const mapBox = useRef<HTMLDivElement>(null);
  const showOnMap = (routeId: string | null) => {
    setFocus(routeId);
    if (window.matchMedia("(max-width: 1023px)").matches) mapBox.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const status = (r: LiveRider) => {
    const p = points[r.riderId];
    if (!p) return { text: r.onRoad ? "waiting for the first position…" : r.rounds.every((x) => x.status === "COMPLETED") ? "round finished" : "not started", tone: "muted" as const };
    const age = now - new Date(p.at).getTime();
    if (age > STALE_MS) return { text: `no signal for ${ago(age)} (last ${clock(p.at)})`, tone: "stale" as const };
    return { text: `seen ${ago(age)}`, tone: "live" as const };
  };

  // One arrow per round on the road, at the newest point sent for THAT round:
  // heard live, the server's last point if it was for this round, or the end of
  // the round's stored line. A rider with a single round out and a phone that
  // does not say which round falls back to the rider's own last point.
  const mapRiders: MapRider[] = data.riders.flatMap((r) => {
    const out = r.rounds.filter((x) => x.status === "IN_PROGRESS");
    return out.flatMap((x) => {
      if (focusIdEarly && x.routeId !== focusIdEarly) return [];
      const end = x.track[x.track.length - 1];
      const candidates: RiderPoint[] = [
        heardRound[x.routeId],
        r.last && r.last.routeId === x.routeId ? points[r.riderId] : undefined,
        end ? { riderId: r.riderId, routeId: x.routeId, shiftId: "", lat: end[0], lng: end[1], accuracy: 0, at: end[2] } : undefined,
        out.length === 1 && !heardRound[x.routeId] ? points[r.riderId] : undefined,
      ].filter((c): c is RiderPoint => !!c);
      const p = candidates.sort((a, b) => b.at.localeCompare(a.at))[0];
      if (!p) return [];
      const age = now - new Date(p.at).getTime();
      return [{
        key: x.routeId, riderId: r.riderId, name: r.name, lat: p.lat, lng: p.lng,
        bearing: typeof p.bearing === "number" ? p.bearing : null,
        speedKmh: typeof p.speed === "number" ? Math.round(p.speed * 3.6) : null,
        ageSec: Math.round(age / 1000), stale: age > STALE_MS,
        label: `${x.shiftName} · ${age > STALE_MS ? `last seen ${clock(p.at)}` : ago(age)}`,
      }];
    });
  });

  // The stops of the shift being shown, or of every shift. Kept stable between
  // clock ticks, or the pins would be redrawn every five seconds.
  const focusId = focused?.round.routeId ?? null;
  const mapStops = useMemo<MapStop[]>(() => data.riders
    .flatMap((r) => r.rounds.filter((x) => !focusId || x.routeId === focusId).flatMap((x) => x.stopList.flatMap((s) => {
      if (s.lat == null || s.lng == null) return [];
      const what = s.state === "delivered" ? `Delivered${s.deliveredAt ? ` ${clock(s.deliveredAt)}` : ""}` : s.state === "skipped" ? `Skipped${s.skipReason ? ` — ${s.skipReason}` : ""}` : "Not delivered yet";
      const gap = s.gapMinutes == null ? "" : s.gapFrom === "start" ? `${span(s.gapMinutes)} after the round started` : `${span(s.gapMinutes)} from previous delivery`;
      return [{
        key: `${x.routeId}:${s.customerId}`, riderId: r.riderId, lat: s.lat, lng: s.lng, state: s.state,
        label: `<b>#${s.stopNumber} ${esc(s.name)}</b> <span style="color:#6b7280">${esc(s.code)}</span><br/>${esc(x.shiftName)} · ${esc(r.name)}<br/>${esc(what)}${gap ? `<br/><span style="color:#b45309;font-weight:600">${esc(gap)}</span>` : ""}`,
      }];
    }))), [data.riders, focusId]);
  // Each started round's line and gold start. A round still out gets the points
  // heard since the page opened added to the end of what the server kept.
  const mapTracks = useMemo<MapTrack[]>(() => data.riders.flatMap((r) => r.rounds.flatMap((x) => {
    if (!x.startedAt || (focusId && x.routeId !== focusId)) return [];
    const kept = x.track;
    const lastAt = kept.length ? kept[kept.length - 1][2] : x.startedAt;
    const live = x.status === "IN_PROGRESS" ? (trail[x.routeId] ?? []).filter((t) => t[2] > lastAt) : [];
    const all = [...kept, ...live];
    const first = x.start ?? (all[0] ? { lat: all[0][0], lng: all[0][1], at: all[0][2], exact: Date.parse(all[0][2]) - Date.parse(x.startedAt) <= 10 * 60_000 } : null);
    const start = first && {
      lat: first.lat, lng: first.lng,
      label: first.exact
        ? `<b>Round started here</b><br/>${esc(x.shiftName)} · ${esc(r.name)}<br/>${clock(x.startedAt)}`
        : `<b>First position after the start</b><br/>${esc(x.shiftName)} · ${esc(r.name)}<br/>${clock(first.at)} — the round started ${clock(x.startedAt)}`,
    };
    return [{ key: x.routeId, riderId: r.riderId, points: all.map((t) => [t[0], t[1]] as [number, number]), start }];
  })), [data.riders, trail, focusId]);

  const counts = useMemo(() => {
    const c = { delivered: 0, pending: 0, skipped: 0, noPin: 0 };
    for (const r of data.riders) for (const x of r.rounds) {
      if (focusId && x.routeId !== focusId) continue;
      for (const s of x.stopList) c[s.state]++;
      c.noPin += x.noPin;
    }
    return c;
  }, [data.riders, focusId]);

  // The shift pills above the map: on the road first, then still to go, then done.
  const ORDER: Record<string, number> = { IN_PROGRESS: 0, PENDING: 1, COMPLETED: 2 };
  const pills = [...rounds].sort((a, b) => (ORDER[a.round.status] ?? 1) - (ORDER[b.round.status] ?? 1) || a.round.shiftName.localeCompare(b.round.shiftName));

  return (
    <div className="flex flex-col gap-3 p-3 sm:p-4 lg:h-[calc(100vh-9rem)] lg:flex-row">
      {/* Riders */}
      <div className="flex w-full flex-col gap-2 lg:w-80 lg:shrink-0 lg:overflow-y-auto">
        <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <span className={cn("inline-flex items-center gap-1.5 font-medium", link === "live" ? "text-emerald-700" : link === "error" ? "text-rose-700" : "text-muted-foreground")}>
            <Radio className="size-3.5" /> {link === "live" ? "Connected" : link === "error" ? "Not connected — sign in again or refresh" : "Connecting…"}
          </span>
          <button type="button" onClick={() => router.refresh()} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" title="Refresh the rounds">
            <RefreshCw className="size-3.5" /> Refresh
          </button>
        </div>
        {data.riders.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No rounds saved for today yet.</p>
        )}
        {data.riders.map((r) => {
          const st = status(r);
          const p = points[r.riderId];
          return (
            <div key={r.riderId} role="button" tabIndex={0}
              onClick={() => showOnMap(selected === r.riderId ? null : riderFocus(r.riderId))}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showOnMap(selected === r.riderId ? null : riderFocus(r.riderId)); } }}
              className={cn("rounded-xl border bg-card p-3 text-left transition-colors", selected === r.riderId ? "border-amber-400 ring-1 ring-amber-300" : "border-border hover:bg-muted/30")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.name}</p>
                  <p className={cn("text-xs", st.tone === "live" ? "text-emerald-700" : st.tone === "stale" ? "text-rose-700" : "text-muted-foreground")}>
                    <span className={cn("mr-1.5 inline-block size-2 rounded-full align-middle", st.tone === "live" ? "bg-emerald-500" : st.tone === "stale" ? "bg-rose-500" : "bg-muted-foreground/40")} />
                    {st.text}
                  </p>
                </div>
                {p && typeof p.speed === "number" && !(now - new Date(p.at).getTime() > STALE_MS) && (
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums">{Math.round(p.speed * 3.6)} km/h</span>
                )}
              </div>
              <ul className="mt-2 space-y-1">
                {r.rounds.map((x) => {
                  const t = roundTimes(x, now);
                  return (
                    <li key={x.routeId} className={cn("-mx-1.5 cursor-pointer rounded-lg px-1.5 py-1 text-xs", focusId === x.routeId ? "bg-amber-50 ring-1 ring-amber-300" : "hover:bg-muted/40")}
                      onClick={(e) => { e.stopPropagation(); showOnMap(x.routeId); }} title="Show this shift on the map">
                      {/* On a narrow screen the status drops under the name rather than squeezing it. */}
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <span className={cn(PILL, "max-w-full truncate", shiftTone(x.shiftName))} title={x.shiftName}>{x.shiftName}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums">
                          {x.status === "COMPLETED" ? (
                            <span className={cn(PILL, "bg-green-800 text-white")}>Done</span>
                          ) : x.status === "IN_PROGRESS" ? (
                            <span className={cn(PILL, "bg-amber-100 text-amber-800")}>{x.delivered}/{x.stops} stops{x.skipped > 0 ? ` · ${x.skipped} skipped` : ""}</span>
                          ) : (
                            <span className={cn(PILL, "bg-muted text-muted-foreground")}>Not started</span>
                          )}
                        </span>
                      </div>
                      {t && (
                        <p className="mt-1 text-[11px] leading-relaxed tabular-nums text-muted-foreground">
                          Started <b className="font-medium text-foreground">{t.started}</b>
                          {t.ended && <> · Ended <b className="font-medium text-foreground">{t.ended}</b></>} · on route <b className="font-medium text-foreground">{t.onRoute}</b>
                          {t.avg && <> · avg <b className="font-medium text-foreground">{t.avg}</b>/delivery</>}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {r.phone && <a href={`tel:${r.phone}`} onClick={(e) => e.stopPropagation()} className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"><Phone className="size-3" /> {r.phone}</a>}
            </div>
          );
        })}
      </div>

      {/* Map */}
      {/* A fixed height on a phone: as a flex item sized only by min-height, the map
          inside measured 0 tall and Leaflet drew nothing. */}
      <div ref={mapBox} className="order-first flex shrink-0 scroll-mt-20 flex-col gap-2 lg:order-none lg:min-h-0 lg:flex-1">
      {/* Which shift the map shows. Scrolls sideways on a phone. */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
        <button type="button" onClick={() => setFocus(null)}
          className={cn(PILL, "shrink-0 px-3 py-1 text-xs", !focusId ? "bg-foreground text-background" : "bg-card text-muted-foreground ring-1 ring-border")}>
          All shifts
        </button>
        {pills.map(({ rider, round }) => (
          <button key={round.routeId} type="button" onClick={() => setFocus(round.routeId)} title={`${round.shiftName} · ${rider.name}`}
            className={cn(PILL, "flex shrink-0 items-center gap-1.5 px-3 py-1 text-xs", shiftTone(round.shiftName), focusId === round.routeId ? "ring-2 ring-foreground/70" : "opacity-80 hover:opacity-100")}>
            <span className={cn("inline-block size-1.5 rounded-full", round.status === "IN_PROGRESS" ? "bg-amber-500" : round.status === "COMPLETED" ? "bg-green-700" : "bg-gray-400")} />
            {round.shiftName}
          </button>
        ))}
      </div>
      <div className="relative h-[55vh] min-h-[300px] overflow-hidden rounded-xl border border-border bg-muted/20 lg:h-auto lg:min-h-0 lg:flex-1">
        <RidersMap riders={mapRiders} stops={mapStops} tracks={mapTracks} selectedId={focusId} focusKey={focusId ?? "all"} onSelect={onSelect} />
        {/* Legend — above Leaflet's panes (z-index 400). */}
        <div className="pointer-events-none absolute bottom-2 left-2 z-[500] flex items-center gap-2.5 rounded-full border border-border bg-card/95 px-2.5 py-1 text-[11px] tabular-nums shadow-sm sm:hidden">
          <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-full bg-green-600" />{counts.delivered}</span>
          <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-full bg-red-600" />{counts.pending}</span>
          <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-full bg-gray-400" />{counts.skipped}</span>
          {counts.noPin > 0 && <span className="text-muted-foreground">{counts.noPin} no pin</span>}
        </div>
        <div className="pointer-events-none absolute bottom-3 left-3 z-[500] hidden rounded-lg border border-border bg-card/95 px-3 py-2 text-[11px] shadow-sm sm:block">
          <p className="mb-1 font-medium">{focused ? `${focused.round.shiftName} · ${focused.rider.name}` : "All shifts today"}</p>
          <p className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full bg-green-600" /> Delivered <b className="ml-auto pl-3 tabular-nums">{counts.delivered}</b></p>
          <p className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full bg-red-600" /> Not delivered yet <b className="ml-auto pl-3 tabular-nums">{counts.pending}</b></p>
          <p className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full bg-gray-400" /> Skipped <b className="ml-auto pl-3 tabular-nums">{counts.skipped}</b></p>
          <p className="mt-1 flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full bg-[#d4a017]" /> Round started here</p>
          <p className="flex items-center gap-1.5"><span className="inline-block h-1 w-2.5 rounded-full bg-[#2563eb]" /> Route driven</p>
          {counts.noPin > 0 && <p className="mt-1 text-muted-foreground">{counts.noPin} stop{counts.noPin === 1 ? "" : "s"} without a location pin</p>}
        </div>
      </div>
      </div>
    </div>
  );
}
