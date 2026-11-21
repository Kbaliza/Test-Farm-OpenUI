/**
 * Tables the audit log deliberately leaves alone.
 *
 * Everything else in the database is audited — a deny-list, not an allow-list,
 * so a table added next year is covered by the deploy that creates it and nobody
 * has to remember. The list is mirrored in supabase/audit-log.sql, which does the
 * attaching; this copy is what the test compares the database against, so the two
 * cannot drift apart in silence.
 *
 * Each exclusion is machine noise or a log of its own — never a decision somebody
 * made:
 *   AuditLog             would record itself recording itself
 *   WhatsappMessageLog   a send queue that rewrites its own status
 *   WhatsappSession      session and QR state, rewritten constantly, holds credentials
 *   DeviceToken          push-token churn on every app launch
 *   CustomerNotification fan-out written by triggers; the decision behind it is
 *                        audited where it was made
 *   Alert                derived from other rows, not decided
 *   CustomerPin          a cache of coordinates read from Customer.locationUrl;
 *                        the link itself is audited on Customer
 *   RiderLocation        a rider's latest GPS point, rewritten every few seconds
 *   RiderTrackPoint      the GPS path behind it, pruned at 30 days
 *   ChecklistCompletion  tick and untick churn that already records who and when,
 *   ChecklistNote        and is pruned at 60 days — auditing it would keep a
 *                        twelve-month shadow of a two-month table
 */
export const AUDIT_DENY_LIST: readonly string[] = [
  "Alert",
  "AuditLog",
  "ChecklistCompletion",
  "ChecklistNote",
  "CustomerNotification",
  "CustomerPin",
  "DeviceToken",
  "RiderLocation",
  "RiderTrackPoint",
  "WhatsappMessageLog",
  "WhatsappSession",
];
