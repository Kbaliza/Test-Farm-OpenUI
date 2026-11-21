// Per-task timing for checklists.
//
// A task may carry its own "HH:MM" (PKT) target. Missing that target is shown in
// red so a late finish is visible, and NOTHING else happens — no alert, no
// notification. Only the checklist's own dueTime feeds the alerts feed.
//
// Pure and free of `server-only`, so the page, the rider API and the tests all
// share one definition of "late".

/** "HH:MM" -> minutes since midnight, or null if malformed/blank. */
export function parseHHMM(s: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** Minutes since PKT midnight for an instant (PKT = UTC+5). */
export function pktMinutesOf(d: Date): number {
  const p = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  return p.getUTCHours() * 60 + p.getUTCMinutes();
}

/**
 * Is this task late?
 *
 * Ticked  → late if it was ticked after its own time.
 * Pending → late once that time has passed.
 * No time set, or a malformed one → never late.
 */
export function isItemLate(args: {
  dueTime: string | null;
  doneAt: Date | null;
  nowMinutes: number;
}): boolean {
  const due = parseHHMM(args.dueTime);
  if (due === null) return false;
  if (args.doneAt) return pktMinutesOf(args.doneAt) > due;
  return args.nowMinutes > due;
}
