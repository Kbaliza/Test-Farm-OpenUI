"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// The map itself — Leaflet on OpenStreetMap tiles. Loaded only in the browser
// (riders-live-client imports it with ssr: false); Leaflet touches `window` as
// soon as it is imported. One arrow per rider, turned to his bearing; the arrow
// goes grey when his last point is stale. Under it, the line he has driven since
// the round started and a gold marker where it started; under that, the stops.

export type MapStop = {
  key: string;
  riderId: string;
  lat: number;
  lng: number;
  state: "delivered" | "pending" | "skipped";
  label: string;
};

const STOP_COLOUR = { delivered: "#16a34a", pending: "#dc2626", skipped: "#9ca3af" } as const;

/** A map-pin symbol in the stop's colour; its tip sits on the customer's spot. */
const pinIcons = Object.fromEntries(
  (Object.keys(STOP_COLOUR) as (keyof typeof STOP_COLOUR)[]).map((state) => [state, L.divIcon({
    html: `<svg viewBox="0 0 24 32" width="24" height="32" style="display:block;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))">
      <path d="M12 1C6 1 1.5 5.5 1.5 11.3c0 7.6 9 18.3 9.7 19.1a1 1 0 0 0 1.6 0c.7-.8 9.7-11.5 9.7-19.1C22.5 5.5 18 1 12 1z" fill="${STOP_COLOUR[state]}" stroke="white" stroke-width="1.6"/>
      <circle cx="12" cy="11.3" r="3.8" fill="white"/>
    </svg>`,
    className: "", iconSize: [24, 32], iconAnchor: [12, 31], popupAnchor: [0, -28], tooltipAnchor: [0, -30],
  })]),
) as Record<keyof typeof STOP_COLOUR, L.DivIcon>;

/** The path of one round: where it started (gold) and the line driven since. */
export type MapTrack = {
  key: string;
  riderId: string;
  points: [number, number][];
  start: { lat: number; lng: number; label: string } | null;
};

const TRACK_COLOUR = "#2563eb";

/** Gold, with a flag: the round started here. */
const startIcon = L.divIcon({
  html: `<svg viewBox="0 0 26 26" width="26" height="26" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">
    <circle cx="13" cy="13" r="11" fill="#d4a017" stroke="white" stroke-width="2"/>
    <path d="M10 7.5v11" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M10.6 8h7l-2 2.6 2 2.6h-7z" fill="white"/>
  </svg>`,
  className: "", iconSize: [26, 26], iconAnchor: [13, 13], tooltipAnchor: [0, -13],
});

export type MapRider = {
  /** One arrow per round on the road — a rider login can be out on several. */
  key: string;
  riderId: string;
  name: string;
  lat: number;
  lng: number;
  bearing: number | null;
  speedKmh: number | null;
  ageSec: number;
  stale: boolean;
  label: string;
};

const ISLAMABAD: [number, number] = [33.6844, 73.0479];

function arrowIcon(bearing: number | null, stale: boolean, selected: boolean) {
  const colour = stale ? "#9ca3af" : selected ? "#b45309" : "#2D4A2E";
  const rot = bearing ?? 0;
  const html = `
    <div style="width:34px;height:34px;display:grid;place-items:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))">
      <svg viewBox="0 0 24 24" width="30" height="30" style="transform:rotate(${rot}deg)">
        <circle cx="12" cy="12" r="10" fill="${colour}" stroke="white" stroke-width="2"/>
        ${bearing == null ? "" : `<path d="M12 5 L16 14 L12 12 L8 14 Z" fill="white"/>`}
      </svg>
    </div>`;
  return L.divIcon({ html, className: "", iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16] });
}

