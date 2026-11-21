import { runDueDayCloses } from "@/lib/day-close";

const EVERY_MS = 60_000;
let started = false;

/**
 * Ask once a minute whether a day needs closing. The answer is "no" for all but
 * the first minute after midnight (PKT), and runDueDayCloses claims that run in
 * the database, so a restart or a second server cannot close a day twice.
 */
export function startDayCloseClock() {
  if (started) return;
  started = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueDayCloses();
    } catch (e) {
      console.error("[day-close] tick failed", e);
    } finally {
      busy = false;
    }
  };
  // A little after start-up, so the server is serving before it does any work.
  setTimeout(tick, 30_000);
  setInterval(tick, EVERY_MS);
}
