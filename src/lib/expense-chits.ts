// Limits for the photos attached to an expense (the chit / invoice).
//
// One expense may carry several photos — a chit is often two or three pages — but
// the whole set is capped at 10 MB so storage does not run away.
//
// The cap is checked in three places and they must agree, which is why the numbers
// and the rule live here rather than being retyped:
//   • the browser, before uploading, so you are told immediately;
//   • /api/expense-chits, which caps each individual file;
//   • addExpense, which sees the finished set and refuses to save an over-limit one.
//
// Honest about what this is: staff using this screen are authenticated and could
// upload 10 MB against each of a hundred expenses. It is a guard against accidents
// and runaway storage, not a security boundary.

export const MAX_CHIT_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB across all photos
export const MAX_CHIT_FILES = 10;

/** Image types the bucket accepts. Not an `image/*` prefix test: `image/svg+xml`
 *  is an executable document and would be served from our own domain. */
export const ALLOWED_CHIT_TYPES = [
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
];

export function isAllowedChitType(type: string): boolean {
  return ALLOWED_CHIT_TYPES.includes(type);
}

/** "1.4 MB", "812 KB" — for telling someone how much of the budget they have used. */
export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * Why this set of photos cannot be attached, or null if it is fine.
 *
 * Takes the sizes rather than the files so the server can call it too. Legacy rows
 * carry a size of 0 (their real size was never recorded), which simply contributes
 * nothing to the total — they are never re-validated anyway.
 */
export function chitSetProblem(sizes: number[]): string | null {
  if (sizes.length > MAX_CHIT_FILES) {
    return `Too many photos — ${MAX_CHIT_FILES} at most.`;
  }
  const total = sizes.reduce((s, b) => s + Math.max(0, b), 0);
  if (total > MAX_CHIT_TOTAL_BYTES) {
    return `Photos total ${fmtBytes(total)} — the limit is ${fmtBytes(MAX_CHIT_TOTAL_BYTES)} for all of them together.`;
  }
  return null;
}

/** How much of the 10 MB is left, given what is already attached. */
export function chitBytesRemaining(sizes: number[]): number {
  const used = sizes.reduce((s, b) => s + Math.max(0, b), 0);
  return Math.max(0, MAX_CHIT_TOTAL_BYTES - used);
}
