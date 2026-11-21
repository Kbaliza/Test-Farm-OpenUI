import { describe, it, expect } from "vitest";
import { parseHHMM, pktMinutesOf, isItemLate } from "@/lib/checklist-time";

// A PKT wall-clock time as a real instant (PKT = UTC+5).
const pkt = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 24, h - 5, m));
const mins = (h: number, m = 0) => h * 60 + m;

describe("parseHHMM", () => {
  it("reads valid times", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("9:30")).toBe(570);
    expect(parseHHMM("23:59")).toBe(1439);
    expect(parseHHMM(" 07:15 ")).toBe(435);
  });

  it("rejects blanks and nonsense", () => {
    for (const bad of ["", "   ", null, undefined, "7", "24:00", "10:60", "abc", "10:5"]) {
      expect(parseHHMM(bad as string)).toBeNull();
    }
  });
});

describe("pktMinutesOf", () => {
  it("converts an instant to PKT minutes", () => {
    expect(pktMinutesOf(pkt(9, 30))).toBe(mins(9, 30));
    expect(pktMinutesOf(new Date(Date.UTC(2026, 7, 24, 0, 0)))).toBe(mins(5)); // UTC midnight = 5am PKT
  });
});

describe("isItemLate", () => {
  it("a task with no time is never late", () => {
    expect(isItemLate({ dueTime: null, doneAt: null, nowMinutes: mins(23) })).toBe(false);
    expect(isItemLate({ dueTime: "", doneAt: pkt(23), nowMinutes: mins(23) })).toBe(false);
    expect(isItemLate({ dueTime: "not a time", doneAt: null, nowMinutes: mins(23) })).toBe(false);
  });

  it("ticked before its time is on time", () => {
    expect(isItemLate({ dueTime: "09:00", doneAt: pkt(8, 45), nowMinutes: mins(12) })).toBe(false);
  });

  it("ticked after its time is late — and stays late", () => {
    expect(isItemLate({ dueTime: "09:00", doneAt: pkt(9, 30), nowMinutes: mins(9, 31) })).toBe(true);
    // still late when looked at hours afterwards
    expect(isItemLate({ dueTime: "09:00", doneAt: pkt(9, 30), nowMinutes: mins(20) })).toBe(true);
  });

  it("ticked exactly on the minute is not late", () => {
    expect(isItemLate({ dueTime: "09:00", doneAt: pkt(9, 0), nowMinutes: mins(10) })).toBe(false);
  });

  it("pending turns late only once the time has passed", () => {
    expect(isItemLate({ dueTime: "09:00", doneAt: null, nowMinutes: mins(8, 59) })).toBe(false);
    expect(isItemLate({ dueTime: "09:00", doneAt: null, nowMinutes: mins(9) })).toBe(false);
    expect(isItemLate({ dueTime: "09:00", doneAt: null, nowMinutes: mins(9, 1) })).toBe(true);
  });

  it("a late task finished late does not depend on the checklist's own due time", () => {
    // Task due 06:00, ticked 07:00 — late, whatever the sheet's overall time is.
    expect(isItemLate({ dueTime: "06:00", doneAt: pkt(7), nowMinutes: mins(7, 1) })).toBe(true);
  });
});
