import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
import { toPoint, keepForTrack, metres, type Point } from "@/lib/rider-location-keeper";

// What the rider app broadcasts, read into the point the server keeps.
describe("toPoint", () => {
  it("reads a full point", () => {
    const p = toPoint({ riderId: "r1", routeId: "rt", shiftId: "sh", lat: 33.49, lng: 73.1, accuracy: 8, speed: 4.2, bearing: 90, at: "2026-10-26T08:00:00.000Z" })!;
    expect(p).toMatchObject({ routeId: "rt", shiftId: "sh", lat: 33.49, lng: 73.1, accuracy: 8, speed: 4.2, bearing: 90 });
    expect(p.at.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  it("leaves out what the phone did not send", () => {
    const p = toPoint({ lat: 33.49, lng: 73.1, at: "2026-10-26T08:00:00.000Z" })!;
    expect(p).toMatchObject({ routeId: null, speed: null, bearing: null, accuracy: null });
  });

  it("never keeps a point in the future", () => {
    const p = toPoint({ lat: 33.49, lng: 73.1, at: new Date(Date.now() + 3_600_000).toISOString() })!;
    expect(p.at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("refuses what is not a position", () => {
    expect(toPoint(null)).toBeNull();
    expect(toPoint({ lat: "33", lng: 73 })).toBeNull();
    expect(toPoint({ lat: 120, lng: 73 })).toBeNull();
    expect(toPoint({ lat: 33, lng: 73, at: "not a time" })).toBeNull();
  });
});

describe("keepForTrack", () => {
  const at = (sec: number) => new Date(Date.UTC(2026, 9, 26, 8, 0, sec));
  const pt = (lat: number, lng: number, sec: number, extra: Partial<Point> = {}): Point =>
    ({ routeId: "rt", shiftId: "sh", lat, lng, accuracy: 8, speed: null, bearing: null, at: at(sec), ...extra });

  it("keeps the first point of a round — it marks where the round started", () => {
    expect(keepForTrack(undefined, pt(33.49, 73.1, 0))).toBe(true);
    expect(keepForTrack(pt(33.49, 73.1, 0), pt(33.49, 73.1, 30, { routeId: "next" }))).toBe(true);
  });

  it("keeps a real move, not a rider standing at a door", () => {
    const last = pt(33.49, 73.1, 0);
    expect(keepForTrack(last, pt(33.4901, 73.1, 30))).toBe(false);   // ~11 m
    expect(keepForTrack(last, pt(33.4903, 73.1, 30))).toBe(true);    // ~33 m
  });

  it("skips vague fixes and bursts", () => {
    const last = pt(33.49, 73.1, 0);
    expect(keepForTrack(last, pt(33.4905, 73.1, 30, { accuracy: 120 }))).toBe(false);
    expect(keepForTrack(last, pt(33.4905, 73.1, 2))).toBe(false);
  });

  it("measures metres", () => {
    expect(metres({ lat: 33.49, lng: 73.1 }, { lat: 33.4909, lng: 73.1 })).toBeCloseTo(100, -1);
  });
});
