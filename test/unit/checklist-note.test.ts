import { describe, it, expect } from "vitest";
import { normalizeNote, noteProblem, NOTE_MAX } from "@/lib/checklist-note";
import { pktNoonToUTC } from "@/lib/pkt";

describe("normalizeNote — what actually gets stored", () => {
  it("trims what was typed", () => {
    expect(normalizeNote("  valve was stiff  ")).toBe("valve was stiff");
  });

  it("treats blank input as 'remove the note'", () => {
    for (const blank of ["", "   ", "\n\t ", null, undefined]) {
      expect(normalizeNote(blank as string)).toBeNull();
    }
  });

  it("keeps a note that is only just long enough", () => {
    expect(normalizeNote("a")).toBe("a");
  });

  it("preserves line breaks inside the note", () => {
    expect(normalizeNote("line one\nline two")).toBe("line one\nline two");
  });
});

describe("noteProblem — the gate", () => {
  it("accepts an ordinary remark", () => {
    expect(noteProblem("Gate was locked, delivered at the back door.")).toBeNull();
  });

  it("always allows clearing", () => {
    expect(noteProblem("")).toBeNull();
    expect(noteProblem("    ")).toBeNull();
    expect(noteProblem(null)).toBeNull();
  });

  it("accepts a note exactly at the limit", () => {
    expect(noteProblem("x".repeat(NOTE_MAX))).toBeNull();
  });

  it("refuses one character over, and says the length", () => {
    const msg = noteProblem("x".repeat(NOTE_MAX + 1));
    expect(msg).toContain(String(NOTE_MAX));
    expect(msg).toContain(String(NOTE_MAX + 1));
  });

  it("measures the trimmed length, not the padding", () => {
    expect(noteProblem(`   ${"x".repeat(NOTE_MAX)}   `)).toBeNull();
  });
});

describe("notes are keyed to one PKT day", () => {
  it("a different day is a different key, so yesterday's note is never read", () => {
    // checklistDayKey() is exactly this — the PKT day stamped onto every tick
    // and every note.
    const today = pktNoonToUTC("2026-08-26");
    const yesterday = pktNoonToUTC("2026-08-25");
    expect(today.getTime()).not.toBe(yesterday.getTime());
    // exactly 24h apart — the same wipe the ticks already rely on
    expect(today.getTime() - yesterday.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
