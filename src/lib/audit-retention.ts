// How long the audit log is kept.
//
// The one place that decides, so lengthening or shortening the window is a
// one-line change with a test behind it — the same shape as
// src/lib/checklist-retention.ts.
//
// The prune itself cannot be an ordinary delete: the table refuses UPDATE and
// DELETE to everyone, including an admin and including the application. It goes
// through prune_audit_log(), a SECURITY DEFINER function in
// supabase/audit-log.sql that sets a transaction-local flag the immutability
// trigger recognises. That is what makes "append-only" true rather than polite.

/** Months of history kept. Anything older is removed by the prune. */
export const AUDIT_RETENTION_MONTHS = 12;

/** The oldest moment still kept, given "now". Anything before this is due to go. */
export function auditCutoff(now: Date = new Date(), months = AUDIT_RETENTION_MONTHS): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/** Whether an entry is still inside the window. */
export function isWithinAuditRetention(
  at: Date,
  now: Date = new Date(),
  months = AUDIT_RETENTION_MONTHS,
): boolean {
  return at >= auditCutoff(now, months);
}
