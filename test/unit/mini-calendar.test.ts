import { describe, it, expect } from "vitest";
import { pickRange, nextPick } from "@/components/ui/mini-calendar";

// The two-click range rule, shared by the Wastage and Rider Cash calendars. It is
// extracted precisely so those two pages cannot disagree about what a second click
// means — which is exactly the kind of thing that goes unnoticed until someone
// exports the wrong week.

const none = { start: null, end: null };

describe("picking a range in two clicks", () => {
  it("the first click sets the start and leaves the end open", () => {
    expect(pickRange(none, "2026-09-10")).toEqual({ start: "2026-09-10", end: null });
  });

  it("the second click closes the range", () => {
    expect(pickRange({ start: "2026-09-10", end: null }, "2026-09-14"))
      .toEqual({ start: "2026-09-10", end: "2026-09-14" });
  });

  it("picking backwards swaps rather than producing an impossible range", () => {
    expect(pickRange({ start: "2026-09-14", end: null }, "2026-09-10"))
      .toEqual({ start: "2026-09-10", end: "2026-09-14" });
  });

  it("clicking the same day twice is a single-day range", () => {
    expect(pickRange({ start: "2026-09-10", end: null }, "2026-09-10"))
      .toEqual({ start: "2026-09-10", end: "2026-09-10" });
  });

  it("a third click starts over instead of stretching the range", () => {
    expect(pickRange({ start: "2026-09-10", end: "2026-09-14" }, "2026-09-20"))
      .toEqual({ start: "2026-09-20", end: null });
  });

  it("starting over works even when the new date is before the old range", () => {
    expect(pickRange({ start: "2026-09-10", end: "2026-09-14" }, "2026-09-01"))
      .toEqual({ start: "2026-09-01", end: null });
  });

  it("crosses a month and a year boundary on plain string comparison", () => {
    expect(pickRange({ start: "2026-12-28", end: null }, "2027-01-03"))
      .toEqual({ start: "2026-12-28", end: "2027-01-03" });
    expect(pickRange({ start: "2027-01-03", end: null }, "2026-12-28"))
      .toEqual({ start: "2026-12-28", end: "2027-01-03" });
  });
});

// The Rider Cash wiring, which keeps the half-made start apart from the range it
// has already applied to the URL. This is where the real fault was: `pickRange`
// above was correct the whole time and every one of its tests passed, while the
// calendar on the page did nothing at all, because the caller handed it the
// applied `from` instead of the pending start.

const applied = (start: string | null, end: string | null) => ({ start, end });

describe("picking a range when the pending start is held apart from the applied one", () => {
  it("applies a range in two clicks on a page with no range yet — the bug that shipped", () => {
    const first = nextPick(null, applied(null, null), "2026-10-01");
    expect(first).toEqual({ start: "2026-10-01", end: null });
    // The URL is untouched after the first click, so the applied range is STILL
    // empty when the second click arrives. Reading it instead of the pending start
    // is what made the calendar unclickable.
    const second = nextPick(first.start, applied(null, null), "2026-10-04");
    expect(second).toEqual({ start: "2026-10-01", end: "2026-10-04" });
  });

  it("completes a single-day range when the same day is clicked twice", () => {
    const first = nextPick(null, applied(null, null), "2026-10-04");
    expect(nextPick(first.start, applied(null, null), "2026-10-04"))
      .toEqual({ start: "2026-10-04", end: "2026-10-04" });
  });

  it("closes the range backwards without needing the applied dates", () => {
    const first = nextPick(null, applied(null, null), "2026-10-04");
    expect(nextPick(first.start, applied(null, null), "2026-10-01"))
      .toEqual({ start: "2026-10-01", end: "2026-10-04" });
  });

  it("starts over from a range that is already applied, ignoring it on the next click", () => {
    const first = nextPick(null, applied("2026-09-01", "2026-09-30"), "2026-10-01");
    expect(first).toEqual({ start: "2026-10-01", end: null });
    expect(nextPick(first.start, applied("2026-09-01", "2026-09-30"), "2026-10-03"))
      .toEqual({ start: "2026-10-01", end: "2026-10-03" });
  });

  it("treats a pending start as authoritative even when an applied range exists", () => {
    expect(nextPick("2026-10-02", applied("2026-09-01", "2026-09-30"), "2026-10-05"))
      .toEqual({ start: "2026-10-02", end: "2026-10-05" });
  });
});