export default function RidersMap({ riders, stops, tracks, selectedId, focusKey, onSelect }: {
  riders: MapRider[]; stops: MapStop[]; tracks: MapTrack[]; selectedId: string | null;
  /** What the map is showing (a shift, or all). It is framed once each time this changes. */
  focusKey: string;
  onSelect: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const stopLayer = useRef<L.LayerGroup | null>(null);
  const trackLayer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  const stopsFitted = useRef<string | null>(null);

  useEffect(() => {
    if (!box.current || map.current) return;
    const m = L.map(box.current, { zoomControl: true }).setView(ISLAMABAD, 11);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    map.current = m;
    // Leaflet measures its box once; tell it whenever the box changes (a phone
    // turned, the page laid out after the map) or it draws into a stale size.
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(box.current);
    stopLayer.current = L.layerGroup().addTo(m);
    trackLayer.current = L.layerGroup().addTo(m);
    const marks = markers.current;
    return () => { ro.disconnect(); m.remove(); map.current = null; stopLayer.current = null; trackLayer.current = null; marks.clear(); fitted.current = false; stopsFitted.current = null; };
  }, []);

  // The stops: a pin per customer, coloured by what the rider has done there.
  // Drawn under the rider arrows; redrawn whole on each update (a few hundred pins).
  // The details show on hover (a tap on a phone), no click needed.
  useEffect(() => {
    const m = map.current, layer = stopLayer.current;
    if (!m || !layer) return;
    layer.clearLayers();
    for (const s of stops) {
      L.marker([s.lat, s.lng], { icon: pinIcons[s.state], zIndexOffset: -1000 })
        .bindTooltip(s.label, { direction: "top", opacity: 1 })
        .addTo(layer);
    }
  }, [stops]);

  // Choosing a shift frames its stops and route once; after that the map is left
  // where you put it.
  useEffect(() => {
    const m = map.current;
    if (!m || stopsFitted.current === focusKey) return;
    const pts: [number, number][] = [
      ...stops.map((s) => [s.lat, s.lng] as [number, number]),
      ...tracks.flatMap((t) => [...t.points, ...(t.start ? [[t.start.lat, t.start.lng] as [number, number]] : [])]),
    ];
    if (!pts.length) return;
    m.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16 });
    stopsFitted.current = focusKey;
    fitted.current = true;
  }, [stops, tracks, focusKey]);

  // The path of each round and its gold start, over the stops and under the arrows.
  useEffect(() => {
    const layer = trackLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const t of tracks) {
      if (t.points.length > 1) {
        const strong = !selectedId || t.key === selectedId;
        L.polyline(t.points, { color: TRACK_COLOUR, weight: strong ? 4 : 3, opacity: strong ? 0.75 : 0.35, lineJoin: "round", interactive: false }).addTo(layer);
      }
      if (t.start) {
        L.marker([t.start.lat, t.start.lng], { icon: startIcon, zIndexOffset: -500 })
          .bindTooltip(t.start.label, { direction: "top", opacity: 1 })
          .addTo(layer);
      }
    }
  }, [tracks, selectedId]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const r of riders) {
      seen.add(r.key);
      const icon = arrowIcon(r.bearing, r.stale, r.key === selectedId);
      const popup = `<b>${r.name}</b><br/>${r.label}${r.speedKmh != null ? `<br/>${r.speedKmh} km/h` : ""}`;
      let mk = markers.current.get(r.key);
      if (!mk) {
        mk = L.marker([r.lat, r.lng], { icon, title: r.name }).addTo(m).bindPopup(popup).on("click", () => onSelect(r.key));
        markers.current.set(r.key, mk);
      } else {
        mk.setLatLng([r.lat, r.lng]); mk.setIcon(icon); mk.setPopupContent(popup);
      }
    }
    for (const [id, mk] of markers.current) if (!seen.has(id)) { mk.remove(); markers.current.delete(id); }
    // Fit everyone the first time positions arrive; after that only follow the selected rider.
    if (riders.length && !fitted.current) {
      m.fitBounds(L.latLngBounds(riders.map((r) => [r.lat, r.lng] as [number, number])), { padding: [40, 40], maxZoom: 15 });
      fitted.current = true;
    } else if (selectedId) {
      const s = riders.find((r) => r.key === selectedId);
      if (s) m.panTo([s.lat, s.lng], { animate: true });
    }
  }, [riders, selectedId, onSelect]);

  return <div ref={box} className="absolute inset-0" />;
}
