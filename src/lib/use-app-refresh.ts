"use client";

import { useEffect, useRef } from "react";

// Subscribe a client component to the topbar's Refresh button. The button fires
// an "app:refresh" window event; components that fetch their own data (rather
// than receiving it from a Server Component) call this to re-fetch on demand,
// since router.refresh() only re-runs Server Components.
export function useAppRefresh(onRefresh: () => void) {
  const ref = useRef(onRefresh);
  ref.current = onRefresh;
  useEffect(() => {
    const handler = () => ref.current();
    window.addEventListener("app:refresh", handler);
    return () => window.removeEventListener("app:refresh", handler);
  }, []);
}
