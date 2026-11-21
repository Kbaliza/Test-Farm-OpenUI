import "server-only";
import { db } from "@/lib/db";

/**
 * When stock was last counted back to nothing.
 *
 * A reset draws a line in time. Everything RECORDED before it is settled — the
 * arrivals and production that made the figures, and equally the rounds, spare
 * stock and mart drops that were claims against them. Everything recorded after
 * it counts. Nothing is deleted: remove this one setting and every figure comes
 * back exactly as it was.
 *
 * Both sides have to move together. Settling only the claims leaves stock that
 * nothing arrived for; settling only the arrivals leaves rounds subtracting from
 * an empty shelf for ever, which reads as "nothing in inventory" on every page
 * and refuses every send, batch and route. That is what happened the first time.
 *
 * Recorded-at, not dated-at, on both sides. A round assigned this afternoon
 * carries this morning's date: judged by the date it would fall on the settled
 * side of a line drawn at noon and take its load out of nobody's stock.
 *
 * Null when stock has never been reset (a fresh database, and every test), in
 * which case nothing is filtered and the figures are exactly as they always were.
 */
export const STOCK_RESET_KEY = "stock.resetAt";

export async function getStockResetAt(): Promise<Date | null> {
  try {
    const rows = await db.$queryRaw<{ value: string }[]>`
      SELECT value FROM "AppSetting" WHERE key = ${STOCK_RESET_KEY} LIMIT 1`;
    const raw = rows[0]?.value;
    if (!raw) return null;
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    // No settings table yet (a database that has not been migrated) — treat it
    // as "never reset" rather than failing every stock read.
    return null;
  }
}
