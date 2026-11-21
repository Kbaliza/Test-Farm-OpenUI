// Client settings that must be identical wherever a Prisma client is built.
//
// The test harness constructs its own client and registers it as the global one
// that `@/lib/db` reads back, so without a shared constant the tests would run
// against different settings than the server does — and the difference would only
// show up as a test that passes where production fails, or the reverse.
//
// It lives in its own module because the harness has to load dotenv before it
// touches anything that reads DATABASE_URL, and importing a plain object cannot
// trip that.

/**
 * Prisma closes an interactive transaction after 5 seconds by default and then
 * rejects every later query in it with "Transaction not found ... refers to an
 * old closed transaction". That assumes a database next door; ours is reached
 * over a pooler measured at 700-1700ms for a single round trip, so a write of a
 * few statements can spend its whole budget on the wire and be killed whole and
 * correct.
 *
 * A floor, not a target: a transaction that finishes early still commits
 * immediately, and a call site needing longer still passes its own timeout.
 */
export const PRISMA_TRANSACTION_OPTIONS = {
  timeout: 30_000,
  maxWait: 15_000,
} as const;
