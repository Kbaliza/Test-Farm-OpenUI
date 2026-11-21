"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps a server-rendered page fresh without a manual reload.
 *
 * Deliveries are written by the rider/mobile app straight to the DB, so Next.js
 * never gets a revalidation signal for them — a bill the manager is already
 * looking at would otherwise stay stale until they regenerate. This calls
 * router.refresh() (a soft refresh: re-runs the server components, keeps client
 * state like filters/scroll) whenever the tab regains focus, and on a gentle
 * interval while the tab is visible.
 *
 * Pass `enabled: false` to pause it (e.g. while the user is mid-edit, so a
 * refresh can't clobber an unsaved draft).
 */
export function useRefreshOnFocus(enabled = true, intervalMs = 60_000) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;

    let last = 0;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      const now = performance.now();
      if (now - last < 3_000) return; // throttle bursts (focus + visibility fire together)
      last = now;
      router.refresh();
    };

    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const timer = intervalMs > 0 ? window.setInterval(refresh, intervalMs) : undefined;

    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) window.clearInterval(timer);
    };
  }, [enabled, intervalMs, router]);
}
