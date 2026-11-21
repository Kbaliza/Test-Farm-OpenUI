import { describe, it, expect } from "vitest";
import {
  MAX_CHIT_TOTAL_BYTES, MAX_CHIT_FILES,
  chitSetProblem, chitBytesRemaining, isAllowedChitType, fmtBytes,
} from "@/lib/expense-chits";

const MB = 1024 * 1024;

// The 10 MB ceiling is on the SET of photos, not on each one — the whole point of
// the change. The same rule runs in the browser before uploading and again in
// addExpense on the finished set, so it has to be exact at the boundary.

describe("the 10 MB ceiling applies to all the photos together", () => {
  it("accepts a set that fits", () => {
    expect(chitSetProblem([2 * MB, 3 * MB, 1 * MB])).toBeNull();
  });

  it("accepts a set landing exactly on the limit", () => {
    // Off-by-one here would reject a set that is precisely allowed.
    expect(chitSetProblem([MAX_CHIT_TOTAL_BYTES])).toBeNull();
    expect(chitSetProblem([6 * MB, 4 * MB])).toBeNull();
  });

  it("refuses one byte over, however the bytes are split", () => {
    expect(chitSetProblem([MAX_CHIT_TOTAL_BYTES + 1])).toContain("limit");
    // Each of these is comfortably under on its own — only the total breaks it.
    expect(chitSetProblem([4 * MB, 4 * MB, 4 * MB])).toContain("limit");
  });

  it("says how big the set actually is, so the message is actionable", () => {
    expect(chitSetProblem([6 * MB, 6 * MB])).toContain("12.0 MB");
  });

  it("accepts an empty set — a chit with no photo is allowed", () => {
    expect(chitSetProblem([])).toBeNull();
  });
});

describe("the file count is capped too", () => {
  it("allows the maximum", () => {
    expect(chitSetProblem(Array(MAX_CHIT_FILES).fill(1024))).toBeNull();
  });

  it("refuses one more, even when they are tiny", () => {
    expect(chitSetProblem(Array(MAX_CHIT_FILES + 1).fill(1))).toContain("Too many");
  });
});

describe("odd sizes do not break the arithmetic", () => {
  it("treats a migrated photo's unknown size (0) as contributing nothing", () => {
    // Rows carried over from the old single-photo column have bytes = 0.
    expect(chitSetProblem([0, 0, 0])).toBeNull();
    expect(chitSetProblem([0, MAX_CHIT_TOTAL_BYTES])).toBeNull();
  });

  it("ignores a negative size rather than using it to buy headroom", () => {
    // Without the clamp, a bogus -20 MB would let an 11 MB photo through.
    expect(chitSetProblem([-20 * MB, 11 * MB])).toContain("limit");
  });
});

describe("how much room is left", () => {
  it("counts down from the ceiling", () => {
    expect(chitBytesRemaining([])).toBe(MAX_CHIT_TOTAL_BYTES);
    expect(chitBytesRemaining([4 * MB])).toBe(MAX_CHIT_TOTAL_BYTES - 4 * MB);
  });

  it("never goes negative", () => {
    expect(chitBytesRemaining([20 * MB])).toBe(0);
  });
});

describe("which images are allowed", () => {
  it("takes the formats a phone camera produces", () => {
    for (const t of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]) {
      expect(isAllowedChitType(t), t).toBe(true);
    }
  });

  it("still refuses SVG — it is a script that would run on our own domain", () => {
    expect(isAllowedChitType("image/svg+xml")).toBe(false);
    expect(isAllowedChitType("application/pdf")).toBe(false);
    expect(isAllowedChitType("text/html")).toBe(false);
    expect(isAllowedChitType("")).toBe(false);
  });
});

describe("sizes read the way a person would say them", () => {
  it("formats bytes, KB and MB", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(3 * MB)).toBe("3.0 MB");
    expect(fmtBytes(MAX_CHIT_TOTAL_BYTES)).toBe("10.0 MB");
  });
});
