import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createCustomer, uniq } from "../helpers";
import { getRiderCashData } from "@/app/(dashboard)/payments/rider-cash/actions";
import { todayPKTString } from "@/lib/pkt";

// The date window is applied in the QUERY. It used to be applied in the browser,
// over a list the server capped at ~30 days of settled history — so asking for an
// older date showed an empty table even though the records were there.

/** Shift a "YYYY-MM-DD" by a number of days. */
function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + by);
  return dt.toISOString().slice(0, 10);
}

/** A collection on a given PKT day. Noon PKT is 07:00 UTC — safely mid-day. */
async function collectionOn(day: string, amount: number, opts: { received?: boolean } = {}) {
  const c = await createCustomer();
  const when = new Date(`${day}T07:00:00.000Z`);
  const p = await db.payment.create({
    data: {
      head: "RIDER_CASH" as never, amount, customerId: c.id, notes: uniq("rc"), date: when,
      handedOverAt: when,
      ...(opts.received ? { receivedAt: when, receivedByName: "Test" } : {}),
    },
  });
  cleanups.push(async () => { await db.payment.delete({ where: { id: p.id } }).catch(() => {}); });
  return p;
}

const has = (rows: { id: string }[], id: string) => rows.some((r) => r.id === id);

describe("picking a date window", () => {
  it("reaches records far older than the 30-day default view", async () => {
    // Settled, and long past the default cut-off: the exact case that used to come
    // back empty.
    const day = shiftDay(todayPKTString(), -120);
    const old = await collectionOn(day, 640, { received: true });

    const unfiltered = await getRiderCashData();
    expect(has(unfiltered.rows, old.id)).toBe(false); // outside the default window

    const ranged = await getRiderCashData({ from: day, to: day });
    expect(has(ranged.rows, old.id)).toBe(true);
  }, 180000);

  it("spans two dates inclusively, and excludes the days either side", async () => {
    const today = todayPKTString();
    const d1 = shiftDay(today, -60);
    const d2 = shiftDay(today, -59);
    const d3 = shiftDay(today, -58);
    const before = await collectionOn(shiftDay(today, -61), 100, { received: true });
    const first = await collectionOn(d1, 200, { received: true });
    const middle = await collectionOn(d2, 300, { received: true });
    const last = await collectionOn(d3, 400, { received: true });
    const after = await collectionOn(shiftDay(today, -57), 500, { received: true });

    const res = await getRiderCashData({ from: d1, to: d3 });
    expect(has(res.rows, first.id)).toBe(true);   // the boundary day is included
    expect(has(res.rows, middle.id)).toBe(true);
    expect(has(res.rows, last.id)).toBe(true);    // and so is the other boundary
    expect(has(res.rows, before.id)).toBe(false);
    expect(has(res.rows, after.id)).toBe(false);
  }, 180000);

  it("one date on its own means that single day", async () => {
    const day = shiftDay(todayPKTString(), -45);
    const on = await collectionOn(day, 700, { received: true });
    const next = await collectionOn(shiftDay(day, 1), 800, { received: true });

    const res = await getRiderCashData({ from: day });
    expect(res.range).toEqual({ from: day, to: day });
    expect(has(res.rows, on.id)).toBe(true);
    expect(has(res.rows, next.id)).toBe(false);
  }, 180000);

  it("a backwards range is corrected, not returned empty", async () => {
    const today = todayPKTString();
    const d1 = shiftDay(today, -40);
    const d2 = shiftDay(today, -38);
    const mid = await collectionOn(shiftDay(today, -39), 900, { received: true });

    const res = await getRiderCashData({ from: d2, to: d1 }); // deliberately reversed
    expect(res.range).toEqual({ from: d1, to: d2 });
    expect(has(res.rows, mid.id)).toBe(true);
  }, 180000);

  it("rubbish in the URL is ignored rather than throwing", async () => {
    for (const bad of [{ from: "not-a-date" }, { from: "2026-13-45" }, { from: "" }, { to: "'; drop table" }]) {
      const res = await getRiderCashData(bad);
      expect(res.dbReady).toBe(true);
      // "2026-13-45" is the right SHAPE, so it is passed through and simply matches
      // nothing; the rest are rejected outright and leave the default view.
      if (bad.from === "2026-13-45") expect(res.range).not.toBeNull();
      else expect(res.range).toBeNull();
    }
  }, 180000);
});

describe("the live figures never follow the date window", () => {
  it("cash with riders, the box and the per-rider tiles stay global", async () => {
    // An unreceived collection today, and a window that deliberately excludes it.
    const today = todayPKTString();
    await collectionOn(today, 1500);
    const farBack = shiftDay(today, -200);

    const wide = await getRiderCashData();
    const narrow = await getRiderCashData({ from: farBack, to: farBack });

    // The table follows the window...
    expect(narrow.rows.length).toBeLessThan(wide.rows.length);
    // ...but the position does not. Reading "with riders 0" here would be a lie.
    expect(narrow.summary.withRiders).toBeCloseTo(wide.summary.withRiders, 2);
    expect(narrow.summary.riderCashBox).toBeCloseTo(wide.summary.riderCashBox, 2);
    expect(narrow.summary.pendingCount).toBe(wide.summary.pendingCount);
    expect(narrow.summary.collectedToday).toBeCloseTo(wide.summary.collectedToday, 2);
    expect(narrow.summary.receivedToday).toBeCloseTo(wide.summary.receivedToday, 2);
    expect(narrow.tiles.length).toBe(wide.tiles.length);
  }, 180000);

  it("today's collection still counts in Collected Today from inside an old window", async () => {
    const today = todayPKTString();
    const before = (await getRiderCashData()).summary.collectedToday;
    await collectionOn(today, 2200);

    const narrow = await getRiderCashData({ from: shiftDay(today, -300), to: shiftDay(today, -299) });
    expect(narrow.rows).toHaveLength(0);
    expect(narrow.summary.collectedToday).toBeCloseTo(before + 2200, 2);
  }, 180000);

  it("a rider visible in the table is always offered in the rider filter", async () => {
    const day = shiftDay(todayPKTString(), -90);
    await collectionOn(day, 350, { received: true });

    const res = await getRiderCashData({ from: day, to: day });
    for (const row of res.rows) {
      if (!row.riderId) continue;
      expect(res.riders.some((r) => r.id === row.riderId), row.riderName).toBe(true);
    }
  }, 180000);
});

describe("no window", () => {
  it("still shows every unconfirmed collection, however old", async () => {
    const ancient = shiftDay(todayPKTString(), -400);
    const stuck = await collectionOn(ancient, 480); // never confirmed

    const res = await getRiderCashData();
    expect(res.range).toBeNull();
    // Unsettled money must never fall off the default view just because it is old.
    expect(has(res.rows, stuck.id)).toBe(true);
  }, 180000);
});
