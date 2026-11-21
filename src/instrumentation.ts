// Runs once when the server starts (Next's instrumentation hook).
//
// Two things live here. The day-end close's clock lives in the web server
// because that is the one process that is always running — the WhatsApp worker
// is parked, and there is no cron on the box. Production only: a laptop running
// `next dev` against a shared database must not be the one closing the day.
// DAY_CLOSE=off switches it off without a deploy of new code.
//
// And the listener that keeps each rider's last position for Riders live
// (src/lib/rider-location-keeper.ts), on the same terms; RIDER_LOCATION=off
// switches it off.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production") return;
  // `next start` on a developer's machine is "production" too, and Next then reads
  // .env.production — the live database. The servers are Linux; a Windows laptop
  // must never be the thing that closes the farm's day.
  if (process.platform === "win32") return;
  if (process.env.DAY_CLOSE !== "off") {
    const { startDayCloseClock } = await import("./lib/day-close-clock");
    startDayCloseClock();
  }
  if (process.env.RIDER_LOCATION !== "off") {
    const { startRiderLocationKeeper } = await import("./lib/rider-location-keeper");
    startRiderLocationKeeper();
  }
}
