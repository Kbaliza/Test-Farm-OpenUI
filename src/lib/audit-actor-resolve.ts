import { getAuditActor, type AuditActor } from "./audit-actor";

/**
 * Who is making this write — for the audit log, and for anything that reads it.
 *
 * getAuditActor() alone was not enough, and the audit log showed it: from 1 to 8
 * October almost every write made by pressing a button on the website — expenses,
 * payments, production, packaging — went in with no name. The holder it reads is
 * filled by the sign-in check, but:
 *
 *   · React's cache() only holds inside a page render. In a server action (every
 *     Save button) it hands back a fresh, empty holder on each call, so what the
 *     sign-in check put there is gone by the time the write happens.
 *   · The fallback, AsyncLocalStorage.enterWith, is set INSIDE the sign-in check,
 *     after its own awaits. The action that awaited the check resumes in its own
 *     context and never sees it.
 *
 * Only writes made while a page was rendering kept their name — which is why a
 * few did, and why it looked like it worked.
 *
 * So when nothing is held, the user is read from the request itself. Next carries
 * the request (and its cookies) through every await of a server action, which is
 * exactly what the two mechanisms above could not do. The answer is remembered
 * per login cookie for a few minutes, so a busy page does not ask Supabase who
 * the user is on every save.
 *
 * No request (the WhatsApp worker, scripts) means no cookies: the write is still
 * recorded, under no name, exactly as before.
 */
const remembered = new Map<string, { actor: AuditActor; until: number }>();
const REMEMBER_MS = 5 * 60_000;

export async function currentAuditActor(): Promise<AuditActor | null> {
  const held = getAuditActor();
  if (held) return held;

  let key = "";
  try {
    const { cookies } = await import("next/headers");
    const jar = await cookies();
    key = jar
      .getAll()
      .filter((c) => c.name.startsWith("sb-") && c.name.includes("auth-token"))
      .map((c) => `${c.name}=${c.value}`)
      .join("|");
  } catch {
    return null; // not in a request
  }
  if (!key) return null;

  const hit = remembered.get(key);
  if (hit && hit.until > Date.now()) return hit.actor;

  try {
    // Imported here, not at the top: auth reads the database through the client
    // this module serves, and a static import would be a cycle. Its own query is a
    // read, which the write hook never intercepts, so asking cannot loop.
    const { getSessionUser } = await import("./auth");
    const user = await getSessionUser();
    if (!user) return null;
    const actor: AuditActor = { id: user.id, name: user.name, role: user.role };
    if (remembered.size > 500) remembered.clear();
    remembered.set(key, { actor, until: Date.now() + REMEMBER_MS });
    return actor;
  } catch {
    // A name that cannot be found must never be the reason a write fails.
    return null;
  }
}
