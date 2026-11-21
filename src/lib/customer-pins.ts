import "server-only";
import { db } from "@/lib/db";

// Reading a customer's location pin out of the link the office saved.
//
// Live, 26 Oct: of 632 active customers, 220 have a short link (maps.app.goo.gl)
// that hides the coordinates behind a redirect, ~280 have a full Google Maps link
// with the coordinates inside it in one of several shapes, and 131 have nothing
// usable. Full links are read here; short links are followed once on the server
// and the answer kept in CustomerPin, so a page load never waits on Google twice
// for the same pin.

export type Pin = { lat: number; lng: number };

/** Pakistan, generously: anything outside is a misread, not a pin. */
const plausible = (lat: number, lng: number) => lat > 23 && lat < 38 && lng > 60 && lng < 78;
const pin = (lat: number, lng: number): Pin | null => (Number.isFinite(lat) && Number.isFinite(lng) && plausible(lat, lng) ? { lat, lng } : null);

function dms(d: string, m: string, s: string) { return Number(d) + Number(m) / 60 + Number(s) / 3600; }

/** Coordinates written inside a link or a bare "lat,lng", or null. */
export function parsePin(raw: string | null | undefined): Pin | null {
  if (!raw) return null;
  let u = raw.trim();
  try { u = decodeURIComponent(u); } catch { /* keep the raw text */ }
  try { u = decodeURIComponent(u); } catch { /* double-encoded links from WhatsApp */ }
  // The pin itself (!3d lat !4d lng) is more exact than the map's centre (@lat,lng).
  let m = u.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (m) return pin(Number(m[1]), Number(m[2]));
  m = u.match(/[?&](?:q|query|ll|destination|daddr|center)=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (m) return pin(Number(m[1]), Number(m[2]));
  m = u.match(/\/place\/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (m) return pin(Number(m[1]), Number(m[2]));
  m = u.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (m) return pin(Number(m[1]), Number(m[2]));
  // 33°28'57.0"N 73°08'10.1"E
  m = u.match(/(\d+)°(\d+)'([\d.]+)"?\s*N[\s+,]*(\d+)°(\d+)'([\d.]+)"?\s*E/i);
  if (m) return pin(dms(m[1], m[2], m[3]), dms(m[4], m[5], m[6]));
  m = u.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/);
  if (m) return pin(Number(m[1]), Number(m[2]));
  return null;
}

const isShort = (u: string) => /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(u.trim());

/** Follow a short link's redirects (at most 5) to the full link, and read that. */
async function resolveShort(url: string): Promise<{ pin: Pin | null; error: string | null }> {
  let current = url.trim();
  try {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0" } });
      const next = res.headers.get("location");
      if (!next) return { pin: null, error: `no redirect (HTTP ${res.status})` };
      current = new URL(next, current).toString();
      const p = parsePin(current);
      if (p) return { pin: p, error: null };
    }
    return { pin: null, error: "no coordinates in the link it leads to" };
  } catch (e) {
    return { pin: null, error: e instanceof Error ? e.message.slice(0, 120) : "could not open the link" };
  }
}

/**
 * Pins for these customers, from the cache where the link has not changed, and
 * read or resolved (then cached) where it has. At most `budget` short links are
 * followed per call so a page never hangs on Google; the rest are picked up on
 * the next call.
 */
export async function pinsFor(customerIds: string[], budget = 40): Promise<Map<string, Pin>> {
  const out = new Map<string, Pin>();
  if (!customerIds.length) return out;
  const [customers, cached] = await Promise.all([
    db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, locationUrl: true } }),
    db.customerPin.findMany({ where: { customerId: { in: customerIds } } }),
  ]);
  const cache = new Map(cached.map((c) => [c.customerId, c]));
  const toResolve: { id: string; url: string }[] = [];
  const writes: { customerId: string; sourceUrl: string; lat: number | null; lng: number | null; error: string | null }[] = [];
  for (const c of customers) {
    const url = (c.locationUrl ?? "").trim();
    if (!url) continue;
    const hit = cache.get(c.id);
    if (hit && hit.sourceUrl === url) {
      if (hit.lat != null && hit.lng != null) out.set(c.id, { lat: hit.lat, lng: hit.lng });
      continue;
    }
    const direct = parsePin(url);
    if (direct) { out.set(c.id, direct); writes.push({ customerId: c.id, sourceUrl: url, lat: direct.lat, lng: direct.lng, error: null }); continue; }
    if (isShort(url)) toResolve.push({ id: c.id, url });
    else writes.push({ customerId: c.id, sourceUrl: url, lat: null, lng: null, error: "no coordinates in the link" });
  }
  // A few at a time, so Google is not hammered.
  const batch = toResolve.slice(0, budget);
  for (let i = 0; i < batch.length; i += 4) {
    const results = await Promise.all(batch.slice(i, i + 4).map(async (r) => ({ r, res: await resolveShort(r.url) })));
    for (const { r, res } of results) {
      if (res.pin) out.set(r.id, res.pin);
      // A failed lookup is not cached as final if the network itself failed; a
      // link that leads nowhere is, so it is not tried on every page load.
      const transient = res.error && /abort|timeout|fetch failed|ENOTFOUND|ECONN/i.test(res.error);
      if (!transient) writes.push({ customerId: r.id, sourceUrl: r.url, lat: res.pin?.lat ?? null, lng: res.pin?.lng ?? null, error: res.error });
    }
  }
  for (const w of writes) {
    await db.customerPin.upsert({
      where: { customerId: w.customerId },
      create: { ...w, resolvedAt: new Date() },
      update: { sourceUrl: w.sourceUrl, lat: w.lat, lng: w.lng, error: w.error, resolvedAt: new Date() },
    });
  }
  return out;
}
