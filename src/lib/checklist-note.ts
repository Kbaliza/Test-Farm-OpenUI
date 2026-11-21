// The rule for a note left against a checklist task.
//
// Kept pure so the box in the browser, the server action and the rider API all
// agree on what an acceptable note is — and so "empty means delete" is decided
// in exactly one place rather than three.

export const NOTE_MAX = 500;

/**
 * What will actually be stored: trimmed, or null when there is nothing to keep.
 * Null is the signal to remove the note rather than store an empty one.
 */
export function normalizeNote(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  return t.length === 0 ? null : t;
}

/** Why this note cannot be saved, or null when it is fine. */
export function noteProblem(raw: string | null | undefined): string | null {
  const t = normalizeNote(raw);
  if (t === null) return null; // clearing is always allowed
  if (t.length > NOTE_MAX) {
    return `Note is too long — keep it under ${NOTE_MAX} characters (currently ${t.length}).`;
  }
  return null;
}
