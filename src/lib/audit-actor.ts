import "server-only";
import { cache } from "react";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who is acting, for the audit log.
 *
 * The database decides what to record; this only tells it whose name to put on
 * the entry. Two rules shape it:
 *
 *   · It must be readable with no query. The Prisma client extension reads it on
 *     the way to every write, and a lookup there would call back into auth,
 *     which itself reads the database — a loop with no exit.
 *   · It must not leak between requests. The value is stored per request, and
 *     put on the wire transaction-locally, because the runtime shares pooled
 *     connections and a session-level setting would sign one person's edit with
 *     another person's name.
 *
 * auth.ts fills this in as a side effect of the role check every write action
 * already performs, so nothing has to remember to set it.
 */
export type AuditActor = { id: string; name: string; role: string };

/** Per-request in the request-handling path — React de-dupes this per request. */
const held = cache(() => ({ current: null as AuditActor | null }));

/**
 * For work with no request behind it: the WhatsApp worker, scripts, anything
 * that wants its own name in the log rather than "unknown".
 */
const als = new AsyncLocalStorage<AuditActor>();

export function setAuditActor(actor: AuditActor): void {
  try {
    held().current = actor;
  } catch {
    // No request to hang it on — see below.
  }
  try {
    // React's cache() only holds within a request. Outside one — the worker, a
    // script, the test suite — it hands back a fresh object every call and the
    // actor would vanish between being set and being read. enterWith puts it on
    // the current async context instead, which survives in both worlds.
    als.enterWith(actor);
  } catch {
    // An actor that cannot be recorded must never be the reason a write fails.
  }
}

export function getAuditActor(): AuditActor | null {
  // The request-scoped holder first: inside a request it is the one that cannot
  // bleed into a neighbouring request.
  try {
    const inRequest = held().current;
    if (inRequest) return inRequest;
  } catch {
    // Not in a request.
  }
  return als.getStore() ?? null;
}

/** Run something as a named actor — for scripts and the worker. */
export function runAsAuditActor<T>(actor: AuditActor, fn: () => T): T {
  return als.run(actor, fn);
}
